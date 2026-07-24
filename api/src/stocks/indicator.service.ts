import { Injectable } from '@nestjs/common';
import { ADX, ATR, CCI, EMA, MACD, MFI, OBV, RSI, SMA } from 'technicalindicators';
export type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number };
const last = <T>(values: T[]) => values[values.length - 1] ?? null;
const finite = (value: number) => Number.isFinite(value) ? value : null;

@Injectable()
export class IndicatorService {
  tradeAnalysis(candles: Candle[]) {
    const requiredCandles = 200;
    if (candles.length < requiredCandles) return { status: 'insufficient_history' as const, requiredCandles, availableCandles: candles.length };
    const close = candles.map((candle) => candle.close);
    const high = candles.map((candle) => candle.high);
    const low = candles.map((candle) => candle.low);
    const volume = candles.map((candle) => candle.volume);
    const ema20 = last(EMA.calculate({ period: 20, values: close }))!;
    const ema50 = last(EMA.calculate({ period: 50, values: close }))!;
    const ema200 = last(EMA.calculate({ period: 200, values: close }))!;
    const rsi = last(RSI.calculate({ period: 14, values: close }))!;
    const macdValue = last(MACD.calculate({ values: close, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false }))!;
    const adxValue = last(ADX.calculate({ period: 14, high, low, close }))!;
    const atr = last(ATR.calculate({ period: 14, high, low, close }))!;
    const obv = last(OBV.calculate({ close, volume }))!;
    const cci = last(CCI.calculate({ period: 20, high, low, close }))!;
    const mfi = last(MFI.calculate({ period: 14, high, low, close, volume }))!;
    const latest = candles.at(-1)!;
    const session = this.sessions(candles).at(-1) ?? candles;
    const recent = candles.slice(-20);
    const support = Math.min(...recent.map((candle) => candle.low));
    const resistance = Math.max(...recent.map((candle) => candle.high));
    const vwap = this.vwap(session);
    const rawIndicators: Record<string, unknown> = { ema20, ema50, ema200, rsi, macd: macdValue?.MACD, macdSignal: macdValue?.signal, macdHistogram: macdValue?.histogram, adx: adxValue?.adx, pdi: adxValue?.pdi, mdi: adxValue?.mdi, atr, obv, cci, mfi, vwap };
    const failedIndicators = Object.entries(rawIndicators).filter(([, value]) => !Number.isFinite(Number(value))).map(([name]) => name);
    const patterns = this.patterns(candles);
    const pattern = patterns.at(0) ?? 'No candlestick pattern';
    const chartPattern = this.chartPattern(candles);
    const volumeAverage = last(SMA.calculate({ period: 20, values: volume }))!;
    const volumeRatio = volumeAverage > 0 ? latest.volume / volumeAverage : 0;
    const buyingVolume = recent.filter((candle) => candle.close >= candle.open).reduce((sum, candle) => sum + candle.volume, 0);
    const sellingVolume = recent.filter((candle) => candle.close < candle.open).reduce((sum, candle) => sum + candle.volume, 0);
    const totalDirectionalVolume = buyingVolume + sellingVolume;
    const buyingPressure = totalDirectionalVolume > 0 ? buyingVolume / totalDirectionalVolume * 100 : 50;
    const sellingPressure = 100 - buyingPressure;
    const histogram = Number(macdValue?.histogram);
    const macd = Number(macdValue?.MACD);
    const signal = Number(macdValue?.signal);
    const pdi = Number(adxValue?.pdi);
    const mdi = Number(adxValue?.mdi);
    const bullish = [latest.close > ema20, ema20 > ema50, ema50 > ema200, rsi >= 50 && rsi <= 70, histogram > 0, pdi > mdi, latest.close >= Number(vwap), buyingPressure > sellingPressure];
    const bearish = [latest.close < ema20, ema20 < ema50, ema50 < ema200, rsi <= 50 && rsi >= 30, histogram < 0, mdi > pdi, latest.close <= Number(vwap), sellingPressure > buyingPressure];
    const bullScore = bullish.filter(Boolean).length;
    const bearScore = bearish.filter(Boolean).length;
    const recommendation = bullScore >= 5 && bullScore > bearScore ? 'BUY' : bearScore >= 5 && bearScore > bullScore ? 'SELL' : 'HOLD';
    const trend = recommendation;
    const confidence = Math.min(95, Math.round(45 + Math.max(bullScore, bearScore) / bullish.length * 50));
    const volumeAnalysis = volumeRatio >= 1.5 ? 'High volume' : volumeRatio >= .8 ? 'Normal volume' : 'Low volume';
    const reasons = [
      ema20 > ema50 ? 'EMA20 above EMA50' : 'EMA20 below EMA50',
      rsi >= 50 ? 'RSI shows positive momentum' : 'RSI shows weak momentum',
      histogram > 0 ? 'MACD histogram is bullish' : 'MACD histogram is bearish',
      `${volumeAnalysis.toLowerCase()} with ${buyingPressure >= sellingPressure ? 'buying' : 'selling'} pressure`,
      Number.isFinite(Number(adxValue?.adx)) ? `ADX ${Number(adxValue?.adx) >= 25 ? 'confirms a strong trend' : 'shows a weak trend'}` : 'ADX could not be calculated',
    ];
    const round = (value: number) => Number(value.toFixed(2));
    const output = (value: unknown) => Number.isFinite(Number(value)) ? round(Number(value)) : 'insufficient_history';
    return {
      status: failedIndicators.length ? 'partial' as const : 'ok' as const,
      currentCandle: latest.time,
      pattern,
      candlestickPattern: pattern,
      chartPattern,
      trend,
      volume: latest.volume,
      rsi: output(rsi),
      macd: { macd: output(macd), signal: output(signal), histogram: output(histogram) },
      ema: { ema20: output(ema20), ema50: output(ema50), ema200: output(ema200) },
      vwap: output(vwap),
      adx: output(adxValue?.adx),
      atr: output(atr),
      obv: output(obv),
      cci: output(cci),
      mfi: output(mfi),
      support: round(support),
      resistance: round(resistance),
      volumeAnalysis: { status: volumeAnalysis, currentVolume: latest.volume, averageVolume: round(volumeAverage), ratio: round(volumeRatio) },
      buyingPressure: round(buyingPressure),
      sellingPressure: round(sellingPressure),
      confidence,
      reason: `${reasons.join(', ')}.${failedIndicators.length ? ` Unavailable indicators: ${failedIndicators.join(', ')}.` : ''}`,
      recommendation,
    };
  }

