import { Candle } from './indicator.service';

export type SetupContext = { candles: Candle[]; direction: 1 | -1; ema20: number; ema50: number; vwap: number; previousVwap: number; atr: number; relativeVolume: number | null };
export type RuleResult = { level: number; reasons: string[] };
const oriented = (a: number, b: number, direction: number) => direction * (a - b);

export class TrendPullbackStrategy {
  readonly name = 'Trend Pullback';
  evaluate(c: SetupContext): RuleResult {
    const [previous, latest] = c.candles.slice(-2);
    const reasons: string[] = [];
    if (oriented(c.ema20, c.ema50, c.direction) <= 0) reasons.push('EMA_ALIGNMENT');
    if (oriented(latest.close, c.vwap, c.direction) <= 0) reasons.push('VWAP_ALIGNMENT');
    const touched = c.direction === 1 ? Math.min(previous.low, latest.low) <= c.ema20 + .25 * c.atr : Math.max(previous.high, latest.high) >= c.ema20 - .25 * c.atr;
    if (!touched) reasons.push('PULLBACK_NOT_TOUCHED');
    if (oriented(latest.close, latest.open, c.direction) <= 0 || oriented(latest.close, previous.close, c.direction) <= 0 || oriented(latest.close, c.ema20, c.direction) <= 0) reasons.push('PULLBACK_CONFIRMATION_MISSING');
    return { level: c.ema20, reasons };
  }
}

export class BreakoutRetestStrategy {
  readonly name = 'Breakout + Retest';
  evaluate(c: SetupContext): RuleResult {
    const [breakout, retest] = c.candles.slice(-2);
    const prior = c.candles.slice(-22, -2);
    const level = c.direction === 1 ? Math.max(...prior.map(bar => bar.high)) : Math.min(...prior.map(bar => bar.low));
    const reasons: string[] = [];
    if (oriented(breakout.close, level, c.direction) <= 0) reasons.push('BREAKOUT_CLOSE_MISSING');
    const touch = c.direction === 1 ? retest.low <= level + .2 * c.atr : retest.high >= level - .2 * c.atr;
    if (!touch || oriented(retest.close, level, c.direction) <= 0 || oriented(retest.close, retest.open, c.direction) <= 0) reasons.push('RETEST_NOT_CONFIRMED');
    if (c.relativeVolume === null) reasons.push('SAME_TIME_VOLUME_UNAVAILABLE');
    else if (c.relativeVolume < 1.2) reasons.push('RELATIVE_VOLUME_LOW');
    return { level, reasons };
  }
}

export class VwapReclaimStrategy {
  readonly name = 'VWAP Reclaim/Rejection';
  evaluate(c: SetupContext): RuleResult {
    const [before, reclaim, hold] = c.candles.slice(-3);
    const reasons: string[] = [];
    if (oriented(before.close, c.previousVwap, c.direction) >= 0 || oriented(reclaim.close, c.previousVwap, c.direction) <= 0) reasons.push('VWAP_CROSS_MISSING');
    if (oriented(hold.close, c.vwap, c.direction) <= 0 || oriented(hold.close, hold.open, c.direction) <= 0 || oriented(hold.close, reclaim.close, c.direction) <= 0) reasons.push('VWAP_HOLD_MISSING');
    const recent = c.candles.slice(-8);
    const crosses = recent.slice(1).filter((bar, i) => (bar.close - c.vwap) * (recent[i].close - c.vwap) < 0).length;
    if (crosses > 2) reasons.push('REPEATED_VWAP_CROSSES');
    return { level: c.vwap, reasons };
  }
}
