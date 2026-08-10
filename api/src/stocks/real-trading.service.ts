import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { marketClock } from './market-clock';
import { UpstoxService } from './upstox.service';
import { Candle, IndicatorService } from './indicator.service';
import { automaticRiskProfile, executionScore } from './trading-decision-engine';
import { ExecutionEngine } from './execution-engine.service';
import { IntradayExecutionService } from './intraday-execution.service';

type RealOrderExecution = {
  brokerOrderId: string;
  stockName: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  entryPrice: number;
  orderStatus: 'COMPLETE' | 'OPEN';
};
type RealTradingChange = { changed: boolean; executions: RealOrderExecution[] };

@Injectable()
export class RealTradingService {
  private readonly logger = new Logger(RealTradingService.name);
  private readonly locks = new Set<string>();
  private readonly lastRunningReconcile = new Map<string, number>();
  private readonly lastQueueDrain = new Map<string, number>();
  constructor(private readonly upstox: UpstoxService, private readonly prisma: PrismaService, private readonly indicators: IndicatorService, private readonly engine: ExecutionEngine, private readonly intraday: IntradayExecutionService) {}

  private async account(userId: string) {
    const existing = await this.prisma.realTradingAccount.findUnique({ where: { userId } });
    if (existing) return existing;
    try {
      return await this.prisma.realTradingAccount.create({ data: { userId } });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
        return this.prisma.realTradingAccount.findUniqueOrThrow({ where: { userId } });
      }
      throw error;
    }
  }

  async updateSettings(userId: string, input: Record<string, unknown>) {
    const current = await this.account(userId);
    const number = (value: unknown, minimum: number, maximum: number, fallback: number) => Number.isFinite(Number(value)) ? Math.min(maximum, Math.max(minimum, Number(value))) : fallback;
    const squareOffTime = typeof input.squareOffTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.squareOffTime) ? input.squareOffTime : current.squareOffTime;
    const entryModes = ['IMMEDIATE_ENTRY', 'ENTRY_BREAKOUT', 'RUNNING_CONFIRMATION', 'TARGET1_CONFIRMATION', 'TARGET2_PULLBACK', 'TREND_CONTINUATION'];
    const entryMode = typeof input.entryMode === 'string' && entryModes.includes(input.entryMode) ? input.entryMode : current.entryMode;
    return this.prisma.realTradingAccount.update({ where: { userId }, data: {
      tradingCapital: number(input.tradingCapital, 1_000, 10_000_000, current.tradingCapital),
      maxOpenTrades: Math.round(number(input.maxOpenTrades, 1, 5, current.maxOpenTrades)),
      riskPerTrade: number(input.riskPerTrade, .5, 2, current.riskPerTrade),
      minimumConfidence: number(input.minimumConfidence, 75, 95, current.minimumConfidence),
      maxDailyLoss: automaticRiskProfile(number(input.tradingCapital, 1_000, 10_000_000, current.tradingCapital)).maxDailyLoss,
      autoTrading: typeof input.autoTrading === 'boolean' ? input.autoTrading : current.autoTrading,
      buySignals: typeof input.buySignals === 'boolean' ? input.buySignals : current.buySignals,
      sellSignals: typeof input.sellSignals === 'boolean' ? input.sellSignals : current.sellSignals,
      aggressiveMode: typeof input.aggressiveMode === 'boolean' ? input.aggressiveMode : current.aggressiveMode,
      squareOffTime,
      entryMode,
    } });
  }

  async dashboard(userId: string) {
    const settings = await this.account(userId);
    const requests = await Promise.allSettled([
      this.upstox.profile(userId),
      this.upstox.funds(userId),
      this.upstox.positions(userId),
      this.upstox.holdings(userId),
      this.upstox.orderBook(userId),
      this.upstox.tradeBook(userId),
    ]);
    const value = (index: number): any => requests[index].status === 'fulfilled' ? requests[index].value : {};
    const errors = requests.flatMap((result, index) => result.status === 'rejected'
      ? [`${['profile', 'funds', 'positions', 'holdings', 'orders', 'trades'][index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
      : []);
    const profile = value(0)?.data ?? {};
    const fundData = value(1)?.data ?? {};
    const equity = fundData.equity ?? fundData;
    const positions = this.array(value(2)?.data).map((position: any) => ({
      instrumentKey: position.instrument_token ?? position.instrument_key,
      symbol: position.trading_symbol ?? position.tradingsymbol,
      side: Number(position.quantity ?? 0) < 0 ? 'SELL' : 'BUY',
      quantity: Math.abs(Number(position.quantity ?? 0)),
      averagePrice: Number(position.average_price ?? position.buy_price ?? position.sell_price ?? 0),
      currentPrice: Number(position.last_price ?? position.close_price ?? 0),
      pnl: Number(position.pnl ?? position.unrealised ?? 0),
      product: position.product,
    })).filter((position: any) => position.quantity > 0);
    const holdings = this.array(value(3)?.data);
    const orders = this.array(value(4)?.data).map((order: any) => ({
      orderId: order.order_id,
      symbol: order.trading_symbol,
      transactionType: order.transaction_type,
      status: order.status,
      quantity: Number(order.quantity ?? 0),
      averagePrice: Number(order.average_price ?? order.price ?? 0),
    }));
    const trades = this.array(value(5)?.data);
    const ledger = await this.prisma.realTradeOrder.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 200 });
    const todayStart = marketClock().tradingDate;
    const dayStart = new Date(`${todayStart}T00:00:00+05:30`);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    await this.prisma.realTradeQueue.updateMany({ where: { userId, status: { in: ['WAITING_FOR_SLOT', 'PROCESSING'] }, queuedAt: { lt: dayStart } }, data: { status: 'REJECTED', displayStatus: 'Expired', decisionResult: 'SKIPPED', blockingCondition: 'Execution attempt expired at end of trading day', reason: 'Execution attempt expired at end of trading day', resolvedAt: new Date() } });
    const executionDecisions = await this.prisma.realTradeQueue.findMany({ where: { userId, queuedAt: { gte: dayStart, lt: dayEnd } }, orderBy: [{ rankScore: 'desc' }, { aiScore: 'desc' }, { confidence: 'desc' }, { riskReward: 'desc' }, { signalTime: 'desc' }], take: 200 });
    const decisionSignals = await this.prisma.aiSignal.findMany({ where: { id: { in: executionDecisions.map((item) => item.signalId) } }, select: { id: true, status: true, profitPercent: true, runningAt: true, target1At: true, target2At: true, target3At: true, stopLossAt: true, target2: true, target3: true, stopLoss: true } });
    const decisionSignalById = new Map(decisionSignals.map((signal) => [signal.id, signal]));
    const queue = executionDecisions.filter((item) => !['COMPLETED', 'STOPLOSS_CONFIRMED', 'CANCELLED', 'EXPIRED'].includes(decisionSignalById.get(item.signalId)?.status ?? ''));
    const todayLedger = ledger.filter((order) => order.createdAt.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) === todayStart);
    const todayPnl = todayLedger.reduce((sum, order) => sum + order.pnl, 0);
    const runningLedger = ledger.filter((order) => order.status === 'OPEN');
    const completedLedger = todayLedger.filter((order) => order.status === 'COMPLETED');
    const wins = completedLedger.filter((order) => order.pnl > 0), losses = completedLedger.filter((order) => order.pnl < 0);
    const usedCapital = runningLedger.reduce((sum, order) => sum + order.investment, 0);
    const brokerAvailable = Number(equity.available_margin ?? equity.available_cash ?? equity.net ?? 0);
    const capital = this.capitalAllocation(brokerAvailable, usedCapital, settings.maxOpenTrades);
    if (requests[0].status === 'fulfilled' && !settings.connectionTime) await this.prisma.realTradingAccount.update({ where: { userId }, data: { connectionTime: new Date() } });
    this.logger.log(`Real trading dashboard | User: ${userId} | Positions: ${positions.length} | Orders: ${orders.length} | Partial errors: ${errors.length}`);
    return {
      connected: requests[0].status === 'fulfilled',
      broker: 'Upstox',
      profile: { userName: profile.user_name, userId: profile.user_id },
      funds: {
        available: brokerAvailable,
        margin: Number(equity.used_margin ?? equity.utilised_margin ?? 0),
      },
      settings,
      riskManager: { ...automaticRiskProfile(settings.tradingCapital, this.recoveryMode(completedLedger)), recoveryMode: this.recoveryMode(completedLedger) },
      safety: { tokenValid: requests[0].status === 'fulfilled', marketOpen: marketClock().canEnter, autoTradingEnabled: settings.autoTrading, dailyLimitReached: todayPnl <= -settings.maxDailyLoss },
      todayPnl,
      statistics: { availableCapital: capital.remainingBalance, capitalPerTrade: capital.capitalPerTrade, usedCapital, netProfit: todayPnl, todayProfit: wins.reduce((sum, order) => sum + order.pnl, 0), todayLoss: Math.abs(losses.reduce((sum, order) => sum + order.pnl, 0)), runningTrades: runningLedger.length, winningTrades: wins.length, losingTrades: losses.length, completedTrades: completedLedger.length, roi: capital.totalCapital ? todayPnl / capital.totalCapital * 100 : 0, winRate: completedLedger.length ? wins.length / completedLedger.length * 100 : 0 },
      executionStatistics: this.executionStatistics(executionDecisions, decisionSignalById),
      target1Strategy: this.target1StrategyAnalytics(executionDecisions, ledger, decisionSignalById),
      connectionTime: settings.connectionTime,
      positions,
      holdings,
      orders,
      trades,
      ledger,
      queue,
      executionDecisions,
      errors,
    };
  }

  async captureTriggeredSignals(userId: string, signals: any[], at = new Date()) {
    let queuedAny = false;
    for (const signal of signals) {
      if (!['RUNNING', 'TARGET1_HIT'].includes(signal.status) || !signal.runningAt) continue;
      const ageMinutes = Math.max(0, (at.getTime() - new Date(signal.entryTriggeredAt ?? signal.signalTime).getTime()) / 60_000);
      const rankScore = this.rankSignal(signal, ageMinutes);
      try {
        const existing = await this.prisma.realTradeQueue.findUnique({ where: { signalId: signal.id } });
        if (!existing) {
          this.logger.log(JSON.stringify({ event: 'real.signal.running', message: 'Signal changed to RUNNING', userId, signalId: signal.id, symbol: signal.symbol, side: signal.side }));
          await this.prisma.realTradeQueue.create({ data: { userId, signalId: signal.id, instrumentKey: signal.instrumentKey, symbol: signal.symbol, side: signal.side, entryPrice: signal.entryPrice, confidence: signal.confidence, aiScore: signal.aiScore, riskReward: signal.riskReward, signalTime: signal.signalTime, runningTime: signal.runningAt, queuedAt: at, reason: 'Ready for immediate execution', rankScore, volumeRatio: Number(signal.volumeRatio ?? 0), trendStrength: Number(signal.trendStrengthScore ?? 0), vwapAligned: Boolean(signal.vwapAligned), emaAligned: Boolean(signal.emaAligned), momentum: Number(signal.momentumScore ?? 0), atrQuality: Number(signal.atrQuality ?? 0), entryMode: (await this.account(userId)).entryMode, decisionResult: 'PENDING' } });
          queuedAny = true;
          this.logger.log(JSON.stringify({ event: 'real.queue.added', message: 'Added to execution queue', userId, signalId: signal.id, symbol: signal.symbol }));
        } else if (!['EXECUTED', 'PROCESSING'].includes(existing.status)) {
          await this.prisma.realTradeQueue.update({ where: { id: existing.id }, data: { status: 'WAITING_FOR_SLOT', displayStatus: 'Revalidating', decisionResult: 'PENDING', blockingCondition: null, resolvedAt: null, reason: 'Signal improved; returned to execution queue', rankScore, confidence: signal.confidence, aiScore: signal.aiScore, riskReward: signal.riskReward, entryPrice: signal.entryPrice, volumeRatio: Number(signal.volumeRatio ?? 0), trendStrength: Number(signal.trendStrengthScore ?? 0), vwapAligned: Boolean(signal.vwapAligned), emaAligned: Boolean(signal.emaAligned), momentum: Number(signal.momentumScore ?? 0), atrQuality: Number(signal.atrQuality ?? 0) } });
          queuedAny = true;
        } else {
          this.logger.debug(JSON.stringify({ event: 'real.queue.duplicate', message: 'Running signal already exists in execution queue', userId, signalId: signal.id, symbol: signal.symbol, queueStatus: existing.status, reason: existing.reason }));
        }
      } catch (error) {
        this.logger.error(JSON.stringify({ event: 'real.queue.error', message: 'Queue error', userId, signalId: signal.id, symbol: signal.symbol, reason: error instanceof Error ? error.message : String(error) }), error instanceof Error ? error.stack : undefined);
      }
    }
    const drained = await this.drainQueue(userId, at);
    return { changed: queuedAny || drained.changed, executions: drained.executions } satisfies RealTradingChange;
  }

  async processTick(userId: string, instrumentKey: string, price: number, at = new Date()) {
    let recovered: RealTradingChange = { changed: false, executions: [] };
    const reconcileKey = userId;
    if (at.getTime() - (this.lastRunningReconcile.get(reconcileKey) ?? 0) >= 1_000) {
      this.lastRunningReconcile.set(reconcileKey, at.getTime());
      const running = await this.prisma.aiSignal.findMany({ where: { userId, status: { in: ['RUNNING', 'TARGET1_HIT'] }, runningAt: { not: null } }, orderBy: [{ finalTradingScore: 'desc' }, { confidence: 'desc' }], take: 20 });
      if (running.length) {
        this.logger.warn(JSON.stringify({ event: 'real.running.reconcile', message: 'Reconciling RUNNING signals in case the transition listener was not triggered', userId, instrumentKey, count: running.length }));
        recovered = await this.captureTriggeredSignals(userId, running, at);
      }
    }
    const settings = await this.account(userId);
    const target1Captured = await this.captureTarget1(userId, instrumentKey, price, at);
    const orders = await this.prisma.realTradeOrder.findMany({ where: { userId, instrumentKey, status: 'OPEN' } });
    let changed = false;
    for (const order of orders) {
      let remainingQuantity = order.remainingQuantity;
      let realizedPnl = order.realizedPnl;
      const reached = (level: number) => order.side === 'BUY' ? price >= level : price <= level;
      const stopped = order.side === 'BUY' ? price <= order.currentStop : price >= order.currentStop;
      const ist = new Date(at.getTime() + 330 * 60_000);
      const hhmm = `${String(ist.getUTCHours()).padStart(2, '0')}:${String(ist.getUTCMinutes()).padStart(2, '0')}`;
      const exitReason = hhmm >= settings.squareOffTime ? 'MARKET CLOSE' : reached(order.target3) ? 'TARGET 3' : stopped ? (order.currentStop === order.entryPrice ? 'BREAK-EVEN' : 'STOP LOSS') : null;
      const highestPrice = Math.max(order.highestPrice ?? order.entryPrice, price);
      const lowestPrice = Math.min(order.lowestPrice ?? order.entryPrice, price);
      const adversePercent = order.side === 'BUY' ? Math.max(0, (order.entryPrice - lowestPrice) / order.entryPrice * 100) : Math.max(0, (highestPrice - order.entryPrice) / order.entryPrice * 100);
      let pnl = realizedPnl + (order.side === 'BUY' ? price - order.entryPrice : order.entryPrice - price) * remainingQuantity;
      let pnlPercent = order.investment ? pnl / order.investment * 100 : 0;
      this.logger.log(JSON.stringify({ event: 'real.tick', userId, tradeId: order.id, symbol: order.symbol, currentPrice: price, entry: order.entryPrice, target1: order.target1, target2: order.target2, target3: order.target3, stop: order.currentStop, target1Hit: reached(order.target1), target2Hit: reached(order.target2), target3Hit: reached(order.target3), exitTriggered: Boolean(exitReason) }));
      if (exitReason) {
        await this.upstox.exitPosition(userId, order.instrumentKey, 'I');
        await this.prisma.realTradeOrder.update({ where: { id: order.id }, data: { status: 'COMPLETED', remainingQuantity: 0, currentPrice: price, highestPrice, lowestPrice, maxDrawdown: Math.max(order.maxDrawdown, adversePercent), pnl, pnlPercent, exitPrice: price, exitReason, exitTime: at } });
        this.logger.log(JSON.stringify({ event: 'real.trade.completed', userId, tradeId: order.id, exitReason, exitPrice: price, pnl, databaseUpdated: true, capitalReleased: true }));
        changed = true;
      } else {
        const target2 = reached(order.target2);
        const target1 = reached(order.target1);
        let targetProgress = order.targetProgress;
        let target1ExitTime = order.target1ExitTime;
        let target1ExitPrice = order.target1ExitPrice;
        let target2ExitTime = order.target2ExitTime;
        let target2ExitPrice = order.target2ExitPrice;
        if (target1 && targetProgress === 'ENTRY') {
          const quantity = Math.max(0, Math.min(remainingQuantity - 1, Math.max(1, Math.floor(order.quantity * .5))));
          if (quantity) await this.closePartial(userId, order, quantity, 'T1');
          remainingQuantity -= quantity;
          realizedPnl += (order.side === 'BUY' ? price - order.entryPrice : order.entryPrice - price) * quantity;
          targetProgress = 'TARGET1_HIT'; target1ExitTime = at; target1ExitPrice = price; changed = true;
        } else if (target2 && targetProgress === 'TARGET1_HIT') {
          const quantity = Math.max(0, Math.min(remainingQuantity - 1, Math.max(1, Math.floor(order.quantity * .3))));
          if (quantity) await this.closePartial(userId, order, quantity, 'T2');
          remainingQuantity -= quantity;
          realizedPnl += (order.side === 'BUY' ? price - order.entryPrice : order.entryPrice - price) * quantity;
          targetProgress = 'TARGET2_HIT'; target2ExitTime = at; target2ExitPrice = price; changed = true;
        }
        const signal = targetProgress === 'TARGET2_HIT' ? await this.prisma.aiSignal.findUnique({ where: { id: order.signalId }, select: { atr: true, previousCandleLow: true, previousCandleHigh: true } }) : null;
        const atrDistance = Math.max(Number(signal?.atr ?? 0) * 2, Math.abs(order.entryPrice - order.stopLoss) * .25);
        const trailingStop = order.side === 'BUY' ? highestPrice - atrDistance : lowestPrice + atrDistance;
        const protectedStop = target2
          ? (order.side === 'BUY' ? Math.max(order.currentStop, order.entryPrice, trailingStop, Number(signal?.previousCandleLow ?? 0)) : Math.min(order.currentStop, order.entryPrice, trailingStop, Number(signal?.previousCandleHigh ?? Number.POSITIVE_INFINITY)))
          : target1 ? order.entryPrice : order.currentStop;
        pnl = realizedPnl + (order.side === 'BUY' ? price - order.entryPrice : order.entryPrice - price) * remainingQuantity;
        pnlPercent = order.investment ? pnl / order.investment * 100 : 0;
        await this.prisma.realTradeOrder.update({ where: { id: order.id }, data: { currentPrice: price, highestPrice, lowestPrice, maxDrawdown: Math.max(order.maxDrawdown, adversePercent), remainingQuantity, realizedPnl, pnl, pnlPercent, currentStop: protectedStop, targetProgress, target1ExitTime, target1ExitPrice, target2ExitTime, target2ExitPrice } });
      }
    }
    let queued: RealTradingChange = { changed: false, executions: [] };
    if (target1Captured || changed || at.getTime() - (this.lastQueueDrain.get(userId) ?? 0) >= 1_000) {
      const waiting = await this.prisma.realTradeQueue.findFirst({ where: { userId, status: 'WAITING_FOR_SLOT' }, select: { id: true } });
      if (waiting) queued = await this.drainQueue(userId, at);
    }
    return { changed: recovered.changed || target1Captured || changed || queued.changed, executions: [...recovered.executions, ...queued.executions] } satisfies RealTradingChange;
  }

  private async drainQueue(userId: string, at: Date): Promise<RealTradingChange> {
    if (this.locks.has(userId)) {
      this.logger.warn(JSON.stringify({ event: 'real.queue.locked', message: 'Queue execution already in progress', userId }));
      return { changed: false, executions: [] };
    }
    this.locks.add(userId);
    this.lastQueueDrain.set(userId, at.getTime());
    let changed = false;
    const executions: RealOrderExecution[] = [];
    try {
      let settings = await this.account(userId);
      if (!settings.autoTrading) return { changed: await this.markWaitingReason(userId, 'Auto Trading OFF'), executions };
      if (!marketClock(at).canEnter) return { changed: await this.markWaitingReason(userId, 'Market is closed'), executions };
      const closed = await this.prisma.realTradeOrder.findMany({ where: { userId, status: 'COMPLETED', exitTime: { not: null } } });
      const today = marketClock(at).tradingDate;
      const dailyPnl = closed.filter((order) => order.exitTime?.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) === today).reduce((sum, order) => sum + order.pnl, 0);
      if (dailyPnl <= -settings.maxDailyLoss) {
        settings = await this.prisma.realTradingAccount.update({ where: { userId }, data: { autoTrading: false } });
        return { changed: await this.markWaitingReason(userId, 'Daily loss limit reached'), executions };
      }
      const slotLimit = settings.maxOpenTrades === 0 ? Number.MAX_SAFE_INTEGER : settings.maxOpenTrades;
      const candidates = await this.prisma.realTradeQueue.findMany({ where: { userId, status: 'WAITING_FOR_SLOT' }, orderBy: [{ rankScore: 'desc' }, { aiScore: 'desc' }, { confidence: 'desc' }, { riskReward: 'desc' }, { signalTime: 'desc' }], take: 20 });
      for (const [candidateIndex, queued] of candidates.entries()) {
        const validationLog: Array<{ step: string; status: 'PASS' | 'FAIL'; detail: string; checkedAt: string }> = [];
        const validate = (step: string, pass: boolean, detail: string) => {
          validationLog.push({ step, status: pass ? 'PASS' : 'FAIL', detail, checkedAt: at.toISOString() });
          this.logger[pass ? 'log' : 'warn'](JSON.stringify({ event: 'real.validation', userId, signalId: queued.signalId, symbol: queued.symbol, step, result: pass ? 'PASS' : 'FAIL', detail }));
          return pass;
        };
        const reject = async (displayStatus: string, reason: string, permanent = false, brokerResponse?: string) => {
          await this.prisma.realTradeQueue.update({ where: { id: queued.id }, data: {
            status: permanent ? 'REJECTED' : 'WAITING_FOR_SLOT',
            displayStatus,
            reason,
            validationLog: JSON.stringify(validationLog),
            brokerResponse,
            // A deferred candidate still has a concrete decision for this pass.
            // It remains queued and may later transition from SKIPPED to EXECUTED.
            decisionResult: 'SKIPPED',
            blockingCondition: reason,
            resolvedAt: permanent ? at : null,
          } });
          changed = true;
        };
        const signal = await this.prisma.aiSignal.findUnique({ where: { id: queued.signalId }, include: { managementDecision: true, stopLossDecision: true } });
        const running = Boolean(signal && ['RUNNING', 'TARGET1_HIT'].includes(signal.status) && signal.entryTriggeredAt && signal.runningAt);
        if (!validate('Signal status must be Running', running, signal ? `Current status: ${signal.status}` : 'Signal record not found')) {
          await reject('Rejected by AI Filter', signal ? `Signal status is ${signal.status}, expected RUNNING` : 'Signal record not found', !signal || ['COMPLETED', 'STOPLOSS_CONFIRMED', 'CANCELLED', 'EXPIRED'].includes(signal.status));
          continue;
        }
        if (!signal) continue; // The missing-record failure was persisted by reject() above.
        const central = this.engine.decide({ ...signal, signalTime: at }, { now: at, marketOpen: true, availableCapital: Number.MAX_SAFE_INTEGER, tradingCapital: settings.tradingCapital, riskPercent: settings.riskPerTrade, openTrades: 0, maxOpenTrades: 0, dailyLoss: Math.max(0, -dailyPnl), maximumDailyLoss: settings.maxDailyLoss, minimumConfidence: settings.minimumConfidence, minimumRiskReward: 2.5, allowMedium: settings.aggressiveMode });
        validate('Central execution decision', central.action === 'EXECUTE', `${central.action}: ${central.reason}; priority ${central.priority}`);
        if (central.action !== 'EXECUTE') { await reject(central.action === 'SKIP' ? 'Blocked' : 'Revalidating', central.reason, false); continue; }
        const modeDecision = this.entryModeEligible(queued, signal);
        if (!validate(`Entry mode: ${queued.entryMode}`, modeDecision.pass, modeDecision.detail)) {
          await reject('Waiting', modeDecision.detail, false);
          continue;
        }
        if (!validate('Live price valid', Number.isFinite(signal.currentPrice) && signal.currentPrice > 0, `Live price ₹${Number(signal.currentPrice).toFixed(2)}`)) {
          await reject('Invalid Live Price', 'Live market price is unavailable', queued.target1Reached);
          continue;
        }
        const moveFromEntry = signal.side === 'BUY' ? signal.currentPrice - signal.entryPrice : signal.entryPrice - signal.currentPrice;
        const opportunityWindow = Math.max(Math.abs(signal.target1 - signal.entryPrice) * .25, signal.entryPrice * .003);
        if (!validate('Entry remains inside opportunity window', moveFromEntry <= opportunityWindow, `Move ₹${moveFromEntry.toFixed(2)} ≤ ₹${opportunityWindow.toFixed(2)}`)) {
          await reject('Entry Invalid', `Price moved too far from entry; waiting for a valid pullback`);
          continue;
        }
        if (queued.entryMode === 'TARGET1_CONFIRMATION') {
          const buy = signal.side === 'BUY';
          const liveChecks = [
            ['Volume increasing', queued.target1VolumeIncreasing === true, `T1 volume ${Number(queued.target1Volume ?? 0).toFixed(0)}`],
            ['EMA trend confirmation', buy ? Number(queued.target1Ema20) > Number(queued.target1Ema50) : Number(queued.target1Ema20) < Number(queued.target1Ema50), `EMA20 ${Number(queued.target1Ema20).toFixed(2)} / EMA50 ${Number(queued.target1Ema50).toFixed(2)}`],
            ['VWAP confirmation', buy ? Number(queued.target1Price) > Number(queued.target1Vwap) : Number(queued.target1Price) < Number(queued.target1Vwap), `Price ${Number(queued.target1Price).toFixed(2)} / VWAP ${Number(queued.target1Vwap).toFixed(2)}`],
            ['MACD confirmation', buy ? Number(queued.target1Macd) > 0 : Number(queued.target1Macd) < 0, `MACD histogram ${Number(queued.target1Macd).toFixed(4)}`],
          ] as const;
          const failed = liveChecks.find(([step, pass, detail]) => !validate(step, pass, detail));
          if (failed) {
            await reject('Rejected after Target 1', `${failed[0]} failed at Target 1`, true);
            continue;
          }
        }
        const duplicatePosition = await this.prisma.realTradeOrder.findFirst({ where: { userId, instrumentKey: signal.instrumentKey, status: { in: ['SUBMITTED', 'OPEN'] } }, select: { id: true } });
        if (!validate('No duplicate position', !duplicatePosition, duplicatePosition ? `Existing position ${duplicatePosition.id}` : 'No open position for instrument')) {
          await reject('Duplicate Position', `Existing open position for ${signal.symbol}`, true);
          continue;
        }
        const existingOpenOrder = await this.prisma.realTradeOrder.findUnique({ where: { signalId: signal.id }, select: { id: true, status: true } });
        if (!validate('No existing open order', !existingOpenOrder, existingOpenOrder ? `Order ${existingOpenOrder.id}: ${existingOpenOrder.status}` : 'No order exists for signal')) {
          await reject('Duplicate Order', `An order already exists for signal ${signal.id}`, true);
          continue;
        }
        let funds: any;
        try {
          funds = await this.upstox.funds(userId);
        } catch (error) {
          const detail = this.fullBrokerError(error);
          validate('Capital available', false, detail);
          await reject('Broker Error', detail, false, detail);
          continue;
        }
        const equity = funds?.data?.equity ?? funds?.data ?? {};
        const margin = Number(equity.available_margin ?? equity.available_cash ?? equity.net ?? 0);
        const allocated = await this.prisma.realTradeOrder.aggregate({ where: { userId, status: { in: ['SUBMITTED', 'OPEN'] } }, _sum: { allocatedCapital: true } });
        const configuredRemaining = Math.max(0, settings.tradingCapital - Number(allocated._sum.allocatedCapital ?? 0));
        const allocationWeight = settings.maxOpenTrades === 1 ? 1 : [0.4, 0.3, 0.2, 0.1, 0.1][Math.min(candidateIndex, 4)];
        const allocation = Math.min(settings.tradingCapital * allocationWeight, configuredRemaining, margin);
        let sizing;
        try { sizing = await this.intraday.calculateIntradayQuantity({ userId, capital: allocation, symbol: signal.symbol, instrumentKey: signal.instrumentKey, entryPrice: signal.currentPrice, stopLoss: signal.stopLoss, target1: signal.target1, side: signal.side as 'BUY'|'SELL', riskPerTrade: settings.riskPerTrade, maxOpenTrades: settings.maxOpenTrades }); }
        catch (error) { await reject('Revalidating', `Intraday margin or charge calculation unavailable: ${this.fullBrokerError(error)}`, false); continue; }
        const quantity = sizing.finalQuantity;
        if (!sizing.viable) { await reject('Charges Failed', sizing.reason, false); continue; }
        if (!sizing.chargeBreakdown) { await reject('Charges Failed', 'Broker charge breakdown is unavailable', false); continue; }
        if (!validate('Capital available', quantity > 0 && allocation > 0, `Available ₹${margin.toFixed(2)}; allocation ₹${allocation.toFixed(2)}; price ₹${signal.currentPrice.toFixed(2)}`)) {
          await reject('Capital Error', `Insufficient capital: available ₹${margin.toFixed(2)}, required at least ₹${signal.currentPrice.toFixed(2)}`, false);
          continue;
        }
        const openTrades = await this.prisma.realTradeOrder.count({ where: { userId, status: { in: ['SUBMITTED', 'OPEN'] } } });
        if (!validate('Maximum Open Trades not exceeded', openTrades < slotLimit, settings.maxOpenTrades === 0 ? `${openTrades} open; Unlimited enabled` : `${openTrades}/${settings.maxOpenTrades} open`)) {
          await reject('Waiting', `Maximum Open Trades reached (${openTrades}/${settings.maxOpenTrades})`, false);
          continue;
        }
        let profile: any;
        try {
          profile = await this.upstox.profile(userId);
        } catch (error) {
          const detail = this.fullBrokerError(error);
          validate('Broker connection valid', false, detail);
          await reject('Broker Error', detail, false, detail);
          continue;
        }
        if (!validate('Broker connection valid', Boolean(profile?.data ?? profile), 'Upstox profile request succeeded')) {
          await reject('Broker Error', 'Upstox broker connection did not return a valid profile');
          continue;
        }
        if (!validate('Access token valid', true, 'Upstox authenticated profile request succeeded')) {
          await reject('Broker Error', 'Upstox access token is invalid');
          continue;
        }
        const directionEnabled = (signal.side === 'BUY' && settings.buySignals) || (signal.side === 'SELL' && settings.sellSignals);
        const watchMode = /WATCH/i.test(signal.managementDecision?.status ?? '') || /WATCH/i.test(signal.managementDecision?.reentryStatus ?? '') || signal.stopLossDecision?.status === 'WAIT';
        const progressedPastEntry = Boolean(signal.stopLossAt || signal.completedAt || (signal.target2At && queued.entryMode !== 'TARGET2_PULLBACK'));
        if (!directionEnabled || watchMode || progressedPastEntry) {
          const reason = !directionEnabled ? `${signal.side} Signals are OFF` : watchMode ? 'AI management is in WATCH/WAIT mode' : 'Signal progressed beyond broker entry eligibility';
          validate('AI execution filter', false, reason);
          await reject('Rejected by AI Filter', reason);
          continue;
        }
        this.logger.log(JSON.stringify({ event: 'real.risk.passed', message: 'Risk checks passed', userId, signalId: queued.signalId, symbol: queued.symbol, availableCapital: margin, allocatedCapital: allocation, quantity, openTrades, slotLimit: settings.maxOpenTrades === 0 ? 'Unlimited' : settings.maxOpenTrades }));
        const claimed = await this.prisma.realTradeQueue.updateMany({
          where: { id: queued.id, status: 'WAITING_FOR_SLOT' },
          data: { status: 'PROCESSING', displayStatus: 'Waiting', reason: 'Submitting order to Upstox', validationLog: JSON.stringify(validationLog), brokerResponse: null },
        });
        if (claimed.count !== 1) {
          this.logger.warn(JSON.stringify({ event: 'real.queue.claim.skipped', userId, signalId: queued.signalId, symbol: queued.symbol, reason: 'Queue item was claimed or resolved by another execution worker' }));
          continue;
        }
        try {
          this.logger.log(JSON.stringify({ event: 'real.broker.sending', message: 'Sending Upstox order', userId, signalId: signal.id, symbol: signal.symbol, side: signal.side, quantity }));
          const placed: any = await this.upstox.placeIntradayOrder(userId, { instrumentKey: signal.instrumentKey, side: signal.side as 'BUY' | 'SELL', quantity, tag: `QP-${signal.id}` });
          this.logger.log(JSON.stringify({ event: 'real.broker.response', message: 'Broker response', userId, signalId: signal.id, symbol: signal.symbol, response: placed }));
          const brokerResponse = JSON.stringify(placed);
          const orderId = String(placed?.data?.order_id ?? '');
          if (!orderId) throw new Error('Upstox did not return an order ID');
          const confirmations: any[] = await this.upstox.waitForOrders(userId, [orderId]);
          const confirmation = confirmations[0]?.data ?? {};
          const orderStatus = String(confirmation.status ?? '').toUpperCase();
          if (!['COMPLETE', 'OPEN'].includes(orderStatus)) throw new Error(`Upstox order was not accepted: ${orderStatus || 'UNKNOWN'}`);
          if (String(confirmation.product ?? '').toUpperCase() !== 'I') throw new Error(`PRODUCT MISMATCH: broker confirmed ${confirmation.product || 'UNKNOWN'}, expected I`);
          const filledQuantity = Number(confirmation.filled_quantity ?? confirmation.quantity ?? 0);
          if (!(filledQuantity > 0) || filledQuantity > quantity) throw new Error(`Broker quantity mismatch: requested ${quantity}, filled ${filledQuantity}`);
          const confirmedEntryPrice = Number(confirmation.average_price ?? confirmation.price);
          const entryPrice = Number.isFinite(confirmedEntryPrice) && confirmedEntryPrice > 0 ? confirmedEntryPrice : signal.currentPrice;
          let qualityComponents: Record<string, number> = {};
          try { qualityComponents = JSON.parse(signal.qualityComponents || '{}'); } catch { qualityComponents = {}; }
          await this.prisma.$transaction([
            this.prisma.realTradeOrder.create({ data: { userId, signalId: signal.id, brokerOrderId: orderId, instrumentKey: signal.instrumentKey, symbol: signal.symbol, side: signal.side, aiConfidence: signal.confidence, aiAnalysis: `${signal.strategy} ${signal.timeframe} · AI score ${signal.aiScore} · Quality ${signal.tradeQualityScore.toFixed(1)} · Risk reward 1:${signal.riskReward.toFixed(2)}`, tradeQualityScore: signal.tradeQualityScore, qualityRating: signal.tradeQualityRating, momentumScore: signal.momentumScore, trendStrength: signal.trendStrengthScore, volumeScore: Number(qualityComponents.volumeStrength ?? 0), riskScore: Number(qualityComponents.riskReward ?? 0), targetProbability: signal.target3Probability, expectedProfit: sizing.expectedNetProfit, expectedHoldingMinutes: signal.expectedHoldingMinutes, entryDelayMs: Math.max(0, at.getTime() - signal.signalTime.getTime()), executionQuality: signal.idealEntryReady ? 'IDEAL' : settings.aggressiveMode ? 'AGGRESSIVE' : 'QUALIFIED', marketCondition: signal.marketTrendAligned ? 'ALIGNED' : 'UNALIGNED', sectorStrength: signal.sectorStrength, niftyTrend: qualityComponents.niftyTrend >= 80 ? 'ALIGNED' : 'WEAK', bankNiftyTrend: qualityComponents.bankNiftyTrend >= 80 ? 'ALIGNED' : 'WEAK', brokerage: sizing.chargeBreakdown.entry.brokerage + sizing.chargeBreakdown.exit.brokerage, taxes: sizing.estimatedCharges - sizing.chargeBreakdown.entry.brokerage - sizing.chargeBreakdown.exit.brokerage, status: 'OPEN', entryPrice, currentPrice: entryPrice, quantity, remainingQuantity: quantity, allocatedCapital: sizing.requiredIntradayMargin, investment: entryPrice * quantity, target1: signal.target1, target2: signal.target2, target3: signal.target3, stopLoss: signal.stopLoss, currentStop: signal.stopLoss, executionTime: at } }),
            this.prisma.realTradeQueue.update({ where: { id: queued.id }, data: { status: 'EXECUTED', displayStatus: 'Executed', decisionResult: 'EXECUTED', blockingCondition: null, reason: `Upstox order ${orderStatus}`, validationLog: JSON.stringify([...validationLog, { step: 'Submit order to Upstox', status: 'PASS', detail: `Broker order ${orderId} accepted with status ${orderStatus}`, checkedAt: at.toISOString() }]), brokerResponse, resolvedAt: at } }),
          ]);
          executions.push({ brokerOrderId: orderId, stockName: signal.stockName || signal.symbol, symbol: signal.symbol, side: signal.side as 'BUY' | 'SELL', quantity, entryPrice, orderStatus: orderStatus as 'COMPLETE' | 'OPEN' });
          this.logger.log(JSON.stringify({ event: 'real.position.created', message: 'Live Position created', userId, signalId: signal.id, symbol: signal.symbol, brokerOrderId: orderId, quantity, entryPrice, orderStatus }));
          changed = true;
        } catch (error) {
          const detail = this.fullBrokerError(error);
          const reason = `Broker API error: ${detail}`;
          validationLog.push({ step: 'Submit order to Upstox', status: 'FAIL', detail, checkedAt: at.toISOString() });
          this.logger.error(JSON.stringify({ event: 'real.execution.failed', message: 'Real order execution failed', userId, signalId: queued.signalId, symbol: queued.symbol, reason }), error instanceof Error ? error.stack : undefined);
          await this.prisma.realTradeQueue.updateMany({ where: { id: queued.id, status: 'PROCESSING' }, data: { status: 'REJECTED', displayStatus: 'Broker Error', decisionResult: 'FAILED', blockingCondition: reason, validationLog: JSON.stringify(validationLog), brokerResponse: detail, resolvedAt: at, reason } });
          changed = true;
        }
      }
      return { changed, executions };
    } finally { this.locks.delete(userId); }
  }

  private async captureTarget1(userId: string, instrumentKey: string, price: number, at: Date) {
    const candidates = await this.prisma.realTradeQueue.findMany({
      where: { userId, instrumentKey, status: 'WAITING_FOR_SLOT', entryMode: 'TARGET1_CONFIRMATION', target1Reached: false },
    });
    let changed = false;
    for (const queued of candidates) {
      const signal = await this.prisma.aiSignal.findUnique({ where: { id: queued.signalId } });
      if (!signal || !['RUNNING', 'TARGET1_HIT'].includes(signal.status)) continue;
      const reached = signal.side === 'BUY' ? price >= signal.target1 : price <= signal.target1;
      if (!reached) continue;
      try {
        const payload: any = await this.upstox.intraday(userId, instrumentKey, 'minutes', 5);
        const rows: unknown[][] = payload?.data?.candles ?? payload?.candles ?? [];
        const candles: Candle[] = rows.map((row) => ({ time: String(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) }))
          .filter((candle) => [candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite))
          .sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime());
        if (candles.length < 50) throw new Error(`Only ${candles.length} candles available for live confirmation`);
        const values: any = this.indicators.calculate(candles);
        const latest = candles.at(-1)!;
        const previous = candles.at(-2);
        const snapshot = {
          target1Reached: true,
          target1Time: at,
          target1Price: price,
          target1Momentum: Number(values.momentum ?? values.roc ?? signal.momentumScore),
          target1Volume: latest.volume,
          target1VolumeIncreasing: Boolean(previous && latest.volume > previous.volume),
          target1Vwap: Number(values.vwap),
          target1Ema20: Number(values.ema20),
          target1Ema50: Number(values.ema50),
          target1Rsi: Number(values.rsi),
          target1Macd: Number(values.macd?.histogram),
          target1Atr: Number(values.atr),
          displayStatus: 'Target 1 reached',
          reason: 'Target 1 reached; evaluating live confirmation',
        };
        await this.prisma.realTradeQueue.updateMany({ where: { id: queued.id, target1Reached: false }, data: snapshot });
        this.logger.log(JSON.stringify({ event: 'real.target1.captured', userId, signalId: signal.id, symbol: signal.symbol, at, price, indicators: snapshot }));
        changed = true;
      } catch (error) {
        const reason = `Unable to calculate live Target 1 indicators: ${error instanceof Error ? error.message : String(error)}`;
        await this.prisma.realTradeQueue.update({ where: { id: queued.id }, data: { status: 'REJECTED', displayStatus: 'Rejected after Target 1', target1Reached: true, target1Time: at, target1Price: price, decisionResult: 'SKIPPED', blockingCondition: reason, reason, resolvedAt: at } });
        changed = true;
      }
    }
    return changed;
  }

  private async closePartial(userId: string, order: { id: string; instrumentKey: string; side: string }, quantity: number, target: 'T1' | 'T2') {
    const side = order.side === 'BUY' ? 'SELL' : 'BUY';
    const placed: any = await this.upstox.placeIntradayOrder(userId, { instrumentKey: order.instrumentKey, side, quantity, tag: `QP-${target}-${order.id}` });
    const orderId = String(placed?.data?.order_id ?? '');
    if (!orderId) throw new Error(`Upstox did not return an order ID for ${target} partial exit`);
    await this.upstox.waitForOrders(userId, [orderId]);
    this.logger.log(JSON.stringify({ event: 'real.partial.exit', userId, tradeId: order.id, target, quantity, brokerOrderId: orderId }));
  }

  async manualExit(userId: string, instrumentKey: string, product: string) {
    if (!instrumentKey || !product) throw new Error('Instrument key and product are required for a broker exit');
    this.logger.warn(`Real position manual exit requested | User: ${userId} | Instrument: ${instrumentKey} | Product: ${product}`);
    return this.upstox.exitPosition(userId, instrumentKey, product);
  }

  async manualExitOrder(userId: string, orderId: string) {
    const order = await this.prisma.realTradeOrder.findFirst({ where: { id: orderId, userId, status: 'OPEN' } });
    if (!order) throw new Error('Open real-trading order not found');
    await this.upstox.exitPosition(userId, order.instrumentKey, 'I');
    const pnl = (order.side === 'BUY' ? order.currentPrice - order.entryPrice : order.entryPrice - order.currentPrice) * order.quantity;
    await this.prisma.realTradeOrder.update({ where: { id: order.id }, data: { status: 'COMPLETED', exitPrice: order.currentPrice, exitReason: 'MANUAL EXIT', exitTime: new Date(), pnl, pnlPercent: order.investment ? pnl / order.investment * 100 : 0 } });
    await this.drainQueue(userId, new Date());
    return this.dashboard(userId);
  }

  async disconnect(userId: string) {
    await this.prisma.realTradingAccount.update({ where: { userId }, data: { autoTrading: false, connectionTime: null } });
    await this.prisma.token.deleteMany({ where: { userId } });
    return { disconnected: true };
  }

  private array(value: unknown): any[] { return Array.isArray(value) ? value : []; }

  private fullBrokerError(error: unknown) {
    const response = error && typeof error === 'object' && 'response' in error ? (error as any).response : undefined;
    const nestResponse = error && typeof error === 'object' && 'getResponse' in error && typeof (error as any).getResponse === 'function' ? (error as any).getResponse() : undefined;
    const nestStatus = error && typeof error === 'object' && 'getStatus' in error && typeof (error as any).getStatus === 'function' ? (error as any).getStatus() : undefined;
    const payload = {
      message: error instanceof Error ? error.message : String(error),
      httpStatus: typeof response?.status === 'number' ? response.status : nestStatus ?? null,
      statusText: response?.statusText ?? null,
      apiResponse: response?.data ?? nestResponse ?? (response && typeof response === 'object' ? response : null),
    };
    try { return JSON.stringify(payload); } catch { return payload.message; }
  }

  private async markWaitingReason(userId: string, reason: string) {
    const waiting = await this.prisma.realTradeQueue.findMany({ where: { userId, status: 'WAITING_FOR_SLOT' }, select: { id: true, signalId: true, symbol: true, reason: true } });
    const stale = waiting.filter((item) => item.reason !== reason);
    if (stale.length) {
      await this.prisma.realTradeQueue.updateMany({ where: { id: { in: stale.map((item) => item.id) } }, data: { displayStatus: 'Waiting', decisionResult: 'SKIPPED', blockingCondition: reason, reason, validationLog: JSON.stringify([{ step: 'Execution precondition', status: 'FAIL', detail: reason, checkedAt: new Date().toISOString() }]) } });
    }
    for (const item of waiting) this.logger.warn(JSON.stringify({ event: 'real.risk.failed', message: 'Risk checks failed', userId, signalId: item.signalId, symbol: item.symbol, reason }));
    return stale.length > 0;
  }

  private rankSignal(signal: any, ageMinutes: number) {
    const qualityScore = Number(signal.tradeQualityScore ?? 0);
    const score = qualityScore > 0 ? qualityScore : executionScore(signal, Number(signal.aiScore ?? signal.finalTradingScore ?? 0));
    // Freshness only breaks near-ties; it never overrules signal quality.
    return Number((score - Math.min(5, ageMinutes * .05)).toFixed(4));
  }

  private recoveryMode(completed: Array<{ pnl: number }>) {
    let winsAfterLossStreak = 0;
    let index = 0;
    while (index < completed.length && completed[index].pnl > 0) { winsAfterLossStreak++; index++; }
    if (winsAfterLossStreak >= 2) return false;
    let losses = 0;
    while (index < completed.length && completed[index].pnl < 0) { losses++; index++; }
    return losses >= 3;
  }

  private entryModeEligible(queued: any, signal: any) {
    const mode = queued.entryMode;
    const buy = signal.side === 'BUY';
    const price = Number(signal.currentPrice), entry = Number(signal.entryPrice), target1 = Number(signal.target1);
    const entryCrossed = buy ? price >= entry : price <= entry;
    if (mode === 'IMMEDIATE_ENTRY') return { pass: true, detail: 'RUNNING signal is eligible for immediate entry' };
    if (mode === 'ENTRY_BREAKOUT') return { pass: entryCrossed, detail: `${signal.side} live ₹${price.toFixed(2)} versus breakout ₹${entry.toFixed(2)}` };
    if (mode === 'RUNNING_CONFIRMATION') return { pass: Boolean(signal.runningAt), detail: `Running since ${signal.runningAt?.toISOString?.() ?? 'unknown'}` };
    if (mode === 'TARGET1_CONFIRMATION') return { pass: queued.target1Reached === true, detail: queued.target1Reached ? `Target 1 captured live at ₹${Number(queued.target1Price).toFixed(2)}` : `Waiting for Target 1 ₹${target1.toFixed(2)}` };
    if (mode === 'TARGET2_PULLBACK') {
      const tolerance = Number(signal.target2) * .003;
      return { pass: Boolean(signal.target2At) && Math.abs(price - Number(signal.target2)) <= tolerance, detail: `Target 2 pullback: hit=${Boolean(signal.target2At)}, live ₹${price.toFixed(2)}` };
    }
    const continuation = Boolean(signal.target1At) && (buy ? price > target1 : price < target1);
    return { pass: continuation, detail: `Trend continuation beyond Target 1: ${continuation ? 'confirmed' : 'waiting'}` };
  }

  private executionStatistics(decisions: any[], signalById: Map<string, any>) {
    const executed = decisions.filter((item) => item.decisionResult === 'EXECUTED');
    const skipped = decisions.filter((item) => item.decisionResult === 'SKIPPED');
    const failed = decisions.filter((item) => item.decisionResult === 'FAILED');
    const passed = decisions.filter((item) => {
      if (item.decisionResult === 'EXECUTED') return true;
      if (item.decisionResult !== 'FAILED') return false;
      try {
        const checks = JSON.parse(item.validationLog || '[]') as Array<{ step: string; status: string }>;
        return !checks.some((check) => check.status === 'FAIL' && check.step !== 'Submit order to Upstox');
      } catch { return false; }
    });
    const skipReasonDistribution = Object.entries(skipped.reduce((counts: Record<string, number>, item) => { const key = item.blockingCondition || item.reason || 'Unknown'; counts[key] = (counts[key] ?? 0) + 1; return counts; }, {})).map(([reason, count]) => ({ reason, count }));
    const missedRows = skipped.map((item) => ({ item, signal: signalById.get(item.signalId) })).filter(({ signal }) => Boolean(signal?.target3At));
    const missed = missedRows.sort((a, b) => Number(b.signal.profitPercent) - Number(a.signal.profitPercent))[0];
    const profitableExecutions = executed.filter((item) => Number(signalById.get(item.signalId)?.profitPercent ?? 0) > 0).length;
    const delays = executed.map((item) => item.resolvedAt ? Math.max(0, new Date(item.resolvedAt).getTime() - new Date(item.signalTime).getTime()) : 0);
    const total = Math.max(1, decisions.length);
    return { signalsFound: decisions.length, signalsPassedFilters: passed.length, signalsExecuted: executed.length, signalsSkipped: skipped.length, signalsFailed: failed.length, skipReasonDistribution, bestMissedOpportunity: missed ? { symbol: missed.item.symbol, profitPercent: missed.signal.profitPercent, reason: missed.item.blockingCondition, status: 'MISSED OPPORTUNITY' } : null, executionAccuracy: executed.length ? profitableExecutions / executed.length * 100 : 0, executionSuccessPercent: passed.length ? executed.length / passed.length * 100 : 0, averageExecutionDelayMs: delays.length ? delays.reduce((sum, delay) => sum + delay, 0) / delays.length : 0, missedOpportunityPercent: missedRows.length / total * 100, skippedPercent: skipped.length / total * 100, expiredPercent: decisions.filter((item) => item.displayStatus === 'Expired').length / total * 100, queueDepth: decisions.filter((item) => item.status === 'WAITING_FOR_SLOT').length };
  }

  private target1StrategyAnalytics(decisions: any[], orders: any[], signalById: Map<string, any>) {
    const rows = decisions.filter((item) => item.entryMode === 'TARGET1_CONFIRMATION');
    const orderBySignal = new Map(orders.map((order) => [order.signalId, order]));
    const target1Hits = rows.filter((item) => item.target1Reached);
    const executed = rows.filter((item) => item.decisionResult === 'EXECUTED');
    const executedOrders = executed.map((item) => orderBySignal.get(item.signalId)).filter(Boolean) as any[];
    const completed = executedOrders.filter((order) => order.status === 'COMPLETED');
    const wins = completed.filter((order) => order.pnl > 0);
    const holdingMinutes = completed.map((order) => order.executionTime && order.exitTime ? (order.exitTime.getTime() - order.executionTime.getTime()) / 60_000 : 0);
    return {
      statistics: {
        todayTarget1Hits: target1Hits.length,
        executedAfterT1: executed.length,
        reachedTarget2: executedOrders.filter((order) => order.target2ExitTime || ['TARGET2_HIT', 'TARGET3_HIT'].includes(order.targetProgress)).length,
        reachedTarget3: completed.filter((order) => order.exitReason === 'TARGET 3').length,
        stoppedOut: completed.filter((order) => order.exitReason === 'STOP LOSS').length,
        averageProfit: completed.length ? completed.reduce((sum, order) => sum + order.pnl, 0) / completed.length : 0,
        averageHoldingTime: holdingMinutes.length ? holdingMinutes.reduce((sum, value) => sum + value, 0) / holdingMinutes.length : 0,
        winRate: completed.length ? wins.length / completed.length * 100 : 0,
        executionAccuracy: target1Hits.length ? executed.length / target1Hits.length * 100 : 0,
      },
      decisionLog: rows.map((item) => {
        const signal = signalById.get(item.signalId);
        const order = orderBySignal.get(item.signalId) as any;
        return {
          stock: item.symbol,
          signalTime: item.signalTime,
          entryTrigger: item.entryPrice,
          runningTime: item.runningTime ?? signal?.runningAt,
          target1Time: item.target1Time,
          executedTime: order?.executionTime ?? null,
          entryPrice: order?.entryPrice ?? null,
          exitPrice: order?.exitPrice ?? null,
          target2: signal?.target2 ?? order?.target2,
          target3: signal?.target3 ?? order?.target3,
          stopLoss: signal?.stopLoss ?? order?.stopLoss,
          exitReason: order?.exitReason ?? null,
          profit: order?.pnl ?? null,
          rejectedReason: item.decisionResult === 'SKIPPED' || item.decisionResult === 'FAILED' ? item.blockingCondition ?? item.reason : null,
        };
      }),
    };
  }

  private capitalAllocation(availableBalance: number, usedCapital: number, maxOpenTrades: number) {
    const available = Math.max(0, Number.isFinite(availableBalance) ? availableBalance : 0);
    const used = Math.max(0, Number.isFinite(usedCapital) ? usedCapital : 0);
    const totalCapital = available + used;
    const capitalPerTrade = maxOpenTrades > 0 ? totalCapital / maxOpenTrades : available;
    return {
      totalCapital,
      capitalPerTrade: Math.max(0, capitalPerTrade),
      remainingBalance: available,
    };
  }
}
