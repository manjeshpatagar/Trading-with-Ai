import { Injectable } from '@nestjs/common';

export type PositionRiskInput = {
  capital: number; accountBalance: number; entryPrice: number; stopLoss: number;
  riskPercent: number; leverage: number; side?: string; target?: number;
  lotSize?: number; liquidityQuantity?: number; maximumQuantity?: number;
};

/** Hard admission rules, independent of signal scoring. */
@Injectable()
export class RiskManagementService {
  daily(input: { dayStartEquity: number; realizedPnl: number; unrealizedPnl: number;
    consecutiveLosses: number; symbolEntries: number; lastStopAt: number | null; at: number },
    limits: { maxDailyLossPercent: number; maxCombinedLossPercent: number; maxConsecutiveLosses: number;
      maxEntriesPerSymbol: number; stopCooldownMinutes: number; allowReentry: boolean }) {
    const reasons: string[] = [];
    if (!Number.isFinite(input.dayStartEquity) || input.dayStartEquity <= 0
      || ![input.realizedPnl, input.unrealizedPnl, input.consecutiveLosses, input.symbolEntries, input.at,
        limits.maxDailyLossPercent, limits.maxCombinedLossPercent, limits.maxConsecutiveLosses,
        limits.maxEntriesPerSymbol, limits.stopCooldownMinutes].every(Number.isFinite)) return ['INVALID_DAILY_RISK_STATE'];
    if (input.realizedPnl <= -input.dayStartEquity * limits.maxDailyLossPercent / 100) reasons.push('DAILY_REALIZED_LOSS_LIMIT');
    if (input.realizedPnl + input.unrealizedPnl <= -input.dayStartEquity * limits.maxCombinedLossPercent / 100) reasons.push('DAILY_COMBINED_LOSS_LIMIT');
    if (input.consecutiveLosses >= limits.maxConsecutiveLosses) reasons.push('CONSECUTIVE_LOSS_LIMIT');
    if (input.symbolEntries >= limits.maxEntriesPerSymbol || !limits.allowReentry && input.symbolEntries > 0) reasons.push('SYMBOL_ENTRY_LIMIT');
    if (input.lastStopAt !== null && input.at - input.lastStopAt < limits.stopCooldownMinutes * 60_000) reasons.push('STOP_LOSS_COOLDOWN');
    return reasons;
  }

  size(input: PositionRiskInput) {
    const rejectionReasons: string[] = [];
    const positive = (n: number) => Number.isFinite(n) && n > 0;
    const lot = input.lotSize ?? 1;
    if (![input.capital, input.accountBalance, input.entryPrice, input.stopLoss, input.riskPercent, input.leverage].every(positive)
      || input.riskPercent > 100 || !Number.isSafeInteger(lot) || lot < 1) rejectionReasons.push('INVALID_RISK_INPUT');
    if (input.side !== undefined && !['BUY', 'SELL'].includes(input.side)) rejectionReasons.push('INVALID_SIDE');
    const direction = input.side === 'SELL' ? -1 : 1;
    if (input.side && direction * (input.entryPrice - input.stopLoss) <= 0) rejectionReasons.push('INVALID_STOP_SIDE');
    const riskPerShare = Math.abs(input.entryPrice - input.stopLoss);
    if (!positive(riskPerShare)) rejectionReasons.push('INVALID_STOP_DISTANCE');
    if (input.target !== undefined && (!positive(input.target)
      || direction * (input.target - input.entryPrice) / riskPerShare < 1.5)) rejectionReasons.push('INSUFFICIENT_REWARD');
    for (const cap of [input.liquidityQuantity, input.maximumQuantity]) {
      if (cap !== undefined && (!Number.isSafeInteger(cap) || cap < 0)) rejectionReasons.push('INVALID_QUANTITY_LIMIT');
    }
    const leverage = positive(input.leverage) ? Math.max(1, input.leverage) : 1;
    const marginPerShare = positive(input.entryPrice) ? input.entryPrice / leverage : 0;
    const maximumRisk = positive(input.accountBalance) && positive(input.riskPercent) ? input.accountBalance * input.riskPercent / 100 : 0;
    const marginQuantity = positive(marginPerShare) && positive(input.capital) ? Math.floor(input.capital / marginPerShare) : 0;
    const riskQuantity = positive(riskPerShare) ? Math.floor(maximumRisk / riskPerShare) : 0;
    const raw = Math.min(marginQuantity, riskQuantity, input.liquidityQuantity ?? Number.MAX_SAFE_INTEGER, input.maximumQuantity ?? Number.MAX_SAFE_INTEGER);
    const quantity = rejectionReasons.length ? 0 : Math.max(0, Math.floor(raw / lot) * lot);
    if (!quantity && !rejectionReasons.length) rejectionReasons.push('ZERO_QUANTITY');
    return { leverage, marginPerShare, marginQuantity, riskPerShare, maximumRisk, riskQuantity,
      quantity, monetaryRisk: quantity * riskPerShare, marginUsed: quantity * marginPerShare,
      notionalValue: quantity * (positive(input.entryPrice) ? input.entryPrice : 0),
      eligible: rejectionReasons.length === 0, rejectionReasons };
  }
}
