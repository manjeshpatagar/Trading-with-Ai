export type LedgerTrade = { id: string; status: string; side: string; symbol: string; quantity: number; entryPrice: number | null; exitPrice: number | null; entryTime: Date | null; exitTime: Date | null; pnl: number; netPnl: number | null; riskAmount?: number | null; configurationSnapshot?: string | null; entryMode?: string | null };

/** Only finalized fills contribute to realized performance. Signal hits are not fills. */
export function summarizeLedger(input: LedgerTrade[], startingEquity: number) {
  const closed = input.filter(trade => trade.status.startsWith('CLOSED') && trade.entryTime && trade.exitTime && trade.entryPrice && trade.exitPrice && trade.quantity > 0)
    .sort((a, b) => a.exitTime!.getTime() - b.exitTime!.getTime() || a.id.localeCompare(b.id));
  const value = (trade: LedgerTrade) => trade.netPnl ?? trade.pnl;
  const winners = closed.filter(trade => value(trade) > 0), losers = closed.filter(trade => value(trade) < 0);
  const sum = (rows: LedgerTrade[]) => rows.reduce((total, row) => total + value(row), 0);
  let equity = startingEquity, peak = equity, maxDrawdown = 0, maxDrawdownPercent = 0, consecutive = 0, maxConsecutiveLosses = 0;
  for (const trade of closed) {
    equity += value(trade); peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (peak > 0) maxDrawdownPercent = Math.max(maxDrawdownPercent, (peak - equity) / peak * 100);
    consecutive = value(trade) < 0 ? consecutive + 1 : 0;
    maxConsecutiveLosses = Math.max(maxConsecutiveLosses, consecutive);
  }
  const group = (key: (trade: LedgerTrade) => string) => {
    const result: Record<string, { trades: number; netPnl: number; winners: number }> = {};
    for (const trade of closed) { const bucket = result[key(trade)] ??= { trades: 0, netPnl: 0, winners: 0 }; bucket.trades++; bucket.netPnl += value(trade); if (value(trade) > 0) bucket.winners++; }
    return result;
  };
  const snapshot = (trade: LedgerTrade) => { try { return JSON.parse(trade.configurationSnapshot ?? '{}'); } catch { return {}; } };
  const riskTrades = closed.filter(trade => Number.isFinite(trade.riskAmount) && Number(trade.riskAmount) > 0);
  return { triggeredEntries: input.filter(trade => trade.entryTime && trade.quantity > 0).length,
    runningTrades: input.filter(trade => trade.status === 'OPEN').length, completedTrades: closed.length,
    winners: winners.length, losers: losers.length, breakeven: closed.length - winners.length - losers.length,
    netPnl: sum(closed), winRate: closed.length ? winners.length / closed.length * 100 : null,
    profitFactor: losers.length ? sum(winners) / Math.abs(sum(losers)) : null,
    expectancy: closed.length ? sum(closed) / closed.length : null,
    averageWin: winners.length ? sum(winners) / winners.length : null,
    averageLoss: losers.length ? Math.abs(sum(losers)) / losers.length : null,
    maxDrawdown, maxDrawdownPercent, maxConsecutiveLosses, consecutiveLosses: consecutive,
    averageHoldingMinutes: closed.length ? closed.reduce((total, trade) => total + (trade.exitTime!.getTime() - trade.entryTime!.getTime()) / 60000, 0) / closed.length : null,
    averageR: riskTrades.length ? riskTrades.reduce((total, trade) => total + value(trade) / trade.riskAmount!, 0) / riskTrades.length : null,
    legacyTradesWithoutNetCharges: closed.filter(trade => trade.netPnl === null).length,
    byStrategy: group(trade => snapshot(trade).setup?.strategyName ?? 'Legacy / Unversioned'),
    byRegime: group(trade => snapshot(trade).setup?.marketRegime?.regime ?? 'Unknown'),
    bySymbol: group(trade => trade.symbol), byDirection: group(trade => trade.side), byEntryMode: group(trade => trade.entryMode ?? 'Legacy / Unknown') };
}
