import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { marketClock } from './market-clock';
import { UpstoxService } from './upstox.service';

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
  constructor(private readonly upstox: UpstoxService, private readonly prisma: PrismaService) {}

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
    const queue = await this.prisma.realTradeQueue.findMany({ where: { userId, status: { in: ['WAITING_FOR_SLOT', 'PROCESSING', 'REJECTED', 'EXECUTED'] } }, orderBy: [{ confidence: 'desc' }, { aiScore: 'desc' }, { riskReward: 'desc' }, { signalTime: 'desc' }], take: 100 });
    const todayStart = marketClock().tradingDate;
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
      connectionTime: settings.connectionTime,
      positions,
      holdings,
      orders,
      trades,
      ledger,
      queue,
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
          await this.prisma.realTradeQueue.create({ data: { userId, signalId: signal.id, instrumentKey: signal.instrumentKey, symbol: signal.symbol, side: signal.side, entryPrice: signal.entryPrice, confidence: signal.confidence, aiScore: signal.aiScore, riskReward: signal.riskReward, signalTime: signal.signalTime, queuedAt: at, reason: 'Waiting for risk checks' } });
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
    const orders = await this.prisma.realTradeOrder.findMany({ where: { userId, instrumentKey, status: 'OPEN' } });
    let changed = false;
    for (const order of orders) {
      const pnl = (order.side === 'BUY' ? price - order.entryPrice : order.entryPrice - price) * order.quantity;
      const pnlPercent = order.investment ? pnl / order.investment * 100 : 0;
      const reached = (level: number) => order.side === 'BUY' ? price >= level : price <= level;
      const stopped = order.side === 'BUY' ? price <= order.currentStop : price >= order.currentStop;
      const ist = new Date(at.getTime() + 330 * 60_000);
      const hhmm = `${String(ist.getUTCHours()).padStart(2, '0')}:${String(ist.getUTCMinutes()).padStart(2, '0')}`;
      const exitReason = hhmm >= settings.squareOffTime ? 'MARKET CLOSE' : reached(order.target3) ? 'TARGET 3' : stopped ? (order.currentStop === order.entryPrice ? 'BREAK-EVEN' : 'STOP LOSS') : null;
      if (exitReason) {
        await this.upstox.exitPosition(userId, order.instrumentKey, 'I');
        await this.prisma.realTradeOrder.update({ where: { id: order.id }, data: { status: 'COMPLETED', currentPrice: price, pnl, pnlPercent, exitPrice: price, exitReason, exitTime: at } });
        changed = true;
      } else {
        const target2 = reached(order.target2);
        const target1 = reached(order.target1);
        await this.prisma.realTradeOrder.update({ where: { id: order.id }, data: { currentPrice: price, pnl, pnlPercent, targetProgress: target2 ? 'TARGET2_HIT' : target1 ? 'TARGET1_HIT' : order.targetProgress, currentStop: target2 ? order.target1 : target1 ? order.entryPrice : order.currentStop } });
      }
    }
    let queued: RealTradingChange = { changed: false, executions: [] };
    if (changed || at.getTime() - (this.lastQueueDrain.get(userId) ?? 0) >= 2_000) {
      const waiting = await this.prisma.realTradeQueue.findFirst({ where: { userId, status: 'WAITING_FOR_SLOT' }, select: { id: true } });
      if (waiting) queued = await this.drainQueue(userId, at);
    }
    return { changed: recovered.changed || changed || queued.changed, executions: [...recovered.executions, ...queued.executions] } satisfies RealTradingChange;
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
      while (true) {
        const queued = await this.prisma.realTradeQueue.findFirst({ where: { userId, status: 'WAITING_FOR_SLOT' }, orderBy: [{ confidence: 'desc' }, { aiScore: 'desc' }, { riskReward: 'desc' }, { signalTime: 'desc' }] });
        if (!queued) break;
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
            resolvedAt: permanent ? at : null,
          } });
          changed = true;
        };
        const signal = await this.prisma.aiSignal.findUnique({ where: { id: queued.signalId }, include: { managementDecision: true, stopLossDecision: true } });
        const running = Boolean(signal && signal.status === 'RUNNING' && signal.entryTriggeredAt && signal.runningAt);
        if (!validate('Signal status must be Running', running, signal ? `Current status: ${signal.status}` : 'Signal record not found')) {
          await reject('Rejected by AI Filter', signal ? `Signal status is ${signal.status}, expected RUNNING` : 'Signal record not found');
          continue;
        }
        if (!signal) continue;
        if (!validate('Confidence ≥ Minimum Confidence', signal.confidence >= settings.minimumConfidence, `${signal.confidence}% ≥ ${settings.minimumConfidence}%`)) {
          await reject('Confidence Too Low', `Confidence too low: ${signal.confidence}% < ${settings.minimumConfidence}%`);
          continue;
        }
        const minimumRiskReward = 3;
        if (!validate('Risk/Reward ≥ Minimum Risk/Reward', Number(signal.riskReward) >= minimumRiskReward, `${Number(signal.riskReward).toFixed(2)} ≥ ${minimumRiskReward.toFixed(2)}`)) {
          await reject('Risk/Reward Failed', `Risk/Reward failed: ${Number(signal.riskReward).toFixed(2)} < ${minimumRiskReward.toFixed(2)}`);
          continue;
        }
        const crossed = signal.side === 'BUY' ? signal.currentPrice >= signal.entryPrice : signal.currentPrice <= signal.entryPrice;
        if (!validate('Live price satisfies entry condition', crossed, `${signal.side} live ₹${signal.currentPrice.toFixed(2)} versus entry ₹${signal.entryPrice.toFixed(2)}`)) {
          await reject('Live Price Changed', `Live price changed: ₹${signal.currentPrice.toFixed(2)} no longer satisfies ${signal.side} entry ₹${signal.entryPrice.toFixed(2)}`);
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
        const capital = this.capitalAllocation(margin, Number(allocated._sum.investment ?? 0), settings.maxOpenTrades);
        const allocation = Math.min(capital.capitalPerTrade, margin);
        const quantity = Math.floor(allocation / signal.currentPrice);
        if (!validate('Capital available', quantity > 0 && allocation > 0, `Available ₹${margin.toFixed(2)}; allocation ₹${allocation.toFixed(2)}; price ₹${signal.currentPrice.toFixed(2)}`)) {
          await reject('Capital Error', `Insufficient capital: available ₹${margin.toFixed(2)}, required at least ₹${signal.currentPrice.toFixed(2)}`, false);
          break;
        }
        const openTrades = await this.prisma.realTradeOrder.count({ where: { userId, status: { in: ['SUBMITTED', 'OPEN'] } } });
        if (!validate('Maximum Open Trades not exceeded', openTrades < slotLimit, settings.maxOpenTrades === 0 ? `${openTrades} open; Unlimited enabled` : `${openTrades}/${settings.maxOpenTrades} open`)) {
          await reject('Waiting', `Maximum Open Trades reached (${openTrades}/${settings.maxOpenTrades})`, false);
          break;
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
        if (!directionEnabled || watchMode || signal.target1At || signal.stopLossAt || signal.completedAt) {
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
        if (claimed.count !== 1) continue;
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
            this.prisma.realTradeOrder.create({ data: { userId, signalId: signal.id, brokerOrderId: orderId, instrumentKey: signal.instrumentKey, symbol: signal.symbol, side: signal.side, aiConfidence: signal.confidence, aiAnalysis: `${signal.strategy} ${signal.timeframe} · AI score ${signal.aiScore} · Risk reward 1:${signal.riskReward.toFixed(2)}`, status: 'OPEN', entryPrice, currentPrice: entryPrice, quantity, allocatedCapital: allocation, investment: entryPrice * quantity, target1: signal.target1, target2: signal.target2, target3: signal.target3, stopLoss: signal.stopLoss, currentStop: signal.stopLoss, executionTime: at } }),
            this.prisma.realTradeQueue.update({ where: { id: queued.id }, data: { status: 'EXECUTED', displayStatus: 'Executed', reason: `Upstox order ${orderStatus}`, validationLog: JSON.stringify([...validationLog, { step: 'Submit order to Upstox', status: 'PASS', detail: `Broker order ${orderId} accepted with status ${orderStatus}`, checkedAt: at.toISOString() }]), brokerResponse, resolvedAt: at } }),
          ]);
          executions.push({ brokerOrderId: orderId, stockName: signal.stockName || signal.symbol, symbol: signal.symbol, side: signal.side as 'BUY' | 'SELL', quantity, entryPrice, orderStatus: orderStatus as 'COMPLETE' | 'OPEN' });
          this.logger.log(JSON.stringify({ event: 'real.position.created', message: 'Live Position created', userId, signalId: signal.id, symbol: signal.symbol, brokerOrderId: orderId, quantity, entryPrice, orderStatus }));
          changed = true;
        } catch (error) {
          const detail = this.fullBrokerError(error);
          const reason = `Broker API error: ${detail}`;
          validationLog.push({ step: 'Submit order to Upstox', status: 'FAIL', detail, checkedAt: at.toISOString() });
          this.logger.error(JSON.stringify({ event: 'real.execution.failed', message: 'Real order execution failed', userId, signalId: queued.signalId, symbol: queued.symbol, reason }), error instanceof Error ? error.stack : undefined);
          await this.prisma.realTradeQueue.updateMany({ where: { id: queued.id, status: 'PROCESSING' }, data: { status: 'REJECTED', displayStatus: 'Broker Error', validationLog: JSON.stringify(validationLog), brokerResponse: detail, resolvedAt: at, reason } });
          changed = true;
        }
      }
      return { changed, executions };
    } finally { this.locks.delete(userId); }
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
      await this.prisma.realTradeQueue.updateMany({ where: { id: { in: stale.map((item) => item.id) } }, data: { displayStatus: 'Waiting', reason, validationLog: JSON.stringify([{ step: 'Execution precondition', status: 'FAIL', detail: reason, checkedAt: new Date().toISOString() }]) } });
    }
    for (const item of waiting) this.logger.warn(JSON.stringify({ event: 'real.risk.failed', message: 'Risk checks failed', userId, signalId: item.signalId, symbol: item.symbol, reason }));
    return stale.length > 0;
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
