import { MarketPricesService } from './market-prices.service';
import { compareTargetOneHits, mergeTradeEvents } from './signal-history-events';
import type { AiTradeEvent } from '@prisma/client';
import { marketClock } from './market-clock';
import { protectOpeningSignal } from './opening-protection';
import { strategyHistoryRange, summarizeStrategyMonth } from './strategy-weekly';
import { analyzeTargetOne } from './target-one-analysis';
import { selectStrategyRows } from './strategy-list';
import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { ScanRow } from './scanner.service';
import { matchesStatusFilter, resolveSignalStatuses } from './signal-status-filter';
import { StopLossDecisionService } from './stop-loss-decision.service';

const ACTIVE = ['WAITING', 'ENTRY_TRIGGERED', 'RUNNING', 'TARGET1_HIT', 'PARTIAL_PROFIT_BOOKED', 'TRAILING_STOP_ACTIVE', 'TARGET2_HIT', 'TARGET3_HIT', 'STOPLOSS_CONFIRMATION'];
const TERMINAL = ['COMPLETED', 'STOPLOSS_HIT', 'STOPLOSS_CONFIRMED', 'AI_EXIT'];

@Injectable()
export class SignalHistoryService {
  private readonly logger = new Logger(SignalHistoryService.name);
  private readonly activeCache = new Map<string, any[]>();
  private readonly hydrating = new Map<string, Promise<any[]>>();
  private readonly locks = new Set<string>();
  private readonly tickQueues = new Map<string, Promise<unknown>>();
  private readonly writeQueue: Array<() => Promise<void>> = [];
  private readonly lastLivePriceWrite = new Map<string, number>();
  private readonly pendingLivePriceWrites = new Map<string, { price: number; at: Date }>();
  private livePriceFlushTimer?: NodeJS.Timeout;
  private writers = 0;
  private metrics = { stateChanges: 0, databaseWrites: 0, skippedUpdates: 0, totalMs: 0 };
  constructor(private readonly prisma: PrismaService, private readonly stopLossDecision: StopLossDecisionService, private readonly prices?: MarketPricesService) {}

  private readonly publications = new Map<string, Promise<unknown>>();

