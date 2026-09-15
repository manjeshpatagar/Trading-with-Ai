type StrategyRow = { signal?: string; price?: number; aiScore?: number; target1At?: unknown };
export function selectStrategyRows<T extends StrategyRow>(rows: T[], side: 'BUY' | 'SELL'): T[] {
  // Eligibility must be selected before the event. A Target 1 timestamp must
  // never promote an unlisted stock into the execution list after its hit.
  return rows.filter(row => row.signal === side && Number(row.price) >= 60 && Number(row.price) <= 600)
    .sort((a, b) => Number(b.aiScore ?? 0) - Number(a.aiScore ?? 0)).slice(0, 10);
}
