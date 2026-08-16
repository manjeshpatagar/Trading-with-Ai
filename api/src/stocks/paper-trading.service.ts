import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { PaperOrderExecutionService } from './paper-order-execution.service';
import { marketClock } from './market-clock';

type TriggeredSignal = { id: string; userId: string; instrumentKey: string; symbol: string; side: string; entryPrice: number; currentPrice: number; confidence: number; aiScore: number; riskReward: number; signalTime: Date; status: string; entryTriggeredAt?: Date | null; runningAt?: Date | null; target1At?: Date | null; stopLossAt?: Date | null; completedAt?: Date | null };

const DEMO_CAPITAL = 10_000;
const MAX_ACTIVE_DEMO_TRADES = 1;

export function calculateDemoIntradayPosition(input: { capital: number; accountBalance: number; entryPrice: number; stopLoss: number; riskPercent: number; leverage: number }) {
  const leverage = Math.max(1, Number(input.leverage));
  const marginPerShare = input.entryPrice / leverage;
  const marginQuantity = marginPerShare > 0 ? Math.floor(input.capital / marginPerShare) : 0;
  const riskPerShare = Math.abs(input.entryPrice - input.stopLoss);
  const maximumRisk = input.accountBalance * input.riskPercent / 100;
  const riskQuantity = riskPerShare > 0 ? Math.floor(maximumRisk / riskPerShare) : 0;
  const quantity = Math.max(0, Math.min(marginQuantity, riskQuantity));
  return { leverage, marginPerShare, marginQuantity, riskPerShare, maximumRisk, riskQuantity, quantity, marginUsed: quantity * marginPerShare, notionalValue: quantity * input.entryPrice };
}

@Injectable()
export class PaperTradingService {
  private readonly logger = new Logger(PaperTradingService.name);
  private readonly demoExecutionLocks = new Set<string>();
  private readonly legacyReconciliationLocks = new Set<string>();
  constructor(private readonly prisma: PrismaService, private readonly execution: PaperOrderExecutionService) {}

  async account(userId: string) {
    try {
      this.logger.log(JSON.stringify({ event: 'paper.database.wallet.initialize', userId }));
      const account = await this.prisma.paperTradingAccount.upsert({ where: { userId }, create: { userId, startingBalance: DEMO_CAPITAL, maxOpenTrades: MAX_ACTIVE_DEMO_TRADES, autoDemoTrading: true }, update: { startingBalance: DEMO_CAPITAL, maxOpenTrades: MAX_ACTIVE_DEMO_TRADES, autoDemoTrading: true } });
      this.logger.log(JSON.stringify({ event: 'paper.database.wallet.ready', userId, accountId: account.id, startingBalance: account.startingBalance }));
      return account;
    } catch (error) {
      this.logError('paper.database.wallet.failed', error, { userId });
      throw error;
    }
  }

  async createTrade(userId: string, _row?: unknown) {
    this.logger.warn(JSON.stringify({ event: 'paper.legacy.create.disabled', userId, reason: 'Demo orders are created only from canonical TARGET1_HIT signals' }));
    return false;
  }

  async captureTriggeredDemoSignals(userId: string, trades: TriggeredSignal[], at = new Date()) {
    const account = await this.account(userId);
    if (!account.autoDemoTrading) return false;
    for (const trade of trades) {
      if (trade.status !== 'TARGET1_HIT' || !trade.target1At || !['BUY', 'SELL'].includes(trade.side)) continue;
      await this.prisma.demoTradeQueue.upsert({
        where: { signalId: trade.id },
        update: {},
        create: { userId, signalId: trade.id, instrumentKey: trade.instrumentKey, symbol: trade.symbol, side: trade.side, entryPrice: trade.entryPrice, confidence: trade.confidence, aiScore: trade.aiScore, riskReward: trade.riskReward, signalTime: trade.signalTime, queuedAt: trade.target1At ?? at },
      });
    }
    return this.drainDemoQueue(userId, at);
  }

