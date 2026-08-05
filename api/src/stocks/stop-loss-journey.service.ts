import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { UpstoxService } from './upstox.service';
import { matchesStatusFilter } from './signal-status-filter';

export type JourneyCandle = { time: Date; open: number; high: number; low: number; close: number; volume: number };

export function reconstructStopLossJourney(signal: any, candles: JourneyCandle[]) {
  const buy = signal.side === 'BUY';
  const entry = Number(signal.entryPrice), stop = Number(signal.stopLoss), exit = Number(signal.exitPrice ?? stop);
  const ordered = [...candles].sort((a, b) => a.time.getTime() - b.time.getTime());
  const endedAt = new Date(signal.stopLossAt ?? signal.stopLossHitAt ?? signal.completedAt);
  const stopMinute = Math.floor(endedAt.getTime() / 60_000) * 60_000;
  // The high/low ordering inside the stop-loss candle is unknowable. Only use
  // completed candles before it for favorable milestones, then anchor the
  // boundary with its open and the persisted tick-level exit price.
  const completedBeforeStop = ordered.filter((candle) => candle.time.getTime() < stopMinute);
  const stopCandle = ordered.find((candle) => candle.time.getTime() === stopMinute);
  const crossed = (candle: JourneyCandle, level: number) => candle.low <= level && candle.high >= level;
  const reached = (candle: JourneyCandle, level: number) => buy ? candle.high >= level : candle.low <= level;
  const firstEntry = completedBeforeStop.find((candle) => crossed(candle, entry) || reached(candle, entry));
  const beforeExit = (value: unknown) => value && new Date(value as string | Date).getTime() < endedAt.getTime();
  const target1Index = completedBeforeStop.findIndex((candle) => reached(candle, Number(signal.target1)));
  const target2Index = completedBeforeStop.findIndex((candle) => reached(candle, Number(signal.target2)));
  const target3Index = completedBeforeStop.findIndex((candle) => reached(candle, Number(signal.target3)));
  const reachedTarget1 = beforeExit(signal.target1At ?? signal.target1HitAt) || target1Index >= 0;
  const reachedTarget2 = beforeExit(signal.target2At ?? signal.target2HitAt) || target2Index >= 0;
  const reachedTarget3 = beforeExit(signal.target3At ?? signal.target3HitAt) || target3Index >= 0;
  const boundaryPrices = [entry, exit, ...(stopCandle ? [stopCandle.open] : [])];
  const highs = [...completedBeforeStop.map((candle) => candle.high), ...boundaryPrices], lows = [...completedBeforeStop.map((candle) => candle.low), ...boundaryPrices];
  const highest = highs.length ? Math.max(...highs) : exit;
  const lowest = lows.length ? Math.min(...lows) : exit;
  const favorablePrice = buy ? highest : lowest;
  const adversePrice = buy ? lowest : highest;
  const maxProfitPercent = entry ? Math.max(0, (buy ? favorablePrice - entry : entry - favorablePrice) / entry * 100) : 0;
  const maxDrawdownPercent = entry ? Math.max(0, (buy ? entry - adversePrice : adversePrice - entry) / entry * 100) : 0;
  const stopLossPercent = entry ? (buy ? exit - entry : entry - exit) / entry * 100 : 0;
  const peakIndex = completedBeforeStop.findIndex((candle) => buy ? candle.high === favorablePrice : candle.low === favorablePrice);
  const reversedToBreakeven = maxProfitPercent > 0 && peakIndex >= 0 && completedBeforeStop.some((candle, index) => index > peakIndex && crossed(candle, entry));
  const journeyType = reachedTarget3 ? 'Entry → Target 3 → Stop Loss'
    : reachedTarget2 ? 'Entry → Target 2 → Stop Loss'
    : reachedTarget1 ? 'Entry → Target 1 → Stop Loss'
    : reversedToBreakeven ? 'Entry → Breakeven → Stop Loss'
    : maxProfitPercent > 0 ? 'Entry → Profit → Stop Loss'
    : 'Immediate Stop Loss';
  const path = ['Entry', ...(reachedTarget3 ? ['Target 1', 'Target 2', 'Target 3'] : reachedTarget2 ? ['Target 1', 'Target 2'] : reachedTarget1 ? ['Target 1'] : maxProfitPercent > 0 ? ['Profit'] : []), ...(reversedToBreakeven ? ['Breakeven'] : maxProfitPercent > 0 ? ['Reverse'] : []), 'Stop Loss'];
  const startedAt = new Date(signal.entryTriggeredAt ?? signal.runningAt ?? signal.signalTime);
  return {
    signalId: signal.id, stockName: signal.stockName, symbol: signal.symbol, side: signal.side,
    strategy: signal.strategy, timeframe: signal.timeframe, entryPrice: entry, stopLossPrice: stop,
    exitPrice: exit, exitTime: endedAt, highestPriceBeforeStopLoss: highest, lowestPriceBeforeStopLoss: lowest,
    reachedEntry: Boolean(signal.entryTriggeredAt ?? firstEntry), firstEntryCrossingTime: signal.entryTriggeredAt ?? firstEntry?.time ?? null,
    reachedTarget1, reachedTarget2, reachedTarget3,
    maxProfitPercent, maxDrawdownPercent, stopLossPercent,
    holdingMinutes: Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 60_000)),
    journeyType, path, candleCount: ordered.length, dataQuality: ordered.length ? 'ONE_MINUTE_CANDLES' : 'INSUFFICIENT_DATA',
  };
}

