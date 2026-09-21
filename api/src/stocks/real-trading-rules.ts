import { marketClock } from './market-clock';
export type RealSource = 'STRATEGY' | 'SIGNAL_HISTORY';
export type RealSwitches = { strategyEnabledAt: Date | null; historyEnabledAt: Date | null };
type Candidate = { side: string; instrumentKey: string; signalTime: Date; target1At: Date | null; stopLossAt: Date | null; completedAt: Date | null; aiStrategyListed: boolean; aiStrategyListedAt: Date | null; top100Selected: boolean; currentPrice: number; target3: number; stopLoss: number };
export const LIVE_HIT_MAX_AGE_MS = 5_000;
export function liveSource(signal: Candidate, control: RealSwitches, at: Date, now = new Date()): RealSource | null {
  const hit = signal.target1At;
  if (!hit || hit.getTime() !== at.getTime() || hit > now || now.getTime() - hit.getTime() > LIVE_HIT_MAX_AGE_MS
    || signal.signalTime > hit || marketClock(signal.signalTime).tradingDate !== marketClock(hit).tradingDate
    || !marketClock(now).canEnter || !marketClock(hit).canEnter || signal.stopLossAt || signal.completedAt
    || !['BUY', 'SELL'].includes(signal.side) || !signal.instrumentKey.startsWith('NSE_EQ|')
    || ![signal.currentPrice, signal.target3, signal.stopLoss].every(value => Number.isFinite(value) && value > 0)) return null;
  // No entry on a gap already beyond the final target or the stop.
  if (signal.side === 'BUY' ? signal.currentPrice >= signal.target3 || signal.currentPrice <= signal.stopLoss
    : signal.currentPrice <= signal.target3 || signal.currentPrice >= signal.stopLoss) return null;
  const enabled = (since: Date | null) => since !== null && hit > since;
  if (enabled(control.strategyEnabledAt) && signal.aiStrategyListed && signal.aiStrategyListedAt && signal.aiStrategyListedAt <= hit) return 'STRATEGY';
  if (enabled(control.historyEnabledAt) && signal.top100Selected && signal.currentPrice >= 60 && signal.currentPrice <= 600) return 'SIGNAL_HISTORY';
  return null;
}
export function realExitReason(trade: { side: string; target: number; stopLoss: number }, price: number) {
  if (!Number.isFinite(price) || price <= 0) return null;
  if (trade.side === 'BUY' ? price <= trade.stopLoss : price >= trade.stopLoss) return 'STOP LOSS';
  if (trade.side === 'BUY' ? price >= trade.target : price <= trade.target) return 'TARGET';
  return null;
}
export const brokerTerminal = (status: string) => ['complete', 'rejected', 'cancelled'].includes(status.toLowerCase());