  private publishSerial<T>(userId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.publications.get(userId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.publications.set(userId, next);
    void next.finally(() => { if (this.publications.get(userId) === next) this.publications.delete(userId); }).catch(() => undefined);
    return next;
  }

  async recordScannerSignals(userId: string, rows: ScanRow[], latestPrice?: (key: string) => number | null) {
    return this.publishSerial(userId, () => this.recordAndPublish(userId, rows, latestPrice));
  }

  private async recordAndPublish(userId: string, rows: ScanRow[], latestPrice?: (key: string) => number | null) {
    if (marketClock().beforeTradingStart) return;
    const { start, end } = this.tradingDayRange();
    // Decide ranking before publishing new signals. Eligibility and the signal
    // are then committed together, before any tick can consume the setup.
    const candidates = await this.decorate(userId, rows);
    const eligible = new Map([...selectStrategyRows(candidates, 'BUY'), ...selectStrategyRows(candidates, 'SELL')]
      .map(row => [`${row.instrumentKey}:${row.timeframe}`, row.signal]));
    const actionable = rows.filter((row) => row.universeRank <= 100 && row.price >= 60 && row.price <= 600 && (row.signal === 'BUY' || row.signal === 'SELL') && [row.entry, row.stopLoss, row.target1, row.target2, row.target3, row.riskReward].every((value) => Number.isFinite(value)));
    for (let row of actionable) {
      const fingerprint = this.fingerprint(row);
      const strategy = this.strategy(row);
      try {
        this.logger.debug(JSON.stringify({ event: 'signal.database.lookup', symbol: row.symbol, instrumentKey: row.instrumentKey, timeframe: row.timeframe }));
        const existing = await this.prisma.aiSignal.findFirst({ where: { userId, instrumentKey: row.instrumentKey, timeframe: row.timeframe, signalTime: { gte: start, lt: end } }, include: { managementDecision: true }, orderBy: { signalTime: 'desc' } });
        if (existing && ACTIVE.includes(existing.status)) {
          existing.currentPrice = row.price;
          await this.prisma.aiSignal.update({ where: { id: existing.id }, data: { currentPrice: row.price } });
          continue;
        }
        const reentryAllowed = Boolean(existing && TERMINAL.includes(existing.status) && existing.managementDecision?.reentryStatus === 'RE-ENTRY ALLOWED');
        if (existing && TERMINAL.includes(existing.status) && !reentryAllowed) continue;
        if (existing && !reentryAllowed && (!this.isFresh(row, existing) || existing.setupFingerprint === fingerprint)) continue;
        const price = latestPrice?.(row.instrumentKey) ?? row.price;
        const buy = row.signal === 'BUY';
        const ordered = buy
          ? row.stopLoss! < row.entry! && row.entry! < row.target1! && row.target1! < row.target2! && row.target2! < row.target3!
          : row.stopLoss! > row.entry! && row.entry! > row.target1! && row.target1! > row.target2! && row.target2! > row.target3!;
        if (!Number.isFinite(price) || !ordered || (buy ? price >= row.target1! || price <= row.stopLoss! : price <= row.target1! || price >= row.stopLoss!)) {
          this.logger.warn(JSON.stringify({ event: 'signal.stale-setup.skipped', symbol: row.symbol, price, target1: row.target1 }));
          continue;
        }
        row = { ...row, price };
        if (marketClock().beforeTradingStart) continue;
        const registeredAt = new Date();
        const listed = eligible.get(`${row.instrumentKey}:${row.timeframe}`) === row.signal;
        const created = await this.prisma.aiSignal.create({ data: { signalKey: `${userId}:${row.instrumentKey}:${row.timeframe}:${Date.now()}:${crypto.randomUUID()}`, setupFingerprint: fingerprint, userId, instrumentKey: row.instrumentKey, stockName: row.company, symbol: row.symbol, sector: row.sector, strategy, timeframe: row.timeframe, side: row.signal, currentPrice: row.price, entryPrice: row.entry!, stopLoss: row.stopLoss!, target1: row.target1!, target2: row.target2!, target3: row.target3!, confidence: row.confidence, aiScore: row.aiScore, riskReward: row.riskReward!, volume: row.volume, universeRank: row.universeRank, selectionScore: row.selectionScore, top100Selected: true, signalTime: registeredAt, signalGeneratedAt: registeredAt, aiStrategyListed: listed, aiStrategyListedAt: listed ? registeredAt : null, events: { create: { type: 'SIGNAL_GENERATED', eventTime: registeredAt, triggerPrice: row.price, executedPrice: row.price, profitPercent: 0, holdingMinutes: 0 } } }, include: { events: true } });
        const cacheKey = `${userId}:${created.instrumentKey}`; this.activeCache.set(cacheKey, [...(this.activeCache.get(cacheKey) ?? []).filter((trade) => trade.id !== created.id), created]);
        this.logger.log(JSON.stringify({ event: 'signal.generated', tradeId: created.id, symbol: created.symbol, side: created.side, aiScore: created.aiScore, strategy: created.strategy, timeframe: created.timeframe }));
      } catch (error) { const exception = error instanceof Error ? error : new Error(String(error)); this.logger.error(JSON.stringify({ event: 'signal.generation.error', exceptionName: exception.name, message: exception.message, symbol: row?.symbol, tradeId: null, stack: exception.stack }), exception.stack); }
    }
    await this.persistStrategyList(userId, rows);
  }

  async publishStrategyList(userId: string, rows: ScanRow[]) {
    return this.publishSerial(userId, () => this.persistStrategyList(userId, rows, true));
  }

  private async persistStrategyList(userId: string, rows: ScanRow[], captureDisplayedResults = false) {
    // Rank the exact decorated rows served to the page, never raw scanner sides/scores.
    const decorated = await this.decorate(userId, rows);
    const topBuy = selectStrategyRows(decorated, 'BUY');
    const topSell = selectStrategyRows(decorated, 'SELL');
    const selected = [...topBuy, ...topSell].filter(row => row.tradeId);
    const ids = selected.map(row => row.tradeId!);
    const at = new Date();
    const { start, end } = this.tradingDayRange(at);
    await this.prisma.$transaction([
      this.prisma.aiSignal.updateMany({ where: { userId, signalTime: { gte: start, lt: end }, aiStrategyListed: true, id: { notIn: ids } }, data: { aiStrategyListed: false, aiStrategyRank: null } }),
      ...selected.flatMap((row) => [
        this.prisma.aiSignal.updateMany({ where: { userId, id: row.tradeId!, aiStrategyListedAt: null }, data: { aiStrategyListedAt: at } }),
        this.prisma.aiSignal.updateMany({ where: { userId, id: row.tradeId! }, data: { aiStrategyListed: true, aiStrategyRank: (row.signal === 'BUY' ? topBuy : topSell).indexOf(row) + 1 } }),
      ]),
      // A result belongs to the page once that exact trade is displayed with
      // T1 reached. Keep it even when the next ranking removes the stock.
      ...selected.filter(row => captureDisplayedResults && 'target1At' in row && row.target1At).map(row => this.prisma.aiStrategyResult.upsert({
        where: { tradeId: row.tradeId! }, update: {},
        create: { tradeId: row.tradeId!, observedAt: at, source: 'AI_STRATEGY_PAGE' },
      })),
    ]);
    return { topBuy, topSell };
  }

  async processTick(userId: string, instrumentKey: string, price: number, at = new Date()) {
    const key = `${userId}:${instrumentKey}`;
    const previous = this.tickQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      for (let attempt = 0; ; attempt++) {
        try { return await this.processTickSerial(userId, instrumentKey, price, at); }
        catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
          if (attempt >= 2 || !['P1001', 'P1002', 'P1008', 'P2024', 'P2028', 'P2034'].includes(code)) throw error;
          this.logger.warn(JSON.stringify({ event: 'lifecycle.tick.retry', userId, instrumentKey, at, attempt: attempt + 1, code }));
          // Retain the original price/timestamp and queue position: a following
          // pullback must not erase a target hit during a transient DB failure.
          await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
        }
      }
    });
    this.tickQueues.set(key, next);
    try { return await next; }
    finally { if (this.tickQueues.get(key) === next) this.tickQueues.delete(key); }
  }

  private async processTickSerial(userId: string, instrumentKey: string, price: number, at: Date) {
    await this.publications.get(userId);
    if (!Number.isFinite(price)) return [];
    const { start, end } = this.tradingDayRange(at);
    const cacheKey = `${userId}:${instrumentKey}`;
    let signals = this.activeCache.get(cacheKey);
    if (!signals) { let pending = this.hydrating.get(cacheKey); if (!pending) { this.logger.debug(JSON.stringify({ event: 'lifecycle.cache.hydrate', instrumentKey })); pending = this.prisma.aiSignal.findMany({ where: { userId, instrumentKey, niftyContext: { is: null }, status: { in: ACTIVE }, signalTime: { gte: start, lt: end } }, include: { events: { orderBy: { eventTime: 'asc' } } } }); this.hydrating.set(cacheKey, pending); } signals = await pending; this.activeCache.set(cacheKey, signals); this.hydrating.delete(cacheKey); }
    signals = signals.filter((trade) => ACTIVE.includes(trade.status) && trade.signalTime >= start && trade.signalTime < end);
    this.activeCache.set(cacheKey, signals);
    const updatedTrades = [];
    for (const signal of signals) {
      if (this.locks.has(signal.id)) { this.metrics.skippedUpdates += 1; continue; }
      this.locks.add(signal.id);
      try {
      const startedAt = Date.now();
      if (at < signal.signalTime) continue;
      const buy = signal.side === 'BUY'; const reached = (level: number) => buy ? price >= level : price <= level; const stopped = buy ? price <= signal.stopLoss : price >= signal.stopLoss;
      const elapsed = (from: Date) => Math.max(0, Math.round((at.getTime() - from.getTime()) / 60_000));
      let data: Record<string, unknown> = { currentPrice: price };
      const events: Array<{ type: string; triggerPrice: number; executedPrice: number; eventTime: Date; profitPercent: number; holdingMinutes: number }> = [];
      const entered = signal.status !== 'WAITING' || (!marketClock(at).beforeTradingStart && reached(signal.entryPrice));
      const entryAt = signal.entryTriggeredAt ?? (entered ? at : null);
      const addEvent = (type: string, triggerPrice: number, eventTime = at) => events.push({ type, triggerPrice, executedPrice: price, eventTime, profitPercent: type === 'SIGNAL_GENERATED' || type === 'ENTRY_TRIGGERED' || type === 'RUNNING' ? 0 : this.profit(signal.side, signal.entryPrice, price), holdingMinutes: entryAt ? elapsed(entryAt) : 0 });
      if (entered && !signal.entryTriggeredAt) { data = { ...data, entryTriggeredAt: at, entryExecutedPrice: price }; addEvent('ENTRY_TRIGGERED', signal.entryPrice); }
      if (entered && signal.status === 'STOPLOSS_CONFIRMATION') {
        let confirmation;
        try { confirmation = await this.stopLossDecision.evaluateConfirmation(userId, signal, price, at); }
        catch (error) {
          this.logger.warn(JSON.stringify({ event: 'stoploss.confirmation.failsafe_exit', tradeId: signal.id, symbol: signal.symbol, message: error instanceof Error ? error.message : String(error) }));
          confirmation = { status: 'EXIT' };
        }
        if (confirmation?.status === 'CONTINUED') {
          data = { ...data, status: 'RUNNING' };
          addEvent('STOPLOSS_RECOVERED', price);
        } else if (confirmation?.status === 'EXIT') {
          const profitPercent = this.profit(signal.side, signal.entryPrice, price); const holdingMinutes = elapsed(entryAt ?? signal.signalTime);
          data = { ...data, status: 'STOPLOSS_CONFIRMED', stopLossAt: at, stopLossHitAt: at, completedAt: at, exitPrice: price, profitPercent, lossPercent: Math.abs(Math.min(0, profitPercent)), holdingMinutes };
          addEvent('STOPLOSS_CONFIRMED', signal.stopLoss); addEvent('COMPLETED', price);
        }
      } else if (entered && stopped) {
        let decision;
        try { decision = await this.stopLossDecision.evaluateTouch(userId, signal, price, at); }
        catch (error) {
          this.logger.warn(JSON.stringify({ event: 'stoploss.decision.failsafe_exit', tradeId: signal.id, symbol: signal.symbol, message: error instanceof Error ? error.message : String(error) }));
          decision = { status: 'EXIT' };
        }
        addEvent('STOPLOSS_TOUCHED', signal.stopLoss);
        if (decision.status === 'WAIT') {
          data = { ...data, status: 'STOPLOSS_CONFIRMATION' };
        } else {
          const profitPercent = this.profit(signal.side, signal.entryPrice, price); const holdingMinutes = elapsed(entryAt ?? signal.signalTime);
          data = { ...data, status: 'STOPLOSS_CONFIRMED', stopLossAt: at, stopLossHitAt: at, completedAt: at, exitPrice: price, profitPercent, lossPercent: Math.abs(Math.min(0, profitPercent)), holdingMinutes };
          addEvent('STOPLOSS_CONFIRMED', signal.stopLoss); addEvent('COMPLETED', price);
        }
      } else if (entered && reached(signal.target3)) {
        const profitPercent = this.profit(signal.side, signal.entryPrice, price); const holdingMinutes = elapsed(entryAt ?? signal.signalTime);
        data = { ...data, status: 'COMPLETED', entryTriggeredAt: entryAt, runningAt: signal.runningAt ?? at, target1At: signal.target1At ?? at, target1HitAt: signal.target1At ?? at, target1ExecutedPrice: signal.target1At ? signal.target1ExecutedPrice : price, target2At: signal.target2At ?? at, target2HitAt: signal.target2At ?? at, target2ExecutedPrice: signal.target2At ? signal.target2ExecutedPrice : price, target3At: signal.target3At ?? at, target3HitAt: signal.target3At ?? at, target3ExecutedPrice: signal.target3At ? signal.target3ExecutedPrice : price, completedAt: at, exitPrice: price, profitPercent, lossPercent: 0, holdingMinutes };
        if (!signal.runningAt) addEvent('RUNNING', signal.entryPrice); if (!signal.target1At) addEvent('TARGET1_HIT', signal.target1); if (!signal.target2At) addEvent('TARGET2_HIT', signal.target2); if (!signal.target3At) addEvent('TARGET3_HIT', signal.target3); addEvent('COMPLETED', price);
      } else if (entered && !signal.target2At && reached(signal.target2)) {
        data = { ...data, status: 'TARGET2_HIT', entryTriggeredAt: entryAt, runningAt: signal.runningAt ?? at, target1At: signal.target1At ?? at, target1HitAt: signal.target1At ?? at, target1ExecutedPrice: signal.target1At ? signal.target1ExecutedPrice : price, target2At: signal.target2At ?? at, target2HitAt: signal.target2At ?? at, target2ExecutedPrice: signal.target2At ? signal.target2ExecutedPrice : price };
        if (!signal.runningAt) addEvent('RUNNING', signal.entryPrice); if (!signal.target1At) addEvent('TARGET1_HIT', signal.target1); if (!signal.target2At) addEvent('TARGET2_HIT', signal.target2);
      } else if (entered && !signal.target1At && reached(signal.target1)) {
        data = { ...data, status: 'TARGET1_HIT', entryTriggeredAt: entryAt, runningAt: signal.runningAt ?? at, target1At: signal.target1At ?? at, target1HitAt: signal.target1At ?? at, target1ExecutedPrice: signal.target1At ? signal.target1ExecutedPrice : price };
        if (!signal.runningAt) addEvent('RUNNING', signal.entryPrice); if (!signal.target1At) addEvent('TARGET1_HIT', signal.target1);
      } else if (entered && signal.status === 'WAITING') data = { ...data, status: 'ENTRY_TRIGGERED', entryTriggeredAt: at };
      else if (signal.status === 'ENTRY_TRIGGERED') { data = { ...data, status: 'RUNNING', runningAt: signal.runningAt ?? at }; if (!signal.runningAt) addEvent('RUNNING', signal.entryPrice); }
      const nextStatus = typeof data.status === 'string' ? data.status : signal.status;
      signal.currentPrice = price;
      signal.updatedAt = at;
      if (nextStatus === signal.status && !events.length) {
        const lastWrite = this.lastLivePriceWrite.get(signal.id) ?? 0;
        if (at.getTime() - lastWrite >= 2_000) {
          this.lastLivePriceWrite.set(signal.id, at.getTime());
          this.queueLivePriceWrite(signal.id, price, at);
        } else this.metrics.skippedUpdates += 1;
        this.locks.delete(signal.id);
        continue;
      }
      this.metrics.stateChanges += 1; this.metrics.totalMs += Date.now() - startedAt;
      // Persist lifecycle transitions before returning them to execution
      // consumers. Demo trading rereads this canonical row immediately; an
      // asynchronous write allowed it to see RUNNING and reject a real T1 hit.
      // Read current membership: lifecycle cache entries may predate the latest
      // page publication. Off-page signals must not enter the report on a tick.
      const listedAtHit = events.some(event => event.type === 'TARGET1_HIT')
        ? await this.prisma.aiSignal.findFirst({ where: { id: signal.id, userId, aiStrategyListed: true }, select: { id: true } })
        : null;
      const membershipWrites = listedAtHit ? [this.prisma.aiStrategyResult.upsert({
        where: { tradeId: signal.id }, update: {},
        create: { tradeId: signal.id, observedAt: at, source: 'AI_STRATEGY_TARGET1' },
      })] : [];
      // Durable demo inbox: the hit and its execution request either both commit
      // or neither does. A failed consumer can retry after a process restart.
      const hit = events.find(event => event.type === 'TARGET1_HIT');
      const demoWrites = hit ? [this.prisma.demoTradeQueue.upsert({
        where: { signalId_portfolio: { signalId: signal.id, portfolio: 'STRATEGY' } }, update: {},
        create: { userId, portfolio: 'STRATEGY', signalId: signal.id, instrumentKey,
          symbol: signal.symbol, side: signal.side, entryPrice: signal.entryPrice,
          confidence: signal.confidence, aiScore: signal.aiScore, riskReward: signal.riskReward,
          signalTime: signal.signalTime, queuedAt: hit.eventTime, updatedAt: new Date(), status: 'PENDING_EXECUTION' },
      })] : [];
      const persisted = await this.prisma.$transaction([this.prisma.aiSignal.update({ where: { id: signal.id }, data }), ...events.map((event) => this.prisma.aiTradeEvent.upsert({ where: { tradeId_type: { tradeId: signal.id, type: event.type } }, update: {}, create: { tradeId: signal.id, ...event } })), ...membershipWrites, ...demoWrites]);
      Object.assign(signal, data, { events: mergeTradeEvents(signal.events ?? [], persisted.slice(1, 1 + events.length) as AiTradeEvent[]) });
      this.metrics.databaseWrites += 1;
      this.logger.log(JSON.stringify({ event: 'lifecycle.updated', tradeId: signal.id, symbol: signal.symbol, fromStatus: signal.status, toStatus: data.status ?? signal.status, livePrice: price, events: events.map((event) => event.type) }));
      updatedTrades.push({ ...signal, events: signal.events });
      } finally { this.locks.delete(signal.id); }
    }
    this.logMetrics(); return updatedTrades.filter(Boolean);
  }

  private async historicalStrategyMembership(userId: string) {
    // Current ranking controls new entries, never historical visibility.
    const orders = await this.prisma.paperOrder.findMany({
      where: { userId, portfolio: 'STRATEGY', entryTime: { not: null }, signalId: { not: null } },
      select: { signalId: true },
    });
    return { OR: [
      { aiStrategyListed: true },
      { aiStrategyListedAt: { not: null } },
      { id: { in: orders.map(order => order.signalId!) } },
    ] };
  }

  async strategyWeekly(userId: string, at = new Date()) {
    const { start, end } = strategyHistoryRange(at);
    const signals = await this.prisma.aiSignal.findMany({
      where: { userId, ...await this.historicalStrategyMembership(userId), entryTriggeredAt: { gte: start, lt: end }, side: { in: ['BUY', 'SELL'] } },
      select: { id: true, entryTriggeredAt: true, completedAt: true, profitPercent: true },
    });
    return summarizeStrategyMonth(signals, at);
  }

  private todayStrategyWhere(userId: string, at: Date) {
    const { start, end } = strategyHistoryRange(at, 1);
    return { userId, signalTime: { gte: start, lt: end },
      aiStrategyListedAt: { not: null, lte: at }, side: { in: ['BUY', 'SELL'] } };
  }

  async todayStrategySignals(userId: string, at = new Date()) {
    const signals = await this.prisma.aiSignal.findMany({
      where: this.todayStrategyWhere(userId, at),
      include: { events: { orderBy: { eventTime: 'asc' } }, stopLossDecision: { include: { timeline: true } }, managementDecision: true },
      orderBy: [{ signalTime: 'desc' }, { id: 'asc' }],
    });
    const rows = signals.map(signal => {
      const quote = this.prices?.get(userId, signal.instrumentKey);
      return {
        instrumentKey: signal.instrumentKey, symbol: signal.symbol, company: signal.stockName,
        tradeId: signal.id, signalId: signal.id, signal: signal.side, timeframe: signal.timeframe,
        price: quote?.ltp ?? signal.currentPrice, entry: signal.entryPrice,
        stopLoss: signal.stopLoss, target1: signal.target1, target2: signal.target2, target3: signal.target3,
        confidence: signal.confidence, aiScore: signal.aiScore, riskReward: signal.riskReward,
        trend: signal.side === 'BUY' ? 'BULLISH' : 'BEARISH', strategy: signal.strategy,
        tradeStatus: signal.status, signalGeneratedAt: signal.signalTime,
        entryTriggeredAt: signal.entryTriggeredAt, target1At: signal.target1At,
        target2At: signal.target2At, target3At: signal.target3At, stopLossAt: signal.stopLossAt,
        completedAt: signal.completedAt, profitPercent: signal.profitPercent,
        lastUpdated: signal.updatedAt, events: signal.events,
        stopLossDecision: signal.stopLossDecision, managementDecision: signal.managementDecision,
      };
    });
    return { todayBuy: rows.filter(row => row.signal === 'BUY'), todaySell: rows.filter(row => row.signal === 'SELL'),
      tradingDate: new Date(strategyHistoryRange(at, 1).start.getTime() + 330 * 60_000).toISOString().slice(0, 10) };
  }

  async targetOneAnalysis(userId: string, at = new Date(), period?: string) {
    const { start, end } = strategyHistoryRange(at);
    const signals = await this.prisma.aiSignal.findMany({
      where: period === 'today' ? this.todayStrategyWhere(userId, at) : { userId, strategyResult: { isNot: null }, entryTriggeredAt: { gte: start, lt: end }, side: { in: ['BUY', 'SELL'] } },
      select: {
        id: true, instrumentKey: true, symbol: true, stockName: true, side: true,
        entryTriggeredAt: true, entryPrice: true, target1: true, target1At: true, target1HitAt: true, target1ExecutedPrice: true,
        stopLossAt: true, stopLossHitAt: true, stopLoss: true, completedAt: true, exitPrice: true, status: true,
        events: { where: { type: { in: ['TARGET1_HIT', 'TARGET3_HIT', 'STOPLOSS_TOUCHED', 'STOPLOSS_HIT', 'STOPLOSS_CONFIRMED'] } }, select: { type: true, eventTime: true, executedPrice: true } },
      },
    });
    const report = analyzeTargetOne(signals, at);
    return period === 'today' ? { ...report, period: 'today' as const } : report;
  }

  async history(userId: string, status?: string) {
    const { start, end } = this.tradingDayRange();
    const stored = await this.prisma.aiSignal.findMany({ where: { userId, top100Selected: true, side: { in: ['BUY', 'SELL'] }, signalTime: { gte: start, lt: end } }, include: { events: { orderBy: { eventTime: 'asc' } }, postTradeAnalysis: true, stopLossDecision: { include: { timeline: { orderBy: { eventTime: 'asc' } } } }, managementDecision: true }, orderBy: [{ signalTime: 'desc' }, { aiScore: 'desc' }, { confidence: 'desc' }, { volume: 'desc' }] });
    const signals = stored
      .map((trade) => ({ ...trade, events: trade.events, postTradeAnalysis: trade.postTradeAnalysis, stopLossDecision: trade.stopLossDecision, managementDecision: trade.managementDecision }))
      .filter((trade) => trade.currentPrice >= 60 && trade.currentPrice <= 600)
      .filter((trade) => matchesStatusFilter(trade, status))
      .sort(compareTargetOneHits);
    const todaySignals = signals.filter((signal) => signal.signalTime >= start && signal.signalTime < end);
    const completed = todaySignals.filter((signal) => resolveSignalStatuses(signal).has('COMPLETED'));
    const winners = completed.filter((signal) => Number(signal.profitPercent) > 0), losers = completed.filter((signal) => Number(signal.profitPercent) < 0);
    const average = (items: typeof signals) => items.length ? items.reduce((sum, item) => sum + Number(item.profitPercent ?? 0), 0) / items.length : 0;
    const ranked = [...completed].sort((a, b) => Number(b.profitPercent) - Number(a.profitPercent));
    const publicTrade = ({ postTradeAnalysis: _postTradeAnalysis, stopLossDecision: _stopLossDecision, managementDecision: _managementDecision, ...trade }: typeof signals[number]) => trade;
    return { signals: signals.map(trade => this.prices?.mark(userId, publicTrade(trade)) ?? publicTrade(trade)), summary: { todaySignals: todaySignals.length, winningTrades: winners.length, losingTrades: losers.length, winRate: completed.length ? winners.length / completed.length * 100 : 0, averageProfit: average(winners), averageLoss: average(losers), bestTrade: ranked.at(0) ? publicTrade(ranked[0]) : null, worstTrade: ranked.at(-1) ? publicTrade(ranked.at(-1)!) : null } };
  }

  async one(userId: string, id: string) { const stored = await this.prisma.aiSignal.findFirst({ where: { id, userId }, include: { events: { orderBy: { eventTime: 'asc' } } } }); return stored; }
  async assertRegenerationAllowed(userId: string, id: string) {
    const trade = await this.one(userId, id);
    if (!trade) throw new BadRequestException('Trade not found.');
    if (!TERMINAL.includes(trade.status)) throw new ConflictException('A new trade cannot be generated while this trade is active.');
    return trade;
  }
  activeFor(userId: string, instrumentKey: string, timeframe: string, strategy?: string) {
    const { start, end } = this.tradingDayRange();
    return this.prisma.aiSignal.findFirst({ where: { userId, instrumentKey, timeframe, ...(strategy ? { strategy } : {}), status: { in: ACTIVE }, signalTime: { gte: start, lt: end } }, orderBy: { signalTime: 'desc' } });
  }
  latestFor(userId: string, instrumentKey: string, timeframe: string) { return this.prisma.aiSignal.findFirst({ where: { userId, instrumentKey, timeframe }, orderBy: { signalTime: 'desc' } }); }
  async executedStrategySignals(userId: string) {
    // Orders retain the original canonical ID even when ranking, scanner
    // coverage, session, or a newer setup for the same instrument changes.
    const orders = await this.prisma.paperOrder.findMany({
      where: { userId, portfolio: 'STRATEGY', entryTime: { not: null }, signalId: { not: null } },
      orderBy: { entryTime: 'desc' },
    });
    if (!orders.length) return [];
    const signals = await this.prisma.aiSignal.findMany({
      where: { userId, id: { in: orders.map(order => order.signalId!) } },
      include: { events: { orderBy: { eventTime: 'asc' } } },
    });
    const byId = new Map(signals.map(signal => [signal.id, signal]));
    return orders.flatMap(order => {
      const signal = byId.get(order.signalId!);
      if (!signal) return []; // Never synthesize a Demo-only signal.
      return [{
        instrumentKey: signal.instrumentKey, symbol: signal.symbol, company: signal.stockName,
        timeframe: signal.timeframe, signal: signal.side, signalId: signal.id, tradeId: signal.id,
        price: signal.currentPrice, entry: signal.entryPrice, stopLoss: signal.stopLoss,
        target1: signal.target1, target2: signal.target2, target3: signal.target3,
        confidence: signal.confidence, aiScore: signal.aiScore, riskReward: signal.riskReward,
        strategy: signal.strategy, trend: signal.side === 'BUY' ? 'BULLISH' : 'BEARISH',
        tradeStatus: signal.status, signalGeneratedAt: signal.signalTime,
        entryTriggeredAt: signal.entryTriggeredAt, target1At: signal.target1At,
        target2At: signal.target2At, target3At: signal.target3At,
        stopLossAt: signal.stopLossAt, completedAt: signal.completedAt,
        profitPercent: signal.profitPercent, events: signal.events, lastUpdated: signal.updatedAt,
        paperTrade: { id: order.id, signalId: order.signalId, status: order.status,
          entryPrice: order.entryPrice, exitPrice: order.exitPrice, entryTime: order.entryTime,
          exitTime: order.exitTime, quantity: order.quantity, pnl: order.pnl, exitReason: order.exitReason },
      }];
    });
  }
  async decorate<T extends { instrumentKey: string; timeframe: string }>(userId: string, rows: T[]) {
    const { start, end } = this.tradingDayRange();
    const validRows = rows.filter((row) => row?.instrumentKey && row?.timeframe);
    if (!validRows.length) return [];
    const pairs = [...new Map(validRows.map((row) => [`${row.instrumentKey}:${row.timeframe}`, { instrumentKey: row.instrumentKey, timeframe: row.timeframe }])).values()];
    this.logger.debug(JSON.stringify({ event: 'top.database.batch.query', userId, rows: validRows.length, uniquePairs: pairs.length }));
    const storedTrades = await this.prisma.aiSignal.findMany({
      where: { userId, signalTime: { gte: start, lt: end }, OR: pairs },
      include: { events: { orderBy: { eventTime: 'asc' } }, stopLossDecision: { include: { timeline: { orderBy: { eventTime: 'asc' } } } }, managementDecision: true },
      orderBy: { signalTime: 'desc' },
    });
    const latestByPair = new Map<string, typeof storedTrades[number]>();
    for (const trade of storedTrades) {
      const key = `${trade.instrumentKey}:${trade.timeframe}`;
      if (!latestByPair.has(key)) latestByPair.set(key, trade);
    }
    const decorated = validRows.map((row) => {
      try {
        const storedTrade = latestByPair.get(`${row.instrumentKey}:${row.timeframe}`);
        if (!storedTrade) return { ...row, tradeStatus: null, tradeId: null };
        const liveTrade = this.cached(storedTrade);
        // Cached lifecycle objects contain live scalar fields but not Prisma
        // relations. Merge instead of replacing so events/decisions survive.
        const trade = { ...storedTrade, ...(liveTrade ?? {}), events: storedTrade.events ?? [] };
        if (![trade.currentPrice, trade.entryPrice, trade.stopLoss, trade.target1, trade.target2, trade.target3, trade.aiScore, trade.confidence].every(Number.isFinite)) throw Object.assign(new Error('Trade contains a null, undefined, or non-finite numeric field.'), { tradeId: trade.id, symbol: trade.symbol });
        const stamp = (type: string, fallback: Date | null) => { const event = (trade.events ?? []).find((item) => item.type === type); return event ? `${event.eventTime.toISOString()}|Trigger ₹${event.triggerPrice.toFixed(2)}|Executed ₹${event.executedPrice.toFixed(2)}|${event.profitPercent >= 0 ? '+' : ''}${event.profitPercent.toFixed(2)}%|${event.holdingMinutes} min` : fallback; };
        return { ...row, price: trade.currentPrice, entry: trade.entryPrice, signal: trade.side, signalStrength: this.statusLabel(trade.status), strategy: trade.strategy, buyLevel: trade.side === 'BUY' ? trade.entryPrice : null, sellLevel: trade.side === 'SELL' ? trade.entryPrice : null, safeEntry: trade.entryPrice, aggressiveEntry: trade.entryPrice, stopLoss: trade.stopLoss, target1: trade.target1, target2: trade.target2, target3: trade.target3, confidence: trade.confidence, aiScore: trade.aiScore, intradayScore: trade.aiScore, riskReward: trade.riskReward, tradeStatus: trade.status, signalId: trade.id, tradeId: trade.id, signalGeneratedAt: stamp('SIGNAL_GENERATED', trade.signalTime), entryTriggeredAt: stamp('ENTRY_TRIGGERED', trade.entryTriggeredAt), target1At: stamp('TARGET1_HIT', trade.target1At), target2At: stamp('TARGET2_HIT', trade.target2At), target3At: stamp('TARGET3_HIT', trade.target3At), stopLossAt: stamp('STOPLOSS_CONFIRMED', trade.stopLossAt), completedAt: stamp('COMPLETED', trade.completedAt), profitPercent: trade.profitPercent, holdingDuration: trade.holdingMinutes, events: trade.events, stopLossDecision: storedTrade.stopLossDecision, managementDecision: storedTrade.managementDecision, lastUpdated: trade.updatedAt };
      } catch (error) { const exception = error instanceof Error ? error : new Error(String(error)); this.logger.error(JSON.stringify({ event: 'top.stock.skipped', exceptionName: exception.name, message: exception.message, tradeId: error && typeof error === 'object' && 'tradeId' in error ? String(error.tradeId) : null, symbol: error && typeof error === 'object' && 'symbol' in error ? String(error.symbol) : null, instrumentKey: row?.instrumentKey, stack: exception.stack }), exception.stack); return null; }
    });
    return decorated.filter((row): row is NonNullable<typeof row> => row !== null).map(row => protectOpeningSignal(row));
  }
  private strategy(row: ScanRow) {
    if (Boolean(row.indicators.orbBreak)) return 'ORB';
    if (row.tags.includes('breakout')) return 'Breakout';
    if (row.vwap && Math.abs(row.price - row.vwap) / row.price < .003) return 'VWAP';
    if ((row.signal === 'BUY' && row.price > (row.ema20 ?? row.price)) || (row.signal === 'SELL' && row.price < (row.ema20 ?? row.price))) return 'Momentum';
    return 'Pullback';
  }
  private profit(side: string, entry: number, exit: number) { return (side === 'BUY' ? exit - entry : entry - exit) / entry * 100; }
  private fingerprint(row: ScanRow) { const value = (input: number | null) => Number(input).toFixed(2); return [row.signal, value(row.entry), value(row.stopLoss), value(row.target1), value(row.target2), value(row.target3), row.aiScore].join(':'); }
  private isFresh(row: ScanRow, previous: { entryPrice: number; stopLoss: number; target1: number; target2: number; target3: number; aiScore: number }) {
    const changed = (left: number | null, right: number) => Number(left).toFixed(2) !== Number(right).toFixed(2);
    return changed(row.entry, previous.entryPrice) && changed(row.stopLoss, previous.stopLoss) && changed(row.target1, previous.target1) && changed(row.target2, previous.target2) && changed(row.target3, previous.target3) && row.aiScore !== previous.aiScore;
  }
  private statusLabel(value: string) { return value.replace('TARGET1', 'T1').replace('TARGET2', 'T2').replace('TARGET3', 'T3').replace('STOPLOSS', 'STOP LOSS').replaceAll('_', ' '); }
  private cached<T extends { id: string }>(trade: T) { for (const items of this.activeCache.values()) { const found = items.find((item) => item.id === trade.id); if (found) return found as T; } return null; }
  private queueLivePriceWrite(id: string, price: number, at: Date) {
    this.pendingLivePriceWrites.set(id, { price, at });
    if (this.livePriceFlushTimer) return;
    this.livePriceFlushTimer = setTimeout(() => this.flushLivePriceWrites(), 1_000);
  }
  private flushLivePriceWrites() {
    this.livePriceFlushTimer = undefined;
    const batch = [...this.pendingLivePriceWrites.entries()].slice(0, 100);
    for (const [signalId] of batch) this.pendingLivePriceWrites.delete(signalId);
    if (batch.length) this.enqueue(async () => {
      await this.prisma.$transaction(batch.map(([signalId, tick]) => this.prisma.aiSignal.updateMany({ where: { id: signalId, updatedAt: { lte: tick.at } }, data: { currentPrice: tick.price, updatedAt: tick.at } })));
      this.metrics.databaseWrites += batch.length;
    });
    if (this.pendingLivePriceWrites.size) this.livePriceFlushTimer = setTimeout(() => this.flushLivePriceWrites(), 1_000);
  }
  private enqueue(write: () => Promise<void>) { this.writeQueue.push(write); this.drain(); }
  private drain() { while (this.writers < 1 && this.writeQueue.length) { const write = this.writeQueue.shift()!; this.writers += 1; void write().catch((error) => this.logger.error(`Lifecycle queued write failed: ${error instanceof Error ? error.stack : String(error)}`)).finally(() => { this.writers -= 1; this.drain(); }); } }
  private logMetrics() { const processed = this.metrics.stateChanges + this.metrics.skippedUpdates; if (processed && processed % 100 === 0) this.logger.log(JSON.stringify({ event: 'lifecycle.metrics', activeTrades: [...this.activeCache.values()].reduce((sum, items) => sum + items.filter((item) => ACTIVE.includes(item.status)).length, 0), stateChanges: this.metrics.stateChanges, databaseWrites: this.metrics.databaseWrites, averageUpdateMs: this.metrics.stateChanges ? this.metrics.totalMs / this.metrics.stateChanges : 0, skippedUpdates: this.metrics.skippedUpdates, queuedWrites: this.writeQueue.length })); }
  private tradingDayRange(at = new Date()) {
    const shifted = new Date(at.getTime() + 330 * 60_000);
    const start = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 330 * 60_000);
    return { start, end: new Date(start.getTime() + 86_400_000) };
  }
}
