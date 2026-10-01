import { Injectable } from '@nestjs/common';
import { Candle, IndicatorService } from './indicator.service';
import { completedCandles, sameTimeRelativeVolume } from './market-snapshot';
import { MarketRegimeService } from './market-regime.service';
import { TrendPullbackStrategy, BreakoutRetestStrategy, VwapReclaimStrategy } from './strategy-rules';

@Injectable()
export class StrategySetupService {
  evaluate(instrument: { symbol: string; instrumentKey: string }, input: Candle[], at: number, technicalScore: number) {
    const candles = completedCandles(input, at);
    if (candles.length < 55) return [];
    const calculator = new IndicatorService();
    const indicators = calculator.calculate(candles);
    const previous = calculator.calculate(candles.slice(0, -1));
    const regime = new MarketRegimeService().classify(candles, at);
    const relativeVolume = sameTimeRelativeVolume(candles);
    const latest = candles.at(-1)!;
    const atr = indicators.atr ?? NaN;
    return [new TrendPullbackStrategy(), new BreakoutRetestStrategy(), new VwapReclaimStrategy()].flatMap(strategy => ([1, -1] as const).map(direction => {
      const rule = strategy.evaluate({ candles, direction, ema20: indicators.ema20 ?? NaN, ema50: indicators.ema50 ?? NaN,
        vwap: indicators.vwap ?? NaN, previousVwap: previous.vwap ?? NaN, atr, relativeVolume: relativeVolume?.ratio ?? null });
      const reasons = [...rule.reasons];
      if (!regime.regime.endsWith(direction === 1 ? 'UPTREND' : 'DOWNTREND')) reasons.push('REGIME_NOT_ELIGIBLE');
      if (!Number.isFinite(atr) || atr <= 0 || !Number.isFinite(rule.level)) reasons.push('INDICATORS_UNAVAILABLE');
      if (Math.abs(latest.close - rule.level) > atr) reasons.push('ENTRY_TOO_EXTENDED');
      if (latest.volume <= 0) reasons.push('NO_LIQUIDITY');
      const recent = candles.slice(-3);
      const stop = direction === 1 ? Math.min(...recent.map(bar => bar.low)) - .2 * atr : Math.max(...recent.map(bar => bar.high)) + .2 * atr;
      const risk = direction * (latest.close - stop);
      if (!(risk > 0) || risk > 2 * atr) reasons.push('STOP_DISTANCE_INVALID');
      const target1 = latest.close + direction * risk * 1.5;
      const prior = candles.slice(-22, -3);
      const obstacle = direction === 1 ? Math.max(...prior.map(bar => bar.high)) : Math.min(...prior.map(bar => bar.low));
      if (direction * (obstacle - latest.close) > 0 && direction * (obstacle - target1) < 0) reasons.push('STRUCTURAL_REWARD_BLOCKED');
      return { ...instrument, strategyName: strategy.name, strategyVersion: '2.0.0', direction: direction === 1 ? 'BUY' as const : 'SELL' as const,
        marketRegime: regime, setupClassification: strategy.name, signalTimestamp: new Date(at).toISOString(), marketDataTimestamp: latest.time,
        referenceEntryPrice: latest.close, stopLossPrice: stop, target1, target2: latest.close + direction * risk * 2.25, target3: latest.close + direction * risk * 3,
        expectedRewardRisk: 3, technicalScore, entryQualityScore: Math.max(0, 100 - reasons.length * 20),
        liquidityScore: relativeVolume ? Math.min(100, Math.round(relativeVolume.ratio * 50)) : null,
        winProbability: null, calibrationStatus: 'NOT_CALIBRATED', riskValidation: 'ACCOUNT_ADMISSION_REQUIRED',
        eligibleSetup: reasons.length === 0, rejectionReasons: reasons, configurationVersion: 'equity-setup-v2-defaults',
        relativeVolume, expiresAt: new Date(Date.parse(latest.time) + 900000).toISOString() };
    }));
  }
}