@Injectable()
export class StopLossJourneyService {
  private readonly logger = new Logger(StopLossJourneyService.name);
  constructor(private readonly prisma: PrismaService, private readonly upstox: UpstoxService) {}

  async analysis(userId: string, period = 'today', customDate?: string) {
    const { start, end, label } = this.dateRange(period, customDate);
    const candidates = await this.prisma.aiSignal.findMany({
      where: { userId, top100Selected: true, side: { in: ['BUY', 'SELL'] }, signalTime: { gte: start, lt: end } },
      include: { events: { orderBy: { eventTime: 'asc' } }, stopLossDecision: { include: { timeline: { orderBy: { eventTime: 'asc' } } } } },
      orderBy: { stopLossAt: 'desc' },
    });
    // Keep this identical to SignalHistoryService.history(..., 'STOPLOSS_HIT').
    const signals = candidates.filter((signal) => signal.currentPrice >= 60 && signal.currentPrice <= 600 && matchesStatusFilter(signal, 'STOPLOSS_HIT'));
    const journeys: Array<ReturnType<typeof reconstructStopLossJourney>> = [];
    for (const signal of signals) {
      const start = signal.entryTriggeredAt ?? signal.runningAt ?? signal.signalTime;
      const end = signal.stopLossAt ?? signal.stopLossHitAt ?? signal.completedAt!;
      const candles = await this.candles(userId, signal.instrumentKey, start, end);
      const journey = reconstructStopLossJourney(signal, candles);
      const expected = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 60_000));
      journey.dataQuality = !candles.length ? 'INSUFFICIENT_DATA' : candles.length >= expected * .8 ? 'ONE_MINUTE_CANDLES' : 'PARTIAL_ONE_MINUTE_CANDLES';
      journeys.push(journey);
    }
    const count = (type: string) => journeys.filter((journey) => journey.journeyType === type).length;
    const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    const dashboardStopLossCount = signals.length;
    if (period === 'today' && dashboardStopLossCount !== journeys.length) this.logger.error(JSON.stringify({ event: 'stoploss.journey.count_mismatch', dashboardStopLossCount, journeyCount: journeys.length, start, end, reason: 'Historical records were included unexpectedly' }));
    return { generatedAt: new Date(), period, selectedDate: label, range: { start, end }, dashboardStopLossCount, journeyStopLossCount: journeys.length, countMatchesDashboard: dashboardStopLossCount === journeys.length, journeys, summary: {
      stopLossTotal: journeys.length,
      immediateStopLoss: count('Immediate Stop Loss'),
      reachedEntryBeforeStopLoss: journeys.filter((journey) => journey.reachedEntry).length,
      reachedTarget1BeforeStopLoss: journeys.filter((journey) => journey.reachedTarget1).length,
      reachedTarget2BeforeStopLoss: journeys.filter((journey) => journey.reachedTarget2).length,
      reachedTarget3BeforeStopLoss: journeys.filter((journey) => journey.reachedTarget3).length,
      averageMaximumProfitBeforeStopLoss: average(journeys.map((journey) => journey.maxProfitPercent)),
      averageTimeUntilStopLoss: average(journeys.map((journey) => journey.holdingMinutes)),
    } };
  }

  private dateRange(period: string, customDate?: string) {
    const today = new Date();
    const shifted = new Date(today.getTime() + 330 * 60_000);
    const midnight = (year: number, month: number, day: number) => new Date(Date.UTC(year, month, day) - 330 * 60_000);
    const todayStart = midnight(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
    let start = todayStart, end = new Date(todayStart.getTime() + 86_400_000);
    if (period === 'yesterday') { start = new Date(todayStart.getTime() - 86_400_000); end = todayStart; }
    else if (period === 'week') { start = new Date(todayStart.getTime() - 6 * 86_400_000); }
    else if (period === 'month') start = midnight(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1);
    else if (period === 'custom' && customDate && /^\d{4}-\d{2}-\d{2}$/.test(customDate)) {
      start = new Date(`${customDate}T00:00:00+05:30`); end = new Date(start.getTime() + 86_400_000);
    }
    const display = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
    return { start, end, label: period === 'week' || period === 'month' ? `${display.format(start)} – ${display.format(new Date(end.getTime() - 1))}` : display.format(start) };
  }

  private async candles(userId: string, instrumentKey: string, start: Date, end: Date) {
    const rangeStart = new Date(Math.floor(start.getTime() / 60_000) * 60_000);
    const rangeEnd = new Date(Math.floor(end.getTime() / 60_000) * 60_000);
    let stored = await this.prisma.historicalCandle.findMany({ where: { instrumentKey, timeframe: '1m', candleTime: { gte: rangeStart, lte: rangeEnd } }, orderBy: { candleTime: 'asc' } });
    const expectedMinutes = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 60_000));
    if (stored.length < Math.min(3, expectedMinutes)) {
      try {
        const format = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
        const today = format(new Date());
        const payload = format(end) === today
          ? await this.upstox.intraday(userId, instrumentKey, 'minutes', 1)
          : await this.upstox.history(userId, instrumentKey, 'minutes', 1, format(end), format(start));
        const rows: unknown[][] = payload?.data?.candles ?? payload?.candles ?? [];
        const downloaded = rows.map((row: any[]) => ({ time: new Date(String(row[0])), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) }))
          .filter((candle) => Number.isFinite(candle.time.getTime()) && [candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite));
        for (let offset = 0; offset < downloaded.length; offset += 100) await this.prisma.$transaction(downloaded.slice(offset, offset + 100).map((candle) => this.prisma.historicalCandle.upsert({ where: { instrumentKey_timeframe_candleTime: { instrumentKey, timeframe: '1m', candleTime: candle.time } }, create: { instrumentKey, timeframe: '1m', candleTime: candle.time, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume }, update: { open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume } })));
        stored = await this.prisma.historicalCandle.findMany({ where: { instrumentKey, timeframe: '1m', candleTime: { gte: rangeStart, lte: rangeEnd } }, orderBy: { candleTime: 'asc' } });
      } catch (error) { this.logger.warn(JSON.stringify({ event: 'stoploss.journey.backfill.failed', instrumentKey, reason: error instanceof Error ? error.message : String(error) })); }
    }
    return stored.map((candle) => ({ time: candle.candleTime, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume }));
  }
}
