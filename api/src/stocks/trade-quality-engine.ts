export type QualityInput = {
  side: 'BUY' | 'SELL' | string; aiScore: number; confidence: number; momentum?: number; trendStrength?: number; volumeRatio?: number;
  vwapAligned?: boolean; emaAligned?: boolean; ema200Aligned?: boolean; rsi?: number; macdHistogram?: number; atr?: number; price?: number;
  support?: number; resistance?: number; breakoutConfirmed?: boolean; previousCandleStrength?: number; currentCandleStrength?: number;
  sectorStrength?: number; marketTrendAligned?: boolean; niftyTrendAligned?: boolean; bankNiftyTrendAligned?: boolean; volatility?: number;
  riskReward?: number; targetDistancePercent?: number; stopDistancePercent?: number; volumeIncreasing?: boolean;
};

export type TradeQualityResult = ReturnType<typeof tradeQuality>;

const clamp = (value: number) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
const directionalRsi = (rsi: number, buy: boolean) => clamp(100 - Math.abs(rsi - (buy ? 60 : 40)) * 3);

export function tradeQuality(input: QualityInput) {
  const buy = input.side === 'BUY';
  const price = Number(input.price ?? 0), atr = Math.abs(Number(input.atr ?? 0));
  const distanceScore = (level: number | undefined, favorable: boolean) => {
    if (!(price > 0) || !Number.isFinite(Number(level))) return 50;
    const distanceAtr = atr > 0 ? Math.abs(price - Number(level)) / atr : Math.abs(price - Number(level)) / price * 100;
    return clamp(favorable ? 100 - distanceAtr * 20 : 50 + Math.min(50, distanceAtr * 15));
  };
  const momentum = clamp(50 + (buy ? 1 : -1) * Number(input.momentum ?? 0) * 5);
  const macd = clamp(50 + (buy ? 1 : -1) * Number(input.macdHistogram ?? 0) * 250);
  const volatility = clamp(100 - Math.abs(Number(input.volatility ?? (price ? atr / price * 100 : 1)) - 1.2) * 35);
  const components: Record<string, number> = {
    aiScore: clamp(input.aiScore), confidence: clamp(input.confidence), momentum, trendStrength: clamp(input.trendStrength ?? 0),
    volumeStrength: clamp(Number(input.volumeRatio ?? 0) / 3 * 100), vwapPosition: input.vwapAligned ? 100 : 20,
    emaAlignment: input.emaAligned ? (input.ema200Aligned ? 100 : 75) : 15, rsi: directionalRsi(Number(input.rsi ?? 50), buy), macd,
    atr: volatility, support: distanceScore(input.support, buy), resistance: distanceScore(input.resistance, !buy), breakoutConfirmation: input.breakoutConfirmed ? 100 : 30,
    previousCandleStrength: clamp(input.previousCandleStrength ?? 50), currentCandleStrength: clamp(input.currentCandleStrength ?? 50), sectorStrength: clamp(input.sectorStrength ?? 0),
    marketTrend: input.marketTrendAligned ? 100 : 20, niftyTrend: input.niftyTrendAligned ? 100 : 40, bankNiftyTrend: input.bankNiftyTrendAligned ? 100 : 40,
    volatility, riskReward: clamp(Number(input.riskReward ?? 0) / 5 * 100), targetDistance: clamp(Number(input.targetDistancePercent ?? 0) / 3 * 100),
    stopLossDistance: clamp(100 - Math.abs(Number(input.stopDistancePercent ?? 0) - 1) * 45),
  };
  const weights: Record<string, number> = { aiScore: 10, confidence: 10, momentum: 7, trendStrength: 7, volumeStrength: 7, vwapPosition: 5, emaAlignment: 6, rsi: 4, macd: 4, atr: 3, support: 3, resistance: 3, breakoutConfirmation: 5, previousCandleStrength: 3, currentCandleStrength: 4, sectorStrength: 4, marketTrend: 4, niftyTrend: 3, bankNiftyTrend: 2, volatility: 2, riskReward: 5, targetDistance: 2, stopLossDistance: 3 };
  const totalWeight = Object.values(weights).reduce((sum, value) => sum + value, 0);
  const score = Number((Object.entries(weights).reduce((sum, [key, weight]) => sum + components[key] * weight, 0) / totalWeight).toFixed(2));
  const rating = score >= 96 ? 'Excellent' : score >= 91 ? 'Very Good' : score >= 86 ? 'Good' : score >= 81 ? 'Average' : 'Skip';
  const stars = score >= 96 ? '★★★★★' : score >= 91 ? '★★★★☆' : score >= 86 ? '★★★★' : score >= 81 ? '★★★' : '★';
  const timingChecks = { momentum: momentum >= 60, volumeIncrease: Boolean(input.volumeIncreasing), candleConfirmation: components.currentCandleStrength >= 60, breakoutConfirmation: Boolean(input.breakoutConfirmed), vwap: Boolean(input.vwapAligned), ema: Boolean(input.emaAligned) };
  const confirmations = Object.values(timingChecks).filter(Boolean).length;
  const entryReady = score >= 96 || (score >= 80 && confirmations >= 5);
  const target1Probability = Math.round(clamp(score + Math.min(5, Number(input.riskReward ?? 0)) * 1.5));
  const target2Probability = Math.round(clamp(target1Probability - 8 - Math.max(0, Number(input.targetDistancePercent ?? 0) - 1) * 2));
  const target3Probability = Math.round(clamp(target2Probability - 16 - Math.max(0, Number(input.targetDistancePercent ?? 0) - 2) * 3));
  const expectedHoldingMinutes = Math.max(5, Math.round(8 + Number(input.targetDistancePercent ?? 1) * 7 + (100 - score) * .3));
  return { score, rating, stars, expectedSuccess: Math.round(clamp(score - (entryReady ? 1 : 6))), action: score < 80 ? 'SKIP' : entryReady ? 'EXECUTE IMMEDIATELY' : 'WAIT FOR IDEAL ENTRY', entryReady, entryReason: entryReady ? Object.entries(timingChecks).filter(([, pass]) => pass).map(([key]) => key).join(', ') : `Only ${confirmations}/6 entry confirmations`, timingChecks, target1Probability, target2Probability, target3Probability, expectedHoldingMinutes, components };
}
