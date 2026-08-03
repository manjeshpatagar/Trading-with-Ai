import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { PaperOrderExecutionService } from './paper-order-execution.service';
import { marketClock } from './market-clock';
import type { ScanRow } from './scanner.service';

type Candidate = { instrumentKey: string; symbol: string; signal: string; confidence: number; price: number; entry?: number | null; stopLoss?: number | null; target3?: number | null };
type TriggeredSignal = { id: string; userId: string; instrumentKey: string; symbol: string; side: string; entryPrice: number; currentPrice: number; confidence: number; aiScore: number; riskReward: number; signalTime: Date; status: string; stopLoss: number; target1: number; target2: number; target3: number; entryTriggeredAt?: Date | null; target1At?: Date | null; stopLossAt?: Date | null; completedAt?: Date | null };
const DEMO_CAPITAL_PER_TRADE = 10_000;
const MAX_DEMO_OPEN_TRADES = 5;
const MINIMUM_RISK_REWARD = 3;
const RISK_REWARD_EPSILON = 1e-9;

type DemoCandleDecision = {
  action: 'HOLD' | 'EXIT' | 'BOOK PROFIT' | 'TRAIL STOP' | 'REDUCE RISK';
  reason: string;
  trailingStop?: number;
  strength: 'WEAK' | 'MODERATE' | 'STRONG' | 'VERY STRONG';
  currentTarget?: number;
  timeRemainingSeconds: number;
};

@Injectable()
export class PaperTradingService {
  private readonly logger = new Logger(PaperTradingService.name);
  private readonly demoExecutionLocks = new Set<string>();
  private readonly completedDailyResets = new Map<string, string>();
  private readonly dailyResetTasks = new Map<string, Promise<void>>();
  private readonly liveMarks = new Map<string, { currentPrice: number; pnl: number; pnlPercent: number }>();
  private readonly evaluatedDemoCandles = new Map<string, number>();
  private readonly demoDecisionStates = new Map<string, DemoCandleDecision>();
  constructor(private readonly prisma: PrismaService, private readonly execution: PaperOrderExecutionService) {}

  async account(userId: string) {
    try {
      this.logger.log(JSON.stringify({ event: 'paper.database.wallet.initialize', userId }));
      const account = await this.prisma.paperTradingAccount.upsert({
        where: { userId },
        create: { userId, autoDemoTrading: true, startingBalance: 10_000, maxOpenTrades: MAX_DEMO_OPEN_TRADES },
        update: {},
      });
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
      if (!account.enabled) {
        this.logDemoSkip('Demo Trading service disabled for account', { userId, instrumentKey: row.instrumentKey });
        return false;
      }
      if (row.confidence < account.minimumConfidence) {
        this.logDemoSkip('Confidence too low', { userId, instrumentKey: row.instrumentKey, confidence: row.confidence, minimumConfidence: account.minimumConfidence });
        return false;
      }
      const now = new Date();
      await this.resetExpiredDemoState(userId, now);
      const { start, end } = this.tradingDayBounds(now);
      const active = await this.prisma.paperOrder.findMany({
        where: { userId, status: { in: ['WAITING', 'OPEN'] }, createdAt: { gte: start, lt: end } },
      });
      if (account.maxOpenTrades > 0 && active.length >= Math.min(MAX_DEMO_OPEN_TRADES, account.maxOpenTrades)) {
        this.logDemoSkip('Max trades reached', { userId, instrumentKey: row.instrumentKey, openTrades: active.length, maxOpenTrades: account.maxOpenTrades });
        return false;
      }
      const availableCapital = account.startingBalance + account.realizedPnl
        - active.reduce((sum, order) => sum + Number(order.budget), 0);
      if (availableCapital < DEMO_CAPITAL_PER_TRADE) {
        this.logDemoSkip('Capital unavailable', { userId, instrumentKey: row.instrumentKey, availableCapital, requiredCapital: DEMO_CAPITAL_PER_TRADE });
        return false;
      }
      const previous = await this.prisma.paperOrder.findFirst({
        where: { userId, instrumentKey: row.instrumentKey, createdAt: { gte: start, lt: end } },
      });
      if (previous) {
        this.logger.warn(JSON.stringify({ event: 'paper.trade.create.rejected', userId, instrumentKey: row.instrumentKey, reason: 'Instrument was already traded' }));
        return false;
      }
      const budget = DEMO_CAPITAL_PER_TRADE;
      const entry = Number(row.entry), stopLoss = Number(row.stopLoss), target = Number(row.target3);
      if (![entry, stopLoss, target, row.price].every(Number.isFinite) || entry <= 0) {
        this.logDemoSkip('Invalid scanner prices', { userId, instrumentKey: row.instrumentKey, entry, stopLoss, target, currentPrice: row.price });
        return false;
      }
      const budgetQuantity = Math.floor(budget / entry);
      const riskCapital = account.startingBalance * account.riskPerTrade / 100;
      const riskQuantity = Math.abs(entry - stopLoss) > 0 ? Math.floor(riskCapital / Math.abs(entry - stopLoss)) : budgetQuantity;
      const quantity = Math.max(0, Math.min(budgetQuantity, riskQuantity));
      if (!quantity) {
        this.logDemoSkip('Capital allocation returned zero', { userId, instrumentKey: row.instrumentKey, budget, entry, riskCapital, riskQuantity, budgetQuantity });
        return false;
      }
      await this.prisma.paperOrder.create({ data: { userId, instrumentKey: row.instrumentKey, symbol: row.symbol, side: row.signal, confidence: row.confidence, quantity, budget, plannedEntry: entry, currentPrice: row.price, investment: 0, target, stopLoss } });
      this.logger.log(JSON.stringify({ event: 'paper.trade.created', userId, symbol: row.symbol, side: row.signal, quantity, budget, plannedEntry: entry }));
      return true;
    } catch (error) { this.logError('paper.trade.create.failed', error, { userId }); return false; }
  }

