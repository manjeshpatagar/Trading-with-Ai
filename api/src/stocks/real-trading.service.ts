import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { marketClock } from './market-clock';
import { UpstoxService } from './upstox.service';
import { Candle, IndicatorService } from './indicator.service';

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
  constructor(private readonly upstox: UpstoxService, private readonly prisma: PrismaService, private readonly indicators: IndicatorService) {}

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
      maxOpenTrades: Math.round(number(input.maxOpenTrades, 0, 10, current.maxOpenTrades)),
      riskPerTrade: number(input.riskPerTrade, .1, 10, current.riskPerTrade),
      minimumConfidence: number(input.minimumConfidence, 0, 100, current.minimumConfidence),
      maxDailyLoss: number(input.maxDailyLoss, 100, 10_000_000, current.maxDailyLoss),
      maxDailyProfit: number(input.maxDailyProfit, 100, 10_000_000, current.maxDailyProfit),
      autoTrading: typeof input.autoTrading === 'boolean' ? input.autoTrading : current.autoTrading,
      buySignals: typeof input.buySignals === 'boolean' ? input.buySignals : current.buySignals,
      sellSignals: typeof input.sellSignals === 'boolean' ? input.sellSignals : current.sellSignals,
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
      safety: { tokenValid: requests[0].status === 'fulfilled', marketOpen: marketClock().canEnter, autoTradingEnabled: settings.autoTrading, dailyLimitReached: todayPnl <= -settings.maxDailyLoss || todayPnl >= settings.maxDailyProfit },
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
      if (signal.status !== 'RUNNING' || !signal.runningAt) continue;
      this.lastRunningReconcile.set(`${userId}:${signal.instrumentKey}`, at.getTime());
      try {
        const existing = await this.prisma.realTradeQueue.findUnique({ where: { signalId: signal.id } });
        if (!existing) {
          this.logger.log(JSON.stringify({ event: 'real.signal.running', message: 'Signal changed to RUNNING', userId, signalId: signal.id, symbol: signal.symbol, side: signal.side }));
          const ageMinutes = Math.max(0, (at.getTime() - new Date(signal.entryTriggeredAt ?? signal.signalTime).getTime()) / 60_000);
          const rankScore = this.rankSignal(signal, ageMinutes);
          await this.prisma.realTradeQueue.create({ data: { userId, signalId: signal.id, instrumentKey: signal.instrumentKey, symbol: signal.symbol, side: signal.side, entryPrice: signal.entryPrice, confidence: signal.confidence, aiScore: signal.aiScore, riskReward: signal.riskReward, signalTime: signal.signalTime, runningTime: signal.runningAt, queuedAt: at, reason: 'Waiting for execution decision', rankScore, volumeRatio: Number(signal.volumeRatio ?? 0), trendStrength: Number(signal.trendStrengthScore ?? 0), vwapAligned: Boolean(signal.vwapAligned), emaAligned: Boolean(signal.emaAligned), momentum: Number(signal.momentumScore ?? 0), atrQuality: Number(signal.atrQuality ?? 0), entryMode: (await this.account(userId)).entryMode, decisionResult: 'PENDING' } });
          queuedAny = true;
          this.logger.log(JSON.stringify({ event: 'real.queue.added', message: 'Added to execution queue', userId, signalId: signal.id, symbol: signal.symbol }));
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
    const reconcileKey = `${userId}:${instrumentKey}`;
    if (at.getTime() - (this.lastRunningReconcile.get(reconcileKey) ?? 0) >= 5_000) {
      this.lastRunningReconcile.set(reconcileKey, at.getTime());
      const running = await this.prisma.aiSignal.findMany({ where: { userId, instrumentKey, status: 'RUNNING', runningAt: { not: null } } });
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
      const openPnl = (order.side === 'BUY' ? price - order.entryPrice : order.entryPrice - price) * order.remainingQuantity;
      const pnl = order.realizedPnl + openPnl;
      const pnlPercent = order.investment ? pnl / order.investment * 100 : 0;
      const reached = (level: number) => order.side === 'BUY' ? price >= level : price <= level;
      const stopped = order.side === 'BUY' ? price <= order.currentStop : price >= order.currentStop;
      const ist = new Date(at.getTime() + 330 * 60_000);
      const hhmm = `${String(ist.getUTCHours()).padStart(2, '0')}:${String(ist.getUTCMinutes()).padStart(2, '0')}`;
      const exitReason = hhmm >= settings.squareOffTime ? 'MARKET CLOSE' : reached(order.target3) ? 'TARGET 3' : stopped ? (order.currentStop === order.entryPrice ? 'BREAK-EVEN' : 'STOP LOSS') : null;
      if (exitReason) {
        await this.upstox.exitPosition(userId, order.instrumentKey, 'I');
        await this.prisma.realTradeOrder.update({ where: { id: order.id }, data: { status: 'COMPLETED', remainingQuantity: 0, currentPrice: price, pnl, pnlPercent, exitPrice: price, exitReason, exitTime: at } });
        changed = true;
      } else {
        const target2 = reached(order.target2);
        const target1 = reached(order.target1);
        if (target2 && !order.target2ExitTime && order.quantity > 1) {
          const exitQuantity = Math.floor(order.quantity * .5);
          const partialQuantity = Math.min(exitQuantity, order.remainingQuantity);
          await this.submitPartialExit(userId, order, partialQuantity);
          const partialPnl = (order.side === 'BUY' ? price - order.entryPrice : order.entryPrice - price) * partialQuantity;
          await this.prisma.realTradeOrder.update({ where: { id: order.id }, data: { currentPrice: price, remainingQuantity: order.remainingQuantity - partialQuantity, realizedPnl: order.realizedPnl + partialPnl, pnl, pnlPercent, targetProgress: 'TARGET2_HIT', target2ExitTime: at, target2ExitPrice: price, currentStop: order.entryPrice } });
        } else {
          await this.prisma.realTradeOrder.update({ where: { id: order.id }, data: { currentPrice: price, pnl, pnlPercent, targetProgress: target1 ? 'TARGET1_HIT' : order.targetProgress } });
        }
      }
    }
    let queued: RealTradingChange = { changed: false, executions: [] };
    if (target1Captured || changed || at.getTime() - (this.lastQueueDrain.get(userId) ?? 0) >= 2_000) {
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
      if (dailyPnl <= -settings.maxDailyLoss || dailyPnl >= settings.maxDailyProfit) {
        settings = await this.prisma.realTradingAccount.update({ where: { userId }, data: { autoTrading: false } });
        return { changed: await this.markWaitingReason(userId, dailyPnl <= -settings.maxDailyLoss ? 'Daily loss limit reached' : 'Daily profit limit reached'), executions };
      }
      const slotLimit = settings.maxOpenTrades === 0 ? Number.MAX_SAFE_INTEGER : settings.maxOpenTrades;
      const candidates = await this.prisma.realTradeQueue.findMany({ where: { userId, status: 'WAITING_FOR_SLOT' }, orderBy: [{ rankScore: 'desc' }, { aiScore: 'desc' }, { confidence: 'desc' }, { riskReward: 'desc' }, { signalTime: 'desc' }] });
      for (const queued of candidates) {
        const validationLog: Array<{ step: string; status: 'PASS' | 'FAIL'; detail: string; checkedAt: string }> = [];
        const validate = (step: string, pass: boolean, detail: string) => {
          validationLog.push({ step, status: pass ? 'PASS' : 'FAIL', detail, checkedAt: at.toISOString() });
          this.logger[pass ? 'log' : 'warn'](JSON.stringify({ event: 'real.validation', userId, signalId: queued.signalId, symbol: queued.symbol, step, result: pass ? 'PASS' : 'FAIL', detail }));
          return pass;
        };
        const reject = async (displayStatus: string, reason: string, permanent = true, brokerResponse?: string) => {
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
          await reject('Rejected by AI Filter', signal ? `Signal status is ${signal.status}, expected RUNNING` : 'Signal record not found');
          continue;
        }
        if (!signal) continue; // The missing-record failure was persisted by reject() above.
        validate('AI Score recorded', Number.isFinite(signal.aiScore), `AI Score ${signal.aiScore}`);
        const scannerPassed = signal.top100Selected && Number.isFinite(signal.volumeRatio) && Number.isFinite(signal.trendStrengthScore);
        if (!validate('Scanner validation persisted', scannerPassed, `Top 100: ${signal.top100Selected}; volume ratio ${signal.volumeRatio.toFixed(2)}; trend ${signal.trendStrengthScore.toFixed(1)}`)) {
          await reject('Rejected by Scanner', 'Scanner validation is missing from the persisted AI signal');
          continue;
        }
        const validationAgeMinutes = Math.max(0, (at.getTime() - signal.signalTime.getTime()) / 60_000);
        if (!validate('Validation age within trading session', validationAgeMinutes <= 375, `${validationAgeMinutes.toFixed(1)} minutes ≤ 375 minutes`)) {
          await reject('Expired', `Validation expired: ${validationAgeMinutes.toFixed(1)} minutes old`);
          continue;
        }
        if (!validate('Confidence ≥ Minimum Confidence', signal.confidence >= settings.minimumConfidence, `${signal.confidence}% ≥ ${settings.minimumConfidence}%`)) {
          await reject('Confidence Too Low', `Confidence too low: ${signal.confidence}% < ${settings.minimumConfidence}%`);
          continue;
        }
        const minimumRiskReward = 3;
        if (!validate('Risk/Reward ≥ Minimum Risk/Reward', Number(signal.riskReward) >= minimumRiskReward, `${Number(signal.riskReward).toFixed(2)} ≥ ${minimumRiskReward.toFixed(2)}`)) {
          await reject('Risk/Reward Failed', `Risk/Reward failed: ${Number(signal.riskReward).toFixed(2)} < ${minimumRiskReward.toFixed(2)}`);
          continue;
        }
        const modeDecision = this.entryModeEligible(queued, signal);
        if (!validate(`Entry mode: ${queued.entryMode}`, modeDecision.pass, modeDecision.detail)) {
          await reject('Waiting', modeDecision.detail, false);
          continue;
        }
        if (!validate('Live price valid', Number.isFinite(signal.currentPrice) && signal.currentPrice > 0, `Live price ₹${Number(signal.currentPrice).toFixed(2)}`)) {
          await reject('Invalid Live Price', 'Live market price is unavailable', queued.target1Reached);
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
          await reject('Duplicate Position', `Existing open position for ${signal.symbol}`);
          continue;
        }
        const existingOpenOrder = await this.prisma.realTradeOrder.findUnique({ where: { signalId: signal.id }, select: { id: true, status: true } });
        if (!validate('No existing open order', !existingOpenOrder, existingOpenOrder ? `Order ${existingOpenOrder.id}: ${existingOpenOrder.status}` : 'No order exists for signal')) {
          await reject('Duplicate Order', `An order already exists for signal ${signal.id}`);
          continue;
        }
        let funds: any;
        try {
          funds = await this.upstox.funds(userId);
        } catch (error) {
          const detail = this.fullBrokerError(error);
          validate('Capital available', false, detail);
          await reject('Broker Error', detail, true, detail);
          continue;
        }
        const equity = funds?.data?.equity ?? funds?.data ?? {};
        const margin = Number(equity.available_margin ?? equity.available_cash ?? equity.net ?? 0);
        const allocated = await this.prisma.realTradeOrder.aggregate({ where: { userId, status: { in: ['SUBMITTED', 'OPEN'] } }, _sum: { investment: true } });
        const configuredRemaining = Math.max(0, settings.tradingCapital - Number(allocated._sum.investment ?? 0));
        const allocation = Math.min(settings.tradingCapital, configuredRemaining, margin);
        const quantity = Math.floor(allocation / signal.currentPrice);
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
          await reject('Broker Error', detail, true, detail);
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
          const confirmedEntryPrice = Number(confirmation.average_price ?? confirmation.price);
          const entryPrice = Number.isFinite(confirmedEntryPrice) && confirmedEntryPrice > 0 ? confirmedEntryPrice : signal.currentPrice;
          await this.prisma.$transaction([
            this.prisma.realTradeOrder.create({ data: { userId, signalId: signal.id, brokerOrderId: orderId, instrumentKey: signal.instrumentKey, symbol: signal.symbol, side: signal.side, aiConfidence: signal.confidence, aiAnalysis: `${signal.strategy} ${signal.timeframe} · AI score ${signal.aiScore} · Risk reward 1:${signal.riskReward.toFixed(2)}`, status: 'OPEN', entryPrice, currentPrice: entryPrice, quantity, remainingQuantity: quantity, allocatedCapital: allocation, investment: entryPrice * quantity, target1: signal.target1, target2: signal.target2, target3: signal.target3, stopLoss: signal.stopLoss, currentStop: signal.stopLoss, executionTime: at } }),
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

  private async submitPartialExit(userId: string, order: any, quantity: number) {
    const side = order.side === 'BUY' ? 'SELL' : 'BUY';
    const placed: any = await this.upstox.placeIntradayOrder(userId, { instrumentKey: order.instrumentKey, side, quantity, tag: `QP-T2-${order.signalId}` });
    const orderId = String(placed?.data?.order_id ?? '');
    if (!orderId) throw new Error('Upstox did not return an order ID for the Target 2 partial exit');
    const confirmations: any[] = await this.upstox.waitForOrders(userId, [orderId]);
    const status = String(confirmations[0]?.data?.status ?? '').toUpperCase();
    if (!['COMPLETE', 'OPEN'].includes(status)) throw new Error(`Target 2 partial exit was not accepted: ${status || 'UNKNOWN'}`);
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
    const directionalMomentum = signal.side === 'BUY' ? Number(signal.momentumScore ?? 0) : -Number(signal.momentumScore ?? 0);
    return Number((
      Number(signal.aiScore ?? 0) * .30
      + Number(signal.confidence ?? 0) * .25
      + Math.min(5, Number(signal.riskReward ?? 0)) * 6
      + Math.min(3, Number(signal.volumeRatio ?? 0)) * 5
      + Math.min(50, Number(signal.trendStrengthScore ?? 0)) * .2
      + (signal.vwapAligned ? 5 : 0)
      + (signal.emaAligned ? 5 : 0)
      + Math.max(-5, Math.min(5, directionalMomentum))
      + Math.max(0, Math.min(1, Number(signal.atrQuality ?? 0))) * 5
      - Math.min(30, ageMinutes) * .1
    ).toFixed(4));
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
    const missed = skipped.map((item) => ({ item, signal: signalById.get(item.signalId) })).filter(({ signal }) => Number(signal?.profitPercent ?? 0) > 0).sort((a, b) => Number(b.signal.profitPercent) - Number(a.signal.profitPercent))[0];
    const profitableExecutions = executed.filter((item) => Number(signalById.get(item.signalId)?.profitPercent ?? 0) > 0).length;
    return { signalsFound: decisions.length, signalsPassedFilters: passed.length, signalsExecuted: executed.length, signalsSkipped: skipped.length, signalsFailed: failed.length, skipReasonDistribution, bestMissedOpportunity: missed ? { symbol: missed.item.symbol, profitPercent: missed.signal.profitPercent, reason: missed.item.blockingCondition } : null, executionAccuracy: executed.length ? profitableExecutions / executed.length * 100 : 0 };
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
