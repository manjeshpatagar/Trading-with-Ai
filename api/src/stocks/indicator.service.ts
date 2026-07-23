import { Injectable } from '@nestjs/common';
import { ATR, EMA, MACD, RSI, SMA } from 'technicalindicators';
export type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number };
const last = <T>(values: T[]) => values[values.length - 1] ?? null;
const finite = (value: number) => Number.isFinite(value) ? value : null;

@Injectable()
export class IndicatorService {
  calculate(candles: Candle[]) {
    if (candles.length < 50) return {};
    const close = candles.map((candle) => candle.close), high = candles.map((candle) => candle.high), low = candles.map((candle) => candle.low), volume = candles.map((candle) => candle.volume);
    const ema = (period: number) => last(EMA.calculate({ period, values: close }));
    const macd = last(MACD.calculate({ values: close, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false }));
    const atr = last(ATR.calculate({ period: 14, high, low, close }));
    const rsi = last(RSI.calculate({ period: 14, values: close }));
    const sessions = this.sessions(candles);
    const today = sessions.at(-1) ?? candles;
    const previousDay = sessions.at(-2) ?? [];
    const openingRange = today.slice(0, Math.max(1, Math.ceil(15 / this.intervalMinutes(today))));
    const todayHigh = finite(Math.max(...today.map((candle) => candle.high)));
    const todayLow = finite(Math.min(...today.map((candle) => candle.low)));
    const previousDayHigh = previousDay.length ? finite(Math.max(...previousDay.map((candle) => candle.high))) : null;
    const previousDayLow = previousDay.length ? finite(Math.min(...previousDay.map((candle) => candle.low))) : null;
    const previousDayClose = previousDay.at(-1)?.close ?? null;
    const openingRangeHigh = finite(Math.max(...openingRange.map((candle) => candle.high)));
    const openingRangeLow = finite(Math.min(...openingRange.map((candle) => candle.low)));
    const supertrend = this.supertrend(candles, 10, 3);
    return {
      ema9: ema(9), ema20: ema(20), ema50: ema(50), ema200: ema(200), rsi, macd,
      signalLine: macd?.signal ?? null, histogram: macd?.histogram ?? null, vwap: this.vwap(today), atr, supertrend,
      volume: today.at(-1)?.volume ?? 0, volumeSma: last(SMA.calculate({ period: 20, values: volume })), averageVolume: last(SMA.calculate({ period: 50, values: volume })),
      openingRangeHigh, openingRangeLow, previousDayHigh, previousDayLow, previousDayClose, todayHigh, todayLow,
      support: todayLow, resistance: todayHigh, pivot: previousDayHigh !== null && previousDayLow !== null && previousDayClose !== null ? (previousDayHigh + previousDayLow + previousDayClose) / 3 : null,
      patterns: this.patterns(candles),
    };
  }

  private vwap(candles: Candle[]) { let numerator = 0, denominator = 0; for (const candle of candles) { numerator += ((candle.high + candle.low + candle.close) / 3) * candle.volume; denominator += candle.volume; } return denominator ? numerator / denominator : null; }
  private sessions(candles: Candle[]) { const groups: Candle[][] = []; for (const candle of candles) { const date = candle.time.slice(0, 10); const group = groups.at(-1); if (!group?.length || group[0].time.slice(0, 10) !== date) groups.push([candle]); else group.push(candle); } return groups; }
  private intervalMinutes(candles: Candle[]) { if (candles.length < 2) return 5; const interval = Math.round((new Date(candles[1].time).getTime() - new Date(candles[0].time).getTime()) / 60_000); return interval > 0 ? interval : 5; }
  private patterns(candles: Candle[]) {
    const latest = candles.at(-1)!, previous = candles.at(-2), before = candles.at(-3);
    if (!latest || !previous) return [];
    const body = Math.abs(latest.close - latest.open), range = latest.high - latest.low, upper = latest.high - Math.max(latest.open, latest.close), lower = Math.min(latest.open, latest.close) - latest.low;
    const priorBody = Math.abs(previous.close - previous.open);
    const found: string[] = [];
    if (range && body / range <= .1) found.push('Doji');
    if (range && body / range <= .1 && lower > range * .6) found.push('Dragonfly Doji');
    if (range && body / range <= .1 && upper > range * .6) found.push('Gravestone Doji');
    if (range && lower >= body * 2 && upper <= body) found.push('Hammer');
    if (range && upper >= body * 2 && lower <= body) found.push('Inverted Hammer');
    if (range && body / range >= .9) found.push(latest.close >= latest.open ? 'Bullish Marubozu' : 'Bearish Marubozu');
    if (previous.close < previous.open && latest.close > latest.open && latest.open <= previous.close && latest.close >= previous.open) found.push('Bullish Engulfing');
    if (previous.close > previous.open && latest.close < latest.open && latest.open >= previous.close && latest.close <= previous.open) found.push('Bearish Engulfing');
    if (previous.close < previous.open && latest.close > latest.open && latest.close > (previous.open + previous.close) / 2 && latest.open < previous.close) found.push('Piercing Pattern');
    if (previous.close > previous.open && latest.close < latest.open && latest.close < (previous.open + previous.close) / 2 && latest.open > previous.close) found.push('Dark Cloud Cover');
    if (latest.high <= previous.high && latest.low >= previous.low) found.push('Inside Bar');
    if (latest.high >= previous.high && latest.low <= previous.low) found.push('Outside Bar');
    if (range && body / range < .35 && upper > body && lower > body) found.push('Spinning Top');
    if (before && before.close < before.open && previous.close > previous.open && latest.close > latest.open && latest.close > previous.close) found.push('Three White Soldiers');
    if (before && before.close > before.open && previous.close < previous.open && latest.close < latest.open && latest.close < previous.close) found.push('Three Black Crows');
    if (priorBody && body < priorBody * .5 && latest.high <= previous.high && latest.low >= previous.low) found.push(latest.close >= latest.open ? 'Bullish Harami' : 'Bearish Harami');
    return found;
  }
  private supertrend(candles: Candle[], period: number, multiplier: number) { if (candles.length < period + 1) return null; const tr = candles.map((candle, index) => index ? Math.max(candle.high - candle.low, Math.abs(candle.high - candles[index - 1].close), Math.abs(candle.low - candles[index - 1].close)) : candle.high - candle.low); const atr = SMA.calculate({ period, values: tr }); let upper = 0, lower = 0, current = 0; for (let index = period - 1; index < candles.length; index++) { const value = atr[index - period + 1], middle = (candles[index].high + candles[index].low) / 2, basicUpper = middle + multiplier * value, basicLower = middle - multiplier * value; if (index === period - 1) { upper = basicUpper; lower = basicLower; current = upper; continue; } upper = basicUpper < upper || candles[index - 1].close > upper ? basicUpper : upper; lower = basicLower > lower || candles[index - 1].close < lower ? basicLower : lower; current = current === upper ? (candles[index].close <= upper ? upper : lower) : (candles[index].close >= lower ? lower : upper); } const latest = candles.at(-1)!; return { value: current, direction: latest.close >= current ? 'bullish' : 'bearish' }; }
}
