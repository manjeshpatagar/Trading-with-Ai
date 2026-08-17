import { Injectable } from '@nestjs/common';

@Injectable()
export class IntradayIntelligenceService {
  evaluate(input: any) {
    const n = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    const price = n(input.price), atr = n(input.atr), adx = n(input.adx), direction = n(input.direction), volumeRatio = n(input.volumeRatio);
    const latest = input.latestCandle ?? {}, previous = input.previousCandle ?? {};
    const open = n(latest.open, price), high = n(latest.high, price), low = n(latest.low, price), close = n(latest.close, price);
    const range = Math.max(high - low, price * .00001), bodyRatio = Math.abs(close - open) / range, closeLocation = (close - low) / range;
    const atrPercent = price ? atr / price * 100 : 0;
    const bullishStructure = Boolean(input.marketStructure?.higherHigh && input.marketStructure?.higherLow);
    const bearishStructure = Boolean(input.marketStructure?.lowerLow && input.marketStructure?.lowerHigh);
    const stockRegime = atrPercent >= 2 ? 'HIGH_VOLATILITY' : atrPercent > 0 && atrPercent < .4 ? 'LOW_VOLATILITY' : adx < 18 ? 'SIDEWAYS' : direction > 0 && bullishStructure ? 'TRENDING_BULLISH' : direction < 0 && bearishStructure ? 'TRENDING_BEARISH' : 'UNCERTAIN';
    const setupType = input.orbBreak ? 'ORB' : input.previousDayBreak ? (direction > 0 ? 'BREAKOUT' : 'BREAKDOWN') : adx < 18 ? 'MEAN_REVERSION' : Math.abs(price - n(input.ema20)) <= atr * .4 ? 'PULLBACK' : 'MOMENTUM';
    const strongClose = direction > 0 ? closeLocation >= .7 : direction < 0 ? closeLocation <= .3 : false;
    const volumeExpansion = volumeRatio >= 1.2 && n(latest.volume) >= n(previous.volume);
    const setupConfirmed = Boolean(input.candleClosed && direction && strongClose && (!['BREAKOUT', 'BREAKDOWN', 'ORB'].includes(setupType) || volumeExpansion));
    const tradabilityReasons = [!input.dataFresh ? 'STALE_DATA' : '', !input.sufficientHistory ? 'INSUFFICIENT_HISTORY' : '', n(input.selectionScore) <= 0 ? 'LIQUIDITY_UNVERIFIED' : '', n(input.volume) <= 0 ? 'NO_CURRENT_VOLUME' : ''].filter(Boolean);
    const noTradeReasons = [...tradabilityReasons, !setupConfirmed ? 'SETUP_NOT_CONFIRMED' : '', volumeRatio < 1 ? 'WEAK_VOLUME' : '', input.fakeBreakout ? 'FAKE_BREAKOUT' : '', input.lateEntry ? 'LATE_OR_OVEREXTENDED_ENTRY' : '', n(input.riskReward) < 1.5 ? 'POOR_RISK_REWARD' : '', 'MARKET_AND_SECTOR_REGIME_UNVERIFIED', 'HISTORICAL_EVIDENCE_UNVERIFIED', 'MULTI_TIMEFRAME_UNVERIFIED'].filter(Boolean);
    return {
      version: 1,
      marketContext: { marketRegime: 'UNCERTAIN', sectorRegime: 'UNCERTAIN', stockRegime, nifty: 'UNAVAILABLE', bankNifty: 'UNAVAILABLE', sectorIndex: 'UNAVAILABLE', volatilityRegime: atrPercent >= 2 ? 'HIGH_VOLATILITY' : atrPercent > 0 && atrPercent < .4 ? 'LOW_VOLATILITY' : 'NORMAL' },
      setup: { setupType, setupDirection: direction > 0 ? 'BUY' : direction < 0 ? 'SELL' : 'NONE', setupStrength: input.entryQuality ?? 'UNVERIFIED', setupConfirmed, confirmation: setupConfirmed ? 'CLOSED_CANDLE_CONFIRMED' : 'WAITING_FOR_CONFIRMATION' },
      priceBehavior: { structure: bullishStructure ? 'HIGHER_HIGH_HIGHER_LOW' : bearishStructure ? 'LOWER_LOW_LOWER_HIGH' : 'MIXED', breakOfStructure: Boolean(input.orbBreak || input.previousDayBreak), bodyRangeRatio: bodyRatio, bodyStrengthPercent: Math.round(bodyRatio * 100), upperWickPercent: Math.round((high - Math.max(open, close)) / range * 100), lowerWickPercent: Math.round((Math.min(open, close) - low) / range * 100), closeLocationPercent: Math.round(closeLocation * 100), rangeVsAtr: atr ? range / atr : null, gapPercent: n(input.openingGapPercent) },
      volumeAnalysis: { relativeVolume: volumeRatio, timeAdjustedRelativeVolume: null, volumeVsPrevious20Candles: volumeRatio, volumeExpansion, volumeDirectionConfirmation: volumeExpansion && strongClose, status: volumeExpansion ? 'CONFIRMED' : 'WEAK_OR_UNVERIFIED' },
      multiTimeframeAlignment: { status: 'UNVERIFIED', oneMinute: 'UNAVAILABLE', fiveMinute: stockRegime, fifteenMinute: 'UNAVAILABLE', thirtyMinute: 'UNAVAILABLE' },
      liquidity: { status: tradabilityReasons.length ? 'UNVERIFIED' : 'TRADABLE', averageTradedValue: null, spread: null, marketDepth: null, circuitProximity: null, reasons: tradabilityReasons },
      scoring: { existingAiScore: n(input.aiScore), transparentScoreStatus: 'UNVERIFIED', historicalExpectancyWeightApplied: false },
      historicalEvidence: { status: 'UNVERIFIED', sampleSize: 0, calibratedProbability: null, expectancyR: null },
      finalDecision: noTradeReasons.length ? 'NO TRADE' : direction > 0 ? 'BUY' : direction < 0 ? 'SELL' : 'HOLD', noTradeReasons,
      explanation: noTradeReasons.length ? `No trade: ${noTradeReasons.join(', ')}` : `${setupType} confirmed with price, trend and volume alignment.`,
    };
  }
}
