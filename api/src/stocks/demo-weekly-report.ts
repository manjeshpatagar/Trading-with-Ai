import type { AiSignal, PaperOrder } from '@prisma/client';
import { strategyWeekRange } from './strategy-weekly';

type LinkedSignal = Pick<AiSignal, 'id' | 'stockName' | 'target1' | 'target2' | 'target3' | 'target1At' | 'target1HitAt' | 'target1ExecutedPrice'>;
export function demoWeeklyReport(orders: PaperOrder[], signals: LinkedSignal[], at = new Date()) {
  const { start, end } = strategyWeekRange(at);
  const linked = new Map(signals.map(signal => [signal.id, signal]));
  const seen = new Set<string>();
  const rows = orders.flatMap(order => {
    if (seen.has(order.id) || order.portfolio !== 'SIGNAL_HISTORY' || !order.entryTime || order.entryTime < start || order.entryTime >= end || order.entryTime > at || (order.status !== 'OPEN' && !order.status.startsWith('CLOSED'))) return [];
    seen.add(order.id);
    const signal = order.signalId ? linked.get(order.signalId) : undefined;
    const targetAt = signal?.target1At ?? signal?.target1HitAt;
    const target1At = targetAt && targetAt <= at ? targetAt : null;
    const completed = Boolean(order.status.startsWith('CLOSED') && order.exitTime && order.exitTime >= order.entryTime && order.exitTime <= at);
    const validPnl = Number.isFinite(order.pnl);
    const outcome = !completed ? order.status === 'OPEN' ? 'RUNNING' : 'UNKNOWN' : !validPnl ? 'UNKNOWN' : order.pnl > 0 ? 'WIN' : order.pnl < 0 ? 'LOSS' : 'BREAKEVEN';
    const stopped = completed && /STOP|SL_HIT/i.test(order.exitReason ?? '');
    return [{
      id: order.id, instrumentKey: order.instrumentKey, symbol: order.symbol, stockName: signal?.stockName ?? order.symbol,
      side: order.side, entryPrice: order.entryPrice, entryAt: order.entryTime.toISOString(), quantity: order.quantity,
      currentPrice: order.currentPrice, priceUpdatedAt: order.updatedAt.toISOString(),
      target1Price: signal?.target1 ?? null, target2: signal?.target2 ?? null, target3: signal?.target3 ?? null,
      demoTarget: order.target, stopLossLevel: order.stopLoss, target1At: target1At?.toISOString() ?? null, target1ObservedPrice: signal?.target1ExecutedPrice ?? null,
      stopLossAt: stopped ? order.exitTime!.toISOString() : null, stopLossHitPrice: stopped ? order.exitPrice : null,
      completedAt: completed ? order.exitTime!.toISOString() : null, exitPrice: completed ? order.exitPrice : null,
      exitReason: completed ? order.exitReason : null, outcome,
      profitAmount: validPnl && outcome !== 'UNKNOWN' ? order.pnl : null, profitPercent: validPnl && outcome !== 'UNKNOWN' && Number.isFinite(order.pnlPercent) ? order.pnlPercent : null,
      minutesAfterTarget1: completed && target1At && order.exitTime! >= target1At ? (order.exitTime!.getTime() - target1At.getTime()) / 60_000 : null,
      durationMinutes: completed ? (order.exitTime!.getTime() - order.entryTime.getTime()) / 60_000 : null,
    }];
  }).sort((a, b) => b.entryAt.localeCompare(a.entryAt));
  const summarize = (items: typeof rows) => ({
    trades: items.length, reachedTarget1: items.filter(row => row.target1At).length, stocks: new Set(items.map(row => row.instrumentKey)).size,
    stopLossHits: items.filter(row => row.stopLossAt).length, completed: items.filter(row => row.completedAt).length,
    wins: items.filter(row => row.outcome === 'WIN').length, losses: items.filter(row => row.outcome === 'LOSS').length,
    breakeven: items.filter(row => row.outcome === 'BREAKEVEN').length, running: items.filter(row => row.outcome === 'RUNNING').length,
    unknown: items.filter(row => row.outcome === 'UNKNOWN').length,
    realizedProfit: items.filter(row => row.outcome === 'WIN').reduce((sum, row) => sum + row.profitAmount!, 0),
    realizedLoss: items.filter(row => row.outcome === 'LOSS').reduce((sum, row) => sum + Math.abs(row.profitAmount!), 0),
    realizedPnl: items.filter(row => row.completedAt).reduce((sum, row) => sum + (row.profitAmount ?? 0), 0),
    unrealizedPnl: items.filter(row => row.outcome === 'RUNNING').reduce((sum, row) => sum + (row.profitAmount ?? 0), 0),
  });
  const dayKey = (value: string | Date) => new Date(new Date(value).getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = dayKey(new Date(end.getTime() - (index + 1) * 86_400_000));
    const entries = rows.filter(row => dayKey(row.entryAt) === date);
    return { date, rows: entries, summary: summarize(entries) };
  });
  return { generatedAt: at.toISOString(), timezone: 'Asia/Kolkata', basis: 'DEMO_EXECUTION', rows, summary: summarize(rows), days };
}
