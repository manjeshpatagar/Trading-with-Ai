import { marketClock } from './market-clock';
export type RealSource = 'STRATEGY' | 'SIGNAL_HISTORY';
export type RealSwitches = { strategyEnabledAt: Date | null; historyEnabledAt: Date | null };
type Candidate = { side: string; instrumentKey: string; signalTime: Date; target1At: Date | null; stopLossAt: Date | null; completedAt: Date | null; aiStrategyListed: boolean; aiStrategyListedAt: Date | null; top100Selected: boolean; currentPrice: number; target3: number; stopLoss: number };
export const LIVE_HIT_MAX_AGE_MS = 5_000;
export function realEligibility(signal: Candidate, source: RealSource, at: Date) {
  return source === 'STRATEGY'
    ? !!(signal.aiStrategyListed && signal.aiStrategyListedAt && signal.aiStrategyListedAt <= at)
    : signal.top100Selected && signal.currentPrice >= 60 && signal.currentPrice <= 600;
}
export type EntryDecision = { code: string; reason: string };
export function realEntryDecision(signal: Candidate, control: RealSwitches, source: RealSource, at: Date, now = new Date()): EntryDecision | null {
  if (!realEligibility(signal, source, at)) return { code: 'NOT_ELIGIBLE', reason: source === 'STRATEGY' ? 'Stock was not on the Strategy list before this T1 hit' : 'Stock did not qualify for Signal History at this T1 hit' };
  const since = source === 'STRATEGY' ? control.strategyEnabledAt : control.historyEnabledAt;
  if (!since) return { code: 'PAGE_OFF', reason: 'Real trading was OFF on this page' };
  const hit = signal.target1At;
  if (!hit || hit.getTime() !== at.getTime()) return { code: 'NOT_LIVE_EVENT', reason: 'Callback does not match the original T1 event; no late entry' };
  if (hit <= since) return { code: 'BEFORE_ACTIVATION', reason: 'T1 occurred before this page was switched ON' };
  if (hit > now || signal.signalTime > hit) return { code: 'INVALID_TIMESTAMP', reason: 'Signal timestamps are invalid or ahead of the server clock' };
  if (now.getTime() - hit.getTime() > LIVE_HIT_MAX_AGE_MS) return { code: 'STALE_SIGNAL', reason: 'T1 is more than five seconds old; no late entry' };
  if (marketClock(signal.signalTime).tradingDate !== marketClock(hit).tradingDate) return { code: 'PREVIOUS_SESSION', reason: 'Signal belongs to an earlier trading session' };
  if (!marketClock(now).canEnter || !marketClock(hit).canEnter) return { code: 'ENTRY_WINDOW_CLOSED', reason: 'T1 or submission is outside the intraday entry window' };
  if (signal.stopLossAt || signal.completedAt) return { code: 'SIGNAL_FINISHED', reason: 'Signal had already completed or reached its stop before entry' };
  if (!['BUY', 'SELL'].includes(signal.side) || !signal.instrumentKey.startsWith('NSE_EQ|')
    || ![signal.currentPrice, signal.target3, signal.stopLoss].every(value => Number.isFinite(value) && value > 0)) return { code: 'INVALID_SIGNAL', reason: 'Signal does not have valid equity order levels' };
  if (signal.side === 'BUY' ? signal.currentPrice >= signal.target3 || signal.currentPrice <= signal.stopLoss
    : signal.currentPrice <= signal.target3 || signal.currentPrice >= signal.stopLoss) return { code: 'PRICE_PASSED_EXIT', reason: 'Live price already passed Target 3 or the stop' };
  return null;
}
export function liveSource(signal: Candidate, control: RealSwitches, at: Date, now = new Date()): RealSource | null {
  for (const source of ['STRATEGY', 'SIGNAL_HISTORY'] as const) if (!realEntryDecision(signal, control, source, at, now)) return source;
  return null;
}
export class RealEntryRejected extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function realExitReason(trade: { side: string; target: number; stopLoss: number }, price: number) {
  if (!Number.isFinite(price) || price <= 0) return null;
  if (trade.side === 'BUY' ? price <= trade.stopLoss : price >= trade.stopLoss) return 'STOP LOSS';
  if (trade.side === 'BUY' ? price >= trade.target : price <= trade.target) return 'TARGET';
  return null;
}
export const brokerTerminal = (status: string) => ['complete', 'rejected', 'cancelled'].includes(status.toLowerCase());
