import { MarketPricesService } from './market-prices.service';
import type { Prisma } from '@prisma/client';
import { compareTargetOneHits, confirmedTargetOneTime } from './signal-history-events';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { PaperOrderExecutionService } from './paper-order-execution.service';
import { marketClock } from './market-clock';
import { strategyWeekRange } from './strategy-weekly';
import { demoWeeklyReport } from './demo-weekly-report';

type HistorySignal = Prisma.AiSignalGetPayload<{ include: { events: true } }>;

type TriggeredSignal = { id: string; userId: string; instrumentKey: string; symbol: string; side: string; entryPrice: number; currentPrice: number; confidence: number; aiScore: number; riskReward: number; signalTime: Date; status: string; entryTriggeredAt?: Date | null; runningAt?: Date | null; target1At?: Date | null; stopLossAt?: Date | null; completedAt?: Date | null };

const DEMO_CAPITAL = 10_000;
const MAX_ACTIVE_DEMO_TRADES = 1;
const LIVE_POST_TARGET1_STATUSES = ['TARGET1_HIT', 'TARGET2_HIT', 'PARTIAL_PROFIT_BOOKED', 'TRAILING_STOP_ACTIVE'];
export type DemoPortfolio = 'STRATEGY' | 'SIGNAL_HISTORY';
const DEMO_PORTFOLIOS: DemoPortfolio[] = ['STRATEGY', 'SIGNAL_HISTORY'];

export function calculateDemoIntradayPosition(input: { capital: number; accountBalance: number; entryPrice: number; stopLoss: number; riskPercent: number; leverage: number }) {
  const leverage = Number.isFinite(input.leverage) ? Math.max(1, input.leverage) : 5;
  const marginPerShare = input.entryPrice / leverage;
  const marginQuantity = marginPerShare > 0 ? Math.floor(input.capital / marginPerShare) : 0;
  const riskPerShare = Math.abs(input.entryPrice - input.stopLoss);
  const maximumRisk = input.accountBalance * input.riskPercent / 100;
  const riskQuantity = riskPerShare > 0 ? Math.floor(maximumRisk / riskPerShare) : 0;
  // Demo intraday trades intentionally deploy all available cash as margin.
  // Risk figures remain available for display/diagnostics, but do not reduce
  // the quantity because this account permits only one open trade at a time.
  const quantity = Math.max(0, marginQuantity);
  return { leverage, marginPerShare, marginQuantity, riskPerShare, maximumRisk, riskQuantity, quantity, marginUsed: quantity * marginPerShare, notionalValue: quantity * input.entryPrice };
}

@Injectable()
export class PaperTradingService {
  private readonly logger = new Logger(PaperTradingService.name);
  private readonly demoExecutionLocks = new Map<string, Promise<void>>();
  private readonly closeLocks = new Set<string>();
  private readonly legacyReconciliationLocks = new Set<string>();
  constructor(private readonly prisma: PrismaService, private readonly execution: PaperOrderExecutionService, private readonly prices: MarketPricesService = new MarketPricesService()) {}

