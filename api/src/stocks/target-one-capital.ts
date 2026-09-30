export type CapitalTrade = { id: string; instrumentKey: string; side: string; target1At: string; target1ObservedPrice: number | null; completedAt: string | null; exitPrice: number | null };
export type OrderCharges = { total: number; brokerage: number };
export type CapitalBroker = {
  margin(trade: CapitalTrade, quantity: number): Promise<number>;
  charges(trade: CapitalTrade, quantity: number, exit: boolean): Promise<OrderCharges>;
};
export type CapitalResult = {
  id: string; date: string; status: 'CLOSED' | 'OPEN' | 'SKIPPED' | 'UNAVAILABLE'; reason: string | null;
  quantity: number; capitalBefore: number | null; capitalAfter: number | null; marginUsed: number | null; leverage: number | null;
  entryCharges: number | null; exitCharges: number | null; brokerage: number | null; charges: number | null;
  grossPnl: number | null; netPnl: number | null;
};
export type CapitalDay = { date: string; startingCapital: number; closingBalance: number | null; grossProfit: number; grossLoss: number; charges: number; netPnl: number; traded: number; skipped: number; open: number; complete: boolean };
export type CapitalReport = { rows: CapitalResult[]; days: CapitalDay[] };
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
export const capitalDate = (value: string) => new Date(Date.parse(value) + 330 * 60_000).toISOString().slice(0, 10);
function validCharges(value: OrderCharges) {
  if (!Number.isFinite(value.total) || value.total < 0 || !Number.isFinite(value.brokerage) || value.brokerage < 0 || value.brokerage > value.total) throw new Error('Charges unavailable');
  return value;
}

/** Pure chronological replay. No order placement or changes to demo/live accounts. */
export async function simulateTargetOneCapital(trades: CapitalTrade[], broker: CapitalBroker): Promise<CapitalReport> {
  const rows: CapitalResult[] = [], days: CapitalDay[] = [];
  const grouped = new Map<string, CapitalTrade[]>();
  for (const trade of [...new Map(trades.map(trade => [trade.id, trade])).values()]) {
    const date = capitalDate(trade.target1At);
    grouped.set(date, [...(grouped.get(date) ?? []), trade]);
  }
  for (const [date, items] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    let balance = 10_000, busyUntil = -Infinity, unavailable = false;
    const day: CapitalDay = { date, startingCapital: 10_000, closingBalance: 10_000, grossProfit: 0, grossLoss: 0, charges: 0, netPnl: 0, traded: 0, skipped: 0, open: 0, complete: true };
    for (const trade of items.sort((a, b) => a.target1At.localeCompare(b.target1At) || a.id.localeCompare(b.id))) {
      const result: CapitalResult = { id: trade.id, date, status: 'UNAVAILABLE', reason: null, quantity: 0, capitalBefore: unavailable ? null : balance, capitalAfter: null, marginUsed: null, leverage: null, entryCharges: null, exitCharges: null, brokerage: null, charges: null, grossPnl: null, netPnl: null };
      rows.push(result);
      if (unavailable) { result.reason = 'Earlier trade could not be calculated; next balance is unknown'; continue; }
      if (Date.parse(trade.target1At) <= busyUntil) { result.status = 'SKIPPED'; result.reason = 'Capital occupied by an earlier trade'; day.skipped++; continue; }
      if (balance <= 0) { result.status = 'SKIPPED'; result.reason = 'No capital available'; day.skipped++; continue; }
      try {
        const entry = trade.target1ObservedPrice;
        if (entry === null || !Number.isFinite(entry) || entry <= 0 || !['BUY', 'SELL'].includes(trade.side)) throw new Error('Recorded Target 1 entry price is unavailable');
        const unit = await broker.margin(trade, 1);
        if (!Number.isFinite(unit) || unit <= 0) throw new Error('Stock margin unavailable');
        // Find the largest whole-share position that fits margin PLUS entry fees.
        let low = 1, high = Math.floor(balance / unit), best: { quantity: number; margin: number; fees: OrderCharges } | undefined;
        if (!Number.isSafeInteger(high)) throw new Error('Invalid stock margin');
        let quantity = high;
        while (low <= high) {
          const margin = quantity === 1 ? unit : await broker.margin(trade, quantity);
          const fees = validCharges(await broker.charges(trade, quantity, false));
          if (!Number.isFinite(margin) || margin <= 0) throw new Error('Stock margin unavailable');
          if (margin + fees.total <= balance) { best = { quantity, margin, fees }; low = quantity + 1; }
          else high = quantity - 1;
          quantity = Math.floor((low + high) / 2);
        }
        if (!best) { result.status = 'SKIPPED'; result.reason = 'Insufficient capital for one share including charges'; day.skipped++; continue; }
        const exitAt = trade.completedAt ? Date.parse(trade.completedAt) : null;
        if (exitAt !== null && (!Number.isFinite(exitAt) || exitAt < Date.parse(trade.target1At))) throw new Error('Exit time is invalid');
        const closesToday = exitAt !== null && capitalDate(trade.completedAt!) === date;
        const exit = trade.exitPrice;
        if (closesToday && (exit === null || !Number.isFinite(exit) || exit <= 0)) throw new Error('Recorded exit price is unavailable');
        const exitFees = closesToday ? validCharges(await broker.charges(trade, best.quantity, true)) : null;
        const gross = closesToday ? round((exit! - entry) * best.quantity * (trade.side === 'SELL' ? -1 : 1)) : null;
        const charges = round(best.fees.total + (exitFees?.total ?? 0));
        const net = gross === null ? null : round(gross - charges);
        Object.assign(result, { status: closesToday ? 'CLOSED' : 'OPEN', quantity: best.quantity, marginUsed: round(best.margin), leverage: entry * best.quantity / best.margin,
          entryCharges: round(best.fees.total), exitCharges: exitFees ? round(exitFees.total) : null, brokerage: round(best.fees.brokerage + (exitFees?.brokerage ?? 0)), charges, grossPnl: gross, netPnl: net });
        day.traded++; day.charges = round(day.charges + charges);
        if (net !== null) {
          balance = round(balance + net); result.capitalAfter = balance; busyUntil = exitAt!;
          day.grossProfit = round(day.grossProfit + Math.max(0, gross!)); day.grossLoss = round(day.grossLoss + Math.max(0, -gross!));
        } else { balance = round(balance - charges); busyUntil = Infinity; day.open++; day.complete = false; result.reason = 'No same-day exit recorded; entry charges only'; }
      } catch (error) {
        unavailable = true; day.complete = false;
        result.reason = error instanceof Error && /Recorded|Exit time/.test(error.message) ? error.message : 'Broker margin or charges unavailable; calculation paused for this day';
      }
    }
    day.netPnl = round(day.grossProfit - day.grossLoss - day.charges);
    day.closingBalance = unavailable || day.open ? null : balance;
    days.push(day);
  }
  return { rows, days: days.reverse() };
}
