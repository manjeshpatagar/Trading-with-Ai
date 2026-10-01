/** Deterministic evidence score, never a calibrated probability. */
export function technicalEvidence(indicators: Record<string, any>, price: number) {
  const n = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const ema9 = n(indicators.ema9), ema20 = n(indicators.ema20), ema50 = n(indicators.ema50), vwap = n(indicators.vwap);
  const rsi = n(indicators.rsi, 50), histogram = n(indicators.macd?.histogram);
  const bullish = price > ema9 && ema9 > ema20 && ema20 > ema50;
  const bearish = price < ema9 && ema9 < ema20 && ema20 < ema50;
  const direction = bullish ? 1 : bearish ? -1 : histogram > 0 && rsi >= 55 ? 1 : histogram < 0 && rsi <= 45 ? -1 : 0;
  const patterns: string[] = Array.isArray(indicators.patterns) ? indicators.patterns : [];
  const patternBias = patterns.some(p => /Bullish|Hammer|Morning|Piercing/i.test(p)) ? 1 : patterns.some(p => /Bearish|Gravestone|Evening|Dark Cloud/i.test(p)) ? -1 : 0;
  const orb = direction > 0 ? price > n(indicators.openingRangeHigh, Infinity) : direction < 0 ? price < n(indicators.openingRangeLow, -Infinity) : false;
  const prior = direction > 0 ? price > n(indicators.previousDayHigh, Infinity) : direction < 0 ? price < n(indicators.previousDayLow, -Infinity) : false;
  const volumeRatio = n(indicators.volumeSma) > 0 ? n(indicators.volume) / n(indicators.volumeSma) : 0;
  const aligned = [direction * (price - vwap) > 0, direction > 0 ? rsi >= 52 : rsi <= 48, direction * histogram > 0,
    indicators.supertrend?.direction === (direction > 0 ? 'bullish' : 'bearish')].filter(Boolean).length;
  const scoreBreakdown = { trend: direction ? bullish || bearish ? 20 : 10 : 0,
    momentum: direction && direction * histogram > 0 && (direction > 0 ? rsi >= 52 : rsi <= 48) ? 18 : direction ? 8 : 0,
    volume: Math.min(16, Math.round(Math.max(0, volumeRatio - .7) * 20)),
    breakoutQuality: orb || prior ? Math.min(18, 10 + Math.round(Math.min(2, volumeRatio) * 4)) : 4,
    candlestickPatterns: patternBias === direction ? 12 : patterns.length ? 4 : 2, indicatorAlignment: aligned * 4 };
  return { direction, aiScore: Object.values(scoreBreakdown).reduce((total, value) => total + value, 0), scoreBreakdown };
}
