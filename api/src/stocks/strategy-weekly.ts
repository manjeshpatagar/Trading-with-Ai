const DAY = 86_400_000;
const OFFSET = 330 * 60_000;
export function strategyWeekRange(at = new Date()) {
  return strategyHistoryRange(at, 7);
}
export function strategyHistoryRange(at = new Date(), days = 30) {
  const shifted = new Date(at.getTime() + OFFSET);
  const today = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - OFFSET;
  return { start: new Date(today - (days - 1) * DAY), end: new Date(today + DAY) };
}
type Outcome = { id: string; entryTriggeredAt: Date | null; completedAt: Date | null; profitPercent: number | null };
export function summarizeStrategyMonth(signals: Outcome[], at = new Date()) {
  const { start } = strategyHistoryRange(at);
  const days = Array.from({ length: 30 }, (_, index) => ({ date: new Date(start.getTime() + index * DAY + OFFSET).toISOString().slice(0, 10), entries: 0, completed: 0, wins: 0, losses: 0, breakeven: 0, pending: 0, unclassified: 0 }));
  const seen = new Set<string>();
  for (const signal of signals) {
    if (seen.has(signal.id) || !signal.entryTriggeredAt || signal.entryTriggeredAt > at) continue;
    seen.add(signal.id);
    const date = new Date(signal.entryTriggeredAt.getTime() + OFFSET).toISOString().slice(0, 10);
    const day = days.find(day => day.date === date);
    if (!day) continue;
    day.entries++;
    if (!signal.completedAt || signal.completedAt > at) { day.pending++; continue; }
    day.completed++;
    if (signal.profitPercent === null || !Number.isFinite(signal.profitPercent)) day.unclassified++;
    else if (signal.profitPercent > 0) day.wins++;
    else if (signal.profitPercent < 0) day.losses++;
    else day.breakeven++;
  }
  return { days: days.reverse(), timezone: 'Asia/Kolkata' };
}
