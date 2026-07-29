import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Candle, IndicatorService } from './indicator.service';
import { UpstoxService } from './upstox.service';

@Injectable()
export class PostTradeAnalysisService {
  private readonly logger = new Logger(PostTradeAnalysisService.name);
  private readonly running = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly upstox: UpstoxService,
    private readonly indicatorService: IndicatorService,
  ) {}

  async generate(userId: string, tradeId: string, force = false) {
    if (this.running.has(tradeId)) return null;
    this.running.add(tradeId);
    try {
      const trade = await this.prisma.aiSignal.findFirst({
        where: { id: tradeId, userId, status: { in: ['COMPLETED', 'STOPLOSS_HIT', 'STOPLOSS_CONFIRMED'] } },
        include: { events: { orderBy: { eventTime: 'asc' } }, postTradeAnalysis: true, stopLossDecision: true },
      });
      if (!trade?.completedAt || !trade.entryTriggeredAt) return null;
      if (trade.postTradeAnalysis && !force) return trade.postTradeAnalysis;

      const interval = this.interval(trade.timeframe);
      const from = new Date(trade.entryTriggeredAt.getTime() - 12 * 86_400_000).toISOString().slice(0, 10);
      const to = new Date().toISOString().slice(0, 10);
      const payload: any = await this.upstox.history(userId, trade.instrumentKey, 'minutes', interval, to, from);
      const candles = this.candles(payload);
      if (!candles.length) throw new Error(`No Upstox candles available for ${trade.symbol}`);
      const entryCandles = candles.filter((candle) => new Date(candle.time) <= trade.entryTriggeredAt!);
      const exitCandles = candles.filter((candle) => new Date(candle.time) <= trade.completedAt!);
      const afterExit = candles.filter((candle) => new Date(candle.time) > trade.completedAt!);
      const entry = this.snapshot(entryCandles, trade.entryPrice);
      const exit = this.snapshot(exitCandles, Number(trade.exitPrice ?? trade.currentPrice));
      const eventTypes = trade.events.map((event) => event.type);
      const buy = trade.side === 'BUY';
      const pnl = Number(trade.profitPercent ?? 0);
      const stopped = /STOPLOSS/.test(trade.status) || eventTypes.some((type) => /STOPLOSS_(HIT|CONFIRMED)/.test(type));
      const reachedAfterExit = (level: number) => afterExit.some((candle) => buy ? candle.high >= level : candle.low <= level);
      const target1Hit = eventTypes.includes('TARGET1_HIT'), target2Hit = eventTypes.includes('TARGET2_HIT'), target3Hit = eventTypes.includes('TARGET3_HIT');
      const scenarios: string[] = [];
      if (stopped && reachedAfterExit(trade.target1)) scenarios.push('Stop Loss hit before price later reached Target 1');
      if (target1Hit && stopped) scenarios.push('Target 1 reached before a Stop Loss reversal');
      if (target2Hit && !target3Hit) scenarios.push('Target 2 reached before reversal');
      const breakoutLevel = buy ? Number(entry.indicators.resistance) : Number(entry.indicators.support);
      const enteredBreakout = Number.isFinite(breakoutLevel) && (buy ? trade.entryPrice >= breakoutLevel : trade.entryPrice <= breakoutLevel);
      if (enteredBreakout && pnl < 0 && exit.volumeRatio < 1) scenarios.push('Fake breakout with insufficient follow-through volume');
      if (stopped && reachedAfterExit(trade.entryPrice)) scenarios.push('Possible liquidity sweep / stop-loss hunt: price reclaimed entry after the stop');
      if (entry.overextended) scenarios.push('Late entry into an overextended intraday move');
      if (!target3Hit && reachedAfterExit(trade.target3)) scenarios.push('Early exit: holding would later have reached Target 3');

      const exitReason = stopped ? 'STOP LOSS' : target3Hit ? 'TARGET 3' : eventTypes.at(-1)?.replaceAll('_', ' ') ?? trade.status;
      const progression = target3Hit ? 'Targets 1, 2 and 3 reached' : target2Hit ? 'Targets 1 and 2 reached' : target1Hit ? 'Target 1 reached' : 'No target reached';
      const entryQuality = entry.overextended ? 'Poor — overextended' : entry.nearLevel ? 'Good — entered near EMA20/VWAP support or resistance' : entry.position > 80 || entry.position < 20 ? 'Weak — entered near the edge of the session range' : 'Average — entered mid-range';
      const favorableAfterExit = afterExit.length ? (buy ? Math.max(...afterExit.map((candle) => candle.high)) : Math.min(...afterExit.map((candle) => candle.low))) : null;
      const exitQuality = target3Hit ? 'Excellent — planned final target captured' : stopped && favorableAfterExit !== null && (buy ? favorableAfterExit > trade.entryPrice : favorableAfterExit < trade.entryPrice) ? 'Weak — stop preceded a recovery through entry' : stopped ? 'Disciplined — risk limit enforced' : 'Average — exited before final target';
      const alignedAtEntry = this.alignment(entry, trade.side);
      const alignedAtExit = this.alignment(exit, trade.side);
      const explanationConfidence = Math.min(98, Math.round(60 + Math.min(20, candles.length / 20) + Math.min(12, trade.events.length * 2) + (entry.complete && exit.complete ? 6 : 0)));
      const keyReasons = pnl >= 0
        ? `${trade.symbol} succeeded because ${alignedAtEntry}/7 directional indicators aligned at entry, ${progression.toLowerCase()}, and volume was ${entry.volumeRatio.toFixed(2)}x its 20-candle average.`
        : `${trade.symbol} failed because directional alignment weakened from ${alignedAtEntry}/7 at entry to ${alignedAtExit}/7 at exit; price position was ${entry.position.toFixed(1)}% and entry volume was ${entry.volumeRatio.toFixed(2)}x average.`;
      const mistakes = scenarios.length ? scenarios.join('; ') : pnl < 0 && !entry.nearLevel ? 'Entry lacked proximity to EMA20, VWAP, or a confirmed session level' : 'No material execution mistake detected from the recorded candles';
      const improvement = entry.overextended
        ? `Require a pullback toward EMA20 (${this.price(entry.indicators.ema20)}) or VWAP (${this.price(entry.indicators.vwap)}) before entering.`
        : stopped
          ? `Require volume above 1.0x average and MACD/ADX confirmation before reusing this ${trade.strategy} setup.`
          : `Retain the same setup, but trail risk only after Target 1 rather than exiting before the next planned level.`;
      const recoveryProbability = stopped ? Math.max(5, Math.min(95, Math.round((alignedAtExit / 7) * 55 + (reachedAfterExit(trade.entryPrice) ? 30 : 5)))) : null;
      const breakdownProbability = stopped ? 100 - Number(recoveryProbability) : Math.max(5, Math.min(95, Math.round((7 - alignedAtExit) / 7 * 70)));
      const aiSummary = `${trade.symbol} ${trade.side} closed at ${this.price(Number(trade.exitPrice ?? trade.currentPrice))} for ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}% via ${exitReason}. Entry was ${entry.position.toFixed(1)}% through the session range, RSI moved ${this.number(entry.indicators.rsi)}→${this.number(exit.indicators.rsi)}, ADX ${this.number(entry.indicators.adx)}→${this.number(exit.indicators.adx)}, and ${progression.toLowerCase()}.`;
      const futureRecommendation = pnl >= 0
        ? `Prefer similar ${trade.strategy} ${trade.side} setups when at least ${Math.max(4, alignedAtEntry)}/7 indicators align and volume is at least ${Math.max(1, entry.volumeRatio).toFixed(1)}x average.`
        : `Avoid the same entry when session position exceeds ${entry.position.toFixed(0)}% without a pullback; wait for EMA20/VWAP confirmation and ADX above 20.`;

      const data = {
        entryQuality, exitQuality, pnlPercent: pnl, exitReason, targetProgression: progression,
        entryIndicators: JSON.stringify(entry), exitIndicators: JSON.stringify(exit),
        marketContext: `${entry.trend} at entry; ${exit.trend} at exit. Session support ${this.price(entry.indicators.support)}, resistance ${this.price(entry.indicators.resistance)}.`,
        aiSummary, keyReasons, explanationConfidence, mistakesDetected: mistakes,
        suggestedImprovement: improvement, recoveryProbability, breakdownProbability,
        futureRecommendation, specialScenarios: JSON.stringify(scenarios),
        newsSentiment: null, analyzedThrough: candles.at(-1) ? new Date(candles.at(-1)!.time) : new Date(),
      };
      const analysis = await this.prisma.postTradeAnalysis.upsert({ where: { tradeId }, create: { tradeId, ...data }, update: data });
      this.logger.log(JSON.stringify({ event: 'post-trade.analysis.generated', tradeId, symbol: trade.symbol, pnl, scenarios }));
      return analysis;
    } catch (error) {
      this.logger.error(JSON.stringify({ event: 'post-trade.analysis.failed', tradeId, message: error instanceof Error ? error.message : String(error) }));
      return null;
    } finally {
      this.running.delete(tradeId);
    }
  }

  private candles(payload: any): Candle[] {
    return (payload?.data?.candles ?? []).map((row: unknown[]) => ({ time: String(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) })).filter((candle: Candle) => [candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)).sort((a: Candle, b: Candle) => new Date(a.time).getTime() - new Date(b.time).getTime());
  }

  private snapshot(candles: Candle[], price: number) {
    const indicators: any = this.indicatorService.calculate(candles);
    const sessionDate = candles.at(-1)?.time.slice(0, 10);
    const session = candles.filter((candle) => candle.time.startsWith(sessionDate ?? ''));
    const high = session.length ? Math.max(...session.map((candle) => candle.high)) : price;
    const low = session.length ? Math.min(...session.map((candle) => candle.low)) : price;
    const position = high > low ? (price - low) / (high - low) * 100 : 50;
    const atr = Number(indicators.atr ?? 0);
    const ema20 = Number(indicators.ema20 ?? price), vwap = Number(indicators.vwap ?? price);
    const nearLevel = atr > 0 && Math.min(Math.abs(price - ema20), Math.abs(price - vwap), Math.abs(price - low), Math.abs(high - price)) <= atr * .6;
    const overextended = atr > 0 && Math.abs(price - ema20) / atr >= 2.5 || Number(indicators.rsi ?? 50) > 72 || Number(indicators.rsi ?? 50) < 28;
    const volume = session.at(-1)?.volume ?? 0, average = Number(indicators.volumeSma ?? 0);
    const trend = price > ema20 && ema20 > Number(indicators.ema50 ?? ema20) ? 'BULLISH' : price < ema20 && ema20 < Number(indicators.ema50 ?? ema20) ? 'BEARISH' : 'SIDEWAYS';
    return { price, position, trend, nearLevel, overextended, volumeRatio: average > 0 ? volume / average : 0, complete: Boolean(indicators.ema200 && indicators.adx), indicators };
  }

  private alignment(snapshot: any, side: string) {
    const indicators = snapshot.indicators ?? {};
    const direction = side === 'BUY' ? 1 : -1;
    const price = Number(snapshot.price ?? indicators.ema20 ?? 0);
    return [
      direction * (Number(indicators.ema20) - Number(indicators.ema50)) > 0,
      direction * (Number(indicators.ema50) - Number(indicators.ema200)) > 0,
      direction * (price - Number(indicators.vwap)) > 0,
      side === 'BUY' ? Number(indicators.rsi) >= 50 : Number(indicators.rsi) <= 50,
      direction * Number(indicators.macd?.histogram ?? indicators.histogram) > 0,
      Number(indicators.adx) >= 20,
      indicators.supertrend?.direction === (side === 'BUY' ? 'bullish' : 'bearish'),
    ].filter(Boolean).length;
  }
  private interval(timeframe: string): 1 | 3 | 5 | 15 | 30 { const value = Number.parseInt(timeframe); return [1, 3, 5, 15, 30].includes(value) ? value as 1 | 3 | 5 | 15 | 30 : 5; }
  private price(value: unknown) { return `₹${Number(value ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`; }
  private number(value: unknown) { return Number.isFinite(Number(value)) ? Number(value).toFixed(1) : 'unavailable'; }
}
