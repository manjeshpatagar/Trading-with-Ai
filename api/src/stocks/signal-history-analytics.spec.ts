import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { SignalHistoryService } from './signal-history.service';

const trade = (id: string, status: string, types: string[], profitPercent: number | null = null) => ({
  id,
  status,
  confidence: 96,
  profitPercent,
  events: types.map((type) => ({ type })),
});

test('builds event-ledger progression and stop-loss cohorts with filterable signal ids', () => {
  const service = new SignalHistoryService({} as never, {} as never, {} as never);
  const analytics = (service as any).tradeProgressAnalytics([
    trade('winner', 'COMPLETED', ['SIGNAL_GENERATED', 'ENTRY_TRIGGERED', 'RUNNING', 'TARGET1_HIT', 'TARGET2_HIT', 'TARGET3_HIT', 'COMPLETED'], 4),
    trade('stopped-after-t1', 'STOPLOSS_CONFIRMED', ['SIGNAL_GENERATED', 'ENTRY_TRIGGERED', 'RUNNING', 'TARGET1_HIT', 'STOPLOSS_CONFIRMED', 'COMPLETED'], -1),
    trade('active', 'RUNNING', ['SIGNAL_GENERATED', 'ENTRY_TRIGGERED', 'RUNNING']),
  ]);

  const section = (key: string) => analytics.sections.find((item: any) => item.key === key);
  const metric = (sectionKey: string, metricKey: string) => section(sectionKey).metrics.find((item: any) => item.key === metricKey);

  assert.equal(metric('flow', 'flow_running').count, 3);
  assert.deepEqual(metric('target1', 'target1_stoploss').signalIds, ['stopped-after-t1']);
  assert.deepEqual(metric('target2', 'target2_target3').signalIds, ['winner']);
  assert.deepEqual(metric('wins', 'win_target3').signalIds, ['winner']);
  assert.deepEqual(metric('running', 'running_active').signalIds, ['active']);
  assert.deepEqual(analytics.qualities.find((item: any) => item.key === 'quality_elite').signalIds, ['winner']);
  assert.equal(analytics.conversions.find((item: any) => item.key === 'target2_target3').percentage, 100);
  assert.ok(analytics.health.find((item: any) => item.key === 'health_score').value >= 0);
});

test('ranks completed trades by entry hour and identifies best, worst, profitable, and active hours', () => {
  const service = new SignalHistoryService({} as never, {} as never, {} as never);
  const completed = (at: string, profitPercent: number) => ({ signalTime: new Date(at), entryTriggeredAt: new Date(at), profitPercent });
  const result = (service as any).bestTradingHours([
    completed('2026-08-04T03:50:00.000Z', 2),
    completed('2026-08-04T04:00:00.000Z', 1),
    completed('2026-08-04T04:40:00.000Z', -1),
    completed('2026-08-04T05:40:00.000Z', 4),
  ]);

  assert.equal(result.bestHour, '11:00-12:00');
  assert.equal(result.worstHour, '10:00-11:00');
  assert.equal(result.mostProfitableHour, '11:00-12:00');
  assert.equal(result.mostActiveHour, '09:15-10:00');
  assert.equal(result.hours.reduce((sum: number, hour: any) => sum + hour.signals, 0), 4);
});

test('loss reason categories and details exactly reconcile to losing trade total', () => {
  const service = new SignalHistoryService({} as never, {} as never, {} as never);
  const loss = (id: string, types: string[]) => ({ id, symbol: id, stockName: id, side: 'BUY', entryPrice: 100, exitPrice: 99, profitPercent: -1, holdingMinutes: 12, confidence: 90, aiScore: 80, strategy: 'Momentum', signalTime: new Date('2026-08-04T04:00:00.000Z'), entryTriggeredAt: new Date('2026-08-04T04:05:00.000Z'), completedAt: new Date('2026-08-04T04:17:00.000Z'), events: types.map((type) => ({ type })) });
  const result = (service as any).losingTradeBreakdown([
    loss('stop', ['STOPLOSS_CONFIRMED']),
    loss('trail', ['TRAILING_STOP_ACTIVE', 'STOPLOSS_CONFIRMED']),
    loss('manual', ['MANUAL_EXIT']),
    loss('close', ['MARKET_CLOSE']),
    loss('reverse', ['REVERSE_SIGNAL_EXIT']),
  ]);

  assert.equal(result.total, 5);
  assert.equal(result.trades.length, 5);
  assert.equal(result.categories.reduce((sum: number, item: any) => sum + item.count, 0), result.total);
  assert.deepEqual(new Set(result.categories.map((item: any) => item.reason)), new Set(['Stop Loss Hit', 'Trailing Stop Loss', 'Manual Exit Loss', 'Market Close Exit', 'Reverse Signal Exit']));
});

test('dashboard market window is limited to 09:15 through 15:30 IST', () => {
  const service = new SignalHistoryService({} as never, {} as never, {} as never);
  const range = (service as any).dashboardTradingRange(new Date('2026-08-04T12:00:00.000Z'));
  assert.equal(range.start.toISOString(), '2026-08-04T03:45:00.000Z');
  assert.equal(range.end.toISOString(), '2026-08-04T10:00:00.000Z');
});
