import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Candle, IndicatorService } from './indicator.service';
import { UpstoxService } from './upstox.service';

type Trade = { id: string; userId: string; instrumentKey: string; symbol: string; timeframe: string; side: string; currentPrice: number; entryPrice: number; stopLoss: number };
type Context = { trade: Trade; price: number; candles: Candle[]; indicators: any; at: Date };
type Scores = { recoveryProbability: number; breakdownProbability: number; confidence: number };

@Injectable()
export class StopLossDecisionService {
  private readonly logger = new Logger(StopLossDecisionService.name);
  constructor(private readonly prisma: PrismaService, private readonly upstox: UpstoxService, private readonly indicators: IndicatorService) {}

  calculateRecoveryProbability(context: Context) {
    const { trade, price, candles, indicators } = context;
    const direction = trade.side === 'BUY' ? 1 : -1;
    const latest = candles.at(-1)!;
    const recent = candles.slice(-20);
    const atr = Math.max(Number(indicators.atr), price * .001);
    const ema20 = Number(indicators.ema20), ema50 = Number(indicators.ema50), vwap = Number(indicators.vwap), rsi = Number(indicators.rsi);
    const histogram = Number(indicators.macd?.histogram), adx = Number(indicators.adx), pdi = Number(indicators.directionalMovement?.pdi), mdi = Number(indicators.directionalMovement?.mdi);
    const support = Number(indicators.support), resistance = Number(indicators.resistance);
    const buyingVolume = recent.filter((candle) => candle.close >= candle.open).reduce((sum, candle) => sum + candle.volume, 0);
    const sellingVolume = recent.filter((candle) => candle.close < candle.open).reduce((sum, candle) => sum + candle.volume, 0);
    const volumePressure = (buyingVolume - sellingVolume) / Math.max(1, buyingVolume + sellingVolume) * direction;
    const patterns: string[] = Array.isArray(indicators.patterns) ? indicators.patterns : [];
    const patternBias = patterns.some((pattern) => /Bullish|Hammer|Piercing/i.test(pattern)) ? 1 : patterns.some((pattern) => /Bearish|Gravestone|Dark Cloud/i.test(pattern)) ? -1 : 0;
    const structureLevel = direction > 0 ? support : resistance;
    const structure = Number.isFinite(structureLevel) ? Math.max(-1, Math.min(1, direction * (price - structureLevel) / atr)) : 0;
    const components = [
      Math.max(-1, Math.min(1, direction * (ema20 - ema50) / atr)),
      Math.max(-1, Math.min(1, direction * (rsi - 50) / 20)),
      Math.max(-1, Math.min(1, direction * histogram / atr)),
      Math.max(-1, Math.min(1, direction * (price - vwap) / atr)),
      Math.max(-1, Math.min(1, direction * (pdi - mdi) / Math.max(10, adx))),
      Math.max(-1, Math.min(1, volumePressure)),
      structure,
      patternBias * direction,
      Math.max(-1, Math.min(1, direction * (latest.close - latest.open) / atr)),
    ].filter(Number.isFinite);
    const composite = components.reduce((sum, value) => sum + value, 0) / Math.max(1, components.length);
    return Math.round(100 / (1 + Math.exp(-2.75 * composite)));
  }

  calculateBreakdownProbability(context: Context) { return 100 - this.calculateRecoveryProbability(context); }

  calculateDecision(context: Context): Scores & { decision: 'WAIT' | 'EXIT' } {
    const recoveryProbability = this.calculateRecoveryProbability(context);
    const breakdownProbability = 100 - recoveryProbability;
    const adx = Number(context.indicators.adx);
    const confidence = Math.round(Math.min(99, 50 + Math.abs(recoveryProbability - 50) * .8 + Math.min(20, Number.isFinite(adx) ? adx / 2 : 0)));
    return { recoveryProbability, breakdownProbability, confidence, decision: recoveryProbability >= 55 ? 'WAIT' : 'EXIT' };
  }

  generateReason(context: Context, decision: 'WAIT' | 'EXIT') {
    const { trade, price, indicators } = context;
    const direction = trade.side === 'BUY' ? 1 : -1;
    const reasons = [
      direction * (price - Number(direction > 0 ? indicators.support : indicators.resistance)) >= 0 ? `${direction > 0 ? 'Support' : 'Resistance'} is holding` : `${direction > 0 ? 'Support' : 'Resistance'} has failed`,
      direction * (Number(indicators.ema20) - Number(indicators.ema50)) > 0 ? 'EMA20 and EMA50 remain aligned' : 'EMA20 and EMA50 confirm adverse momentum',
      direction * (price - Number(indicators.vwap)) >= 0 ? 'VWAP is supporting recovery' : 'VWAP has been lost',
      direction * Number(indicators.macd?.histogram) > 0 ? 'MACD momentum supports recovery' : 'MACD momentum confirms breakdown',
      Number(indicators.adx) > 25 ? 'ADX confirms trend strength' : 'Trend strength is not yet decisive',
    ];
    return `${reasons.join('. ')}. ${decision === 'WAIT' ? 'Wait for one completed candle.' : 'Exit immediately.'}`;
  }

