import { strategyWeekRange } from './strategy-weekly';

type Event = { type: string; eventTime: Date; executedPrice: number };
export type TargetOneSignal = {
  id: string; instrumentKey: string; symbol: string; stockName: string; side: string;
  entryTriggeredAt: Date | null; entryPrice: number; target1: number;
  target1At: Date | null; target1HitAt: Date | null; target1ExecutedPrice: number | null;
  stopLossAt: Date | null; stopLossHitAt: Date | null; stopLoss: number;
  completedAt: Date | null; exitPrice: number | null; status: string; events: Event[];
};

export function analyzeTargetOne(signals: TargetOneSignal[], at = new Date()) {
  const { start, end } = strategyWeekRange(at);
  const seen = new Set<string>();
  const rows = signals.flatMap(signal => {
    if (seen.has(signal.id) || !signal.entryTriggeredAt || signal.entryTriggeredAt < start || signal.entryTriggeredAt >= end || signal.entryTriggeredAt > at || !['BUY', 'SELL'].includes(signal.side)) return [];
    seen.add(signal.id);
    const events = [...signal.events].filter(event => event.eventTime <= at).sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime());
    const targetEvent = events.find(event => event.type === 'TARGET1_HIT');
    const target1At = signal.target1At ?? signal.target1HitAt ?? targetEvent?.eventTime;
    if (!target1At || target1At > at || target1At < signal.entryTriggeredAt) return [];
    const afterTarget = (time: Date | null | undefined) => time && time >= target1At && time <= at ? time : null;
    const stopEvent = events.find(event => ['STOPLOSS_TOUCHED', 'STOPLOSS_HIT', 'STOPLOSS_CONFIRMED'].includes(event.type) && event.eventTime >= target1At);
    const stopLossAt = stopEvent?.eventTime ?? afterTarget(signal.stopLossAt ?? signal.stopLossHitAt);
    const completedAt = afterTarget(signal.completedAt);
    const stopExitAt = afterTarget(signal.stopLossAt ?? signal.stopLossHitAt);
    const exitPrice = completedAt && signal.exitPrice !== null && Number.isFinite(signal.exitPrice) && signal.exitPrice > 0 ? signal.exitPrice : null;
    // Target 1 is the reference level requested for this report. The original
    // entry P&L deliberately does not determine the post-Target-1 outcome.
    const profitPercent = exitPrice !== null && Number.isFinite(signal.target1) && signal.target1 > 0
      ? (exitPrice - signal.target1) / signal.target1 * (signal.side === 'SELL' ? -100 : 100) : null;
    const outcome = !completedAt ? 'RUNNING' : profitPercent === null ? 'UNKNOWN' : profitPercent > 0 ? 'WIN' : profitPercent < 0 ? 'LOSS' : 'BREAKEVEN';
    return [{
      id: signal.id, instrumentKey: signal.instrumentKey, symbol: signal.symbol, stockName: signal.stockName, side: signal.side,
      entryPrice: signal.entryPrice, entryAt: signal.entryTriggeredAt.toISOString(),
      target1Price: signal.target1, target1At: target1At.toISOString(), target1ObservedPrice: signal.target1ExecutedPrice ?? targetEvent?.executedPrice ?? null,
      stopLossLevel: signal.stopLoss, stopLossAt: stopLossAt?.toISOString() ?? null,
      stopLossHitPrice: stopEvent?.executedPrice ?? (stopExitAt && completedAt && stopExitAt.getTime() === completedAt.getTime() ? exitPrice : null),
      completedAt: completedAt?.toISOString() ?? null, exitPrice, profitPercent, outcome,
      exitReason: !completedAt ? null : stopExitAt ? 'STOP LOSS' : signal.status === 'AI_EXIT' ? 'AI EXIT' : events.some(event => event.type === 'TARGET3_HIT' && event.eventTime >= target1At && event.eventTime <= completedAt) ? 'TARGET 3' : 'COMPLETED',
      minutesAfterTarget1: completedAt ? (completedAt.getTime() - target1At.getTime()) / 60_000 : null,
    }];
  }).sort((a, b) => b.target1At.localeCompare(a.target1At));
  return {
    timezone: 'Asia/Kolkata', basis: 'TARGET_1_LEVEL', generatedAt: at.toISOString(), rows,
    summary: {
      reachedTarget1: rows.length, stocks: new Set(rows.map(row => row.instrumentKey)).size,
      stopLossHits: rows.filter(row => row.stopLossAt).length,
      completed: rows.filter(row => row.completedAt).length,
      wins: rows.filter(row => row.outcome === 'WIN').length,
      losses: rows.filter(row => row.outcome === 'LOSS').length,
      breakeven: rows.filter(row => row.outcome === 'BREAKEVEN').length,
      running: rows.filter(row => row.outcome === 'RUNNING').length,
      unknown: rows.filter(row => row.outcome === 'UNKNOWN').length,
    },
  };
}