  async drainDemoQueue(userId: string, at = new Date()) {
    if (this.demoExecutionLocks.has(userId)) return false;
    this.demoExecutionLocks.add(userId);
    let changed = false;
    try {
      const account = await this.account(userId);
      if (!account.autoDemoTrading || !account.enabled || !marketClock(at).canEnter) return false;
      while (true) {
        const active = await this.prisma.paperOrder.findMany({ where: { userId, status: 'OPEN' } });
        if (active.length >= MAX_ACTIVE_DEMO_TRADES) break;
        const usedCapital = active.reduce((sum, order) => sum + Number(order.budget), 0);
        const availableCapital = account.startingBalance + account.realizedPnl - usedCapital;
        const allocation = Math.max(0, availableCapital);
        if (allocation <= 0) break;
        const queued = await this.prisma.demoTradeQueue.findFirst({ where: { userId, status: 'WAITING_FOR_CAPITAL' }, orderBy: [{ confidence: 'desc' }, { aiScore: 'desc' }, { riskReward: 'desc' }, { signalTime: 'desc' }] });
        if (!queued) break;
        const signal = await this.prisma.aiSignal.findUnique({ where: { id: queued.signalId } });
        const invalidReason = !signal ? 'Signal no longer exists'
          : signal.stopLossAt ? 'Stop loss already reached'
            : signal.completedAt ? 'Trade already completed'
              : signal.status !== 'TARGET1_HIT' ? `Signal state is ${signal.status}`
                : !signal.target1At ? 'Target 1 timestamp is missing'
                  : null;
        if (invalidReason) {
          await this.prisma.demoTradeQueue.update({ where: { id: queued.id }, data: { status: 'REJECTED', rejectedAt: at, rejectReason: invalidReason } });
          continue;
        }
        if (!signal) continue;
        const duplicate = await this.prisma.paperOrder.findUnique({ where: { signalId: queued.signalId } });
        if (duplicate) {
          await this.prisma.demoTradeQueue.update({ where: { id: queued.id }, data: { status: 'EXECUTED', executedAt: duplicate.entryTime ?? duplicate.createdAt } });
          continue;
        }
        const executionPrice = Number(signal.currentPrice);
        const sizing = calculateDemoIntradayPosition({ capital: allocation, accountBalance: account.startingBalance, entryPrice: executionPrice, stopLoss: Number(signal.stopLoss), riskPercent: account.riskPerTrade, leverage: Number(process.env.DEMO_INTRADAY_LEVERAGE ?? 5) });
        const quantity = sizing.quantity;
        if (!Number.isFinite(executionPrice) || executionPrice <= 0 || quantity <= 0) {
          await this.prisma.demoTradeQueue.update({ where: { id: queued.id }, data: { status: 'REJECTED', rejectedAt: at, rejectReason: 'Insufficient allocation for one share' } });
          continue;
        }
        const fill = await this.execution.fill({ price: executionPrice, quantity, at });
        const marginUsed = sizing.marginUsed;
        await this.prisma.$transaction([
          this.prisma.paperOrder.create({ data: { userId, signalId: signal.id, instrumentKey: signal.instrumentKey, symbol: signal.symbol, side: signal.side, confidence: signal.confidence, status: 'OPEN', quantity, budget: marginUsed, plannedEntry: signal.entryPrice, currentPrice: executionPrice, target: signal.target3, stopLoss: signal.stopLoss, ...fill } }),
          this.prisma.demoTradeQueue.update({ where: { id: queued.id }, data: { status: 'EXECUTED', executedAt: at } }),
        ]);
        changed = true;
        this.logger.log(JSON.stringify({ event: 'demo.trade.auto.executed', userId, signalId: signal.id, symbol: signal.symbol, side: signal.side, product: 'INTRADAY', entryPrice: executionPrice, entryTime: at, quantity, marginUsed, notionalValue: fill.investment, leverage: sizing.leverage }));
      }
      return changed;
    } finally {
      this.demoExecutionLocks.delete(userId);
    }
  }