  calculate(candles: Candle[]) {
    if (candles.length < 50) return {};
    const close = candles.map((candle) => candle.close), high = candles.map((candle) => candle.high), low = candles.map((candle) => candle.low), volume = candles.map((candle) => candle.volume);
    const ema = (period: number) => last(EMA.calculate({ period, values: close }));
    const macd = last(MACD.calculate({ values: close, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false }));
    const atr = last(ATR.calculate({ period: 14, high, low, close }));
    const adx = last(ADX.calculate({ period: 14, high, low, close }));
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
      signalLine: macd?.signal ?? null, histogram: macd?.histogram ?? null, vwap: this.vwap(today), atr, adx: adx?.adx ?? null, directionalMovement: adx ? { pdi: adx.pdi, mdi: adx.mdi } : null, supertrend,
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
  private chartPattern(candles: Candle[]) {
    const recent = candles.slice(-30);
    if (recent.length < 10) return 'No chart pattern';
    const latest = recent.at(-1)!;
    const prior = recent.slice(0, -1);
    const priorHigh = Math.max(...prior.map((candle) => candle.high));
    const priorLow = Math.min(...prior.map((candle) => candle.low));
    if (latest.close > priorHigh) return 'Resistance Breakout';
    if (latest.close < priorLow) return 'Support Breakdown';
    const half = Math.floor(prior.length / 2);
    const firstHigh = Math.max(...prior.slice(0, half).map((candle) => candle.high));
    const secondHigh = Math.max(...prior.slice(half).map((candle) => candle.high));
    const firstLow = Math.min(...prior.slice(0, half).map((candle) => candle.low));
    const secondLow = Math.min(...prior.slice(half).map((candle) => candle.low));
    const tolerance = latest.close * .005;
    if (Math.abs(firstHigh - secondHigh) <= tolerance) return 'Double Top';
    if (Math.abs(firstLow - secondLow) <= tolerance) return 'Double Bottom';
    return 'Range Consolidation';
  }
  private supertrend(candles: Candle[], period: number, multiplier: number) { if (candles.length < period + 1) return null; const tr = candles.map((candle, index) => index ? Math.max(candle.high - candle.low, Math.abs(candle.high - candles[index - 1].close), Math.abs(candle.low - candles[index - 1].close)) : candle.high - candle.low); const atr = SMA.calculate({ period, values: tr }); let upper = 0, lower = 0, current = 0; for (let index = period - 1; index < candles.length; index++) { const value = atr[index - period + 1], middle = (candles[index].high + candles[index].low) / 2, basicUpper = middle + multiplier * value, basicLower = middle - multiplier * value; if (index === period - 1) { upper = basicUpper; lower = basicLower; current = upper; continue; } upper = basicUpper < upper || candles[index - 1].close > upper ? basicUpper : upper; lower = basicLower > lower || candles[index - 1].close < lower ? basicLower : lower; current = current === upper ? (candles[index].close <= upper ? upper : lower) : (candles[index].close >= lower ? lower : upper); } const latest = candles.at(-1)!; return { value: current, direction: latest.close >= current ? 'bullish' : 'bearish' }; }
}
