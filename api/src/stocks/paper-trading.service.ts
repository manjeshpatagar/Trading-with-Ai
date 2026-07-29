import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { PaperOrderExecutionService } from './paper-order-execution.service';
import { marketClock } from './market-clock';

type Candidate = { instrumentKey: string; symbol: string; signal: string; confidence: number; price: number; entry?: number | null; stopLoss?: number | null; target3?: number | null };
type TriggeredSignal = { id: string; userId: string; instrumentKey: string; symbol: string; side: string; entryPrice: number; currentPrice: number; confidence: number; aiScore: number; riskReward: number; signalTime: Date; status: string; entryTriggeredAt?: Date | null; target1At?: Date | null; stopLossAt?: Date | null; completedAt?: Date | null };

@Injectable()
export class PaperTradingService {
  private readonly logger = new Logger(PaperTradingService.name);
  private readonly demoExecutionLocks = new Set<string>();
  constructor(private readonly prisma: PrismaService, private readonly execution: PaperOrderExecutionService) {}

  async account(userId: string) {
    try {
      this.logger.log(JSON.stringify({ event: 'paper.database.wallet.initialize', userId }));
      const account = await this.prisma.paperTradingAccount.upsert({ where: { userId }, create: { userId, startingBalance: 10_000 }, update: {} });
      this.logger.log(JSON.stringify({ event: 'paper.database.wallet.ready', userId, accountId: account.id, startingBalance: account.startingBalance }));
      return account;
    } catch (error) {
      this.logError('paper.database.wallet.failed', error, { userId });
      throw error;
    }
  }

  async createTrade(userId: string, row?: Candidate) {
    try {
      if (!marketClock().canEnter) {
        this.logger.warn(JSON.stringify({ event: 'paper.trade.create.rejected', userId, reason: 'New entries are disabled outside 09:15-15:15 IST' }));
        return false;
      }
      if (!row || !['BUY', 'SELL'].includes(row.signal)) {
        this.logger.warn(JSON.stringify({ event: 'paper.trade.create.rejected', userId, reason: 'Scanner candidate is unavailable' }));
        return false;
      }
      const account = await this.account(userId);
      if (!account.enabled || row.confidence < account.minimumConfidence) return false;
      const activeCount = await this.prisma.paperOrder.count({ where: { userId, status: { in: ['WAITING', 'OPEN'] } } });
      if (activeCount >= account.maxOpenTrades) return false;
      const previous = await this.prisma.paperOrder.findFirst({ where: { userId, instrumentKey: row.instrumentKey } });
      if (previous) {
        this.logger.warn(JSON.stringify({ event: 'paper.trade.create.rejected', userId, instrumentKey: row.instrumentKey, reason: 'Instrument was already traded' }));
        return false;
      }
      const budget = account.startingBalance * .9 / Math.min(account.maxOpenTrades, 4);
      const entry = Number(row.entry), stopLoss = Number(row.stopLoss), target = Number(row.target3);
      if (![entry, stopLoss, target, row.price].every(Number.isFinite) || entry <= 0) return false;
      const budgetQuantity = Math.floor(budget / entry);
      const riskCapital = account.startingBalance * account.riskPerTrade / 100;
      const riskQuantity = Math.abs(entry - stopLoss) > 0 ? Math.floor(riskCapital / Math.abs(entry - stopLoss)) : budgetQuantity;
      const quantity = Math.max(0, Math.min(budgetQuantity, riskQuantity));
      if (!quantity) return false;
      await this.prisma.paperOrder.create({ data: { userId, instrumentKey: row.instrumentKey, symbol: row.symbol, side: row.signal, confidence: row.confidence, quantity, budget, plannedEntry: entry, currentPrice: row.price, investment: 0, target, stopLoss } });
      this.logger.log(JSON.stringify({ event: 'paper.trade.created', userId, symbol: row.symbol, side: row.signal, quantity, budget, plannedEntry: entry }));
      return true;
    } catch (error) { this.logError('paper.trade.create.failed', error, { userId }); return false; }
  }

