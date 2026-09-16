// Pure event helpers shared by the API and the history page.
type Event = { type: string; eventTime: Date | string };
type EventSignal = { events?: readonly Event[] | null };

export function confirmedTargetOneTime(signal: EventSignal): string | null {
  const times = (signal.events ?? [])
    .filter(event => event.type === 'TARGET1_HIT' && (typeof event.eventTime === 'string' || event.eventTime instanceof Date))
    .map(event => new Date(event.eventTime).getTime())
    .filter(Number.isFinite);
  // A target is hit once per trade. Duplicate deliveries cannot move that hit.
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

export function compareTargetOneHits(a: EventSignal, b: EventSignal): number {
  const left = confirmedTargetOneTime(a);
  const right = confirmedTargetOneTime(b);
  if (!left) return right ? 1 : 0;
  if (!right) return -1;
  return Date.parse(right) - Date.parse(left);
}

export function mergeTradeEvents<T extends Event>(previous: readonly T[], incoming: readonly T[]): T[] {
  // Persisted events are unique by trade and type. Incoming database records
  // supply the canonical timestamp; partial updates retain earlier events.
  const events = new Map(previous.map(event => [event.type, event]));
  for (const event of incoming) events.set(event.type, event);
  return [...events.values()].sort((a, b) => new Date(a.eventTime).getTime() - new Date(b.eventTime).getTime());
}

export function mergeHistoryUpdate<T extends { id: string; events: Event[] }>(signals: T[], updates: T[]): T[] {
  const merged = new Map(signals.map(signal => [signal.id, signal]));
  for (const update of updates) {
    const previous = merged.get(update.id);
    merged.set(update.id, { ...previous, ...update, events: mergeTradeEvents(previous?.events ?? [], update.events ?? []) });
  }
  return [...merged.values()].sort(compareTargetOneHits);
}