  async captureTriggeredDemoSignals(userId: string, trades: TriggeredSignal[], at = new Date()) {
    await this.resetExpiredDemoState(userId, at);
    const account = await this.account(userId);
    for (const trade of trades) {
      this.logger.log(JSON.stringify({
        event: 'demo.signal.received',
        message: '[Paper] Signal received',
        userId,
        signalId: trade.id,
        symbol: trade.symbol,
        status: trade.status,
        entryTriggeredAt: trade.entryTriggeredAt ?? null,
      }));
    }
    if (!account.autoDemoTrading) {
      this.logDemoSkip('Auto trading disabled', { userId, receivedSignals: trades.length });
      return false;
    }
    return this.drainDemoQueue(userId, at);
  }

  /**
   * Called after each scanner candle has been persisted to signal history.
   * Demo entries and management decisions are deliberately made here, where
   * volume and indicator confirmation are available, never from an LTP alone.
   */
  async evaluateCandleRows(userId: string, rows: ScanRow[], at = new Date()) {
    await this.resetExpiredDemoState(userId, at);
    for (const row of rows) {
      const candleTime = this.candleTime(row, at);
    }
    const entryChanged = await this.drainDemoQueue(userId, at);
    let positionChanged = false;
    for (const row of rows) {
      const orders = await this.prisma.paperOrder.findMany({
        where: { userId, instrumentKey: row.instrumentKey, status: 'OPEN' },
      });
      for (const order of orders) {
        const candleTime = this.candleTime(row, at);
        if ((this.evaluatedDemoCandles.get(order.id) ?? 0) >= candleTime.getTime()) continue;
        this.evaluatedDemoCandles.set(order.id, candleTime.getTime());
        const signal = order.signalId
          ? await this.prisma.aiSignal.findUnique({ where: { id: order.signalId } })
          : await this.prisma.aiSignal.findFirst({ where: { userId, instrumentKey: row.instrumentKey }, orderBy: { signalTime: 'desc' } });
        const decision = this.demoDecision(order, signal, row, at);
        this.demoDecisionStates.set(order.id, decision);
        if (decision.trailingStop != null && this.improvesStop(order.side, Number(order.stopLoss), decision.trailingStop)) {
          await this.prisma.paperOrder.update({
            where: { id: order.id },
            data: { stopLoss: decision.trailingStop, currentPrice: row.price },
          });
          order.stopLoss = decision.trailingStop;
          positionChanged = true;
        }
        if (['EXIT', 'BOOK PROFIT'].includes(decision.action)) {
          await this.close(order.id, row.price, decision.reason, at);
          positionChanged = true;
        } else {
          this.markOpenOrder(order, row.price);
          this.logger.log(JSON.stringify({
            event: 'demo.trade.candle.decision',
            userId,
            orderId: order.id,
            symbol: order.symbol,
            action: decision.action,
            reason: decision.reason,
            trailingStop: decision.trailingStop ?? order.stopLoss,
            candleTime,
          }));
        }
      }
    }
    return entryChanged || positionChanged;
  }

  async drainDemoQueue(userId: string, at = new Date()) {
    if (this.demoExecutionLocks.has(userId)) {
      this.logDemoSkip('Queue blocked: execution already in progress', { userId });
      return false;
    }
    this.demoExecutionLocks.add(userId);
    let changed = false;
    try {
      const account = await this.account(userId);
      if (!account.autoDemoTrading) {
        this.logDemoSkip('Auto trading disabled', { userId });
        return false;
      }
      if (!account.enabled) {
        this.logDemoSkip('Demo Trading service disabled for account', { userId });
        return false;
      }
      const clock = marketClock(at);
      if (!clock.canEnter) {
        this.logDemoSkip('Signal expired or market entry window closed', { userId, marketStatus: clock.status, at });
        return false;
      }
      this.logger.log(JSON.stringify({ event: 'demo.validation.started', message: '[Demo] Queue check passed', userId }));
      const { start, end } = this.tradingDayBounds(at);
      changed = await this.executeUnlimitedSignals(userId, start, end, at);
      return changed;
    } finally {
      this.demoExecutionLocks.delete(userId);
    }
  }