  generateTimeline(decision: { status: string; recoveryProbability: number; recommendation: string; touchedAt: Date }, context: Context) {
    return [
      { type: 'STOP_LOSS_TOUCHED', detail: 'Stop Loss touched', eventTime: decision.touchedAt },
      { type: 'MARKET_STRUCTURE', detail: this.generateReason(context, decision.status === 'WAIT' ? 'WAIT' : 'EXIT').split('.')[0], eventTime: context.at },
      { type: 'RECOVERY_PROBABILITY', detail: `Recovery Probability ${decision.recoveryProbability}%`, value: decision.recoveryProbability, eventTime: context.at },
      { type: 'RECOMMENDATION', detail: `Recommendation ${decision.recommendation}`, eventTime: context.at },
    ];
  }

  async evaluateTouch(userId: string, trade: Trade, price: number, at: Date) {
    const context = await this.context(userId, trade, price, at);
    const scores = this.calculateDecision(context);
    const interval = this.intervalMinutes(trade.timeframe);
    const confirmationCandleTime = new Date(Math.floor(at.getTime() / (interval * 60_000)) * interval * 60_000);
    const reason = this.generateReason(context, scores.decision);
    const recommendation = scores.decision === 'WAIT' ? 'Wait for ONE completed candle' : 'Exit Immediately';
    const record = await this.prisma.stopLossDecision.upsert({
      where: { tradeId: trade.id },
      create: { tradeId: trade.id, status: scores.decision, recoveryProbability: scores.recoveryProbability, breakdownProbability: scores.breakdownProbability, confidence: scores.confidence, reason, recommendation, touchedAt: at, confirmationCandleTime },
      update: { status: scores.decision, recoveryProbability: scores.recoveryProbability, breakdownProbability: scores.breakdownProbability, confidence: scores.confidence, reason, recommendation, touchedAt: at, confirmationCandleTime, resolvedAt: scores.decision === 'EXIT' ? at : null },
    });
    const timeline = this.generateTimeline({ ...record, recommendation }, context);
    await this.prisma.stopLossDecisionEvent.createMany({ data: timeline.map((event) => ({ decisionId: record.id, ...event })) });
    this.logger.log(JSON.stringify({ event: 'stoploss.decision', tradeId: trade.id, symbol: trade.symbol, ...scores }));
    return { ...record, timeline };
  }

  async evaluateConfirmation(userId: string, trade: Trade, price: number, at: Date) {
    const previous = await this.prisma.stopLossDecision.findUnique({ where: { tradeId: trade.id } });
    if (!previous) return this.evaluateTouch(userId, trade, price, at);
    const intervalMs = this.intervalMinutes(trade.timeframe) * 60_000;
    if (at.getTime() < previous.confirmationCandleTime.getTime() + intervalMs) return null;
    const context = await this.context(userId, trade, price, at);
    const scores = this.calculateDecision(context);
    const recovered = scores.recoveryProbability > previous.recoveryProbability && scores.recoveryProbability >= 55;
    const status = recovered ? 'CONTINUED' : 'EXIT';
    const recommendation = recovered ? 'Trade Continued' : 'Exit Immediately';
    const reason = this.generateReason(context, recovered ? 'WAIT' : 'EXIT');
    const updated = await this.prisma.stopLossDecision.update({ where: { tradeId: trade.id }, data: { status, recoveryProbability: scores.recoveryProbability, breakdownProbability: scores.breakdownProbability, confidence: scores.confidence, reason, recommendation, resolvedAt: at } });
    await this.prisma.stopLossDecisionEvent.createMany({ data: [
      { decisionId: updated.id, type: 'CONFIRMATION_CANDLE', detail: `${new Date(previous.confirmationCandleTime.getTime() + intervalMs).toISOString()} candle completed`, eventTime: at },
      { decisionId: updated.id, type: 'RECOVERY_PROBABILITY_UPDATED', detail: `Recovery Probability ${scores.recoveryProbability}%`, value: scores.recoveryProbability, eventTime: at },
      { decisionId: updated.id, type: recovered ? 'TRADE_CONTINUED' : 'TRADE_CLOSED', detail: recommendation, eventTime: at },
    ] });
    return updated;
  }

  private async context(userId: string, trade: Trade, price: number, at: Date): Promise<Context> {
    const interval = this.intervalMinutes(trade.timeframe);
    const cutoff = Math.floor(at.getTime() / (interval * 60_000)) * interval * 60_000;
    const stored = await this.prisma.historicalCandle.findMany({ where: { instrumentKey: trade.instrumentKey, timeframe: `${interval}m`, candleTime: { lt: new Date(cutoff) } }, orderBy: { candleTime: 'desc' }, take: 250 });
    let candles = stored.reverse().map((item) => ({ time: item.candleTime.toISOString(), open: item.open, high: item.high, low: item.low, close: item.close, volume: item.volume }));
    // Always merge the live intraday response so the touch and confirmation
    // decisions cannot reuse the same stale completed-candle snapshot.
    const payload: any = await this.upstox.intraday(userId, trade.instrumentKey, 'minutes', interval);
    const rows: unknown[][] = payload?.data?.candles ?? [];
    const current = rows.map((row: any[]) => ({ time: String(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) })).filter((candle) => new Date(candle.time).getTime() < cutoff);
    const merged = new Map([...candles, ...current].map((candle) => [new Date(candle.time).getTime(), candle]));
    candles = [...merged.values()].sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime());
    if (candles.length < 50) throw new Error(`Stop loss decision requires at least 50 completed ${interval}m candles; received ${candles.length}`);
    return { trade, price, candles, indicators: this.indicators.calculate(candles), at };
  }

  private intervalMinutes(timeframe: string) { const value = Number.parseInt(timeframe, 10); return value === 3 ? 3 : 5; }
}
