import { Injectable } from '@nestjs/common';

@Injectable()
export class DemoSignalApprovalService {
  evaluate(signal: any, minimumProbability = 55, at = new Date()): any {
    let intelligence: any = {};
    try { intelligence = signal.intelligenceJson ? JSON.parse(signal.intelligenceJson) : signal.intelligence ?? {}; } catch { intelligence = {}; }
    const evidence = intelligence.historicalEvidence ?? {}, setup = intelligence.setup ?? {}, market = intelligence.marketContext ?? {};
    const probability = Number(evidence.calibratedProbability), expectancy = Number(evidence.expectancyR), winRate = Number(evidence.target1HitRate);
    const requiredRegime = signal.side === 'BUY' ? 'TRENDING_BULLISH' : 'TRENDING_BEARISH';
    const age = at.getTime() - new Date(signal.updatedAt ?? signal.signalTime).getTime();
    const reasons = [!['BUY', 'SELL'].includes(signal.side) ? 'INVALID_DIRECTION' : '', intelligence.finalDecision !== signal.side && signal.finalDecision !== signal.side ? 'SINGLE_HISTORY_NOT_APPROVED' : '', !setup.setupConfirmed ? 'SETUP_NOT_CONFIRMED' : '', evidence.status !== 'VERIFIED' ? 'HISTORICAL_EVIDENCE_UNVERIFIED' : '', !Number.isFinite(expectancy) || expectancy <= 0 ? 'NON_POSITIVE_EXPECTANCY' : '', !Number.isFinite(probability) || probability < minimumProbability ? 'CALIBRATED_PROBABILITY_TOO_LOW' : '', Number(signal.riskReward) < 1.5 ? 'RISK_REWARD_TOO_LOW' : '', intelligence.volumeAnalysis?.volumeDirectionConfirmation !== true ? 'VOLUME_NOT_CONFIRMED' : '', intelligence.liquidity?.status !== 'TRADABLE' ? 'LIQUIDITY_UNVERIFIED' : '', intelligence.multiTimeframeAlignment?.status !== 'STRONG' ? 'TIMEFRAMES_NOT_ALIGNED' : '', market.marketRegime !== requiredRegime ? 'MARKET_NOT_ALIGNED' : '', market.sectorRegime !== requiredRegime ? 'SECTOR_NOT_ALIGNED' : '', age < 0 || age > 120_000 ? 'MARKET_DATA_STALE' : '', !Number.isFinite(Number(signal.currentPrice)) || Number(signal.currentPrice) <= 0 ? 'INVALID_LIVE_PRICE' : '', !Number.isFinite(Number(signal.stopLoss)) || !Number.isFinite(Number(signal.target1)) ? 'INVALID_TRADE_LEVELS' : ''].filter(Boolean);
    if (reasons.length) return { approved: false, reasons };
    const expectedValue = expectancy * Number(signal.riskReward);
    const rankScore = expectedValue * .35 + probability / 100 * .2 + Number(signal.riskReward) / 3 * .15 + Number(signal.aiScore) / 100 * .1 + Number(intelligence.volumeAnalysis.relativeVolume ?? 0) / 3 * .1 + .1;
    const selectionReasons = [`Confirmed ${setup.setupType} ${signal.side}`, `Historical expectancy +${expectancy.toFixed(2)}R`, `Calibrated probability ${probability.toFixed(1)}%`, `Risk/reward 1:${Number(signal.riskReward).toFixed(2)}`, `Market and sector ${requiredRegime}`, `Relative volume ${Number(intelligence.volumeAnalysis.relativeVolume).toFixed(2)}x`];
    return { approved: true, candidate: { signal, intelligence, setupType: setup.setupType, calibratedProbability: probability, historicalWinRate: winRate, historicalExpectancy: expectancy, expectedValue, rankScore, selectionReasons } };
  }
  rank(signals: any[], minimumProbability: number, at = new Date()) {
    const unique = [...new Map(signals.map((signal) => [signal.id, signal])).values()];
    return unique.flatMap((signal) => { const result = this.evaluate(signal, minimumProbability, at); return result.approved ? [result.candidate] : []; }).sort((left, right) => right.rankScore - left.rankScore || right.expectedValue - left.expectedValue || new Date(right.signal.signalTime).getTime() - new Date(left.signal.signalTime).getTime());
  }
}
