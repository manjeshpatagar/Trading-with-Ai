import { LivePrice, markPosition, markPrice, newerPrice } from '../../api/src/stocks/live-price';

type Row = { instrumentKey: string; currentPrice: number; marketTimestamp?: number; marketSequence?: number; marketReceivedAt?: number };
type Order = Row & { status: string; side: string; entryPrice?: number | null; plannedEntry: number; quantity: number; pnl: number; pnlPercent: number; budget: number };
/** One book per signed-in history view, shared by history and demo queries. */
export class LivePriceBook {
  private readonly quotes = new Map<string, LivePrice>();
  accept(quote: LivePrice) {
    if (!newerPrice(quote, this.quotes.get(quote.instrumentKey))) return false;
    this.quotes.set(quote.instrumentKey, quote);
    return true;
  }
  private ingest(rows: Row[]) {
    for (const row of rows) this.accept({ instrumentKey: row.instrumentKey, ltp: row.currentPrice,
      timestamp: Number(row.marketTimestamp), sequence: Number(row.marketSequence), receivedAt: Number(row.marketReceivedAt) });
  }
  history<T extends { signals: Row[] }>(data: T): T {
    this.ingest(data.signals);
    return { ...data, signals: data.signals.map(row => markPrice(row, this.quotes.get(row.instrumentKey))) };
  }
  demo<T extends { openPositions: Order[]; waitingOrders: Order[]; summary: { virtualBalance: number; usedCapital: number; availableCapital: number; todayPnl: number }; performance: { todayProfit: number; todayLoss: number } }>(data: T): T {
    this.ingest(data.openPositions);
    const openPositions = data.openPositions.map(order => markPosition(order, this.quotes.get(order.instrumentKey)));
    const usedCapital = openPositions.reduce((sum, order) => sum + order.budget, 0);
    const unrealized = openPositions.reduce((sum, order) => sum + order.pnl, 0);
    return { ...data, openPositions, summary: { ...data.summary, usedCapital,
      availableCapital: Math.max(0, data.summary.virtualBalance - usedCapital),
      todayPnl: data.performance.todayProfit - data.performance.todayLoss + unrealized } };
  }
}
