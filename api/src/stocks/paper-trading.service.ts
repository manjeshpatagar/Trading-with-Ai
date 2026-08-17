import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { PaperOrderExecutionService } from './paper-order-execution.service';
import { marketClock } from './market-clock';

type TriggeredSignal = { id: string; userId: string; instrumentKey: string; symbol: string; side: string; entryPrice: number; currentPrice: number; stopLoss?: number; target1?: number; target2?: number; target3?: number; confidence: number; aiScore: number; riskReward: number; signalTime: Date; status: string; executionEligible?: boolean; demoExecuted?: boolean; entryTriggeredAt?: Date | null; stopLossAt?: Date | null; completedAt?: Date | null };

const DEMO_CAPITAL = 10_000;
const MAX_ACTIVE_DEMO_TRADES = 1;

export function demoExecutionRejection(signal: TriggeredSignal, at: Date, maxAgeSeconds = 2700) {
  if (signal.status !== 'ENTRY_TRIGGERED') return `SIGNAL_STATUS_${signal.status}`;
  if (!signal.executionEligible) return 'EXECUTION_NOT_ELIGIBLE';
  if (signal.demoExecuted) return 'ALREADY_EXECUTED';
  if (!signal.entryTriggeredAt) return 'ENTRY_TRIGGER_TIMESTAMP_MISSING';
  if (!['BUY', 'SELL'].includes(signal.side)) return 'INVALID_DIRECTION';
  if (![signal.entryPrice, signal.stopLoss, signal.target1].every((value) => Number.isFinite(Number(value)) && Number(value) > 0)) return 'INVALID_TRADE_LEVELS';
  if (at.getTime() - signal.entryTriggeredAt.getTime() > Math.max(1, maxAgeSeconds) * 1000) return 'SIGNAL_EXPIRED';
  return null;
}

