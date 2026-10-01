import { Candle } from './indicator.service';

/** Provider candles are start-stamped; cached/provider objects are never mutated. */
export function completedCandles(input: Candle[], at: number, intervalMinutes = 5): Candle[] {
  const duration = intervalMinutes * 60_000;
  if (!Number.isFinite(at) || !Number.isFinite(duration) || duration <= 0) return [];
  const unique = new Map<number, Candle>();
  const conflicts = new Set<number>();
  for (const candle of input) {
    const start = Date.parse(candle.time);
    if (!Number.isFinite(start) || start + duration > at
      || ![candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)
      || candle.volume < 0 || candle.low <= 0 || candle.high < Math.max(candle.open, candle.close)
      || candle.low > Math.min(candle.open, candle.close) || candle.high < candle.low) continue;
    const previous = unique.get(start);
    if (previous && ['open', 'high', 'low', 'close', 'volume'].some(key => previous[key as keyof Candle] !== candle[key as keyof Candle])) conflicts.add(start);
    unique.set(start, { ...candle, time: new Date(start).toISOString() });
  }
  return [...unique].filter(([start]) => !conflicts.has(start)).sort(([a], [b]) => a - b).map(([, candle]) => candle);
}

export function sameTimeRelativeVolume(candles: Candle[], minimumSessions = 3) {
  const latest = candles.at(-1);
  if (!latest) return null;
  const slot = (time: string) => new Date(Date.parse(time) + 330 * 60_000).toISOString();
  const current = slot(latest.time);
  const history = new Map<string, number>();
  for (const candle of candles.slice(0, -1)) {
    const time = slot(candle.time);
    if (time.slice(0, 10) < current.slice(0, 10) && time.slice(11, 16) === current.slice(11, 16)) history.set(time.slice(0, 10), candle.volume);
  }
  if (history.size < minimumSessions) return null;
  const average = [...history.values()].reduce((sum, v) => sum + v, 0) / history.size;
  return average > 0 ? { ratio: latest.volume / average, sessions: history.size, average } : null;
}
