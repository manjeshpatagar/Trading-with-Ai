/** Price ordering is independent of signal lifecycle/database timestamps. */
export type LivePrice = { instrumentKey: string; ltp: number; timestamp: number; sequence: number; receivedAt: number };
export function newerPrice(incoming: LivePrice, previous?: LivePrice) {
  return Number.isFinite(incoming.ltp) && incoming.ltp > 0
    && Number.isFinite(incoming.timestamp) && incoming.timestamp > 0
    && Number.isFinite(incoming.sequence) && incoming.sequence > 0
    && (!previous || incoming.timestamp > previous.timestamp
      || incoming.timestamp === previous.timestamp && incoming.sequence > previous.sequence);
}
export function markPrice<T extends { instrumentKey: string; currentPrice: number }>(row: T, quote?: LivePrice) {
  return { ...row, ...(quote ? { currentPrice: quote.ltp, marketTimestamp: quote.timestamp, marketSequence: quote.sequence, marketReceivedAt: quote.receivedAt, lastMarketUpdate: new Date(quote.timestamp).toISOString() } : {}) };
}
export function markPosition<T extends { instrumentKey: string; currentPrice: number; status: string; side: string; entryPrice?: number | null; plannedEntry: number; quantity: number; pnl: number; pnlPercent: number }>(order: T, quote?: LivePrice) {
  if (!quote || order.status !== 'OPEN') return order;
  const entry = Number(order.entryPrice ?? order.plannedEntry);
  const pnl = (order.side === 'BUY' ? quote.ltp - entry : entry - quote.ltp) * order.quantity;
  return { ...markPrice(order, quote), pnl, pnlPercent: entry * order.quantity ? pnl / (entry * order.quantity) * 100 : 0 };
}
