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
  const service = new SignalHistoryService({} as never, {} as never);
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
