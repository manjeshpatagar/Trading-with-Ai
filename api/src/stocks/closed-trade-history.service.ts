import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

type Query = { start?: string; end?: string; side?: string; reason?: string; page?: string; pageSize?: string; sort?: string; sortBy?: string; export?: string };
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const rate = (name: string, fallback: number) => { const value = Number(process.env[name]); return Number.isFinite(value) && value >= 0 ? value : fallback; };
export const istDate = (value: Date) => new Date(value.getTime() + 330 * 60_000).toISOString().slice(0, 10);
export function istRange(start: string, end: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) throw new Error('Invalid date range');
  const from = new Date(`${start}T00:00:00+05:30`), to = new Date(`${end}T00:00:00+05:30`); to.setUTCDate(to.getUTCDate() + 1); return { from, to };
}
export function namedIstRange(preset: string, at = new Date()) {
  const today = istDate(at), date = new Date(`${today}T00:00:00+05:30`), add = (days: number) => { const copy = new Date(date); copy.setUTCDate(copy.getUTCDate() + days); return istDate(copy); }, weekday = (new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7;
  if (preset === 'today') return { start: today, end: today }; if (preset === 'yesterday') return { start: add(-1), end: add(-1) }; if (preset === 'this-week') return { start: add(-weekday), end: today }; if (preset === 'last-week') return { start: add(-weekday - 7), end: add(-weekday - 1) }; if (preset === 'last-7-days') return { start: add(-6), end: today }; if (preset === 'last-14-days') return { start: add(-13), end: today }; if (preset === 'this-month') return { start: `${today.slice(0, 8)}01`, end: today };
  if (preset === 'last-month') { const first = new Date(`${today.slice(0, 8)}01T00:00:00+05:30`); first.setUTCDate(first.getUTCDate() - 1); const end = istDate(first); return { start: `${end.slice(0, 8)}01`, end }; } throw new Error('Unknown date preset');
}
export function estimateCharges(entryPrice: number, exitPrice: number, quantity: number, side: string = 'BUY') {
  const entryTurnover = entryPrice * quantity, exitTurnover = exitPrice * quantity;
  const buy = side === 'SELL' ? exitTurnover : entryTurnover, sell = side === 'SELL' ? entryTurnover : exitTurnover, turnover = buy + sell, brokerRate = rate('EQUITY_INTRADAY_BROKERAGE_RATE', .001), cap = rate('EQUITY_INTRADAY_BROKERAGE_CAP', 20);
  const entryBrokerage = Math.min(cap, entryTurnover * brokerRate), exitBrokerage = Math.min(cap, exitTurnover * brokerRate), brokerage = entryBrokerage + exitBrokerage;
  const stt = sell * rate('EQUITY_INTRADAY_STT_RATE', .00025), transaction = turnover * rate('NSE_EQUITY_TRANSACTION_RATE', .0000173), sebi = turnover * rate('SEBI_TURNOVER_RATE', .000001), stamp = buy * rate('EQUITY_INTRADAY_STAMP_RATE', .00003), gst = (brokerage + transaction + sebi) * rate('TRADING_GST_RATE', .18), other = stt + transaction + sebi + stamp + gst;
  return { entryBrokerage: round(entryBrokerage), exitBrokerage: round(exitBrokerage), brokerage: round(brokerage), otherCharges: round(other), totalCharges: round(brokerage + other) };
}
@Injectable()
export class ClosedTradeHistoryService {
  constructor(private readonly prisma: PrismaService) {}
  async report(userId: string, query: Query) {
    try {
      const today = istDate(new Date()), start = query.start ?? today, end = query.end ?? today, { from, to } = istRange(start, end), side = ['BUY', 'SELL'].includes(query.side ?? '') ? query.side : undefined, reason = query.reason?.toUpperCase();
      const page = Math.max(1, Number(query.page) || 1), pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 25));
      const [stored, ledger, account] = await Promise.all([
        this.prisma.paperOrder.findMany({ where: { userId, portfolio: 'STRATEGY', status: { startsWith: 'CLOSED' }, exitTime: { gte: from, lt: to }, ...(side ? { side } : {}) }, orderBy: { exitTime: query.sort === 'asc' ? 'asc' : 'desc' } }),
        this.prisma.paperOrder.findMany({ where: { userId, portfolio: 'STRATEGY', status: { startsWith: 'CLOSED' }, exitTime: { lt: to } }, orderBy: { exitTime: 'asc' } }),
        this.prisma.paperTradingAccount.findUnique({ where: { userId_portfolio: { userId, portfolio: 'STRATEGY' } } }),
      ]);
      const source = stored.filter(row => row.entryTime && row.exitTime && row.entryPrice && row.exitPrice && (!reason || (reason === 'COMPLETED' ? !/STOP|MANUAL/i.test(row.exitReason ?? '') : reason === 'STOPLOSS' ? /STOP/i.test(row.exitReason ?? '') : /MANUAL/i.test(row.exitReason ?? ''))));
      const rows = source.map(order => {
        const entry = Number(order.entryPrice), exit = Number(order.exitPrice), grossPnl = order.grossPnl ?? (order.side === 'BUY' ? exit - entry : entry - exit) * order.quantity, estimated = estimateCharges(entry, exit, order.quantity, order.side), entryBrokerage = order.entryBrokerage ?? estimated.entryBrokerage, exitBrokerage = order.exitBrokerage ?? estimated.exitBrokerage, brokerage = entryBrokerage + exitBrokerage, otherCharges = order.otherCharges ?? estimated.otherCharges, totalCharges = order.totalCharges ?? brokerage + otherCharges, netPnl = order.netPnl ?? grossPnl - totalCharges, marginUsed = Number(order.budget);
        return { id: order.id, entryTime: order.entryTime!.toISOString(), exitTime: order.exitTime!.toISOString(), symbol: order.symbol, side: order.side, entryPrice: entry, exitPrice: exit, quantity: order.quantity, marginUsed, grossPnl, entryBrokerage, exitBrokerage, brokerage, otherCharges, totalCharges, netPnl, netPnlPercent: marginUsed ? netPnl / marginUsed * 100 : 0, exitReason: order.exitReason ?? 'COMPLETED', durationMinutes: order.durationMinutes ?? Math.floor((order.exitTime!.getTime() - order.entryTime!.getTime()) / 60000), chargesSource: order.chargesSource ?? 'ESTIMATED_CURRENT_RULES' };
      });
      const ledgerNet = (order: typeof ledger[number]) => {
        if (!order.entryPrice || !order.exitPrice || !order.entryTime || !order.exitTime) return 0;
        const entry = Number(order.entryPrice), exit = Number(order.exitPrice);
        const gross = order.grossPnl ?? (order.side === 'BUY' ? exit - entry : entry - exit) * order.quantity;
        const estimated = estimateCharges(entry, exit, order.quantity, order.side);
        const totalCharges = order.totalCharges ?? (order.entryBrokerage ?? estimated.entryBrokerage) + (order.exitBrokerage ?? estimated.exitBrokerage) + (order.otherCharges ?? estimated.otherCharges);
        return order.netPnl ?? gross - totalCharges;
      };
      const openingBalance = Number(account?.startingBalance ?? 10_000) + ledger.filter(order => order.exitTime && order.exitTime < from).reduce((total, order) => total + ledgerNet(order), 0);
      const periodLedger = ledger.filter(order => order.exitTime && order.exitTime >= from && order.exitTime < to);
      const closingBalance = openingBalance + periodLedger.reduce((total, order) => total + ledgerNet(order), 0);
      const sortBy = ['entryTime', 'exitTime', 'symbol', 'grossPnl', 'netPnl', 'durationMinutes'].includes(query.sortBy ?? '') ? query.sortBy! : 'exitTime';
      const direction = query.sort === 'asc' ? 1 : -1;
      rows.sort((left, right) => { const a = left[sortBy as keyof typeof left], b = right[sortBy as keyof typeof right]; return (typeof a === 'string' ? String(a).localeCompare(String(b)) : Number(a) - Number(b)) * direction; });
      const sum = (items: typeof rows, key: keyof typeof rows[number]) => items.reduce((total, row) => total + Number(row[key] ?? 0), 0), wins = rows.filter(row => row.netPnl > 0), losses = rows.filter(row => row.netPnl < 0);
      const dates: string[] = []; for (let day = new Date(from); day < to; day.setUTCDate(day.getUTCDate() + 1)) dates.push(istDate(day));
      let runningBalance = openingBalance;
      const daily = dates.map(date => { const items = rows.filter(row => istDate(new Date(row.exitTime)) === date), dayWins = items.filter(row => row.netPnl > 0), dayOpeningBalance = runningBalance, accountDayNet = periodLedger.filter(order => order.exitTime && istDate(order.exitTime) === date).reduce((total, order) => total + ledgerNet(order), 0); runningBalance += accountDayNet; return { date, openingBalance: dayOpeningBalance, closingBalance: runningBalance, totalTrades: items.length, wins: dayWins.length, losses: items.filter(row => row.netPnl < 0).length, grossProfit: sum(items.filter(row => row.grossPnl > 0), 'grossPnl'), grossLoss: Math.abs(sum(items.filter(row => row.grossPnl < 0), 'grossPnl')), brokerage: sum(items, 'brokerage'), otherCharges: sum(items, 'otherCharges'), totalCharges: sum(items, 'totalCharges'), netPnl: sum(items, 'netPnl'), winRate: items.length ? dayWins.length / items.length * 100 : 0 }; });
      const total = rows.length;
      return { range: { start, end }, summary: { openingBalance, closingBalance, totalTrades: total, winningTrades: wins.length, losingTrades: losses.length, breakevenTrades: rows.filter(row => row.netPnl === 0).length, grossProfit: sum(rows.filter(row => row.grossPnl > 0), 'grossPnl'), grossLoss: Math.abs(sum(rows.filter(row => row.grossPnl < 0), 'grossPnl')), brokerage: sum(rows, 'brokerage'), otherCharges: sum(rows, 'otherCharges'), totalCharges: sum(rows, 'totalCharges'), netPnl: sum(rows, 'netPnl'), winRate: total ? wins.length / total * 100 : 0, averageProfit: wins.length ? sum(wins, 'netPnl') / wins.length : 0, averageLoss: losses.length ? Math.abs(sum(losses, 'netPnl') / losses.length) : 0, totalMarginUsed: sum(rows, 'marginUsed') }, daily, rows: rows.slice((page - 1) * pageSize, page * pageSize), allRows: query.export === 'true' ? rows : [], pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) } };
    } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'Invalid history query'); }
  }
}
