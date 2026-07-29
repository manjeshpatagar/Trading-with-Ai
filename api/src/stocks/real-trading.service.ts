import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { marketClock } from './market-clock';
import { UpstoxService } from './upstox.service';

@Injectable()
export class RealTradingService {
  private readonly logger = new Logger(RealTradingService.name);
  private readonly locks = new Set<string>();
  constructor(private readonly upstox: UpstoxService, private readonly prisma: PrismaService) {}

  private account(userId: string) {
    return this.prisma.realTradingAccount.upsert({ where: { userId }, create: { userId }, update: {} });
  }

  async updateSettings(userId: string, input: Record<string, unknown>) {
    const current = await this.account(userId);
    const number = (value: unknown, minimum: number, maximum: number, fallback: number) => Number.isFinite(Number(value)) ? Math.min(maximum, Math.max(minimum, Number(value))) : fallback;
    const squareOffTime = typeof input.squareOffTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.squareOffTime) ? input.squareOffTime : current.squareOffTime;
    const updated = await this.prisma.realTradingAccount.update({ where: { userId }, data: {
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
    if (updated.autoTrading) {
      const triggered = await this.prisma.aiSignal.findMany({ where: { userId, status: 'ENTRY_TRIGGERED', entryTriggeredAt: { not: null }, target1At: null, stopLossAt: null, completedAt: null } });
      await this.captureTriggeredSignals(userId, triggered);
    }
    return updated;
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
    const queue = await this.prisma.realTradeQueue.findMany({ where: { userId, status: 'WAITING_FOR_SLOT' }, orderBy: [{ confidence: 'desc' }, { aiScore: 'desc' }, { riskReward: 'desc' }, { signalTime: 'desc' }] });
    const todayStart = marketClock().tradingDate;
    const todayLedger = ledger.filter((order) => order.createdAt.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) === todayStart);
    const todayPnl = todayLedger.reduce((sum, order) => sum + order.pnl, 0);
    const runningLedger = ledger.filter((order) => order.status === 'OPEN');
    const completedLedger = todayLedger.filter((order) => order.status === 'COMPLETED');
    const wins = completedLedger.filter((order) => order.pnl > 0), losses = completedLedger.filter((order) => order.pnl < 0);
    const usedCapital = runningLedger.reduce((sum, order) => sum + order.investment, 0);
    if (requests[0].status === 'fulfilled' && !settings.connectionTime) await this.prisma.realTradingAccount.update({ where: { userId }, data: { connectionTime: new Date() } });
    this.logger.log(`Real trading dashboard | User: ${userId} | Positions: ${positions.length} | Orders: ${orders.length} | Partial errors: ${errors.length}`);
    return {
      connected: requests[0].status === 'fulfilled',
      broker: 'Upstox',
      profile: { userName: profile.user_name, userId: profile.user_id },
      funds: {
        available: Number(equity.available_margin ?? equity.available_cash ?? equity.net ?? 0),
        margin: Number(equity.used_margin ?? equity.utilised_margin ?? 0),
      },
      settings,
      safety: { tokenValid: requests[0].status === 'fulfilled', marketOpen: marketClock().canEnter, autoTradingEnabled: settings.autoTrading, dailyLimitReached: todayPnl <= -settings.maxDailyLoss || todayPnl >= settings.maxDailyProfit },
      todayPnl,
      statistics: { availableCapital: Math.max(0, settings.tradingCapital - usedCapital), usedCapital, netProfit: todayPnl, todayProfit: wins.reduce((sum, order) => sum + order.pnl, 0), todayLoss: Math.abs(losses.reduce((sum, order) => sum + order.pnl, 0)), runningTrades: runningLedger.length, winningTrades: wins.length, losingTrades: losses.length, completedTrades: completedLedger.length, roi: settings.tradingCapital ? todayPnl / settings.tradingCapital * 100 : 0, winRate: completedLedger.length ? wins.length / completedLedger.length * 100 : 0 },
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
    const settings = await this.account(userId);
    if (!settings.autoTrading) return false;
    for (const signal of signals) {
      if (signal.status !== 'ENTRY_TRIGGERED' || !signal.entryTriggeredAt || !['BUY', 'SELL'].includes(signal.side) || signal.confidence < settings.minimumConfidence || Number(signal.riskReward) < 3) continue;
      if ((signal.side === 'BUY' && !settings.buySignals) || (signal.side === 'SELL' && !settings.sellSignals)) continue;
      const crossed = signal.side === 'BUY' ? signal.currentPrice >= signal.entryPrice : signal.currentPrice <= signal.entryPrice;
      if (!crossed) continue;
      await this.prisma.realTradeQueue.upsert({ where: { signalId: signal.id }, update: {}, create: { userId, signalId: signal.id, instrumentKey: signal.instrumentKey, symbol: signal.symbol, side: signal.side, entryPrice: signal.entryPrice, confidence: signal.confidence, aiScore: signal.aiScore, riskReward: signal.riskReward, signalTime: signal.signalTime, queuedAt: at } });
    }
    return this.drainQueue(userId, at);
  }

  async processTick(userId: string, instrumentKey: string, price: number, at = new Date()) {
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
    if (changed) await this.drainQueue(userId, at);
    return changed;
  }

  private async drainQueue(userId: string, at: Date) {
    if (this.locks.has(userId)) return false;
    this.locks.add(userId);
    let changed = false;
    try {
      let settings = await this.account(userId);
      if (!settings.autoTrading || !marketClock(at).canEnter) return false;
      try { await this.upstox.profile(userId); } catch { return false; }
      const closed = await this.prisma.realTradeOrder.findMany({ where: { userId, status: 'COMPLETED', exitTime: { not: null } } });
      const today = marketClock(at).tradingDate;
      const dailyPnl = closed.filter((order) => order.exitTime?.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) === today).reduce((sum, order) => sum + order.pnl, 0);
      if (dailyPnl <= -settings.maxDailyLoss || dailyPnl >= settings.maxDailyProfit) {
        settings = await this.prisma.realTradingAccount.update({ where: { userId }, data: { autoTrading: false } });
        return false;
      }
      const slotLimit = settings.maxOpenTrades === 0 ? Number.MAX_SAFE_INTEGER : settings.maxOpenTrades;
      while (await this.prisma.realTradeOrder.count({ where: { userId, status: { in: ['SUBMITTED', 'OPEN'] } } }) < slotLimit) {
        const allocated = await this.prisma.realTradeOrder.aggregate({ where: { userId, status: { in: ['SUBMITTED', 'OPEN'] } }, _sum: { investment: true } });
        const queued = await this.prisma.realTradeQueue.findFirst({ where: { userId, status: 'WAITING_FOR_SLOT' }, orderBy: [{ confidence: 'desc' }, { aiScore: 'desc' }, { riskReward: 'desc' }, { signalTime: 'desc' }] });
        if (!queued) break;
        const signal = await this.prisma.aiSignal.findUnique({ where: { id: queued.signalId }, include: { managementDecision: true, stopLossDecision: true } });
        const priorStops = signal ? await this.prisma.realTradeOrder.count({ where: { userId, symbol: signal.symbol, status: 'COMPLETED', exitReason: 'STOP LOSS' } }) : 0;
        const watchMode = Boolean(signal && (/WATCH/i.test(signal.managementDecision?.status ?? '') || /WATCH/i.test(signal.managementDecision?.reentryStatus ?? '') || signal.stopLossDecision?.status === 'WAIT'));
        if (!signal || signal.confidence < settings.minimumConfidence || Number(signal.riskReward) < 3 || priorStops >= 2 || watchMode || signal.target1At || signal.stopLossAt || signal.completedAt || !['ENTRY_TRIGGERED', 'RUNNING'].includes(signal.status)) {
          await this.prisma.realTradeQueue.update({ where: { id: queued.id }, data: { status: 'REJECTED', resolvedAt: at, reason: 'Signal is no longer valid' } });
          continue;
        }
        const allocation = settings.maxOpenTrades === 0 ? settings.tradingCapital * settings.riskPerTrade / 100 : settings.tradingCapital / settings.maxOpenTrades;
        if (settings.tradingCapital - Number(allocated._sum.investment ?? 0) < allocation) break;
        const quantity = Math.floor(allocation / signal.currentPrice);
        const funds: any = await this.upstox.funds(userId);
        const equity = funds?.data?.equity ?? funds?.data ?? {};
        const margin = Number(equity.available_margin ?? equity.available_cash ?? 0);
        if (!quantity || margin < allocation) {
          await this.prisma.realTradeQueue.update({ where: { id: queued.id }, data: { status: 'REJECTED', resolvedAt: at, reason: 'Insufficient available margin' } });
          continue;
        }
        try {
          const placed: any = await this.upstox.placeIntradayOrder(userId, { instrumentKey: signal.instrumentKey, side: signal.side as 'BUY' | 'SELL', quantity, tag: `QP-${signal.id}` });
          const orderId = String(placed?.data?.order_id ?? '');
          if (!orderId) throw new Error('Upstox did not return an order ID');
          await this.upstox.waitForOrders(userId, [orderId]);
          await this.prisma.$transaction([
            this.prisma.realTradeOrder.create({ data: { userId, signalId: signal.id, brokerOrderId: orderId, instrumentKey: signal.instrumentKey, symbol: signal.symbol, side: signal.side, aiConfidence: signal.confidence, aiAnalysis: `${signal.strategy} ${signal.timeframe} · AI score ${signal.aiScore} · Risk reward 1:${signal.riskReward.toFixed(2)}`, status: 'OPEN', entryPrice: signal.currentPrice, currentPrice: signal.currentPrice, quantity, allocatedCapital: allocation, investment: signal.currentPrice * quantity, target1: signal.target1, target2: signal.target2, target3: signal.target3, stopLoss: signal.stopLoss, currentStop: signal.stopLoss, executionTime: at } }),
            this.prisma.realTradeQueue.update({ where: { id: queued.id }, data: { status: 'EXECUTED', resolvedAt: at } }),
          ]);
          changed = true;
        } catch (error) {
          await this.prisma.realTradeQueue.update({ where: { id: queued.id }, data: { status: 'REJECTED', resolvedAt: at, reason: error instanceof Error ? error.message : String(error) } });
        }
      }
      return changed;
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
}