  async processTick(userId: string, instrumentKey: string, price: number, at = new Date()) {
    try {
      await this.resetExpiredDemoState(userId, at);
      const account = await this.prisma.paperTradingAccount.findUnique({ where: { userId } });
      if (!account?.enabled) {
        this.logDemoSkip('Demo Trading service disabled or account missing', { userId, instrumentKey });
        return false;
      }
      if (!Number.isFinite(price) || price <= 0) {
        this.logDemoSkip('Invalid tick price', { userId, instrumentKey, price });
        return false;
      }
      const orders = await this.prisma.paperOrder.findMany({ where: { userId, instrumentKey, status: { in: ['WAITING', 'OPEN'] } } });
      let changed = false;
      for (const order of orders) {
        this.logger.log(JSON.stringify({ event: 'demo.tick.received', message: '[Demo Tick]', userId, orderId: order.id, symbol: order.symbol, instrumentKey, livePrice: price, at }));
        if (order.status === 'WAITING') {
          const reached = order.side === 'BUY' ? price >= order.plannedEntry : price <= order.plannedEntry;
          const marketValue = price * order.quantity;
          await this.retryWrite(() => this.prisma.paperOrder.update({ where: { id: order.id }, data: { currentPrice: price, marketValue } }));
          changed = true;
          if (!marketClock(at).canEnter || !reached) continue;
          const fill = await this.execution.fill({ price, quantity: order.quantity, at });
          await this.retryWrite(() => this.prisma.paperOrder.update({ where: { id: order.id }, data: { status: 'OPEN', tradeStage: 'RUNNING', currentPrice: price, marketValue, ...fill } }));
          continue;
        }

        const entryPrice = Number(order.entryPrice);
        const quantity = Number(order.quantity);
        const pnl = (order.side === 'BUY' ? price - entryPrice : entryPrice - price) * quantity;
        const pnlPercent = entryPrice && quantity ? pnl / (entryPrice * quantity) * 100 : 0;
        const marketValue = price * quantity;
        const holdingDuration = order.entryTime ? Math.max(0, Math.floor((at.getTime() - order.entryTime.getTime()) / 60_000)) : 0;
        const linked = order.signalId
          ? await this.prisma.aiSignal.findUnique({ where: { id: order.signalId }, include: { stopLossDecision: true, managementDecision: true } })
          : await this.prisma.aiSignal.findFirst({ where: { userId, instrumentKey }, include: { stopLossDecision: true, managementDecision: true }, orderBy: { signalTime: 'desc' } });
        const target1 = Number(order.target1 ?? linked?.target1);
        const target2 = Number(order.target2 ?? linked?.target2);
        const target3 = Number(order.target);
        const crossed = (level: number) => Number.isFinite(level) && (order.side === 'BUY' ? price >= level : price <= level);
        const target1Hit = crossed(target1);
        const target2Hit = crossed(target2);
        const target3Hit = crossed(target3);
        const stopLossHit = order.side === 'BUY' ? price <= order.stopLoss : price >= order.stopLoss;
        const aiExit = linked?.stopLossDecision?.status === 'EXIT'
          || linked?.managementDecision?.action === 'EXIT'
          || linked?.managementDecision?.action === 'BOOK PROFIT';
        const squareOff = marketClock(at).shouldAutoExit;
        const tradeStage = target3Hit ? 'TARGET3_HIT' : target2Hit ? 'TARGET2_HIT' : target1Hit ? 'TARGET1_HIT' : 'RUNNING';

        await this.retryWrite(() => this.prisma.paperOrder.update({
          where: { id: order.id },
          data: { currentPrice: price, marketValue, pnl, pnlPercent, unrealizedPnl: pnl, unrealizedPnlPercent: pnlPercent, durationMinutes: holdingDuration, tradeStage },
        }));
        this.liveMarks.set(order.id, { currentPrice: price, pnl, pnlPercent });
        changed = true;
        this.logger.log(JSON.stringify({ event: 'demo.position.updated', message: '[Demo Position Updated]', userId, orderId: order.id, symbol: order.symbol, entryPrice, currentPrice: price, marketValue, pnl, pnlPercent, holdingDuration }));
        this.logger.log(JSON.stringify({ event: 'demo.target.check', message: '[Target Check]', userId, orderId: order.id, symbol: order.symbol, livePrice: price, target1, target1Hit, target2, target2Hit, target3, target3Hit, tradeStage }));
        this.logger.log(JSON.stringify({ event: 'demo.stoploss.check', message: '[Stop Loss Check]', userId, orderId: order.id, symbol: order.symbol, side: order.side, livePrice: price, stopLoss: order.stopLoss, stopLossHit }));

        const exitReason = stopLossHit ? 'STOP LOSS' : target3Hit ? 'TARGET 3' : aiExit ? 'AI EXIT' : squareOff ? 'SQUARE OFF TIME' : null;
        if (exitReason) {
          await this.close(order.id, price, exitReason, at);
          this.logger.log(JSON.stringify({ event: 'demo.trade.closed', message: '[Trade Closed]', userId, orderId: order.id, symbol: order.symbol, exitPrice: price, exitReason, realizedPnl: pnl, exitTime: at }));
        }
      }
      if (changed) await this.drainDemoQueue(userId, at);
      return changed;
    } catch (error) { this.logError('paper.portfolio.tick.failed', error, { userId, instrumentKey, price }); return false; }
  }