  async captureTriggeredDemoSignals(userId: string, trades: TriggeredSignal[], at = new Date()) {
    const account = await this.account(userId);
    if (!account.autoDemoTrading) return false;
    for (const trade of trades) {
      if (trade.status !== 'ENTRY_TRIGGERED' || !trade.entryTriggeredAt || !['BUY', 'SELL'].includes(trade.side)) continue;
      const crossed = trade.side === 'BUY' ? trade.currentPrice >= trade.entryPrice : trade.currentPrice <= trade.entryPrice;
      if (!crossed) continue;
      await this.prisma.demoTradeQueue.upsert({
        where: { signalId: trade.id },
        update: {},
        create: { userId, signalId: trade.id, instrumentKey: trade.instrumentKey, symbol: trade.symbol, side: trade.side, entryPrice: trade.entryPrice, confidence: trade.confidence, aiScore: trade.aiScore, riskReward: trade.riskReward, signalTime: trade.signalTime, queuedAt: trade.entryTriggeredAt ?? at },
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
        const active = await this.prisma.paperOrder.findMany({ where: { userId, status: { in: ['WAITING', 'OPEN'] } } });
        if (active.length >= account.maxOpenTrades) break;
        const usedCapital = active.reduce((sum, order) => sum + Number(order.investment || order.budget), 0);
        const availableCapital = account.startingBalance + account.realizedPnl - usedCapital;
        const allocation = account.startingBalance / account.maxOpenTrades;
        if (availableCapital < allocation) break;
        const queued = await this.prisma.demoTradeQueue.findFirst({ where: { userId, status: 'WAITING_FOR_CAPITAL' }, orderBy: [{ confidence: 'desc' }, { aiScore: 'desc' }, { riskReward: 'desc' }, { signalTime: 'desc' }] });
        if (!queued) break;
        const signal = await this.prisma.aiSignal.findUnique({ where: { id: queued.signalId } });
        const invalidReason = !signal ? 'Signal no longer exists'
          : signal.target1At ? 'Target 1 already reached'
            : signal.stopLossAt ? 'Stop loss already reached'
              : signal.completedAt ? 'Trade already completed'
                : !['ENTRY_TRIGGERED', 'RUNNING'].includes(signal.status) ? `Signal state is ${signal.status}`
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
        const quantity = Math.floor(allocation / executionPrice);
        if (!Number.isFinite(executionPrice) || executionPrice <= 0 || quantity <= 0) {
          await this.prisma.demoTradeQueue.update({ where: { id: queued.id }, data: { status: 'REJECTED', rejectedAt: at, rejectReason: 'Insufficient allocation for one share' } });
          continue;
        }
        const fill = await this.execution.fill({ price: executionPrice, quantity, at });
        await this.prisma.$transaction([
          this.prisma.paperOrder.create({ data: { userId, signalId: signal.id, instrumentKey: signal.instrumentKey, symbol: signal.symbol, side: signal.side, confidence: signal.confidence, status: 'OPEN', quantity, budget: allocation, plannedEntry: signal.entryPrice, currentPrice: executionPrice, target: signal.target3, stopLoss: signal.stopLoss, ...fill } }),
          this.prisma.demoTradeQueue.update({ where: { id: queued.id }, data: { status: 'EXECUTED', executedAt: at } }),
        ]);
        changed = true;
        this.logger.log(JSON.stringify({ event: 'demo.trade.auto.executed', userId, signalId: signal.id, symbol: signal.symbol, side: signal.side, entryPrice: executionPrice, entryTime: at, quantity, allocatedCapital: allocation }));
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
    const orders = await this.prisma.paperOrder.findMany({ where: { userId, instrumentKey, status: { in: ['WAITING', 'OPEN'] } } });
    let changed = false;
    for (const order of orders) {
      if (order.status === 'WAITING') {
        if (!marketClock(at).canEnter) continue;
        const reached = order.side === 'BUY' ? price >= order.plannedEntry : price <= order.plannedEntry;
        if (!reached) { await this.prisma.paperOrder.update({ where: { id: order.id }, data: { currentPrice: price } }); continue; }
        const openInvestment = await this.prisma.paperOrder.aggregate({ where: { userId, status: 'OPEN' }, _sum: { investment: true } });
        const available = account.startingBalance + account.realizedPnl - Number(openInvestment._sum.investment ?? 0);
        const fill = await this.execution.fill({ price, quantity: order.quantity, at });
        if (fill.investment > available) continue;
        await this.prisma.paperOrder.update({ where: { id: order.id }, data: { status: 'OPEN', currentPrice: price, ...fill } });
        changed = true;
        continue;
      }
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
      autoDemoTrading: typeof input.autoDemoTrading === 'boolean' ? input.autoDemoTrading : current.autoDemoTrading,
      startingBalance: this.range(input.startingBalance, 1000, 10_000_000, current.startingBalance),
      maxOpenTrades: Math.round(this.range(input.maxOpenTrades, 1, 20, current.maxOpenTrades)),
      minimumConfidence: this.range(input.minimumConfidence, 0, 100, current.minimumConfidence),
      riskPerTrade: this.range(input.riskPerTrade, .1, 20, current.riskPerTrade),
      allowAiWait: typeof input.allowAiWait === 'boolean' ? input.allowAiWait : current.allowAiWait,
      allowReentry: typeof input.allowReentry === 'boolean' ? input.allowReentry : current.allowReentry,
    };
    const updated = await this.prisma.paperTradingAccount.update({ where: { userId }, data });
    if (updated.autoDemoTrading) {
      const triggered = await this.prisma.aiSignal.findMany({ where: { userId, status: 'ENTRY_TRIGGERED', entryTriggeredAt: { not: null }, target1At: null, stopLossAt: null, completedAt: null } });
      await this.captureTriggeredDemoSignals(userId, triggered);
    }
    return updated;
    } catch (error) { this.logError('paper.database.settings.failed', error, { userId }); return this.defaultAccount(userId); }
  }

  async dashboard(userId: string) {
    try {
    this.logger.log(JSON.stringify({ event: 'paper.portfolio.load.start', userId }));
    const account = await this.account(userId);
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
    const usedCapital = openPositions.reduce((sum, order) => sum + order.investment, 0);
    const unrealizedPnl = openPositions.reduce((sum, order) => sum + order.pnl, 0);
    const wins = closedToday.filter((order) => order.pnl > 0), losses = closedToday.filter((order) => order.pnl < 0);
    const sum = (items: typeof closedTrades) => items.reduce((total, order) => total + order.pnl, 0);
    const average = (items: typeof closedTrades) => items.length ? sum(items) / items.length : 0;
    const response = {
      account,
      summary: { virtualBalance: account.startingBalance + account.realizedPnl, usedCapital, availableCapital: account.startingBalance + account.realizedPnl - usedCapital, todayPnl: sum(closedToday) + unrealizedPnl, openPositions: openPositions.length, closedTrades: closedToday.length, winRate: closedToday.length ? wins.length / closedToday.length * 100 : 0 },
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
  private defaultAccount(userId: string) { return { id: '', userId, enabled: true, autoDemoTrading: false, startingBalance: 10_000, minimumConfidence: 90, maxOpenTrades: 4, riskPerTrade: 2, allowAiWait: true, allowReentry: true, realizedPnl: 0, createdAt: new Date(0), updatedAt: new Date(0) }; }
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