  async account(userId: string, portfolio: DemoPortfolio = 'STRATEGY') {
    try {
      this.logger.log(JSON.stringify({ event: 'paper.database.wallet.initialize', userId }));
      const account = await this.prisma.paperTradingAccount.upsert({ where: { userId_portfolio: { userId, portfolio } }, create: { userId, portfolio, startingBalance: DEMO_CAPITAL, maxOpenTrades: MAX_ACTIVE_DEMO_TRADES, autoDemoTrading: true }, update: { startingBalance: DEMO_CAPITAL, maxOpenTrades: MAX_ACTIVE_DEMO_TRADES, autoDemoTrading: true } });
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
    let changed = false;
    for (const portfolio of DEMO_PORTFOLIOS) changed = (await this.capturePortfolio(userId, portfolio, trades, at)) || changed;
    return changed;
  }

  private async capturePortfolio(userId: string, portfolio: DemoPortfolio, trades: TriggeredSignal[], at: Date) {
    if (portfolio === 'STRATEGY') return this.withDemoLock(userId, portfolio, () => this.captureStrategySignals(userId, trades, at));
    return this.drainDemoQueue(userId, at, portfolio, trades.filter(trade => trade.target1At?.getTime() === at.getTime()).map(trade => trade.id));
  }

  private async captureStrategySignals(userId: string, trades: TriggeredSignal[], at: Date) {
    const portfolio: DemoPortfolio = 'STRATEGY';
    const account = await this.account(userId, portfolio);
    if (!account.autoDemoTrading) return false;
    const immediateSignals: string[] = [];
    for (const trade of trades) {
      const completedOnHit = trade.status === 'COMPLETED' && trade.target1At?.getTime() === at.getTime() && trade.completedAt?.getTime() === at.getTime();
      if ((!LIVE_POST_TARGET1_STATUSES.includes(trade.status) && !completedOnHit) || !trade.target1At || trade.stopLossAt || (trade.completedAt && !completedOnHit) || !['BUY', 'SELL'].includes(trade.side)) continue;
      const priorEvent = await this.prisma.demoTradeQueue.findUnique({ where: { signalId_portfolio: { signalId: trade.id, portfolio } } });
      if (priorEvent) {
        this.logger.warn(JSON.stringify({ event: 'demo.target1.duplicate.rejected', userId, portfolio, signalId: trade.id, symbol: trade.symbol, target1At: trade.target1At, existingStatus: priorEvent.status }));
        continue;
      }
      const active = await this.strategySlotOccupiedAt(userId, at);
      const canonical = await this.prisma.aiSignal.findUnique({ where: { id: trade.id } });
      const membershipInvalid = !canonical?.aiStrategyListed || !canonical.aiStrategyListedAt || canonical.aiStrategyListedAt > at;
      const timestampInvalid = !canonical?.target1At || canonical.target1At < canonical.signalTime || canonical.target1At > new Date(at.getTime() + 5_000);
      // Match the lifecycle event, rather than comparing exchange time with
      // wall time after database/queue work. A live hit must not expire while
      // its own execution is being processed.
      const missedEvent = canonical?.target1At?.getTime() !== at.getTime();
      const rejectReason = missedEvent ? 'MISSED TARGET 1 - no late entry'
        : membershipInvalid ? 'Signal must be on the AI Strategy Top 10 BUY or SELL list before Target 1 hits'
        : active ? 'MISSED TARGET 1 - trade slot occupied'
        : timestampInvalid ? 'Signal and Target 1 timestamps are invalid or out of order'
          : null;
      if (!rejectReason) immediateSignals.push(trade.id);
      this.logger.log(JSON.stringify({ event: 'demo.target1.reached', userId, portfolio, signalId: trade.id, instrumentKey: trade.instrumentKey, symbol: trade.symbol, target1At: canonical?.target1At ?? trade.target1At, receivedAt: at }));
      await this.prisma.demoTradeQueue.upsert({
        where: { signalId_portfolio: { signalId: trade.id, portfolio } }, update: { status: rejectReason ? 'REJECTED' : 'WAITING_FOR_CAPITAL', rejectedAt: rejectReason ? at : null, rejectReason },
        create: { userId, portfolio, signalId: trade.id, instrumentKey: trade.instrumentKey, symbol: trade.symbol, side: trade.side, entryPrice: trade.entryPrice, confidence: trade.confidence, aiScore: trade.aiScore, riskReward: trade.riskReward, signalTime: trade.signalTime, queuedAt: trade.target1At ?? at, status: rejectReason ? 'REJECTED' : 'WAITING_FOR_CAPITAL', rejectedAt: rejectReason ? at : null, rejectReason },
      });
      if (rejectReason) {
        this.logger.warn(JSON.stringify({ event: active ? 'demo.trade.blocked.active_trade' : 'demo.trade.rejected.validation', userId, portfolio, signalId: trade.id, symbol: trade.symbol, reason: rejectReason, activeOrderId: active?.id, activeSymbol: active?.symbol }));
      }
    }
    return this.drainDemoQueueUnlocked(userId, at, portfolio, immediateSignals);
  }

  async reconcileTriggeredDemoSignals(userId: string, at = new Date(), portfolio?: DemoPortfolio) {
    // Both portfolios execute only from the live lifecycle callback.
    // Refreshes, exits and restarts must never replay historical hits.
    return false;
  }

  async drainDemoQueue(userId: string, at = new Date(), portfolio: DemoPortfolio = 'STRATEGY', immediateSignals: string[] = []) {
    return this.withDemoLock(userId, portfolio, () => this.drainDemoQueueUnlocked(userId, at, portfolio, immediateSignals));
  }

  private async withDemoLock<T>(userId: string, portfolio: string, work: () => Promise<T>): Promise<T> {
    const lockKey = `${userId}:${portfolio}`;
    const previous = this.demoExecutionLocks.get(lockKey);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    this.demoExecutionLocks.set(lockKey, pending);
    await previous;
    try { return await work(); } finally {
      release();
      if (this.demoExecutionLocks.get(lockKey) === pending) this.demoExecutionLocks.delete(lockKey);
    }
  }

  private async strategySlotOccupiedAt(userId: string, at: Date) {
    // A delayed tick must not enter after a close if its hit happened while
    // the previous position was still open. Use persisted times across restarts.
    return this.prisma.paperOrder.findFirst({ where: { userId, portfolio: 'STRATEGY', OR: [
      { status: 'OPEN' },
      { entryTime: { lte: at }, exitTime: { gte: at } },
    ] } });
  }

  private async drainDemoQueueUnlocked(userId: string, at: Date, portfolio: DemoPortfolio, immediateSignals: string[]) {
    let changed = false;
    if (portfolio === 'SIGNAL_HISTORY') return await this.drainHistoryQueue(userId, at, immediateSignals);
    const account = await this.account(userId, portfolio);
    const clock = marketClock(at);
    this.logger.log(JSON.stringify({ event: 'demo.drain.started', userId, at, enabled: account.enabled, autoDemoTrading: account.autoDemoTrading, canEnter: clock.canEnter, marketStatus: clock.status }));
    if (!account.autoDemoTrading || !account.enabled || !clock.canEnter) { this.logger.warn(JSON.stringify({ event: 'demo.drain.blocked', userId, reason: !account.autoDemoTrading ? 'AUTO_DEMO_DISABLED' : !account.enabled ? 'ACCOUNT_DISABLED' : 'ENTRY_WINDOW_CLOSED', marketStatus: clock.status })); return false; }
    const deferred: string[] = [];
    const { start, end } = this.tradingDayRange(at);
    while (true) {
      const active = await this.prisma.paperOrder.findMany({ where: { userId, portfolio, status: 'OPEN' } });
      if (active.length >= MAX_ACTIVE_DEMO_TRADES || await this.strategySlotOccupiedAt(userId, at)) {
        // A competing live hit consumed the slot while this event waited.
        // Record the skip now; never leave it eligible for a later fill.
        if (immediateSignals.length) await this.prisma.demoTradeQueue.updateMany({
          where: { userId, portfolio, signalId: { in: immediateSignals }, status: 'WAITING_FOR_CAPITAL' },
          data: { status: 'REJECTED', rejectedAt: at, rejectReason: 'MISSED TARGET 1 - trade slot occupied' },
        });
        break;
      }
      const usedCapital = active.reduce((sum, order) => sum + Number(order.budget), 0);
      const availableCapital = account.startingBalance + account.realizedPnl - usedCapital;
      const allocation = Math.max(0, availableCapital);
      if (allocation <= 0) break;
      const queued = await this.prisma.demoTradeQueue.findFirst({ where: { userId, portfolio, status: 'WAITING_FOR_CAPITAL', signalId: { in: immediateSignals }, id: { notIn: deferred } }, orderBy: [{ confidence: 'desc' }, { aiScore: 'desc' }, { riskReward: 'desc' }, { signalTime: 'desc' }] });
      if (!queued) { this.logger.debug(JSON.stringify({ event: 'demo.drain.empty', userId })); break; }
      const signal = await this.prisma.aiSignal.findUnique({ where: { id: queued.signalId } });
      const completedOnHit = portfolio === 'STRATEGY' && immediateSignals.includes(queued.signalId) && signal?.status === 'COMPLETED' && signal.target1At?.getTime() === at.getTime() && signal.completedAt?.getTime() === at.getTime();
      const invalidReason = portfolio === 'STRATEGY' && (!immediateSignals.includes(queued.signalId) || signal?.target1At?.getTime() !== at.getTime()) ? 'MISSED TARGET 1 - no late entry'
        : !signal ? 'Signal no longer exists'
        : !signal.aiStrategyListed || !signal.aiStrategyListedAt || signal.aiStrategyListedAt > at ? 'Signal must be on the AI Strategy Top 10 BUY or SELL list before Target 1 hits'
        : signal.stopLossAt ? 'Stop loss already reached'
          : signal.completedAt && !completedOnHit ? 'Trade already completed'
            : !LIVE_POST_TARGET1_STATUSES.includes(signal.status) && !completedOnHit ? `Signal state is ${signal.status}`
              : !signal.target1At ? 'Target 1 timestamp is missing'
                : signal.target1At < signal.signalTime || signal.target1At > new Date(at.getTime() + 5_000) ? 'Signal and Target 1 timestamps are invalid or out of order'
                  : signal.signalTime < start || signal.signalTime >= end ? 'Signal is from a previous trading session'
                    : !['BUY', 'SELL'].includes(signal.side) ? 'Invalid trade side'
                      : null;
      if (invalidReason) {
        await this.prisma.demoTradeQueue.update({ where: { id: queued.id }, data: { status: 'REJECTED', rejectedAt: at, rejectReason: invalidReason } });
        this.logger.warn(JSON.stringify({ event: 'demo.candidate.rejected', userId, signalId: queued.signalId, symbol: queued.symbol, reason: invalidReason }));
        continue;
      }
      if (!signal) continue;
      const duplicate = await this.prisma.paperOrder.findUnique({ where: { signalId_portfolio: { signalId: queued.signalId, portfolio } } });
      if (duplicate) {
        await this.prisma.demoTradeQueue.update({ where: { id: queued.id }, data: { status: 'EXECUTED', executedAt: duplicate.entryTime ?? duplicate.createdAt } });
        continue;
      }
      const executionPrice = Number(portfolio === 'STRATEGY' ? signal.target1 : signal.currentPrice);
      // Strategy paper fills simulate the exact target level on the live event only.
      if (!Number.isFinite(executionPrice) || executionPrice <= 0
        || !signal.updatedAt) {
        deferred.push(queued.id);
        continue;
      }

      const sizing = calculateDemoIntradayPosition({ capital: allocation, accountBalance: account.startingBalance, entryPrice: executionPrice, stopLoss: Number(signal.stopLoss), riskPercent: account.riskPerTrade, leverage: this.intradayLeverage() });
      const quantity = sizing.quantity;
      if (!Number.isFinite(executionPrice) || executionPrice <= 0 || quantity <= 0) {
        await this.prisma.demoTradeQueue.update({ where: { id: queued.id }, data: { status: 'REJECTED', rejectedAt: at, rejectReason: 'Insufficient allocation for one share' } });
        continue;
      }
      const fill = await this.execution.fill({ price: executionPrice, quantity, at });
      const marginUsed = sizing.marginUsed;
      await this.prisma.$transaction([
        this.prisma.paperOrder.create({ data: { userId, portfolio, signalId: signal.id, instrumentKey: signal.instrumentKey, symbol: signal.symbol, side: signal.side, confidence: signal.confidence, status: 'OPEN', quantity, budget: marginUsed, plannedEntry: signal.entryPrice, currentPrice: executionPrice, target: signal.target3, stopLoss: signal.stopLoss, ...fill } }),
        this.prisma.demoTradeQueue.update({ where: { id: queued.id }, data: { status: 'EXECUTED', executedAt: at } }),
      ]);
      changed = true;
      this.logger.log(JSON.stringify({ event: 'demo.trade.created', userId, portfolio, signalId: signal.id, instrumentKey: signal.instrumentKey, symbol: signal.symbol, side: signal.side, target1At: signal.target1At, entryPrice: executionPrice, entryTime: at, quantity, marginUsed, notionalValue: fill.investment, leverage: sizing.leverage }));
    }
    return changed;
  }

  private historyRejection(signal: HistorySignal, at: Date) {
    const timestamp = confirmedTargetOneTime(signal);
    if (!timestamp) return 'Confirmed Target 1 HIT event is missing';
    const hitAt = new Date(timestamp);
    const { start, end } = this.tradingDayRange(at);
    if (signal.signalTime < start || signal.signalTime >= end || hitAt < start || hitAt >= end) return 'Signal is from a previous trading session';
    if (hitAt.getTime() !== at.getTime()) return 'MISSED TARGET 1 - no late entry';
    if (hitAt < signal.signalTime || hitAt.getTime() > at.getTime() + 5_000) return 'Target 1 event time is invalid';
    if (!marketClock(hitAt).canEnter) return 'Target 1 event is outside the entry window';
    if (signal.stopLossAt) return 'Stop loss already reached';
    if (signal.completedAt) return 'Trade already completed';
    if (!LIVE_POST_TARGET1_STATUSES.includes(signal.status)) return `Signal state is ${signal.status}`;
    if (!['BUY', 'SELL'].includes(signal.side)) return 'Invalid trade side';
    if (!signal.top100Selected || signal.currentPrice < 60 || signal.currentPrice > 600) return 'Signal is not eligible for AI Signal History';
    return null;
  }

  private async drainHistoryQueue(userId: string, at: Date, immediateSignals: string[]) {
    if (!immediateSignals.length || !marketClock(at).canEnter) return false;
    const portfolio = 'SIGNAL_HISTORY';
    await this.account(userId, portfolio);
    return this.prisma.$transaction(async (tx) => {
      // Take SQLite's write lock before reading the slot or balance. This also
      // serializes different API/worker instances, not just this service's lock.
      const account = await tx.paperTradingAccount.update({
        where: { userId_portfolio: { userId, portfolio } }, data: { maxOpenTrades: MAX_ACTIVE_DEMO_TRADES },
      });
      const { start, end } = this.tradingDayRange(at);
      const signals = await tx.aiSignal.findMany({
        where: { userId, id: { in: immediateSignals }, signalTime: { gte: start, lt: end }, events: { some: { type: 'TARGET1_HIT' } } },
        include: { events: { where: { type: 'TARGET1_HIT' } } },
      });
      const queue = await tx.demoTradeQueue.findMany({ where: { userId, portfolio, signalId: { in: immediateSignals } } });
      const orders = await tx.paperOrder.findMany({ where: { userId, portfolio } });
      const queueBySignal = new Map(queue.map(item => [item.signalId, item]));
      const orderBySignal = new Map(orders.filter(order => order.signalId).map(order => [order.signalId!, order]));
      const signalById = new Map(signals.map(signal => [signal.id, signal]));
      let changed = false;

      const occupied = orders.some(order => order.status === 'OPEN' || order.status === 'WAITING');
      const latestExit = orders.reduce((latest, order) => Math.max(latest, order.exitTime?.getTime() ?? 0), 0);
      // Ingest only this live hit. Busy and historical events are terminal skips.
      for (const signal of signals) {
        const prior = queueBySignal.get(signal.id);
        const order = orderBySignal.get(signal.id);
        if (order || prior?.status === 'EXECUTED') {
          if (order && prior?.status === 'WAITING_FOR_CAPITAL') {
            await tx.demoTradeQueue.update({ where: { id: prior.id }, data: { status: 'EXECUTED', executedAt: order.entryTime ?? order.createdAt } });
            prior.status = 'EXECUTED';
            changed = true;
          }
          continue;
        }
        if (prior?.status === 'REJECTED') continue;
        const hitAt = new Date(confirmedTargetOneTime(signal)!);
        const rejection = this.historyRejection(signal, at)
          ?? (occupied ? 'MISSED TARGET 1 - trade slot occupied'
            : hitAt.getTime() <= latestExit ? 'MISSED TARGET 1 - hit before previous trade closed'
              : !account.enabled || !account.autoDemoTrading ? 'Demo trading disabled at Target 1' : null);
        const saved = await tx.demoTradeQueue.upsert({
          where: { signalId_portfolio: { signalId: signal.id, portfolio } },
          update: { status: rejection ? 'REJECTED' : 'WAITING_FOR_CAPITAL', queuedAt: hitAt, rejectedAt: rejection ? at : null, rejectReason: rejection },
          create: { userId, portfolio, signalId: signal.id, instrumentKey: signal.instrumentKey, symbol: signal.symbol, side: signal.side, entryPrice: signal.entryPrice, confidence: signal.confidence, aiScore: signal.aiScore, riskReward: signal.riskReward, signalTime: signal.signalTime, queuedAt: hitAt, status: rejection ? 'REJECTED' : 'WAITING_FOR_CAPITAL', rejectedAt: rejection ? at : null, rejectReason: rejection },
        });
        queueBySignal.set(signal.id, saved);
        changed = true;
      }

      const candidates: Array<{ signal: HistorySignal; queued: (typeof queue)[number] }> = [];
      for (const queued of queueBySignal.values()) {
        if (queued.status !== 'WAITING_FOR_CAPITAL') continue;
        const signal = signalById.get(queued.signalId);
        const rejection = signal ? this.historyRejection(signal, at) : 'No confirmed Target 1 event in this trading session';
        if (!signal || rejection) {
          await tx.demoTradeQueue.update({ where: { id: queued.id }, data: { status: 'REJECTED', rejectedAt: at, rejectReason: rejection } });
          changed = true;
        } else candidates.push({ signal, queued });
      }
      candidates.sort((a, b) => compareTargetOneHits(a.signal, b.signal) || a.signal.id.localeCompare(b.signal.id));
      if (!account.enabled || !account.autoDemoTrading || !marketClock(at).canEnter
        || orders.some(order => order.status === 'OPEN' || order.status === 'WAITING')) return changed;
      const allocation = Math.max(0, account.startingBalance + account.realizedPnl);
      if (allocation <= 0) {
        for (const { queued } of candidates) await tx.demoTradeQueue.update({
          where: { id: queued.id }, data: { status: 'REJECTED', rejectedAt: at, rejectReason: 'MISSED TARGET 1 - capital unavailable' },
        });
        return changed;
      }

      let filled = false;
      for (const { signal, queued } of candidates) {
        if (filled) {
          await tx.demoTradeQueue.update({ where: { id: queued.id }, data: { status: 'REJECTED', rejectedAt: at, rejectReason: 'MISSED TARGET 1 - trade slot occupied' } });
          continue;
        }
        const quote = this.prices.fresh(userId, signal.instrumentKey);
        const price = Number(quote?.ltp);
        // Missing quotes cannot turn this hit into an entry on a later refresh.
        if (!Number.isFinite(price) || price <= 0 || quote!.timestamp < at.getTime()) {
          await tx.demoTradeQueue.update({ where: { id: queued.id }, data: { status: 'REJECTED', rejectedAt: at, rejectReason: 'MISSED TARGET 1 - live quote unavailable' } });
          changed = true;
          continue;
        }
        const expired = signal.side === 'BUY' ? price <= signal.stopLoss || price >= signal.target3 : price >= signal.stopLoss || price <= signal.target3;
        const sizing = calculateDemoIntradayPosition({ capital: allocation, accountBalance: account.startingBalance, entryPrice: price, stopLoss: signal.stopLoss, riskPercent: account.riskPerTrade, leverage: this.intradayLeverage() });
        if (expired || sizing.quantity <= 0) {
          await tx.demoTradeQueue.update({ where: { id: queued.id }, data: { status: 'REJECTED', rejectedAt: at, rejectReason: expired ? 'Price has already reached stop loss or final target' : 'Insufficient allocation for one share' } });
          changed = true;
          continue;
        }
        const fill = await this.execution.fill({ price, quantity: sizing.quantity, at });
        await tx.paperOrder.create({ data: { userId, portfolio, signalId: signal.id, instrumentKey: signal.instrumentKey, symbol: signal.symbol, side: signal.side, confidence: signal.confidence, status: 'OPEN', quantity: sizing.quantity, budget: sizing.marginUsed, plannedEntry: signal.entryPrice, currentPrice: price, target: signal.target3, stopLoss: signal.stopLoss, ...fill } });
        await tx.demoTradeQueue.update({ where: { id: queued.id }, data: { status: 'EXECUTED', executedAt: at } });
        this.logger.log(JSON.stringify({ event: 'demo.history.trade.created', userId, signalId: signal.id, target1EventTime: confirmedTargetOneTime(signal), entryTime: at, entryPrice: price }));
        filled = true;
        changed = true;
      }
      return changed;
    }, { maxWait: 10_000, timeout: 20_000 });
  }

  async historyTargetQueue(userId: string, at = new Date()) {
    // Historical hits are displayed in signal history, never as future entries.
    return [];
  }

  async processTick(userId: string, instrumentKey: string, price: number, at = new Date()) {
    try {
    if (!Number.isFinite(price)) return false;
    const accounts = await this.prisma.paperTradingAccount.findMany({ where: { userId } });
    const accountByPortfolio = new Map(accounts.map((account) => [account.portfolio, account]));
    const orders = await this.prisma.paperOrder.findMany({ where: { userId, instrumentKey, status: 'OPEN', portfolio: { not: 'NIFTY' } } });
    let changed = false;
    for (const order of orders) {
      const account = accountByPortfolio.get(order.portfolio);
      if (!account?.enabled || order.entryTime && order.entryTime > at) continue;
      const entryPrice = Number(order.entryPrice);
      const pnl = (order.side === 'BUY' ? price - entryPrice : entryPrice - price) * order.quantity;
      const pnlPercent = entryPrice ? pnl / (entryPrice * order.quantity) * 100 : 0;
      const targetHit = order.side === 'BUY' ? price >= order.target : price <= order.target;
      const stopTouched = order.side === 'BUY' ? price <= order.stopLoss : price >= order.stopLoss;
      this.logger.log(JSON.stringify({ event: 'demo.position.live-price', userId, orderId: order.id, instrumentKey, symbol: order.symbol, side: order.side, price, previousPrice: order.currentPrice, target: order.target, stopLoss: order.stopLoss, targetHit, stopTouched, at }));
      let exitReason: string | null = targetHit ? 'TARGET' : null;
      if (!exitReason && stopTouched) {
        if (order.portfolio === 'STRATEGY' || !account.allowAiWait) exitReason = 'STOP LOSS';
        else {
          const linked = await this.prisma.aiSignal.findFirst({ where: { userId, instrumentKey }, include: { stopLossDecision: true }, orderBy: { signalTime: 'desc' } });
          if (linked?.status === 'STOPLOSS_CONFIRMED') exitReason = 'STOP LOSS';
          else if (linked?.stopLossDecision?.status === 'EXIT') exitReason = 'AI EXIT';
        }
      }
      if (exitReason) {
        this.logger.log(JSON.stringify({ event: 'demo.position.exit-triggered', userId, orderId: order.id, symbol: order.symbol, price, exitReason, at }));
        await this.close(order.id, price, exitReason, at);
        changed = true;
      } else await this.prisma.paperOrder.update({ where: { id: order.id }, data: { currentPrice: price, pnl, pnlPercent } });
    }
    return changed;
    } catch (error) { this.logError('paper.portfolio.tick.failed', error, { userId, instrumentKey, price }); return false; }
  }

  async manualExit(userId: string, orderId: string, portfolio: DemoPortfolio = 'STRATEGY') {
    try {
      const order = await this.prisma.paperOrder.findFirst({ where: { id: orderId, userId, portfolio, status: 'OPEN' } });
      if (!order) { this.logger.warn(JSON.stringify({ event: 'paper.trade.exit.skipped', userId, orderId, reason: 'Open position not found' })); return false; }
      const price = this.prices.fresh(userId, order.instrumentKey)?.ltp;
      if (!price) return false;
      await this.close(order.id, price, 'MANUAL EXIT', new Date());
      return true;
    } catch (error) { this.logError('paper.trade.exit.failed', error, { userId, orderId }); return false; }
  }

  async closeAllEod(at = new Date()) {
    const orders = await this.prisma.paperOrder.findMany({ where: { status: 'OPEN', portfolio: { not: 'NIFTY' } } });
    let closed = 0;
    for (const order of orders) {
      const price = Number(this.prices.fresh(order.userId, order.instrumentKey)?.ltp);
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

  async updateSettings(userId: string, input: Record<string, unknown>, portfolio: DemoPortfolio = 'STRATEGY') {
    try {
    const current = await this.account(userId, portfolio);
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
    const updated = await this.prisma.paperTradingAccount.update({ where: { userId_portfolio: { userId, portfolio } }, data });
    if (updated.autoDemoTrading) {
      await this.reconcileTriggeredDemoSignals(userId, new Date(), portfolio);
    }
    return updated;
    } catch (error) { this.logError('paper.database.settings.failed', error, { userId }); return this.defaultAccount(userId, portfolio); }
  }

  async signalHistoryWeeklyReport(userId: string, at = new Date()) {
    const { start, end } = strategyWeekRange(at);
    const orders = await this.prisma.paperOrder.findMany({
      where: { userId, portfolio: 'SIGNAL_HISTORY', entryTime: { gte: start, lt: end } },
      orderBy: { entryTime: 'desc' },
    });
    const signals = await this.prisma.aiSignal.findMany({
      where: { userId, id: { in: orders.flatMap(order => order.signalId ? [order.signalId] : []) } },
      select: { id: true, stockName: true, target1: true, target2: true, target3: true, target1At: true, target1HitAt: true, target1ExecutedPrice: true },
    });
    return demoWeeklyReport(orders, signals, at);
  }

  async dashboard(userId: string, portfolio: DemoPortfolio = 'STRATEGY') {
    try {
    this.logger.log(JSON.stringify({ event: 'paper.portfolio.load.start', userId }));
    await this.account(userId, portfolio);
    await this.reconcilePreTarget1Orders(userId, portfolio);
    await this.reconcileTriggeredDemoSignals(userId, new Date(), portfolio);
    const account = await this.account(userId, portfolio);
    const storedOrders = await this.prisma.paperOrder.findMany({ where: { userId, portfolio }, orderBy: { createdAt: 'desc' }, take: 200 });
    const linkedSignals = await this.prisma.aiSignal.findMany({ where: { userId, id: { in: storedOrders.flatMap(order => order.signalId ? [order.signalId] : []) } }, select: { id: true, target1: true, target2: true, target3: true, target1At: true } });
    const byId = new Map(linkedSignals.map(signal => [signal.id, signal]));
    const orders = storedOrders.map(order => ({ ...(this.prices?.position(userId, order) ?? order), signal: order.signalId ? byId.get(order.signalId) ?? null : null }));
    const target1Queue = portfolio === 'SIGNAL_HISTORY' ? await this.historyTargetQueue(userId) : [];
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
      account: { ...account, intradayLeverage: this.intradayLeverage() },
      summary: { virtualBalance: account.startingBalance + account.realizedPnl, usedCapital, availableCapital: Math.max(0, account.startingBalance + account.realizedPnl - usedCapital), todayPnl: sum(closedToday) + unrealizedPnl, openPositions: openPositions.length, closedTrades: closedToday.length, winRate: closedToday.length ? wins.length / closedToday.length * 100 : 0 },
      performance: { todayProfit: sum(wins), todayLoss: Math.abs(sum(losses)), winningTrades: wins.length, losingTrades: losses.length, averageProfit: average(wins), averageLoss: Math.abs(average(losses)), largestWin: wins.length ? Math.max(...wins.map((order) => order.pnl)) : 0, largestLoss: losses.length ? Math.abs(Math.min(...losses.map((order) => order.pnl))) : 0 },
      openPositions, waitingOrders, tradeHistory: closedTrades, target1Queue,
      riskManager,
    };
    const safe = this.sanitize(response);
    this.logger.log(JSON.stringify({ event: 'paper.portfolio.load.success', userId, openPositions: openPositions.length, waitingOrders: waitingOrders.length, history: closedTrades.length, usedCapital: safe.summary.usedCapital, availableCapital: safe.summary.availableCapital }));
    const portfolioSummary = { profit: safe.performance.todayProfit, loss: safe.performance.todayLoss, roi: account.startingBalance ? safe.summary.todayPnl / account.startingBalance * 100 : 0 };
    return { ...safe, balance: safe.summary.virtualBalance, usedCapital: safe.summary.usedCapital, availableCapital: safe.summary.availableCapital, positions: safe.openPositions, history: safe.tradeHistory, summary: { ...safe.summary, ...portfolioSummary } };
    } catch (error) {
      this.logError('paper.portfolio.load.failed', error, { userId });
      throw error;
    }
  }

  private async reconcilePreTarget1Orders(userId: string, portfolio: DemoPortfolio) {
    const lockKey = `${userId}:${portfolio}`;
    if (this.legacyReconciliationLocks.has(lockKey)) return;
    this.legacyReconciliationLocks.add(lockKey);
    try {
      const openOrders = await this.prisma.paperOrder.findMany({ where: { userId, portfolio, status: 'OPEN' } });
      const { start, end } = this.tradingDayRange();
      for (const order of openOrders) {
        const signal = order.signalId ? await this.prisma.aiSignal.findUnique({ where: { id: order.signalId }, include: { events: { where: { type: 'TARGET1_HIT' } } } }) : null;
        const currentTradingDay = Boolean(signal && signal.signalTime >= start && signal.signalTime < end);
        const recordedHit = signal && portfolio === 'SIGNAL_HISTORY' ? confirmedTargetOneTime(signal) : signal?.target1At?.toISOString();
        const enteredAfterTarget1 = Boolean(currentTradingDay && recordedHit && order.entryTime && new Date(recordedHit).getTime() <= order.entryTime.getTime());
        if (enteredAfterTarget1) continue;
        const quote = this.prices.fresh(userId, order.instrumentKey);
        if (!quote) continue;
        await this.close(order.id, quote.ltp, 'RULE CHANGE - TARGET 1 REQUIRED', new Date());
        this.logger.warn(JSON.stringify({ event: 'paper.legacy.position.reconciled', userId, orderId: order.id, signalId: order.signalId, symbol: order.symbol }));
      }
    } finally {
      this.legacyReconciliationLocks.delete(lockKey);
    }
  }

  private async close(orderId: string, price: number, reason: string, at: Date, status = 'CLOSED') {
    const order = await this.prisma.paperOrder.findUniqueOrThrow({ where: { id: orderId } });
    if (order.portfolio === 'STRATEGY') return this.withDemoLock(order.userId, order.portfolio, () => this.closeUnlocked(orderId, price, reason, at, status));
    return this.closeUnlocked(orderId, price, reason, at, status);
  }

  private async closeUnlocked(orderId: string, price: number, reason: string, at: Date, status: string) {
    if (this.closeLocks.has(orderId)) return;
    this.closeLocks.add(orderId);
    try {
    const order = await this.prisma.paperOrder.findUniqueOrThrow({ where: { id: orderId } });
    if (order.status !== 'OPEN') return;
    if (order.portfolio === 'SIGNAL_HISTORY') {
      const closed = await this.prisma.$transaction(async (tx) => {
        await tx.paperTradingAccount.update({ where: { userId_portfolio: { userId: order.userId, portfolio: order.portfolio } }, data: { maxOpenTrades: MAX_ACTIVE_DEMO_TRADES } });
        const current = await tx.paperOrder.findUniqueOrThrow({ where: { id: order.id } });
        if (current.status !== 'OPEN') return false;
        const result = await this.execution.close({ side: current.side, entryPrice: Number(current.entryPrice), price, quantity: current.quantity, reason, at });
        await tx.paperOrder.update({ where: { id: current.id }, data: { status, currentPrice: price, durationMinutes: current.entryTime ? Math.max(0, Math.floor((at.getTime() - current.entryTime.getTime()) / 60_000)) : 0, ...result } });
        await tx.paperTradingAccount.update({ where: { userId_portfolio: { userId: current.userId, portfolio: current.portfolio } }, data: { realizedPnl: { increment: result.pnl } } });
        return true;
      }, { maxWait: 10_000, timeout: 20_000 });
      if (closed) {
        this.logger.log(JSON.stringify({ event: 'demo.history.trade.closed', userId: order.userId, orderId, exitTime: at, reason }));
      }
      return;
    }
    const result = await this.execution.close({ side: order.side, entryPrice: Number(order.entryPrice), price, quantity: order.quantity, reason, at });
    await this.prisma.$transaction([
      this.prisma.paperOrder.update({ where: { id: order.id }, data: { status, currentPrice: price, durationMinutes: order.entryTime ? Math.max(0, Math.floor((at.getTime() - order.entryTime.getTime()) / 60_000)) : 0, ...result } }),
      this.prisma.paperTradingAccount.update({ where: { userId_portfolio: { userId: order.userId, portfolio: order.portfolio } }, data: { realizedPnl: { increment: result.pnl } } }),
    ]);
    this.logger.log(JSON.stringify({ event: 'demo.trade.completed', userId: order.userId, portfolio: order.portfolio, orderId, signalId: order.signalId, symbol: order.symbol, exitPrice: price, exitReason: reason, exitTime: at, pnl: result.pnl }));
    } catch (error) { this.logError('paper.trade.close.failed', error, { orderId, price, reason }); throw error; } finally { this.closeLocks.delete(orderId); }
  }
  private intradayLeverage() { const value = Number(process.env.DEMO_INTRADAY_LEVERAGE ?? 5); return Number.isFinite(value) ? Math.max(1, value) : 5; }
  private range(value: unknown, minimum: number, maximum: number, fallback: number) { const number = Number(value); return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback; }
  private tradingDayRange(at = new Date()) {
    const shifted = new Date(at.getTime() + 330 * 60_000);
    const start = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 330 * 60_000);
    return { start, end: new Date(start.getTime() + 86_400_000) };
  }
  private defaultAccount(userId: string, portfolio: DemoPortfolio = 'STRATEGY') { return { id: '', userId, portfolio, enabled: true, autoDemoTrading: true, startingBalance: DEMO_CAPITAL, minimumConfidence: 90, maxOpenTrades: MAX_ACTIVE_DEMO_TRADES, riskPerTrade: 2, allowAiWait: true, allowReentry: true, realizedPnl: 0, createdAt: new Date(0), updatedAt: new Date(0) }; }
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
