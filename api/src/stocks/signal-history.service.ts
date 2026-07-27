import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { ScanRow } from './scanner.service';
import { StopLossDecisionService } from './stop-loss-decision.service';

const ACTIVE = ['WAITING', 'ENTRY_TRIGGERED', 'RUNNING', 'TARGET1_HIT', 'TARGET2_HIT', 'TARGET3_HIT', 'STOPLOSS_CONFIRMATION'];
const TERMINAL = ['COMPLETED', 'STOPLOSS_HIT', 'STOPLOSS_CONFIRMED'];

@Injectable()
export class SignalHistoryService {
  private readonly logger = new Logger(SignalHistoryService.name);
  private readonly activeCache = new Map<string, any[]>();
  private readonly hydrating = new Map<string, Promise<any[]>>();
  private readonly locks = new Set<string>();
  private readonly writeQueue: Array<() => Promise<void>> = [];
  private writers = 0;
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
        const existing = await this.prisma.aiSignal.findFirst({ where: { userId, instrumentKey: row.instrumentKey, timeframe: row.timeframe, signalTime: { gte: start, lt: end } }, orderBy: { signalTime: 'desc' } });
        if (existing && ACTIVE.includes(existing.status)) {
          existing.currentPrice = row.price;
          continue;
        }
        if (existing && (!this.isFresh(row, existing) || existing.setupFingerprint === fingerprint)) continue;
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
      Object.assign(signal, data); this.metrics.stateChanges += 1; this.metrics.totalMs += Date.now() - startedAt;
      this.enqueue(async () => { await this.prisma.$transaction([this.prisma.aiSignal.update({ where: { id: signal.id }, data }), ...events.map((event) => this.prisma.aiTradeEvent.upsert({ where: { tradeId_type: { tradeId: signal.id, type: event.type } }, update: {}, create: { tradeId: signal.id, ...event } }))]); this.metrics.databaseWrites += 1; });
      this.logger.log(JSON.stringify({ event: 'lifecycle.updated', tradeId: signal.id, symbol: signal.symbol, fromStatus: signal.status, toStatus: data.status ?? signal.status, livePrice: price, events: events.map((event) => event.type) }));
      updatedTrades.push({ ...signal, events: [...(signal.events ?? []), ...events] }); this.locks.delete(signal.id);
    }
    this.logMetrics(); return updatedTrades.filter(Boolean);
  }

  async history(userId: string) {
    const { start, end } = this.tradingDayRange();
    const stored = await this.prisma.aiSignal.findMany({ where: { userId, top100Selected: true, side: { in: ['BUY', 'SELL'] }, signalTime: { gte: start, lt: end } }, include: { events: { orderBy: { eventTime: 'asc' } } }, orderBy: [{ signalTime: 'desc' }, { aiScore: 'desc' }, { confidence: 'desc' }, { volume: 'desc' }] });
    const signals = stored.map((trade) => this.cached(trade) ?? trade).filter((trade) => trade.currentPrice >= 60 && trade.currentPrice <= 600);
    const todaySignals = signals.filter((signal) => signal.signalTime >= start && signal.signalTime < end);
    const completed = todaySignals.filter((signal) => TERMINAL.includes(signal.status));
    const winners = completed.filter((signal) => Number(signal.profitPercent) > 0), losers = completed.filter((signal) => Number(signal.profitPercent) < 0);
    const average = (items: typeof signals) => items.length ? items.reduce((sum, item) => sum + Number(item.profitPercent ?? 0), 0) / items.length : 0;
    const ranked = [...completed].sort((a, b) => Number(b.profitPercent) - Number(a.profitPercent));
    return { signals, summary: { todaySignals: todaySignals.length, winningTrades: winners.length, losingTrades: losers.length, winRate: completed.length ? winners.length / completed.length * 100 : 0, averageProfit: average(winners), averageLoss: average(losers), bestTrade: ranked.at(0) ?? null, worstTrade: ranked.at(-1) ?? null } };
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
        const storedTrade = await this.prisma.aiSignal.findFirst({ where: { userId, instrumentKey: row.instrumentKey, timeframe: row.timeframe, signalTime: { gte: start, lt: end } }, include: { events: { orderBy: { eventTime: 'asc' } }, stopLossDecision: { include: { timeline: { orderBy: { eventTime: 'asc' } } } } }, orderBy: { signalTime: 'desc' } });
        if (!storedTrade) return { ...row, tradeStatus: null, tradeId: null };
        const trade = this.cached(storedTrade) ?? storedTrade;
        if (![trade.currentPrice, trade.entryPrice, trade.stopLoss, trade.target1, trade.target2, trade.target3, trade.aiScore, trade.confidence].every(Number.isFinite)) throw Object.assign(new Error('Trade contains a null, undefined, or non-finite numeric field.'), { tradeId: trade.id, symbol: trade.symbol });
        const stamp = (type: string, fallback: Date | null) => { const event = trade.events.find((item) => item.type === type); return event ? `${event.eventTime.toISOString()}|Trigger ₹${event.triggerPrice.toFixed(2)}|Executed ₹${event.executedPrice.toFixed(2)}|${event.profitPercent >= 0 ? '+' : ''}${event.profitPercent.toFixed(2)}%|${event.holdingMinutes} min` : fallback; };
        return { ...row, price: trade.currentPrice, signal: trade.side, signalStrength: this.statusLabel(trade.status), strategy: trade.strategy, buyLevel: trade.side === 'BUY' ? trade.entryPrice : null, sellLevel: trade.side === 'SELL' ? trade.entryPrice : null, safeEntry: trade.entryPrice, aggressiveEntry: trade.entryPrice, stopLoss: trade.stopLoss, target1: trade.target1, target2: trade.target2, target3: trade.target3, confidence: trade.confidence, aiScore: trade.aiScore, intradayScore: trade.aiScore, riskReward: trade.riskReward, tradeStatus: trade.status, tradeId: trade.id, signalGeneratedAt: stamp('SIGNAL_GENERATED', trade.signalTime), entryTriggeredAt: stamp('ENTRY_TRIGGERED', trade.entryTriggeredAt), target1At: stamp('TARGET1_HIT', trade.target1At), target2At: stamp('TARGET2_HIT', trade.target2At), target3At: stamp('TARGET3_HIT', trade.target3At), stopLossAt: stamp('STOPLOSS_CONFIRMED', trade.stopLossAt), completedAt: stamp('COMPLETED', trade.completedAt), profitPercent: trade.profitPercent, holdingDuration: trade.holdingMinutes, events: trade.events, stopLossDecision: storedTrade.stopLossDecision, lastUpdated: trade.updatedAt };
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
  private fingerprint(row: ScanRow) { const value = (input: number | null) => Number(input).toFixed(2); return [row.signal, value(row.entry), value(row.stopLoss), value(row.target1), value(row.target2), value(row.target3), row.aiScore].join(':'); }
  private isFresh(row: ScanRow, previous: { entryPrice: number; stopLoss: number; target1: number; target2: number; target3: number; aiScore: number }) {
    const changed = (left: number | null, right: number) => Number(left).toFixed(2) !== Number(right).toFixed(2);
    return changed(row.entry, previous.entryPrice) && changed(row.stopLoss, previous.stopLoss) && changed(row.target1, previous.target1) && changed(row.target2, previous.target2) && changed(row.target3, previous.target3) && row.aiScore !== previous.aiScore;
  }
  private statusLabel(value: string) { return value.replace('TARGET1', 'T1').replace('TARGET2', 'T2').replace('TARGET3', 'T3').replace('STOPLOSS', 'STOP LOSS').replaceAll('_', ' '); }
  private cached<T extends { id: string }>(trade: T) { for (const items of this.activeCache.values()) { const found = items.find((item) => item.id === trade.id); if (found) return found as T; } return null; }
  private enqueue(write: () => Promise<void>) { this.writeQueue.push(write); this.drain(); }
  private drain() { while (this.writers < 4 && this.writeQueue.length) { const write = this.writeQueue.shift()!; this.writers += 1; void write().catch((error) => this.logger.error(`Lifecycle queued write failed: ${error instanceof Error ? error.stack : String(error)}`)).finally(() => { this.writers -= 1; this.drain(); }); } }
  private logMetrics() { const processed = this.metrics.stateChanges + this.metrics.skippedUpdates; if (processed && processed % 100 === 0) this.logger.log(JSON.stringify({ event: 'lifecycle.metrics', activeTrades: [...this.activeCache.values()].reduce((sum, items) => sum + items.filter((item) => ACTIVE.includes(item.status)).length, 0), stateChanges: this.metrics.stateChanges, databaseWrites: this.metrics.databaseWrites, averageUpdateMs: this.metrics.stateChanges ? this.metrics.totalMs / this.metrics.stateChanges : 0, skippedUpdates: this.metrics.skippedUpdates, queuedWrites: this.writeQueue.length })); }
  private tradingDayRange(at = new Date()) {
    const shifted = new Date(at.getTime() + 330 * 60_000);
    const start = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 330 * 60_000);
    return { start, end: new Date(start.getTime() + 86_400_000) };
  }
}