  async processTick(userId: string, instrumentKey: string, price: number, at = new Date()) {
    try {
    const account = await this.prisma.paperTradingAccount.findUnique({ where: { userId } });
    if (!account?.enabled || !Number.isFinite(price)) return false;
    const orders = await this.prisma.paperOrder.findMany({ where: { userId, instrumentKey, status: 'OPEN' } });
    let changed = false;
    for (const order of orders) {
      const entryPrice = Number(order.entryPrice);
      const pnl = (order.side === 'BUY' ? price - entryPrice : entryPrice - price) * order.quantity;
      const pnlPercent = entryPrice ? pnl / (entryPrice * order.quantity) * 100 : 0;
      const targetHit = order.side === 'BUY' ? price >= order.target : price <= order.target;
      const stopTouched = order.side === 'BUY' ? price <= order.stopLoss : price >= order.stopLoss;
      let exitReason: string | null = targetHit ? 'TARGET' : null;
      if (!exitReason && stopTouched) {
        if (!account.allowAiWait) exitReason = 'STOP LOSS';
        else {
          const linked = await this.prisma.aiSignal.findFirst({ where: { userId, instrumentKey }, include: { stopLossDecision: true }, orderBy: { signalTime: 'desc' } });
          if (linked?.status === 'STOPLOSS_CONFIRMED') exitReason = 'STOP LOSS';
          else if (linked?.stopLossDecision?.status === 'EXIT') exitReason = 'AI EXIT';
        }
      }
      if (exitReason) {
        await this.close(order.id, price, exitReason, at);
        changed = true;
      } else await this.prisma.paperOrder.update({ where: { id: order.id }, data: { currentPrice: price, pnl, pnlPercent } });
    }
    if (changed) await this.drainDemoQueue(userId, at);
    return changed;
    } catch (error) { this.logError('paper.portfolio.tick.failed', error, { userId, instrumentKey, price }); return false; }
  }

  async manualExit(userId: string, orderId: string) {
    try {
      const order = await this.prisma.paperOrder.findFirst({ where: { id: orderId, userId, status: 'OPEN' } });
      if (!order) { this.logger.warn(JSON.stringify({ event: 'paper.trade.exit.skipped', userId, orderId, reason: 'Open position not found' })); return false; }
      await this.close(order.id, order.currentPrice, 'MANUAL EXIT', new Date());
      await this.drainDemoQueue(userId);
      return true;
    } catch (error) { this.logError('paper.trade.exit.failed', error, { userId, orderId }); return false; }
  }

  async closeAllEod(at = new Date()) {
    const orders = await this.prisma.paperOrder.findMany({ where: { status: 'OPEN' } });
    let closed = 0;
    for (const order of orders) {
      const price = Number(order.currentPrice);
      if (!Number.isFinite(price) || price <= 0) {
        this.logger.error(JSON.stringify({ event: 'eod.paper.price.invalid', orderId: order.id, instrumentKey: order.instrumentKey, price }));
        continue;
      }
      await this.close(order.id, price, 'End of Day Auto Exit', at, 'CLOSED - EOD EXIT');
      closed += 1;
    }
    await this.prisma.paperOrder.updateMany({
      where: { status: 'WAITING' },
      data: { status: 'CLOSED - EOD EXIT', exitTime: at, exitReason: 'End of Day Auto Exit', pnl: 0, pnlPercent: 0, durationMinutes: 0 },
    });
    return closed;
  }

  async updateSettings(userId: string, input: Record<string, unknown>) {
    try {
    const current = await this.account(userId);
    const data = {
      enabled: typeof input.enabled === 'boolean' ? input.enabled : current.enabled,
      autoDemoTrading: true,
      startingBalance: DEMO_CAPITAL,
      maxOpenTrades: MAX_ACTIVE_DEMO_TRADES,
      minimumConfidence: this.range(input.minimumConfidence, 0, 100, current.minimumConfidence),
      riskPerTrade: this.range(input.riskPerTrade, .1, 20, current.riskPerTrade),
      allowAiWait: typeof input.allowAiWait === 'boolean' ? input.allowAiWait : current.allowAiWait,
      allowReentry: typeof input.allowReentry === 'boolean' ? input.allowReentry : current.allowReentry,
    };
    const updated = await this.prisma.paperTradingAccount.update({ where: { userId }, data });
    if (updated.autoDemoTrading) {
      const { start, end } = this.tradingDayRange();
      const triggered = await this.prisma.aiSignal.findMany({ where: { userId, status: 'TARGET1_HIT', signalTime: { gte: start, lt: end }, target1At: { not: null }, stopLossAt: null, completedAt: null } });
      await this.captureTriggeredDemoSignals(userId, triggered);
    }
    return updated;
    } catch (error) { this.logError('paper.database.settings.failed', error, { userId }); return this.defaultAccount(userId); }
  }