export function demoExitReason(side: string, price: number, target3: number, stopLoss: number) {
  const targetHit = side === 'BUY' ? price >= target3 : price <= target3;
  const stopHit = side === 'BUY' ? price <= stopLoss : price >= stopLoss;
  return targetHit ? 'TARGET' : stopHit ? 'STOP_LOSS' : null;
}

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
      const account = await this.prisma.paperTradingAccount.upsert({ where: { userId }, create: { userId, startingBalance: DEMO_CAPITAL, minimumConfidence: 55, maxOpenTrades: MAX_ACTIVE_DEMO_TRADES, autoDemoTrading: false, mode: 'PAUSED' }, update: { maxOpenTrades: MAX_ACTIVE_DEMO_TRADES } });
      this.logger.log(JSON.stringify({ event: 'paper.database.wallet.ready', userId, accountId: account.id, startingBalance: account.startingBalance }));
      return account;
    } catch (error) {
      this.logError('paper.database.wallet.failed', error, { userId });
      throw error;
    }
  }

  async createTrade(userId: string, _row?: unknown) {
    this.logger.warn(JSON.stringify({ event: 'paper.frontend.create.disabled', userId, reason: 'Demo execution is server-side and accepts only approved Single History signals' }));
    return false;
  }

  async captureTriggeredDemoSignals(userId: string, trades: TriggeredSignal[], at = new Date()) {
    const account = await this.account(userId);
    if (!account.autoDemoTrading || account.mode !== 'AUTO') return false;
    this.logger.debug(JSON.stringify({ event: 'demo.monitoring.single_history', userId }));
    for (const trade of trades) {
      const rejection = this.executionRejection(trade, at);
      if (rejection) {
        if (rejection === 'SIGNAL_EXPIRED' && !trade.demoExecuted) await this.prisma.aiSignal.updateMany({ where: { id: trade.id, demoExecuted: false }, data: { executionEligible: false, executionStatus: 'EXPIRED', signalExpiredAt: at } });
        this.logger.debug(JSON.stringify({ event: 'demo.signal.rejected', signalId: trade.id, reason: rejection }));
        continue;
      }
      this.logger.log(JSON.stringify({ event: 'demo.eligible_signal.found', signalId: trade.id, symbol: trade.symbol, side: trade.side, entryPrice: trade.entryPrice }));
      await this.prisma.demoTradeQueue.upsert({
        where: { signalId: trade.id },
        update: {},
        create: { userId, signalId: trade.id, instrumentKey: trade.instrumentKey, symbol: trade.symbol, side: trade.side, entryPrice: trade.entryPrice, confidence: trade.confidence, aiScore: trade.aiScore, riskReward: trade.riskReward, signalTime: trade.signalTime, queuedAt: at },
      });
    }
    return this.drainDemoQueue(userId, at);
  }

  async drainDemoQueue(userId: string, at = new Date()) {
    if (this.demoExecutionLocks.has(userId)) return false;
    this.demoExecutionLocks.add(userId);
    const leased = await this.acquireExecutionLease(userId, at);
    if (!leased) { this.demoExecutionLocks.delete(userId); return false; }
    let changed = false;
    try {
      const account = await this.account(userId);
      if (!account.autoDemoTrading || account.mode !== 'AUTO' || !account.enabled || !marketClock(at).canEnter || account.reconciliationRequired) return false;
      const { start, end } = this.tradingDayRange(at);
      const closedToday = await this.prisma.paperOrder.findMany({ where: { userId, status: { startsWith: 'CLOSED' }, exitTime: { gte: start, lt: end } } });
      const dailyRealized = closedToday.reduce((sum, order) => sum + Number(order.pnl), 0);
      if (dailyRealized <= -(account.startingBalance * account.maxDailyLossPercent / 100) || closedToday.length >= account.maxTradesPerDay) {
        await this.prisma.paperTradingAccount.update({ where: { userId }, data: { autoDemoTrading: false, mode: 'PAUSED', executionState: 'STOPPED', stateReason: dailyRealized < 0 ? 'DAILY LOSS LIMIT REACHED' : 'MAXIMUM DAILY TRADES REACHED' } });
        return false;
      }
      if (account.lastLossAt && at.getTime() - account.lastLossAt.getTime() < account.cooldownAfterLossMinutes * 60_000) return false;
      if (account.lastTradeClosedAt && at.getTime() - account.lastTradeClosedAt.getTime() < account.cooldownAfterTradeMinutes * 60_000) return false;
      await this.prisma.paperTradingAccount.update({ where: { userId }, data: { executionState: 'SCANNING', stateReason: null } });
      while (true) {
        const active = await this.prisma.paperOrder.findMany({ where: { userId, status: 'OPEN' } });
        if (active.length >= MAX_ACTIVE_DEMO_TRADES) break;
        const usedCapital = active.reduce((sum, order) => sum + Number(order.budget), 0);
        const availableCapital = account.startingBalance + account.realizedPnl - usedCapital;
        const allocation = Math.max(0, availableCapital);
        if (allocation <= 0) break;
        const queued = await this.bestQueued(userId, account.minimumConfidence, at);
        if (!queued) break;
        await this.setExecutionState(userId, 'CANDIDATE_FOUND', queued.symbol);
        const signal = await this.prisma.aiSignal.findUnique({ where: { id: queued.signalId } });
        await this.setExecutionState(userId, 'SIGNAL_VALIDATING', queued.symbol);
        const invalidReason = !signal ? 'Signal no longer exists'
          : signal.stopLossAt ? 'Stop loss already reached'
            : signal.completedAt ? 'Trade already completed'
              : signal.status !== 'ENTRY_TRIGGERED' ? `Signal state is ${signal.status}`
                : !signal.entryTriggeredAt ? 'Entry confirmation timestamp is missing'
                  : !signal.executionEligible ? 'Signal is not execution eligible'
                    : signal.demoExecuted ? 'Signal was already demo executed'
                  : null;
        if (invalidReason) {
          await this.prisma.demoTradeQueue.update({ where: { id: queued.id }, data: { status: 'REJECTED', rejectedAt: at, rejectReason: invalidReason } });
          continue;
        }
        if (!signal) continue;
        const executionRejection = this.executionRejection(signal, at);
        if (executionRejection) { await this.prisma.demoTradeQueue.update({ where: { id: queued.id }, data: { status: 'REJECTED', rejectedAt: at, rejectReason: executionRejection } }); continue; }
        const duplicate = await this.prisma.paperOrder.findUnique({ where: { signalId: queued.signalId } });
        if (duplicate) {
          await this.prisma.demoTradeQueue.update({ where: { id: queued.id }, data: { status: 'EXECUTED', executedAt: duplicate.entryTime ?? duplicate.createdAt } });
          continue;
        }
        const signalPrice = Number(signal.currentPrice);
        const slippage = signalPrice * account.slippageBasisPoints / 10_000;
        const executionPrice = signal.side === 'BUY' ? signalPrice + slippage : signalPrice - slippage;
        const currentBalance = account.startingBalance + account.realizedPnl;
        const sizing = calculateDemoIntradayPosition({ capital: allocation, accountBalance: currentBalance, entryPrice: executionPrice, stopLoss: Number(signal.stopLoss), riskPercent: account.riskPerTrade, leverage: Number(process.env.DEMO_INTRADAY_LEVERAGE ?? 1) });
        const quantity = sizing.quantity;
        if (!Number.isFinite(executionPrice) || executionPrice <= 0 || quantity <= 0) {
          await this.prisma.demoTradeQueue.update({ where: { id: queued.id }, data: { status: 'REJECTED', rejectedAt: at, rejectReason: 'Insufficient allocation for one share' } });
          continue;
        }
        const fill = await this.execution.fill({ price: executionPrice, quantity, at });
        const marginUsed = sizing.marginUsed;
        const intelligence = this.readIntelligence(signal.intelligenceJson);
        const evidence = intelligence.historicalEvidence ?? {};
        const tradeId = crypto.randomUUID();
        const executionSnapshot = JSON.stringify({ signalId: signal.id, symbol: signal.symbol, side: signal.side, strategy: signal.strategy, timeframe: signal.timeframe, signalPrice, entryPrice: signal.entryPrice, stopLoss: signal.stopLoss, target1: signal.target1, target2: signal.target2, target3: signal.target3, quantity, capitalAllocated: marginUsed, aiScore: signal.aiScore, confidence: signal.confidence, riskReward: signal.riskReward, generatedAt: signal.signalTime, entryTriggeredAt: signal.entryTriggeredAt, executionEligible: true, demoExecuted: true });
        await this.setExecutionState(userId, 'ENTRY_PENDING', queued.symbol);
        await this.prisma.$transaction(async (tx) => {
          const claimed = await tx.aiSignal.updateMany({ where: { id: signal.id, status: 'ENTRY_TRIGGERED', executionEligible: true, demoExecuted: false }, data: { status: 'RUNNING', runningAt: at, demoExecuted: true, demoTradeId: tradeId, executionStatus: 'DEMO_EXECUTED', executedPrice: executionPrice, executedAt: at, executionSnapshot } });
          if (claimed.count !== 1) throw new Error('SIGNAL_ALREADY_CLAIMED');
          await tx.paperOrder.create({ data: { id: tradeId, userId, signalId: signal.id, instrumentKey: signal.instrumentKey, symbol: signal.symbol, exchange: 'NSE', side: signal.side, setupType: intelligence.setup?.setupType ?? 'UNVERIFIED', signalTime: signal.signalTime, confidence: signal.confidence, aiScore: signal.aiScore, calibratedProbability: evidence.calibratedProbability ?? null, historicalWinRate: evidence.target1HitRate ?? null, historicalExpectancy: evidence.expectancyR ?? null, marketRegime: intelligence.marketContext?.marketRegime ?? null, sectorRegime: intelligence.marketContext?.sectorRegime ?? null, riskReward: signal.riskReward, selectionReason: 'Approved Single History ENTRY_TRIGGERED snapshot', status: 'OPEN', quantity, budget: marginUsed, plannedEntry: signal.entryPrice, entrySignalPrice: signalPrice, slippage, currentPrice: executionPrice, target: signal.target3, target1: signal.target1, target2: signal.target2, stopLoss: signal.stopLoss, initialStopLoss: signal.stopLoss, riskAmount: sizing.riskPerShare * quantity, ...fill } });
          await tx.demoTradeQueue.update({ where: { id: queued.id }, data: { status: 'EXECUTED', executedAt: at } });
          await tx.aiTradeEvent.upsert({ where: { tradeId_type: { tradeId: signal.id, type: 'DEMO_ENTRY_EXECUTED' } }, update: {}, create: { tradeId: signal.id, type: 'DEMO_ENTRY_EXECUTED', triggerPrice: signal.entryPrice, executedPrice: executionPrice, eventTime: at, profitPercent: 0, holdingMinutes: 0 } });
          await tx.aiTradeEvent.upsert({ where: { tradeId_type: { tradeId: signal.id, type: 'RUNNING' } }, update: {}, create: { tradeId: signal.id, type: 'RUNNING', triggerPrice: signal.entryPrice, executedPrice: executionPrice, eventTime: at, profitPercent: 0, holdingMinutes: 0 } });
        });
        changed = true;
        await this.prisma.paperTradingAccount.update({ where: { userId }, data: { executionState: 'OPEN', stateReason: `Monitoring ${signal.symbol}` } });
        this.logger.log(JSON.stringify({ event: 'demo.trade.auto.executed', userId, signalId: signal.id, symbol: signal.symbol, side: signal.side, product: 'INTRADAY', entryPrice: executionPrice, entryTime: at, quantity, marginUsed, notionalValue: fill.investment, leverage: sizing.leverage }));
      }
      if (!changed) await this.setExecutionState(userId, 'MONITORING', 'WAITING FOR ENTRY TRIGGER');
      return changed;
    } finally {
      await this.releaseExecutionLease(userId);
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
      let exitReason: string | null = demoExitReason(order.side, price, order.target, order.stopLoss);
      const heldMinutes = order.entryTime ? Math.floor((at.getTime() - order.entryTime.getTime()) / 60_000) : 0;
      if (!exitReason && heldMinutes >= account.maximumHoldingMinutes) exitReason = 'TIME_STOP';
      if (!exitReason && marketClock(at).shouldAutoExit) exitReason = 'END_OF_DAY';
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
      await this.close(order.id, order.currentPrice, 'MANUAL', new Date());
      await this.drainDemoQueue(userId);
      return true;
    } catch (error) { this.logError('paper.trade.exit.failed', error, { userId, orderId }); return false; }
  }
  async resetAccount(userId: string, confirmation: string) {
    if (confirmation !== 'RESET DEMO ACCOUNT') throw new Error('Explicit reset confirmation is required');
    const open = await this.prisma.paperOrder.count({ where: { userId, status: 'OPEN' } });
    if (open) throw new Error('Close the open demo position before resetting the account');
    await this.prisma.$transaction([
      this.prisma.demoTradeQueue.deleteMany({ where: { userId } }),
      this.prisma.paperOrder.deleteMany({ where: { userId } }),
      this.prisma.paperTradingAccount.update({ where: { userId }, data: { startingBalance: DEMO_CAPITAL, realizedPnl: 0, autoDemoTrading: false, mode: 'PAUSED', executionState: 'WAITING', stateReason: 'DEMO ACCOUNT RESET', lastTradeClosedAt: null, lastLossAt: null, reconciliationRequired: false } }),
    ]);
    this.logger.warn(JSON.stringify({ event: 'paper.account.reset', userId }));
    return this.dashboard(userId);
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
      await this.close(order.id, price, 'END_OF_DAY', at, 'CLOSED - EOD EXIT');
      closed += 1;
    }
    await this.prisma.paperOrder.updateMany({
      where: { status: 'WAITING' },
      data: { status: 'CLOSED - EOD EXIT', exitTime: at, exitReason: 'END_OF_DAY', pnl: 0, pnlPercent: 0, durationMinutes: 0 },
    });
    return closed;
  }

  async updateSettings(userId: string, input: Record<string, unknown>) {
    try {
    const current = await this.account(userId);
    const requestedMode = ['AUTO', 'MANUAL', 'PAUSED'].includes(String(input.mode)) ? String(input.mode) : typeof input.autoDemoTrading === 'boolean' ? input.autoDemoTrading ? 'AUTO' : 'PAUSED' : current.mode;
    const data = {
      enabled: typeof input.enabled === 'boolean' ? input.enabled : current.enabled,
      autoDemoTrading: requestedMode === 'AUTO',
      mode: requestedMode,
      executionState: requestedMode === 'PAUSED' ? 'WAITING' : current.executionState,
      stateReason: requestedMode === 'PAUSED' ? 'AUTO TRADING PAUSED' : null,
      maxOpenTrades: MAX_ACTIVE_DEMO_TRADES,
      minimumConfidence: this.range(input.minimumConfidence, 0, 100, current.minimumConfidence),
      riskPerTrade: this.range(input.riskPerTrade, .1, 5, current.riskPerTrade),
      maxDailyLossPercent: this.range(input.maxDailyLossPercent, .1, 20, current.maxDailyLossPercent),
      maxTradesPerDay: Math.round(this.range(input.maxTradesPerDay, 1, 50, current.maxTradesPerDay)),
      maxSectorExposure: this.range(input.maxSectorExposure, 1, 100, current.maxSectorExposure),
      cooldownAfterLossMinutes: Math.round(this.range(input.cooldownAfterLossMinutes, 0, 240, current.cooldownAfterLossMinutes)),
      cooldownAfterTradeMinutes: Math.round(this.range(input.cooldownAfterTradeMinutes, 0, 240, current.cooldownAfterTradeMinutes)),
      maximumHoldingMinutes: Math.round(this.range(input.maximumHoldingMinutes, 5, 360, current.maximumHoldingMinutes)),
      slippageBasisPoints: this.range(input.slippageBasisPoints, 0, 50, current.slippageBasisPoints),
      allowAiWait: typeof input.allowAiWait === 'boolean' ? input.allowAiWait : current.allowAiWait,
      allowReentry: typeof input.allowReentry === 'boolean' ? input.allowReentry : current.allowReentry,
    };
    const updated = await this.prisma.paperTradingAccount.update({ where: { userId }, data });
    if (updated.autoDemoTrading) {
      const { start, end } = this.tradingDayRange();
      const triggered = await this.prisma.aiSignal.findMany({ where: { userId, status: 'ENTRY_TRIGGERED', executionEligible: true, demoExecuted: false, signalTime: { gte: start, lt: end }, entryTriggeredAt: { not: null }, stopLossAt: null, completedAt: null } });
      await this.captureTriggeredDemoSignals(userId, triggered);
    }
    return updated;
    } catch (error) { this.logError('paper.database.settings.failed', error, { userId }); return this.defaultAccount(userId); }
  }

  async dashboard(userId: string) {
    try {
    this.logger.log(JSON.stringify({ event: 'paper.portfolio.load.start', userId }));
    const account = await this.account(userId);
    await this.reconcileAccount(userId);
    const { start, end } = this.tradingDayRange();
    const approvedSignals = await this.prisma.aiSignal.findMany({ where: { userId, status: 'ENTRY_TRIGGERED', executionEligible: true, demoExecuted: false, signalTime: { gte: start, lt: end }, entryTriggeredAt: { not: null }, stopLossAt: null, completedAt: null } });
    await this.captureTriggeredDemoSignals(userId, approvedSignals);
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
    let equity = 0, peak = 0, maximumDrawdown = 0;
    for (const order of [...closedToday].sort((a, b) => Number(a.exitTime) - Number(b.exitTime))) { equity += order.pnl; peak = Math.max(peak, equity); maximumDrawdown = Math.max(maximumDrawdown, peak - equity); }
    const grossProfit = sum(wins), grossLoss = Math.abs(sum(losses));
    const response = {
      account,
      summary: { virtualBalance: account.startingBalance + account.realizedPnl, usedCapital, availableCapital: Math.max(0, account.startingBalance + account.realizedPnl - usedCapital), realizedPnl: account.realizedPnl, unrealizedPnl, totalPnl: account.realizedPnl + unrealizedPnl, totalReturn: account.startingBalance ? (account.realizedPnl + unrealizedPnl) / account.startingBalance * 100 : 0, todayPnl: sum(closedToday) + unrealizedPnl, openPositions: openPositions.length, closedTrades: closedToday.length, tradesToday: closedToday.length + openPositions.length, winRate: closedToday.length ? wins.length / closedToday.length * 100 : 0 },
      performance: { todayProfit: grossProfit, todayLoss: grossLoss, winningTrades: wins.length, losingTrades: losses.length, averageProfit: average(wins), averageLoss: Math.abs(average(losses)), profitFactor: grossLoss ? grossProfit / grossLoss : null, maximumDrawdown, largestWin: wins.length ? Math.max(...wins.map((order) => order.pnl)) : 0, largestLoss: losses.length ? Math.abs(Math.min(...losses.map((order) => order.pnl))) : 0 },
      openPositions, waitingOrders, waitingQueue: await this.prisma.aiSignal.findMany({ where: { userId, status: 'ENTRY_TRIGGERED', executionEligible: true, demoExecuted: false }, orderBy: { entryTriggeredAt: 'asc' } }), tradeHistory: closedTrades,
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
    const durationMinutes = order.entryTime ? Math.max(0, Math.floor((at.getTime() - order.entryTime.getTime()) / 60_000)) : 0;
    const operations: any[] = [
      this.prisma.paperOrder.update({ where: { id: order.id }, data: { status, currentPrice: price, durationMinutes: order.entryTime ? Math.max(0, Math.floor((at.getTime() - order.entryTime.getTime()) / 60_000)) : 0, ...result } }),
      this.prisma.paperTradingAccount.update({ where: { userId: order.userId }, data: { realizedPnl: { increment: result.pnl }, lastTradeClosedAt: at, ...(result.pnl < 0 ? { lastLossAt: at } : {}), executionState: 'POST_TRADE_CHECK', stateReason: reason } }),
    ];
    if (order.signalId) {
      const stopped = reason === 'STOP_LOSS';
      operations.push(this.prisma.aiSignal.update({ where: { id: order.signalId }, data: { status: stopped ? 'STOPLOSS_HIT' : 'COMPLETED', executionStatus: 'COMPLETED', completedAt: at, ...(stopped ? { stopLossAt: at, stopLossHitAt: at } : { target3At: reason === 'TARGET' ? at : undefined, target3HitAt: reason === 'TARGET' ? at : undefined, target3ExecutedPrice: reason === 'TARGET' ? price : undefined }), exitPrice: price, profitPercent: result.pnlPercent, lossPercent: Math.abs(Math.min(0, result.pnlPercent)), holdingMinutes: durationMinutes } }));
      const eventType = stopped ? 'STOPLOSS_HIT' : reason === 'TARGET' ? 'TARGET3_HIT' : 'COMPLETED';
      operations.push(this.prisma.aiTradeEvent.upsert({ where: { tradeId_type: { tradeId: order.signalId, type: eventType } }, update: {}, create: { tradeId: order.signalId, type: eventType, triggerPrice: stopped ? order.stopLoss : reason === 'TARGET' ? order.target : price, executedPrice: price, eventTime: at, profitPercent: result.pnlPercent, holdingMinutes: durationMinutes } }));
      if (eventType !== 'COMPLETED') operations.push(this.prisma.aiTradeEvent.upsert({ where: { tradeId_type: { tradeId: order.signalId, type: 'COMPLETED' } }, update: {}, create: { tradeId: order.signalId, type: 'COMPLETED', triggerPrice: price, executedPrice: price, eventTime: at, profitPercent: result.pnlPercent, holdingMinutes: durationMinutes } }));
    }
    await this.prisma.$transaction(operations);
    this.logger.log(JSON.stringify({ event: 'paper.trade.exit', userId: order.userId, orderId, symbol: order.symbol, price, reason, pnl: result.pnl }));
    } catch (error) { this.logError('paper.trade.close.failed', error, { orderId, price, reason }); throw error; }
  }
  private async bestQueued(userId: string, _minimumProbability: number, _at: Date) {
    const queued = await this.prisma.demoTradeQueue.findMany({ where: { userId, status: 'WAITING_FOR_CAPITAL' }, orderBy: { signalTime: 'desc' }, take: 100 });
    if (!queued.length) return null;
    return queued.sort((left, right) => right.confidence - left.confidence || right.aiScore - left.aiScore || right.riskReward - left.riskReward || right.signalTime.getTime() - left.signalTime.getTime())[0] ?? null;
  }
  private executionRejection(signal: TriggeredSignal, at: Date) {
    const maxAgeSeconds = Math.max(1, Number(process.env.DEMO_SIGNAL_MAX_AGE_SECONDS ?? 2700));
    return demoExecutionRejection(signal, at, maxAgeSeconds);
  }
  private readIntelligence(value: string | null | undefined): any { try { return value ? JSON.parse(value) : {}; } catch { return {}; } }
  private async setExecutionState(userId: string, executionState: string, stateReason: string | null = null) { await this.prisma.paperTradingAccount.update({ where: { userId }, data: { executionState, stateReason } }); }
  private async reconcileAccount(userId: string) {
    const open = await this.prisma.paperOrder.findMany({ where: { userId, status: 'OPEN' } });
    const invalid = open.length > MAX_ACTIVE_DEMO_TRADES || open.some((order) => !Number.isFinite(order.budget) || order.budget < 0 || !Number.isFinite(order.currentPrice) || order.quantity <= 0);
    await this.prisma.paperTradingAccount.update({ where: { userId }, data: { reconciliationRequired: invalid, ...(invalid ? { executionState: 'STOPPED', stateReason: 'SYSTEM REQUIRES RECONCILIATION', autoDemoTrading: false, mode: 'PAUSED' } : {}) } });
    return !invalid;
  }
  private async acquireExecutionLease(userId: string, at: Date) {
    if (!this.prisma.demoExecutionLease) return true;
    await this.prisma.demoExecutionLease.deleteMany({ where: { userId, expiresAt: { lte: at } } });
    try { await this.prisma.demoExecutionLease.create({ data: { userId, acquiredAt: at, expiresAt: new Date(at.getTime() + 30_000) } }); return true; }
    catch { return false; }
  }
  private async releaseExecutionLease(userId: string) { if (this.prisma.demoExecutionLease) await this.prisma.demoExecutionLease.deleteMany({ where: { userId } }); }
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
