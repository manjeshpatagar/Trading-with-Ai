import { marketClock } from './market-clock';

/** Keep analysis visible while suppressing actionable fresh or cached setups. */
export function protectOpeningSignal<T>(row: T, at = new Date()): T {
  if (!marketClock(at).openingProtection) return row;
  return {
    ...row, signal: 'HOLD', signalStrength: 'HOLD', aiDecision: 'WAIT',
    entry: null, entryPrice: null, buyLevel: null, sellLevel: null, safeEntry: null, aggressiveEntry: null,
    stopLoss: null, target1: null, target2: null, target3: null,
    reason: 'Opening Volatility Protection: 9:15–9:20 — No Trades. Trading Active from 9:20 AM.',
  };
}