  async dashboard(userId: string) {
    try {
    this.logger.log(JSON.stringify({ event: 'paper.portfolio.load.start', userId }));
    const account = await this.account(userId);
    await this.reconcilePreTarget1Orders(userId);
    const { start, end } = this.tradingDayRange();
    const target1Signals = await this.prisma.aiSignal.findMany({ where: { userId, status: 'TARGET1_HIT', signalTime: { gte: start, lt: end }, target1At: { not: null }, stopLossAt: null, completedAt: null } });
    await this.captureTriggeredDemoSignals(userId, target1Signals);
    const orders = await this.prisma.paperOrder.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 200 });
    const clock = marketClock();
    const eodRuns = await this.prisma.eodRiskRun.findMany({ where: { tradingDate: clock.tradingDate, userId: { in: ['ALL', userId] } }, orderBy: { startedAt: 'desc' } });
    const riskManager = { ...clock, status: eodRuns.some((run) => run.status === 'RUNNING') ? 'AUTO EXIT RUNNING' : clock.status, alert: eodRuns.find((run) => run.status === 'FAILED')?.alert ?? null };
    const openPositions = orders.filter((order) => order.status === 'OPEN');
    const waitingOrders = orders.filter((order) => order.status === 'WAITING');
    const closedTrades = orders.filter((order) => order.status.startsWith('CLOSED'));
    const shifted = new Date(Date.now() + 330 * 60_000);
    const todayStart = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 330 * 60_000);
    const closedToday = closedTrades.filter((order) => order.exitTime && order.exitTime >= todayStart);
    const usedCapital = openPositions.reduce((sum, order) => sum + order.budget, 0);
    const unrealizedPnl = openPositions.reduce((sum, order) => sum + order.pnl, 0);
    const wins = closedToday.filter((order) => order.pnl > 0), losses = closedToday.filter((order) => order.pnl < 0);
    const sum = (items: typeof closedTrades) => items.reduce((total, order) => total + order.pnl, 0);
    const average = (items: typeof closedTrades) => items.length ? sum(items) / items.length : 0;
    const response = {
      account,
      summary: { virtualBalance: account.startingBalance + account.realizedPnl, usedCapital, availableCapital: Math.max(0, account.startingBalance + account.realizedPnl - usedCapital), todayPnl: sum(closedToday) + unrealizedPnl, openPositions: openPositions.length, closedTrades: closedToday.length, winRate: closedToday.length ? wins.length / closedToday.length * 100 : 0 },
      performance: { todayProfit: sum(wins), todayLoss: Math.abs(sum(losses)), winningTrades: wins.length, losingTrades: losses.length, averageProfit: average(wins), averageLoss: Math.abs(average(losses)), largestWin: wins.length ? Math.max(...wins.map((order) => order.pnl)) : 0, largestLoss: losses.length ? Math.abs(Math.min(...losses.map((order) => order.pnl))) : 0 },
      openPositions, waitingOrders, tradeHistory: closedTrades,
      riskManager,
    };
    const safe = this.sanitize(response);
    this.logger.log(JSON.stringify({ event: 'paper.portfolio.load.success', userId, openPositions: openPositions.length, waitingOrders: waitingOrders.length, history: closedTrades.length, usedCapital: safe.summary.usedCapital, availableCapital: safe.summary.availableCapital }));
    const portfolioSummary = { profit: safe.performance.todayProfit, loss: safe.performance.todayLoss, roi: account.startingBalance ? safe.summary.todayPnl / account.startingBalance * 100 : 0 };
    return { ...safe, balance: safe.summary.virtualBalance, usedCapital: safe.summary.usedCapital, availableCapital: safe.summary.availableCapital, positions: safe.openPositions, history: safe.tradeHistory, summary: { ...safe.summary, ...portfolioSummary } };
    } catch (error) {
      this.logError('paper.portfolio.load.failed', error, { userId });
      return this.emptyPortfolio(userId);
    }
  }

  private async reconcilePreTarget1Orders(userId: string) {
    if (this.legacyReconciliationLocks.has(userId)) return;
    this.legacyReconciliationLocks.add(userId);
    try {
      const openOrders = await this.prisma.paperOrder.findMany({ where: { userId, status: 'OPEN' } });
      const { start, end } = this.tradingDayRange();
      for (const order of openOrders) {
        const signal = order.signalId ? await this.prisma.aiSignal.findUnique({ where: { id: order.signalId } }) : null;
        const currentTradingDay = Boolean(signal && signal.signalTime >= start && signal.signalTime < end);
        const enteredAfterTarget1 = Boolean(currentTradingDay && signal?.target1At && order.entryTime && signal.target1At.getTime() <= order.entryTime.getTime());
        if (enteredAfterTarget1) continue;
        await this.close(order.id, Number(order.currentPrice), 'RULE CHANGE - TARGET 1 REQUIRED', new Date());
        this.logger.warn(JSON.stringify({ event: 'paper.legacy.position.reconciled', userId, orderId: order.id, signalId: order.signalId, symbol: order.symbol }));
      }
    } finally {
      this.legacyReconciliationLocks.delete(userId);
    }
  }

  private async close(orderId: string, price: number, reason: string, at: Date, status = 'CLOSED') {
    try {
    const order = await this.prisma.paperOrder.findUniqueOrThrow({ where: { id: orderId } });
    const result = await this.execution.close({ side: order.side, entryPrice: Number(order.entryPrice), price, quantity: order.quantity, reason, at });
    await this.prisma.$transaction([
      this.prisma.paperOrder.update({ where: { id: order.id }, data: { status, currentPrice: price, durationMinutes: order.entryTime ? Math.max(0, Math.floor((at.getTime() - order.entryTime.getTime()) / 60_000)) : 0, ...result } }),
      this.prisma.paperTradingAccount.update({ where: { userId: order.userId }, data: { realizedPnl: { increment: result.pnl } } }),
    ]);
    this.logger.log(JSON.stringify({ event: 'paper.trade.exit', userId: order.userId, orderId, symbol: order.symbol, price, reason, pnl: result.pnl }));
    } catch (error) { this.logError('paper.trade.close.failed', error, { orderId, price, reason }); throw error; }
  }
  private range(value: unknown, minimum: number, maximum: number, fallback: number) { const number = Number(value); return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback; }
  private tradingDayRange(at = new Date()) {
    const shifted = new Date(at.getTime() + 330 * 60_000);
    const start = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 330 * 60_000);
    return { start, end: new Date(start.getTime() + 86_400_000) };
  }
  private defaultAccount(userId: string) { return { id: '', userId, enabled: true, autoDemoTrading: true, startingBalance: DEMO_CAPITAL, minimumConfidence: 90, maxOpenTrades: MAX_ACTIVE_DEMO_TRADES, riskPerTrade: 2, allowAiWait: true, allowReentry: true, realizedPnl: 0, createdAt: new Date(0), updatedAt: new Date(0) }; }
  private emptyPortfolio(userId: string) {
    const account = this.defaultAccount(userId);
    return { balance: 10_000, usedCapital: 0, availableCapital: 10_000, positions: [], history: [], account, summary: { profit: 0, loss: 0, roi: 0, virtualBalance: 10_000, usedCapital: 0, availableCapital: 10_000, todayPnl: 0, openPositions: 0, closedTrades: 0, winRate: 0 }, performance: { todayProfit: 0, todayLoss: 0, winningTrades: 0, losingTrades: 0, averageProfit: 0, averageLoss: 0, largestWin: 0, largestLoss: 0 }, openPositions: [], waitingOrders: [], tradeHistory: [], riskManager: marketClock() };
  }
  private sanitize<T>(value: T): T {
    if (Array.isArray(value)) return value.map((item) => this.sanitize(item)) as T;
    if (value instanceof Date) return value as T;
    if (value && typeof value === 'object') { const output: Record<string, unknown> = {}; for (const [key, item] of Object.entries(value)) output[key] = item === undefined || (typeof item === 'number' && !Number.isFinite(item)) ? 0 : this.sanitize(item); return output as T; }
    return value;
  }
  private logError(event: string, error: unknown, context: Record<string, unknown>) {
    const exception = error instanceof Error ? error : new Error(String(error));
    const prisma = error && typeof error === 'object' ? { code: 'code' in error ? String(error.code) : undefined, meta: 'meta' in error ? error.meta : undefined } : {};
    this.logger.error(JSON.stringify({ event, ...context, exceptionName: exception.name, message: exception.message, ...prisma, stack: exception.stack }), exception.stack);
  }
}
