import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { selectStrategyRows } from './strategy-list';
import { SignalHistoryService } from './signal-history.service';

test('published membership uses exact decorated signal IDs, including completed rows occupying page slots', async () => {
  const rows = Array.from({ length: 11 }, (_, index) => ({ tradeId: `id-${index}`, instrumentKey: `key-${index}`, signal: 'SELL', price: 100, aiScore: 100 - index, target1At: index < 10 ? '2026-09-10T05:00:00Z|Trigger ₹100' : null }));
  const operations: any[] = [];
  const captured: string[] = [];
  const prisma: any = { aiStrategyResult: { upsert: async ({ create }: any) => { captured.push(create.tradeId); return create; } }, aiSignal: { updateMany: (operation: any) => { operations.push(operation); return Promise.resolve({ count: 1 }); } }, $transaction: async (items: any[]) => Promise.all(items) };
  const service = new SignalHistoryService(prisma, {} as never);
  (service as any).decorate = async () => rows;
  const published = await service.publishStrategyList('user-1', []);
  assert.deepEqual(published.topSell.map(row => row.tradeId), rows.slice(0, 10).map(row => row.tradeId));
  assert.ok(operations[0].where.signalTime.gte instanceof Date, 'list replacement must preserve previous daily queues');
  assert.equal(operations[0].where.signalTime.lt.getTime() - operations[0].where.signalTime.gte.getTime(), 86_400_000);
  assert.deepEqual(operations[0].where.id.notIn, rows.slice(0, 10).map(row => row.tradeId));
  assert.ok(!operations.some(operation => operation.where.id === 'id-10'));
  assert.equal(operations[1].where.aiStrategyListedAt, null, 'first listing timestamp must survive removal and re-listing');
  assert.deepEqual(captured, rows.slice(0, 10).map(row => row.tradeId));
});

test('selection filters price before taking ten and uses canonical side and score without promoting already-hit signals', () => {
  const rows = [{ signal: 'BUY', price: 20, aiScore: 100 }, { signal: 'SELL', price: 100, aiScore: 100 }, { signal: 'BUY', price: 100, aiScore: 90 }, { signal: 'BUY', price: 100, aiScore: 60, target1At: '2026-09-10T05:00:00Z|Trigger ₹100' }];
  assert.deepEqual(selectStrategyRows(rows, 'BUY'), [rows[2], rows[3]]);
});

 test('a Target 1 hit cannot promote an unlisted stock into the top ten', () => {
  const rows = Array.from({ length: 11 }, (_, index) => ({ signal: 'BUY', price: 100, aiScore: 100 - index, target1At: null as string | null }));
  const before = selectStrategyRows(rows, 'BUY');
  rows[10].target1At = new Date().toISOString();
  assert.deepEqual(selectStrategyRows(rows, 'BUY'), before);
});
