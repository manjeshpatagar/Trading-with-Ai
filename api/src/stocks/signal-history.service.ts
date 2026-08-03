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
  private metrics = { stateChanges: 0, databaseWrites: 0, skippedUpdates: 0, totalMs: 0 };
  constructor(private readonly prisma: PrismaService, private readonly stopLossDecision: StopLossDecisionService) {}

  async recordScannerSignals(userId: string, rows: ScanRow[]) {
    const { start, end } = this.tradingDayRange();
    const actionable = rows.filter((row) => row.universeRank <= 100 && row.price >= 60 && row.price <= 600 && (row.signal === 'BUY' || row.signal === 'SELL') && [row.entry, row.stopLoss, row.target1, row.target2, row.target3, row.riskReward].every((value) => Number.isFinite(value)));
    for (const row of actionable) {
      const fingerprint = this.fingerprint(row);
      const strategy = this.strategy(row);
      try {
        this.logger.debug(JSON.stringify({ event: 'signal.database.lookup', symbol: row.symbol, instrumentKey: row.instrumentKey, timeframe: row.timeframe }));
        const existing = await this.prisma.aiSignal.findFirst({ where: { userId, instrumentKey: row.instrumentKey, timeframe: row.timeframe, signalTime: { gte: start, lt: end } }, include: { managementDecision: true }, orderBy: { signalTime: 'desc' } });
        if (existing && ACTIVE.includes(existing.status)) {
          existing.currentPrice = row.price;
          continue;
        }
        const reentryAllowed = Boolean(existing && TERMINAL.includes(existing.status) && existing.managementDecision?.reentryStatus === 'RE-ENTRY ALLOWED');
        if (existing && TERMINAL.includes(existing.status) && !reentryAllowed) continue;
        if (existing && !reentryAllowed && (!this.isFresh(row, existing) || existing.setupFingerprint === fingerprint)) continue;
        const created = await this.prisma.aiSignal.create({ data: { signalKey: `${userId}:${row.instrumentKey}:${row.timeframe}:${Date.now()}:${crypto.randomUUID()}`, setupFingerprint: fingerprint, userId, instrumentKey: row.instrumentKey, stockName: row.company, symbol: row.symbol, sector: row.sector, strategy, timeframe: row.timeframe, side: row.signal, currentPrice: row.price, entryPrice: row.entry!, stopLoss: row.stopLoss!, target1: row.target1!, target2: row.target2!, target3: row.target3!, confidence: row.confidence, aiScore: row.aiScore, riskReward: row.riskReward!, volume: row.volume, universeRank: row.universeRank, selectionScore: row.selectionScore, top100Selected: true, events: { create: { type: 'SIGNAL_GENERATED', triggerPrice: row.price, executedPrice: row.price, profitPercent: 0, holdingMinutes: 0 } } } });
        const cacheKey = `${userId}:${created.instrumentKey}`; this.activeCache.set(cacheKey, [...(this.activeCache.get(cacheKey) ?? []).filter((trade) => trade.id !== created.id), created]);
        this.logger.log(JSON.stringify({ event: 'signal.generated', tradeId: created.id, symbol: created.symbol, side: created.side, aiScore: created.aiScore, strategy: created.strategy, timeframe: created.timeframe }));
      } catch (error) { const exception = error instanceof Error ? error : new Error(String(error)); this.logger.error(JSON.stringify({ event: 'signal.generation.error', exceptionName: exception.name, message: exception.message, symbol: row?.symbol, tradeId: null, stack: exception.stack }), exception.stack); }
    }
  }

  async processTick(userId: string, instrumentKey: string, price: number, at = new Date()) {
    if (!Number.isFinite(price)) return [];
    const { start, end } = this.tradingDayRange(at);
    const cacheKey = `${userId}:${instrumentKey}`;
    let signals = this.activeCache.get(cacheKey);
    if (!signals) { let pending = this.hydrating.get(cacheKey); if (!pending) { this.logger.debug(JSON.stringify({ event: 'lifecycle.cache.hydrate', instrumentKey })); pending = this.prisma.aiSignal.findMany({ where: { userId, instrumentKey, status: { in: ACTIVE }, signalTime: { gte: start, lt: end } } }); this.hydrating.set(cacheKey, pending); } signals = await pending; this.activeCache.set(cacheKey, signals); this.hydrating.delete(cacheKey); }
    signals = signals.filter((trade) => ACTIVE.includes(trade.status) && trade.signalTime >= start && trade.signalTime < end);
    this.activeCache.set(cacheKey, signals);
    const updatedTrades = [];
    for (const signal of signals) {
      if (this.locks.has(signal.id)) { this.metrics.skippedUpdates += 1; continue; }
      this.locks.add(signal.id); const startedAt = Date.now();
      const buy = signal.side === 'BUY'; const reached = (level: number) => buy ? price >= level : price <= level; const stopped = buy ? price <= signal.stopLoss : price >= signal.stopLoss;
      const elapsed = (from: Date) => Math.max(0, Math.round((at.getTime() - from.getTime()) / 60_000));
      let data: Record<string, unknown> = { currentPrice: price };
      const events: Array<{ type: string; triggerPrice: number; executedPrice: number; eventTime: Date; profitPercent: number; holdingMinutes: number }> = [];
      const entered = signal.status !== 'WAITING' || reached(signal.entryPrice);
      const entryAt = signal.entryTriggeredAt ?? (entered ? at : null);
      const addEvent = (type: string, triggerPrice: number, eventTime = at) => events.push({ type, triggerPrice, executedPrice: price, eventTime, profitPercent: type === 'SIGNAL_GENERATED' || type === 'ENTRY_TRIGGERED' || type === 'RUNNING' ? 0 : this.profit(signal.side, signal.entryPrice, price), holdingMinutes: entryAt ? elapsed(entryAt) : 0 });
      if (entered && !signal.entryTriggeredAt) { data = { ...data, entryTriggeredAt: at, entryExecutedPrice: price }; addEvent('ENTRY_TRIGGERED', signal.entryPrice); }
      if (entered && signal.status === 'STOPLOSS_CONFIRMATION') {
        let confirmation;
        try { confirmation = await this.stopLossDecision.evaluateConfirmation(userId, signal, price, at); }
        catch (error) { this.logger.error(JSON.stringify({ event: 'stoploss.confirmation.error', tradeId: signal.id, symbol: signal.symbol, message: error instanceof Error ? error.message : String(error) })); this.locks.delete(signal.id); continue; }
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
        catch (error) { this.logger.error(JSON.stringify({ event: 'stoploss.decision.error', tradeId: signal.id, symbol: signal.symbol, message: error instanceof Error ? error.message : String(error) })); this.locks.delete(signal.id); continue; }
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
      } else if (entered && reached(signal.target2)) {
        data = { ...data, status: 'TARGET2_HIT', entryTriggeredAt: entryAt, runningAt: signal.runningAt ?? at, target1At: signal.target1At ?? at, target1HitAt: signal.target1At ?? at, target1ExecutedPrice: signal.target1At ? signal.target1ExecutedPrice : price, target2At: signal.target2At ?? at, target2HitAt: signal.target2At ?? at, target2ExecutedPrice: signal.target2At ? signal.target2ExecutedPrice : price };
        if (!signal.runningAt) addEvent('RUNNING', signal.entryPrice); if (!signal.target1At) addEvent('TARGET1_HIT', signal.target1); if (!signal.target2At) addEvent('TARGET2_HIT', signal.target2);
      } else if (entered && reached(signal.target1)) {
        data = { ...data, status: 'TARGET1_HIT', entryTriggeredAt: entryAt, runningAt: signal.runningAt ?? at, target1At: signal.target1At ?? at, target1HitAt: signal.target1At ?? at, target1ExecutedPrice: signal.target1At ? signal.target1ExecutedPrice : price };
        if (!signal.runningAt) addEvent('RUNNING', signal.entryPrice); if (!signal.target1At) addEvent('TARGET1_HIT', signal.target1);
      } else if (entered && signal.status === 'WAITING') data = { ...data, status: 'ENTRY_TRIGGERED', entryTriggeredAt: at };
      else if (signal.status === 'ENTRY_TRIGGERED') { data = { ...data, status: 'RUNNING', runningAt: signal.runningAt ?? at }; if (!signal.runningAt) addEvent('RUNNING', signal.entryPrice); }
      const nextStatus = typeof data.status === 'string' ? data.status : signal.status;
      signal.currentPrice = price;
      if (nextStatus === signal.status) { this.metrics.skippedUpdates += 1; this.locks.delete(signal.id); continue; }
      const fromStatus = signal.status;
      try {
        await this.prisma.$transaction([this.prisma.aiSignal.update({ where: { id: signal.id }, data }), ...events.map((event) => this.prisma.aiTradeEvent.upsert({ where: { tradeId_type: { tradeId: signal.id, type: event.type } }, update: {}, create: { tradeId: signal.id, ...event } }))]);
        this.metrics.databaseWrites += 1;
      } catch (error) {
        this.locks.delete(signal.id);
        throw error;
      }
      Object.assign(signal, data); this.metrics.stateChanges += 1; this.metrics.totalMs += Date.now() - startedAt;
      this.logger.log(JSON.stringify({ event: 'lifecycle.updated', tradeId: signal.id, symbol: signal.symbol, fromStatus, toStatus: data.status ?? signal.status, livePrice: price, events: events.map((event) => event.type) }));
      updatedTrades.push({ ...signal, events: [...(signal.events ?? []), ...events] }); this.locks.delete(signal.id);
    }
    this.logMetrics(); return updatedTrades.filter(Boolean);
  }

  async history(userId: string, status?: string) {
    const { start, end } = this.tradingDayRange();
    const stored = await this.prisma.aiSignal.findMany({ where: { userId, top100Selected: true, side: { in: ['BUY', 'SELL'] }, signalTime: { gte: start, lt: end } }, include: { events: { orderBy: { eventTime: 'asc' } }, postTradeAnalysis: true, stopLossDecision: { include: { timeline: { orderBy: { eventTime: 'asc' } } } }, managementDecision: true }, orderBy: [{ signalTime: 'desc' }, { aiScore: 'desc' }, { confidence: 'desc' }, { volume: 'desc' }] });
    const allToday = stored
      .map((trade) => ({ ...trade, ...(this.cached(trade) ?? {}), events: trade.events, postTradeAnalysis: trade.postTradeAnalysis, stopLossDecision: trade.stopLossDecision, managementDecision: trade.managementDecision }))
      .filter((trade) => trade.currentPrice >= 60 && trade.currentPrice <= 600);
    const signals = allToday.filter((trade) => matchesStatusFilter(trade, status));
    const todaySignals = signals.filter((signal) => signal.signalTime >= start && signal.signalTime < end);
    const completed = todaySignals.filter((signal) => resolveSignalStatuses(signal).has('COMPLETED'));
    const winners = completed.filter((signal) => Number(signal.profitPercent) > 0), losers = completed.filter((signal) => Number(signal.profitPercent) < 0);
    const average = (items: typeof signals) => items.length ? items.reduce((sum, item) => sum + Number(item.profitPercent ?? 0), 0) / items.length : 0;
    const ranked = [...completed].sort((a, b) => Number(b.profitPercent) - Number(a.profitPercent));
    const publicTrade = ({ postTradeAnalysis: _postTradeAnalysis, stopLossDecision: _stopLossDecision, managementDecision: _managementDecision, ...trade }: typeof signals[number]) => trade;
    return {
      signals: signals.map(publicTrade),
      summary: { todaySignals: todaySignals.length, winningTrades: winners.length, losingTrades: losers.length, winRate: completed.length ? winners.length / completed.length * 100 : 0, averageProfit: average(winners), averageLoss: average(losers), bestTrade: ranked.at(0) ? publicTrade(ranked[0]) : null, worstTrade: ranked.at(-1) ? publicTrade(ranked.at(-1)!) : null },
      analytics: this.tradeProgressAnalytics(allToday),
    };
  }

  async one(userId: string, id: string) { const stored = await this.prisma.aiSignal.findFirst({ where: { id, userId }, include: { events: { orderBy: { eventTime: 'asc' } } } }); return stored ? this.cached(stored) ?? stored : null; }
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
  async decorate<T extends { instrumentKey: string; timeframe: string }>(userId: string, rows: T[]) {
    const { start, end } = this.tradingDayRange();
    const decorated = await Promise.all(rows.map(async (row) => {
      try {
        if (!row?.instrumentKey || !row?.timeframe) throw new Error('Invalid scanner row: instrumentKey and timeframe are required.');
        this.logger.debug(JSON.stringify({ event: 'top.database.query', instrumentKey: row.instrumentKey, timeframe: row.timeframe }));
        const storedTrade = await this.prisma.aiSignal.findFirst({ where: { userId, instrumentKey: row.instrumentKey, timeframe: row.timeframe, signalTime: { gte: start, lt: end } }, include: { events: { orderBy: { eventTime: 'asc' } }, stopLossDecision: { include: { timeline: { orderBy: { eventTime: 'asc' } } } }, managementDecision: true }, orderBy: { signalTime: 'desc' } });
        if (!storedTrade) return { ...row, tradeStatus: null, tradeId: null };
        const trade = this.cached(storedTrade) ?? storedTrade;
        if (![trade.currentPrice, trade.entryPrice, trade.stopLoss, trade.target1, trade.target2, trade.target3, trade.aiScore, trade.confidence].every(Number.isFinite)) throw Object.assign(new Error('Trade contains a null, undefined, or non-finite numeric field.'), { tradeId: trade.id, symbol: trade.symbol });
        const stamp = (type: string, fallback: Date | null) => { const event = trade.events.find((item) => item.type === type); return event ? `${event.eventTime.toISOString()}|Trigger ₹${event.triggerPrice.toFixed(2)}|Executed ₹${event.executedPrice.toFixed(2)}|${event.profitPercent >= 0 ? '+' : ''}${event.profitPercent.toFixed(2)}%|${event.holdingMinutes} min` : fallback; };
        return { ...row, price: trade.currentPrice, signal: trade.side, signalStrength: this.statusLabel(trade.status), strategy: trade.strategy, buyLevel: trade.side === 'BUY' ? trade.entryPrice : null, sellLevel: trade.side === 'SELL' ? trade.entryPrice : null, safeEntry: trade.entryPrice, aggressiveEntry: trade.entryPrice, stopLoss: trade.stopLoss, target1: trade.target1, target2: trade.target2, target3: trade.target3, confidence: trade.confidence, aiScore: trade.aiScore, intradayScore: trade.aiScore, riskReward: trade.riskReward, tradeStatus: trade.status, tradeId: trade.id, signalGeneratedAt: stamp('SIGNAL_GENERATED', trade.signalTime), entryTriggeredAt: stamp('ENTRY_TRIGGERED', trade.entryTriggeredAt), target1At: stamp('TARGET1_HIT', trade.target1At), target2At: stamp('TARGET2_HIT', trade.target2At), target3At: stamp('TARGET3_HIT', trade.target3At), stopLossAt: stamp('STOPLOSS_CONFIRMED', trade.stopLossAt), completedAt: stamp('COMPLETED', trade.completedAt), profitPercent: trade.profitPercent, holdingDuration: trade.holdingMinutes, events: trade.events, stopLossDecision: storedTrade.stopLossDecision, managementDecision: storedTrade.managementDecision, lastUpdated: trade.updatedAt };
      } catch (error) { const exception = error instanceof Error ? error : new Error(String(error)); this.logger.error(JSON.stringify({ event: 'top.stock.skipped', exceptionName: exception.name, message: exception.message, tradeId: error && typeof error === 'object' && 'tradeId' in error ? String(error.tradeId) : null, symbol: error && typeof error === 'object' && 'symbol' in error ? String(error.symbol) : null, instrumentKey: row?.instrumentKey, stack: exception.stack }), exception.stack); return null; }
    }));
    return decorated.filter((row): row is NonNullable<typeof row> => row !== null);
  }
  private strategy(row: ScanRow) {
    if (Boolean(row.indicators.orbBreak)) return 'ORB';
    if (row.tags.includes('breakout')) return 'Breakout';
    if (row.vwap && Math.abs(row.price - row.vwap) / row.price < .003) return 'VWAP';
    if ((row.signal === 'BUY' && row.price > (row.ema20 ?? row.price)) || (row.signal === 'SELL' && row.price < (row.ema20 ?? row.price))) return 'Momentum';
    return 'Pullback';
  }
  private profit(side: string, entry: number, exit: number) { return (side === 'BUY' ? exit - entry : entry - exit) / entry * 100; }
  private tradeProgressAnalytics<T extends { id: string; status: string; confidence: number; profitPercent: number | null; events: Array<{ type: string }> }>(trades: T[]) {
    type Predicate = (trade: T, events: Set<string>) => boolean;
    const eventSets = new Map(trades.map((trade) => [trade.id, new Set(trade.events.map((event) => event.type))]));
    const has = (trade: T, type: string) => eventSets.get(trade.id)?.has(type) ?? false;
    const any = (trade: T, types: string[]) => types.some((type) => has(trade, type));
    const active = (trade: T) => ACTIVE.includes(trade.status);
    const stopped = (trade: T) => any(trade, ['STOPLOSS_HIT', 'STOPLOSS_CONFIRMED']);
    const completed = (trade: T) => has(trade, 'COMPLETED') || trade.status === 'COMPLETED';
    const metric = (key: string, label: string, predicate: Predicate) => {
      const signalIds = trades.filter((trade) => predicate(trade, eventSets.get(trade.id)!)).map((trade) => trade.id);
      return { key, label, count: signalIds.length, signalIds };
    };
    const section = (key: string, title: string, totalPredicate: Predicate, metrics: ReturnType<typeof metric>[]) => {
      const signalIds = trades.filter((trade) => totalPredicate(trade, eventSets.get(trade.id)!)).map((trade) => trade.id);
      return { key, title, count: signalIds.length, signalIds, metrics };
    };
    const afterTarget = (trade: T, target: number) => stopped(trade) && has(trade, `TARGET${target}_HIT`) && (target === 3 || !has(trade, `TARGET${target + 1}_HIT`));
    const qualityKey = (trade: T) => {
      if (completed(trade) && has(trade, 'TARGET3_HIT') && !stopped(trade) && trade.confidence > 95) return 'elite';
      if (has(trade, 'TARGET2_HIT') && active(trade) && !stopped(trade)) return 'excellent';
      if (has(trade, 'TARGET1_HIT') && !stopped(trade)) return 'good';
      if (stopped(trade) && !has(trade, 'TARGET1_HIT')) return 'weak';
      return 'average';
    };
    const qualityLabels = {
      elite: { label: 'Elite', stars: 5, tone: 'emerald' },
      excellent: { label: 'Excellent', stars: 4, tone: 'emerald' },
      good: { label: 'Good', stars: 3, tone: 'blue' },
      average: { label: 'Watch', stars: 2, tone: 'amber' },
      weak: { label: 'Weak', stars: 1, tone: 'rose' },
    } as const;
    const qualities = Object.entries(qualityLabels).map(([key, value]) => ({ ...metric(`quality_${key}`, value.label, (trade) => qualityKey(trade) === key), ...value }));
    const qualityBySignal = Object.fromEntries(trades.map((trade) => [trade.id, { key: qualityKey(trade), ...qualityLabels[qualityKey(trade)] }]));
    const rate = (numerator: number, denominator: number) => denominator ? numerator / denominator * 100 : 0;
    const rating = (percent: number, inverse = false) => {
      const score = inverse ? 100 - percent : percent;
      if (score >= 95) return { rating: score >= 99.5 ? 'Perfect' : 'Excellent', stars: 5, tone: 'emerald' };
      if (score >= 75) return { rating: 'Very Good', stars: 4, tone: 'emerald' };
      if (score >= 50) return { rating: 'Good', stars: 3, tone: 'blue' };
      if (score >= 30) return { rating: 'Average', stars: 2, tone: 'amber' };
      return { rating: 'Weak', stars: 1, tone: 'rose' };
    };
    const cohortCount = (predicate: Predicate) => trades.filter((trade) => predicate(trade, eventSets.get(trade.id)!)).length;
    const running = cohortCount((trade) => has(trade, 'RUNNING'));
    const target1 = cohortCount((trade) => has(trade, 'TARGET1_HIT'));
    const target2 = cohortCount((trade) => has(trade, 'TARGET2_HIT'));
    const target3 = cohortCount((trade) => has(trade, 'TARGET3_HIT'));
    const completedCount = cohortCount((trade) => completed(trade));
    const stopLoss = cohortCount((trade) => stopped(trade));
    const conversions = [
      ['running_target1', 'Running → Target 1', target1, running, false],
      ['target1_target2', 'Target 1 → Target 2', target2, target1, false],
      ['target2_target3', 'Target 2 → Target 3', target3, target2, false],
      ['target3_completed', 'Target 3 → Completed', cohortCount((trade) => has(trade, 'TARGET3_HIT') && completed(trade)), target3, false],
      ['running_stoploss', 'Running → Stop Loss', cohortCount((trade) => has(trade, 'RUNNING') && stopped(trade)), running, true],
    ].map(([key, label, numerator, denominator, inverse]) => {
      const percentage = rate(Number(numerator), Number(denominator));
      return { key, label, numerator, denominator, percentage, ...rating(percentage, Boolean(inverse)) };
    });
    const winners = trades.filter((trade) => completed(trade) && Number(trade.profitPercent) > 0);
    const losers = trades.filter((trade) => completed(trade) && Number(trade.profitPercent) < 0);
    const average = (items: T[]) => items.length ? items.reduce((sum, trade) => sum + Number(trade.profitPercent), 0) / items.length : 0;
    const stopTouches = cohortCount((trade) => has(trade, 'STOPLOSS_TOUCHED'));
    const recoveries = cohortCount((trade) => has(trade, 'STOPLOSS_RECOVERED'));
    const winRate = rate(winners.length, completedCount);
    const recoveryRate = rate(recoveries, stopTouches);
    const stopLossRate = rate(stopLoss, Math.max(running, cohortCount((trade) => has(trade, 'ENTRY_TRIGGERED'))));
    const conversionScore = conversions.slice(0, 4).reduce((sum, item) => sum + item.percentage, 0);
    const aiScore = Math.round((winRate + recoveryRate + (100 - stopLossRate) + conversionScore) / 7);
    return {
      generatedAt: new Date().toISOString(),
      compactFlow: [
        metric('flow_today', "Today's Signals", () => true),
        metric('flow_waiting_now', 'Waiting', (trade) => trade.status === 'WAITING'),
        metric('flow_entry', 'Entry', (trade) => has(trade, 'ENTRY_TRIGGERED')),
        metric('flow_running', 'Running', (trade) => has(trade, 'RUNNING')),
        metric('flow_target1', 'T1', (trade) => has(trade, 'TARGET1_HIT')),
        metric('flow_target2', 'T2', (trade) => has(trade, 'TARGET2_HIT')),
        metric('flow_target3', 'T3', (trade) => has(trade, 'TARGET3_HIT')),
        metric('flow_completed', 'Completed', (trade) => completed(trade)),
        metric('flow_stoploss', 'Stop Loss', (trade) => stopped(trade)),
      ],
      conversions,
      qualities,
      qualityBySignal,
      health: [
        { key: 'health_win', label: 'Win Rate', value: winRate, suffix: '%', ...rating(winRate) },
        { key: 'health_profit', label: 'Average Profit', value: average(winners), suffix: '%', ...rating(Math.min(100, average(winners) * 20)) },
        { key: 'health_loss', label: 'Average Loss', value: Math.abs(average(losers)), suffix: '%', ...rating(Math.min(100, Math.abs(average(losers)) * 20), true) },
        { key: 'health_recovery', label: 'Recovery Rate', value: recoveryRate, suffix: '%', ...rating(recoveryRate) },
        { key: 'health_stop', label: 'Stop Loss Rate', value: stopLossRate, suffix: '%', ...rating(stopLossRate, true) },
        { key: 'health_score', label: 'AI Score', value: aiScore, suffix: '/100', ...rating(aiScore) },
      ],
      sections: [
        section('flow', 'Trade Flow Analytics', () => true, [
          metric('flow_waiting', 'Waiting', () => true),
          metric('flow_entry', 'Entry Triggered', (trade) => has(trade, 'ENTRY_TRIGGERED')),
          metric('flow_running', 'Running', (trade) => has(trade, 'RUNNING')),
          metric('flow_target1', 'Target 1', (trade) => has(trade, 'TARGET1_HIT')),
          metric('flow_target2', 'Target 2', (trade) => has(trade, 'TARGET2_HIT')),
          metric('flow_target3', 'Target 3', (trade) => has(trade, 'TARGET3_HIT')),
          metric('flow_completed', 'Trade Completed', (trade) => completed(trade)),
        ]),
        section('running', 'Running Analytics', (trade) => has(trade, 'RUNNING'), [
          metric('running_target1', 'Reached Target 1', (trade) => has(trade, 'RUNNING') && has(trade, 'TARGET1_HIT')),
          metric('running_target2', 'Reached Target 2', (trade) => has(trade, 'RUNNING') && has(trade, 'TARGET2_HIT')),
          metric('running_target3', 'Reached Target 3', (trade) => has(trade, 'RUNNING') && has(trade, 'TARGET3_HIT')),
          metric('running_completed', 'Completed', (trade) => has(trade, 'RUNNING') && completed(trade)),
          metric('running_stoploss', 'Stop Loss', (trade) => has(trade, 'RUNNING') && stopped(trade)),
          metric('running_active', 'Still Running', (trade) => has(trade, 'RUNNING') && active(trade)),
          metric('running_ai_wait', 'Waiting AI Exit', (trade) => has(trade, 'RUNNING') && (trade.status === 'STOPLOSS_CONFIRMATION' || (has(trade, 'STOPLOSS_TOUCHED') && !stopped(trade)))),
        ]),
        section('target1', 'Target 1 Analytics', (trade) => has(trade, 'TARGET1_HIT'), [
          metric('target1_target2', 'Reached Target 2', (trade) => has(trade, 'TARGET1_HIT') && has(trade, 'TARGET2_HIT')),
          metric('target1_target3', 'Reached Target 3', (trade) => has(trade, 'TARGET1_HIT') && has(trade, 'TARGET3_HIT')),
          metric('target1_completed', 'Completed', (trade) => has(trade, 'TARGET1_HIT') && completed(trade)),
          metric('target1_stoploss', 'Hit Stop Loss after Target 1', (trade) => afterTarget(trade, 1)),
          metric('target1_active', 'Still Running', (trade) => has(trade, 'TARGET1_HIT') && active(trade)),
        ]),
        section('target2', 'Target 2 Analytics', (trade) => has(trade, 'TARGET2_HIT'), [
          metric('target2_target3', 'Reached Target 3', (trade) => has(trade, 'TARGET2_HIT') && has(trade, 'TARGET3_HIT')),
          metric('target2_completed', 'Completed', (trade) => has(trade, 'TARGET2_HIT') && completed(trade)),
          metric('target2_stoploss', 'Hit Stop Loss after Target 2', (trade) => afterTarget(trade, 2)),
          metric('target2_active', 'Still Running', (trade) => has(trade, 'TARGET2_HIT') && active(trade)),
        ]),
        section('target3', 'Target 3 Analytics', (trade) => has(trade, 'TARGET3_HIT'), [
          metric('target3_completed', 'Completed Successfully', (trade) => has(trade, 'TARGET3_HIT') && completed(trade) && Number(trade.profitPercent) > 0),
          metric('target3_stoploss', 'Hit Stop Loss after Target 3', (trade) => afterTarget(trade, 3)),
          metric('target3_ai_exit', 'AI Exit', (trade) => has(trade, 'TARGET3_HIT') && any(trade, ['AI_EXIT', 'AIExit'])),
          metric('target3_active', 'Still Running', (trade) => has(trade, 'TARGET3_HIT') && active(trade)),
        ]),
        section('entry', 'Entry Triggered Analytics', (trade) => has(trade, 'ENTRY_TRIGGERED'), [
          metric('entry_running', 'Moved to Running', (trade) => has(trade, 'ENTRY_TRIGGERED') && has(trade, 'RUNNING')),
          metric('entry_stoploss', 'Hit Stop Loss before Running', (trade) => has(trade, 'ENTRY_TRIGGERED') && stopped(trade) && !has(trade, 'RUNNING')),
          metric('entry_cancelled', 'Cancelled', (trade) => has(trade, 'ENTRY_TRIGGERED') && any(trade, ['CANCELLED', 'CANCELED'])),
          metric('entry_expired', 'Expired', (trade) => has(trade, 'ENTRY_TRIGGERED') && has(trade, 'EXPIRED')),
          metric('entry_waiting', 'Still Waiting', (trade) => trade.status === 'ENTRY_TRIGGERED'),
        ]),
        section('waiting', 'Waiting Analytics', () => true, [
          metric('waiting_entry', 'Entry Triggered', (trade) => has(trade, 'ENTRY_TRIGGERED')),
          metric('waiting_cancelled', 'Cancelled', (trade) => any(trade, ['CANCELLED', 'CANCELED'])),
          metric('waiting_expired', 'Expired', (trade) => has(trade, 'EXPIRED')),
          metric('waiting_still', 'Still Waiting', (trade) => trade.status === 'WAITING'),
        ]),
        section('stoploss', 'Stop Loss Breakdown', (trade) => stopped(trade), [
          metric('stop_before_t1', 'Stopped Before Target 1', (trade) => stopped(trade) && !has(trade, 'TARGET1_HIT')),
          metric('stop_after_t1', 'Stopped After Target 1', (trade) => afterTarget(trade, 1)),
          metric('stop_after_t2', 'Stopped After Target 2', (trade) => afterTarget(trade, 2)),
          metric('stop_after_t3', 'Stopped After Target 3', (trade) => afterTarget(trade, 3)),
          metric('stop_break_even', 'Stopped After Break-even', (trade) => stopped(trade) && any(trade, ['BREAK_EVEN', 'BREAK_EVEN_HIT'])),
          metric('stop_trailing', 'Stopped by Trailing Stop', (trade) => stopped(trade) && any(trade, ['TRAILING_STOP', 'TRAILING_STOP_HIT'])),
          metric('stop_ai_exit', 'Stopped by AI Exit', (trade) => any(trade, ['AI_EXIT', 'AIExit'])),
        ]),
        section('wins', 'Winning Trades', (trade) => completed(trade) && Number(trade.profitPercent) > 0, [
          metric('win_target1', 'Exited at Target 1', (trade) => Number(trade.profitPercent) > 0 && completed(trade) && has(trade, 'TARGET1_HIT') && !has(trade, 'TARGET2_HIT')),
          metric('win_target2', 'Exited at Target 2', (trade) => Number(trade.profitPercent) > 0 && completed(trade) && has(trade, 'TARGET2_HIT') && !has(trade, 'TARGET3_HIT')),
          metric('win_target3', 'Exited at Target 3', (trade) => Number(trade.profitPercent) > 0 && completed(trade) && has(trade, 'TARGET3_HIT')),
          metric('win_ai_exit', 'AI Exit Profit', (trade) => Number(trade.profitPercent) > 0 && any(trade, ['AI_EXIT', 'AIExit'])),
          metric('win_trailing', 'Trailing Stop Profit', (trade) => Number(trade.profitPercent) > 0 && any(trade, ['TRAILING_STOP', 'TRAILING_STOP_HIT'])),
          metric('win_market_close', 'Market Close Profit', (trade) => Number(trade.profitPercent) > 0 && any(trade, ['MARKET_CLOSE', 'MARKET CLOSE'])),
        ]),
      ],
    };
  }
  private fingerprint(row: ScanRow) { const value = (input: number | null) => Number(input).toFixed(2); return [row.signal, value(row.entry), value(row.stopLoss), value(row.target1), value(row.target2), value(row.target3), row.aiScore].join(':'); }
  private isFresh(row: ScanRow, previous: { entryPrice: number; stopLoss: number; target1: number; target2: number; target3: number; aiScore: number }) {
    const changed = (left: number | null, right: number) => Number(left).toFixed(2) !== Number(right).toFixed(2);
    return changed(row.entry, previous.entryPrice) && changed(row.stopLoss, previous.stopLoss) && changed(row.target1, previous.target1) && changed(row.target2, previous.target2) && changed(row.target3, previous.target3) && row.aiScore !== previous.aiScore;
  }
  private statusLabel(value: string) { return value.replace('TARGET1', 'T1').replace('TARGET2', 'T2').replace('TARGET3', 'T3').replace('STOPLOSS', 'STOP LOSS').replaceAll('_', ' '); }
  private cached<T extends { id: string }>(trade: T) { for (const items of this.activeCache.values()) { const found = items.find((item) => item.id === trade.id); if (found) return found as T; } return null; }
  private logMetrics() { const processed = this.metrics.stateChanges + this.metrics.skippedUpdates; if (processed && processed % 100 === 0) this.logger.log(JSON.stringify({ event: 'lifecycle.metrics', activeTrades: [...this.activeCache.values()].reduce((sum, items) => sum + items.filter((item) => ACTIVE.includes(item.status)).length, 0), stateChanges: this.metrics.stateChanges, databaseWrites: this.metrics.databaseWrites, averageUpdateMs: this.metrics.stateChanges ? this.metrics.totalMs / this.metrics.stateChanges : 0, skippedUpdates: this.metrics.skippedUpdates, queuedWrites: 0 })); }
  private tradingDayRange(at = new Date()) {
    const shifted = new Date(at.getTime() + 330 * 60_000);
    const start = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 330 * 60_000);
    return { start, end: new Date(start.getTime() + 86_400_000) };
  }
}