  async manualExit(userId: string, orderId: string) {
    try {
      const order = await this.prisma.paperOrder.findFirst({ where: { id: orderId, userId, status: 'OPEN' } });
      if (!order) { this.logger.warn(JSON.stringify({ event: 'paper.trade.exit.skipped', userId, orderId, reason: 'Open position not found' })); return false; }
      await this.close(order.id, this.liveMarks.get(order.id)?.currentPrice ?? order.currentPrice, 'MANUAL EXIT', new Date());
      await this.drainDemoQueue(userId);
      return true;
    } catch (error) { this.logError('paper.trade.exit.failed', error, { userId, orderId }); return false; }
  }

  async closeAllEod(at = new Date()) {
    const orders = await this.prisma.paperOrder.findMany({ where: { status: 'OPEN' } });
    let closed = 0;
    for (const order of orders) {
      const price = Number(this.liveMarks.get(order.id)?.currentPrice ?? order.currentPrice);
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
      maxOpenTrades: Math.round(this.range(input.maxOpenTrades, 0, MAX_DEMO_OPEN_TRADES, current.maxOpenTrades)),
      minimumConfidence: this.range(input.minimumConfidence, 0, 100, current.minimumConfidence),
      riskPerTrade: this.range(input.riskPerTrade, .1, 20, current.riskPerTrade),
      allowAiWait: typeof input.allowAiWait === 'boolean' ? input.allowAiWait : current.allowAiWait,
      allowReentry: typeof input.allowReentry === 'boolean' ? input.allowReentry : current.allowReentry,
    };
    const updated = await this.prisma.paperTradingAccount.update({ where: { userId }, data });
    if (current.maxOpenTrades !== 0 && updated.maxOpenTrades === 0) {
      await this.prisma.demoTradeQueue.updateMany({
        where: { userId, status: 'WAITING_FOR_CAPITAL' },
        data: { status: 'REJECTED', rejectedAt: new Date(), rejectReason: 'Unlimited mode executes signals directly' },
      });
    }
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
    const now = new Date();
    await this.resetExpiredDemoState(userId, now);
    const account = await this.account(userId);
    const { start, end } = this.tradingDayBounds(now);
    const storedOrders = await this.prisma.paperOrder.findMany({
      where: { userId, createdAt: { gte: start, lt: end } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const orders = storedOrders.map((order) => {
      const mark = this.liveMarks.get(order.id);
      const decision = this.demoDecisionStates.get(order.id);
      const live = mark && ['WAITING', 'OPEN'].includes(order.status) ? { ...order, ...mark } : order;
      return decision ? {
        ...live,
        trailingStop: decision.trailingStop ?? order.stopLoss,
        aiDecision: decision.action,
        decisionReason: decision.reason,
        strength: decision.strength,
        currentTarget: decision.currentTarget ?? order.target,
        timeRemainingSeconds: decision.timeRemainingSeconds,
      } : live;
    });
    const clock = marketClock(now);
    const eodRuns = await this.prisma.eodRiskRun.findMany({ where: { tradingDate: clock.tradingDate, userId: { in: ['ALL', userId] } }, orderBy: { startedAt: 'desc' } });
    const riskManager = { ...clock, status: eodRuns.some((run) => run.status === 'RUNNING') ? 'AUTO EXIT RUNNING' : clock.status, alert: eodRuns.find((run) => run.status === 'FAILED')?.alert ?? null };
    const openPositions = orders.filter((order) => order.status === 'OPEN');
    const waitingOrders = orders.filter((order) => order.status === 'WAITING');
    const closedTrades = orders.filter((order) => order.status.startsWith('CLOSED'));
    const closedToday = closedTrades.filter((order) => order.exitTime && order.exitTime >= start && order.exitTime < end);
    const usedCapital = openPositions.reduce((sum, order) => sum + Number(order.investment || order.budget), 0);
    const virtualBalance = account.startingBalance + account.realizedPnl;
    const unrealizedPnl = openPositions.reduce((sum, order) => sum + order.pnl, 0);
    const wins = closedToday.filter((order) => order.pnl > 0), losses = closedToday.filter((order) => order.pnl < 0);
    const sum = (items: typeof closedTrades) => items.reduce((total, order) => total + order.pnl, 0);
    const average = (items: typeof closedTrades) => items.length ? sum(items) / items.length : 0;
    const response = {
      account,
      summary: { virtualBalance, usedCapital, availableCapital: Math.max(0, virtualBalance - usedCapital), todayPnl: sum(closedToday) + unrealizedPnl, openPositions: openPositions.length, closedTrades: closedToday.length, winRate: closedToday.length ? wins.length / closedToday.length * 100 : 0 },
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
      this.prisma.paperOrder.update({ where: { id: order.id }, data: { status, tradeStage: reason, currentPrice: price, marketValue: price * order.quantity, unrealizedPnl: 0, unrealizedPnlPercent: 0, durationMinutes: order.entryTime ? Math.max(0, Math.floor((at.getTime() - order.entryTime.getTime()) / 60_000)) : 0, ...result } }),
      this.prisma.paperTradingAccount.update({ where: { userId: order.userId }, data: { realizedPnl: { increment: result.pnl } } }),
    ]);
    this.liveMarks.delete(order.id);
    this.demoDecisionStates.delete(order.id);
    this.evaluatedDemoCandles.delete(order.id);
    this.logger.log(JSON.stringify({ event: 'paper.trade.exit', userId: order.userId, orderId, symbol: order.symbol, price, reason, pnl: result.pnl }));
    } catch (error) { this.logError('paper.trade.close.failed', error, { orderId, price, reason }); throw error; }
  }
  private async executeUnlimitedSignals(
    userId: string,
    start: Date,
    end: Date,
    at: Date,
  ) {
    const signals = await this.prisma.aiSignal.findMany({
      where: {
        userId,
        status: { in: ['ENTRY_TRIGGERED', 'RUNNING'] },
        entryTriggeredAt: { gte: start, lt: end },
        target1At: null,
        stopLossAt: null,
        completedAt: null,
      },
      orderBy: [{ entryTriggeredAt: 'asc' }, { confidence: 'desc' }],
    });
    if (!signals.length) {
      this.logDemoSkip('Invalid status: no ENTRY_TRIGGERED or RUNNING signals found', { userId, start, end });
      return false;
    }

    const existing = await this.prisma.paperOrder.findMany({
      where: { signalId: { in: signals.map((signal) => signal.id) } },
      select: { signalId: true },
    });
    const executedSignalIds = new Set(existing.map((order) => order.signalId).filter(Boolean));
    const account = await this.account(userId);
    let changed = false;
    for (const signal of signals) {
      const active = await this.prisma.paperOrder.findMany({
        where: { userId, status: { in: ['WAITING', 'OPEN'] } },
        select: { budget: true, investment: true },
      });
      const usedCapital = active.reduce((sum, order) => sum + Number(order.investment || order.budget), 0);
      const availableCapital = account.startingBalance + account.realizedPnl - usedCapital;
      const duplicateFound = executedSignalIds.has(signal.id);
      this.logger.log(JSON.stringify({
        event: 'paper.execution.values',
        message: '[Demo] Signal Loaded',
        signalId: signal.id,
        symbol: signal.symbol,
        status: signal.status,
        confidence: signal.confidence,
        riskReward: signal.riskReward,
        aiScore: signal.aiScore,
        entryPrice: signal.entryPrice,
        capitalPerTrade: DEMO_CAPITAL_PER_TRADE,
        availableCapital,
        usedCapital,
        maxOpenTrades: account.maxOpenTrades,
        openTrades: active.length,
        autoTradingEnabled: account.autoDemoTrading,
        queueLength: signals.length,
        duplicateFound,
        positionExists: duplicateFound,
        executionAllowed: false,
      }));
      if (executedSignalIds.has(signal.id)) {
        this.logDemoBlocked('executeUnlimitedSignals', 'Position already exists for signal', { userId, signalId: signal.id, symbol: signal.symbol, condition: 'position does not already exist', duplicateFound: true });
        continue;
      }
      if (!['BUY', 'SELL'].includes(signal.side)) {
        this.logDemoBlocked('executeUnlimitedSignals', 'Signal side is invalid', { userId, signalId: signal.id, symbol: signal.symbol, condition: 'signal.side is BUY or SELL', side: signal.side });
        continue;
      }
      if (account.maxOpenTrades > 0 && active.length >= Math.min(MAX_DEMO_OPEN_TRADES, account.maxOpenTrades)) {
        this.logDemoBlocked('executeUnlimitedSignals', 'Maximum open trades reached', { userId, signalId: signal.id, symbol: signal.symbol, condition: 'openTrades < maxOpenTrades', openTrades: active.length, maxOpenTrades: account.maxOpenTrades });
        continue;
      }
      if (availableCapital < DEMO_CAPITAL_PER_TRADE) {
        this.logDemoBlocked('executeUnlimitedSignals', 'Available capital is below capital per trade', { userId, signalId: signal.id, symbol: signal.symbol, condition: 'availableCapital >= capitalPerTrade', availableCapital, capitalPerTrade: DEMO_CAPITAL_PER_TRADE, usedCapital });
        continue;
      }
      if (!['ENTRY_TRIGGERED', 'RUNNING'].includes(signal.status)) {
        this.logDemoBlocked('executeUnlimitedSignals', 'Signal status is not executable', { userId, signalId: signal.id, symbol: signal.symbol, condition: 'signal.status is ENTRY_TRIGGERED or RUNNING', status: signal.status });
        continue;
      }
      if (signal.confidence < account.minimumConfidence) {
        this.logDemoBlocked('executeUnlimitedSignals', 'Signal confidence is below account minimum', { userId, signalId: signal.id, symbol: signal.symbol, condition: 'signal.confidence >= account.minimumConfidence', confidence: signal.confidence, minimumConfidence: account.minimumConfidence });
        continue;
      }
      if (signal.riskReward + RISK_REWARD_EPSILON < MINIMUM_RISK_REWARD) {
        this.logDemoBlocked('executeUnlimitedSignals', 'Signal risk/reward is below minimum', { userId, signalId: signal.id, symbol: signal.symbol, condition: 'signal.riskReward >= minimumRiskReward', riskReward: signal.riskReward, minimumRiskReward: MINIMUM_RISK_REWARD });
        continue;
      }
      const executionPrice = Number(signal.currentPrice);
      if (!Number.isFinite(executionPrice) || executionPrice <= 0) {
        this.logDemoBlocked('executeUnlimitedSignals', 'Signal current price is invalid', { userId, signalId: signal.id, symbol: signal.symbol, condition: 'signal.currentPrice is finite and greater than zero', currentPrice: signal.currentPrice, executionPrice });
        continue;
      }
      const quantity = Math.floor(DEMO_CAPITAL_PER_TRADE / executionPrice);
      if (quantity <= 0) {
        this.logDemoBlocked('executeUnlimitedSignals', 'Capital per trade cannot buy one share', { userId, signalId: signal.id, symbol: signal.symbol, condition: 'floor(capitalPerTrade / signal.currentPrice) > 0', executionPrice, capitalPerTrade: DEMO_CAPITAL_PER_TRADE, quantity });
        continue;
      }
      const capitalUsed = quantity * executionPrice;
      this.logger.log(JSON.stringify({ event: 'demo.validation.passed', message: '[Demo] Validation Passed', userId, signalId: signal.id, symbol: signal.symbol, status: signal.status, confidence: signal.confidence, minimumConfidence: account.minimumConfidence, riskReward: signal.riskReward, minimumRiskReward: MINIMUM_RISK_REWARD, availableCapital, capitalPerTrade: DEMO_CAPITAL_PER_TRADE, duplicateFound: false }));
      this.logger.log(JSON.stringify({ event: 'demo.execution.started', message: '[Demo] Creating Position', userId, signalId: signal.id, symbol: signal.symbol, side: signal.side, executionPrice, quantity, capitalUsed }));
      const fill = await this.execution.fill({ price: executionPrice, quantity, at });
      const position = await this.prisma.paperOrder.create({
        data: {
          userId,
          signalId: signal.id,
          instrumentKey: signal.instrumentKey,
          symbol: signal.symbol,
          side: signal.side,
          confidence: signal.confidence,
          status: 'OPEN',
          quantity,
          budget: DEMO_CAPITAL_PER_TRADE,
          plannedEntry: signal.entryPrice,
          currentPrice: executionPrice,
          target: signal.target3,
          target1: signal.target1,
          target2: signal.target2,
          stopLoss: signal.stopLoss,
          marketValue: capitalUsed,
          tradeStage: 'RUNNING',
          ...fill,
          investment: capitalUsed,
        },
      });
      this.logger.log(JSON.stringify({ event: 'demo.position.created', message: '[Demo] PaperOrder Saved', userId, signalId: signal.id, orderId: position.id, symbol: signal.symbol }));
      executedSignalIds.add(signal.id);
      changed = true;
      this.logger.log(JSON.stringify({ event: 'demo.capital.updated', message: '[Demo] Capital Updated', userId, signalId: signal.id, orderId: position.id, capitalUsed, usedCapitalBefore: usedCapital, usedCapitalAfter: usedCapital + capitalUsed, availableCapitalBefore: availableCapital, availableCapitalAfter: availableCapital - capitalUsed }));
    }
    return changed;
  }

  private logDemoSkip(reason: string, context: Record<string, unknown>) {
    this.logger.warn(JSON.stringify({
      event: 'demo.trade.skipped',
      message: `[Demo] Trade skipped because: ${reason}`,
      reason,
      ...context,
    }));
  }

  private logDemoBlocked(functionName: string, reason: string, context: Record<string, unknown>) {
    this.logger.warn(JSON.stringify({
      event: 'paper.execution.blocked',
      message: `[Paper] BLOCKED: ${reason}`,
      file: 'paper-trading.service.ts',
      function: functionName,
      reason,
      ...context,
    }));
  }

  private demoDecision(order: any, signal: any, row: ScanRow, at: Date): DemoCandleDecision {
    const buy = order.side === 'BUY';
    const direction = buy ? 1 : -1;
    const indicators = row.indicators ?? {};
    const entry = Number(order.entryPrice);
    const ema20 = Number(row.ema20);
    const ema50 = Number(row.ema50);
    const vwap = Number(row.vwap);
    const rsi = Number(row.rsi);
    const macd = Number(indicators.macd?.histogram ?? row.macd ?? indicators.histogram);
    const volumeRatio = Number(indicators.volumeRatio);
    const adx = Number(indicators.adx);
    const supertrend = Number(indicators.supertrend);
    const momentum = Number(indicators.momentum ?? indicators.roc);
    const target1Hit = signal && (signal.target1At || (buy ? row.price >= signal.target1 : row.price <= signal.target1));
    const target2Hit = signal && (signal.target2At || (buy ? row.price >= signal.target2 : row.price <= signal.target2));
    const profitable = direction * (row.price - entry) > 0;
    const aligned = [
      direction * (row.price - ema20) > 0,
      direction * (ema20 - ema50) > 0,
      direction * (row.price - vwap) > 0,
      direction * macd > 0,
      buy ? rsi >= 52 && rsi <= 72 : rsi <= 48 && rsi >= 28,
      volumeRatio >= 1,
      adx >= 25,
      !Number.isFinite(supertrend) || direction * (row.price - supertrend) > 0,
      !Number.isFinite(momentum) || direction * momentum > 0,
      !row.entryValidation?.fakeBreakout,
    ];
    const strongCount = aligned.filter(Boolean).length;
    const strong = strongCount >= 9;
    const veryStrong = strongCount === aligned.length && volumeRatio >= 1.2 && adx >= 30;
    const weak = strongCount <= 6 || volumeRatio < .7 || direction * macd <= 0 || direction * (row.price - vwap) <= 0;
    let trailingStop = this.logicalStop(order.side, row, row.price, Number(order.stopLoss));
    if (target1Hit) trailingStop = buy ? Math.max(trailingStop, entry) : Math.min(trailingStop, entry);
    if (target2Hit && signal) trailingStop = buy ? Math.max(trailingStop, Number(signal.target1)) : Math.min(trailingStop, Number(signal.target1));

    const seconds = this.istSeconds(at);
    const afterThree = seconds >= 15 * 3600;
    const afterThreeFifteen = seconds >= 15 * 3600 + 15 * 60;
    const strength: DemoCandleDecision['strength'] = veryStrong ? 'VERY STRONG' : strong ? 'STRONG' : weak ? 'WEAK' : 'MODERATE';
    const currentTarget = signal ? Number(target2Hit ? signal.target3 : target1Hit ? signal.target2 : signal.target1) : Number(order.target);
    const timeRemainingSeconds = Math.max(0, (afterThree ? 15 * 3600 + 15 * 60 : 15 * 3600) - seconds);
    const state = (decision: Omit<DemoCandleDecision, 'strength' | 'currentTarget' | 'timeRemainingSeconds'>): DemoCandleDecision => ({
      ...decision, strength, currentTarget, timeRemainingSeconds,
    });
    const weaknessReason = volumeRatio < .7
      ? 'Volume Drop'
      : direction * (row.price - vwap) <= 0
        ? 'VWAP Breakdown'
        : direction * macd <= 0
          ? (buy ? 'MACD Bearish' : 'MACD Bullish')
          : (buy ? rsi < 50 : rsi > 50)
            ? 'RSI Weak'
            : direction * (row.price - ema20) <= 0
              ? 'Trend Failure'
              : 'Weak Momentum';
    if (target2Hit && !veryStrong) return state({ action: 'BOOK PROFIT', reason: 'Target 2 Booked', trailingStop });
    if (afterThreeFifteen && !veryStrong) return state({ action: profitable ? 'BOOK PROFIT' : 'EXIT', reason: 'Time Exit (3:15 PM)', trailingStop: profitable ? entry : trailingStop });
    if (afterThree && !profitable) return state({ action: 'EXIT', reason: 'Capital Protection', trailingStop });
    if (afterThree && weak) return state({ action: 'BOOK PROFIT', reason: `Time Exit (3 PM) - ${weaknessReason}`, trailingStop: entry });
    if (weak) return state({ action: profitable ? 'BOOK PROFIT' : 'EXIT', reason: weaknessReason, trailingStop });
    if (afterThree && profitable) trailingStop = buy ? Math.max(trailingStop, entry) : Math.min(trailingStop, entry);
    if (target1Hit || this.improvesStop(order.side, Number(order.stopLoss), trailingStop)) {
      return state({ action: target1Hit ? 'TRAIL STOP' : 'REDUCE RISK', reason: target1Hit ? 'Target 1 - Stop Moved to Entry' : 'Capital Protection', trailingStop });
    }
    return state({ action: 'HOLD', reason: strong ? 'Strong Trend' : 'Trade Valid', trailingStop });
  }

  private logicalStop(side: string, row: ScanRow, price: number, fallback: number) {
    const buy = side === 'BUY';
    const direction = buy ? 1 : -1;
    const indicators = row.indicators ?? {};
    const atr = Number(indicators.atr);
    const swing = Number(buy
      ? indicators.swingLow ?? indicators.support ?? row.todayLow
      : indicators.swingHigh ?? indicators.resistance ?? row.todayHigh);
    const candidates = [
      Number.isFinite(atr) && atr > 0 ? price - direction * atr * 1.25 : NaN,
      Number(row.ema20),
      swing,
      Number(row.vwap),
      fallback,
    ].filter((value) => Number.isFinite(value) && (buy ? value < price : value > price));
    return candidates.length ? (buy ? Math.max(...candidates) : Math.min(...candidates)) : NaN;
  }

  private markOpenOrder(order: any, price: number) {
    const entryPrice = Number(order.entryPrice);
    const pnl = (order.side === 'BUY' ? price - entryPrice : entryPrice - price) * Number(order.quantity);
    const pnlPercent = entryPrice ? pnl / (entryPrice * Number(order.quantity)) * 100 : 0;
    this.liveMarks.set(order.id, { currentPrice: price, pnl, pnlPercent });
  }

  private improvesStop(side: string, current: number, candidate: number) {
    return Number.isFinite(candidate) && (side === 'BUY' ? candidate > current : candidate < current);
  }

  private candleTime(row: ScanRow, fallback: Date) {
    const value = row.indicators?.latestCandle?.time ?? row.lastUpdated;
    const date = value ? new Date(value) : fallback;
    return Number.isFinite(date.getTime()) ? date : fallback;
  }

  private istSeconds(at: Date) {
    const values = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(at);
    const parts = Object.fromEntries(values.map((part) => [part.type, part.value]));
    return Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  }
  private tradingDayBounds(at: Date) {
    const tradingDate = marketClock(at).tradingDate;
    return {
      start: new Date(`${tradingDate}T00:00:00+05:30`),
      end: new Date(new Date(`${tradingDate}T00:00:00+05:30`).getTime() + 86_400_000),
    };
  }
  private async resetExpiredDemoState(userId: string, at: Date) {
    const tradingDate = marketClock(at).tradingDate;
    if (this.completedDailyResets.get(userId) === tradingDate) return;
    const resetKey = `${userId}:${tradingDate}`;
    const running = this.dailyResetTasks.get(resetKey);
    if (running) return running;
    const task = this.performExpiredDemoReset(userId, at)
      .then(() => { this.completedDailyResets.set(userId, tradingDate); })
      .finally(() => this.dailyResetTasks.delete(resetKey));
    this.dailyResetTasks.set(resetKey, task);
    return task;
  }
  private async performExpiredDemoReset(userId: string, at: Date) {
    const { start } = this.tradingDayBounds(at);
    const staleOrders = await this.prisma.paperOrder.findMany({
      where: { userId, status: { in: ['WAITING', 'OPEN'] }, createdAt: { lt: start } },
    });
    for (const order of staleOrders) {
      if (order.status === 'OPEN') {
        await this.close(order.id, Number(order.currentPrice), 'End of Day Auto Exit', start, 'CLOSED - EOD EXIT');
      } else {
        await this.prisma.paperOrder.update({
          where: { id: order.id },
          data: { status: 'CLOSED - EOD EXIT', exitTime: start, exitReason: 'End of Day Auto Exit', pnl: 0, pnlPercent: 0, durationMinutes: 0 },
        });
      }
    }
    const staleQueueEntry = await this.prisma.demoTradeQueue.findFirst({
      where: { userId, status: 'WAITING_FOR_CAPITAL', queuedAt: { lt: start } },
      select: { id: true },
    });
    if (staleQueueEntry) {
      await this.prisma.demoTradeQueue.updateMany({
        where: { userId, status: 'WAITING_FOR_CAPITAL', queuedAt: { lt: start } },
        data: { status: 'REJECTED', rejectedAt: start, rejectReason: 'Previous trading day expired' },
      });
    }
  }
  private range(value: unknown, minimum: number, maximum: number, fallback: number) { const number = Number(value); return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback; }
  private async retryWrite<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        if (code !== 'P1008' || attempt >= attempts) throw error;
        this.logger.warn(JSON.stringify({ event: 'paper.database.write.retry', attempt, code }));
        await new Promise((resolve) => setTimeout(resolve, attempt * 100));
      }
    }
  }
  private defaultAccount(userId: string) { return { id: '', userId, enabled: true, autoDemoTrading: true, startingBalance: 10_000, minimumConfidence: 90, maxOpenTrades: MAX_DEMO_OPEN_TRADES, riskPerTrade: 2, allowAiWait: true, allowReentry: true, realizedPnl: 0, createdAt: new Date(0), updatedAt: new Date(0) }; }
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
