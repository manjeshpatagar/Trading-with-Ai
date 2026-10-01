import { Injectable } from '@nestjs/common';
import { Candle, IndicatorService } from './indicator.service';
import { completedCandles } from './market-snapshot';

export type MarketRegime = 'STRONG_UPTREND' | 'WEAK_UPTREND' | 'STRONG_DOWNTREND' | 'WEAK_DOWNTREND' | 'SIDEWAYS' | 'HIGH_VOLATILITY' | 'LOW_VOLATILITY' | 'UNCERTAIN';
export const regimeDefaults = { trendAdx: 20, strongAdx: 30, minimumNormalizedAtr: .001, maximumNormalizedAtr: .025, maximumAgeMs: 600000 };

@Injectable()
export class MarketRegimeService {
  classify(input: Candle[], at: number, config = regimeDefaults) {
    const candles = completedCandles(input, at);
    const indicators = new IndicatorService();
    const current = indicators.calculate(candles);
    const previous = indicators.calculate(candles.slice(0, -3));
    const latest = candles.at(-1);
    const marketDataTimestamp = latest?.time ?? null;
    const closeTime = latest ? Date.parse(latest.time) + 300000 : NaN;
    const features = { ema20: current.ema20 ?? null, ema50: current.ema50 ?? null,
      ema20Slope: current.ema20 != null && previous.ema20 != null ? current.ema20 - previous.ema20 : null,
      ema50Slope: current.ema50 != null && previous.ema50 != null ? current.ema50 - previous.ema50 : null,
      vwap: current.vwap ?? null, vwapSlope: current.vwap != null && previous.vwap != null ? current.vwap - previous.vwap : null,
      adx: current.adx ?? null, pdi: current.directionalMovement?.pdi ?? null, mdi: current.directionalMovement?.mdi ?? null,
      normalizedAtr: latest && current.atr != null ? current.atr / latest.close : null,
      structure: current.marketStructure ?? null, benchmark: 'UNAVAILABLE', sector: 'UNAVAILABLE' };
    const result = (regime: MarketRegime, certainty: number, reasons: string[]) => ({ regime, certainty, certaintyMeaning: 'feature agreement, not win probability', features, marketDataTimestamp, evaluatedAt: new Date(at).toISOString(), reasons });
    if (!latest || candles.length < 55 || at - closeTime > config.maximumAgeMs
      || [features.ema20, features.ema50, features.ema20Slope, features.ema50Slope, features.vwap, features.vwapSlope, features.adx, features.pdi, features.mdi, features.normalizedAtr].some(v => v === null || !Number.isFinite(v))) return result('UNCERTAIN', 0, ['INSUFFICIENT_OR_STALE_DATA']);
    // The latest three bars must be consecutive; overnight gaps cannot masquerade as confirmation.
    if (candles.slice(-3).some((bar, i, rows) => i > 0 && Date.parse(bar.time) - Date.parse(rows[i - 1].time) !== 300000)) return result('UNCERTAIN', 0, ['MISSING_CONFIRMATION_BAR']);
    if (features.normalizedAtr! > config.maximumNormalizedAtr) return result('HIGH_VOLATILITY', 100, ['ATR_ABOVE_CONFIGURED_LIMIT']);
    if (features.normalizedAtr! < config.minimumNormalizedAtr) return result('LOW_VOLATILITY', 100, ['ATR_BELOW_CONFIGURED_LIMIT']);
    const up = [features.ema20! > features.ema50!, features.ema20Slope! > 0, features.ema50Slope! > 0, latest.close > features.vwap!, features.vwapSlope! > 0, features.pdi! > features.mdi!, Boolean(features.structure?.higherLow)].filter(Boolean).length;
    const down = [features.ema20! < features.ema50!, features.ema20Slope! < 0, features.ema50Slope! < 0, latest.close < features.vwap!, features.vwapSlope! < 0, features.mdi! > features.pdi!, Boolean(features.structure?.lowerHigh)].filter(Boolean).length;
    const certainty = Math.round(Math.max(up, down) / 7 * 100);
    if (features.adx! < config.trendAdx || Math.max(up, down) < 5) return result('SIDEWAYS', certainty, ['DIRECTIONAL_AGREEMENT_INSUFFICIENT']);
    return result(up > down ? features.adx! >= config.strongAdx ? 'STRONG_UPTREND' : 'WEAK_UPTREND' : features.adx! >= config.strongAdx ? 'STRONG_DOWNTREND' : 'WEAK_DOWNTREND', certainty, []);
  }
}
