import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { PaperTradingService } from './paper-trading.service';
import { PaperOrderExecutionService } from './paper-order-execution.service';
import { ScannerService } from './scanner.service';
import { StocksController } from './stocks.controller';

test('a feed burst shares open-order reads and skips account queries for unowned instruments', async () => {
  let reads = 0;
  let release!: (orders: any[]) => void;
  const service = new PaperTradingService({ paperOrder: { findMany: () => {
    reads++;
    return new Promise(resolve => { release = resolve; });
  } } } as never, new PaperOrderExecutionService());
  const ticks = Array.from({ length: 100 }, (_, i) => service.processTick('u', `stock-${i}`, 100));
  assert.equal(reads, 1);
  release([]);
  assert.deepEqual(await Promise.all(ticks), Array(100).fill(false));
  const next = service.processTick('u', 'stock-0', 101);
  assert.equal(reads, 2, 'the next read must see newly created positions');
  release([]);
  await next;
});

test('dashboard reads saved setups while the first full scan is pending', async () => {
  const controller = new StocksController(
    { userFromSession: () => 'u' } as never, {} as never, {} as never, {} as never, {} as never,
    { latestReport: () => null, scanReport: () => { throw new Error('must not wait for scan'); } } as never,
    { executedStrategySignals: async () => [], todayStrategySignals: async () => ({ todayBuy: [{ symbol: 'SAVED' }], todaySell: [] }) } as never,
    {} as never, {} as never, {} as never,
  );
  const result = await controller.dashboard('Bearer local');
  assert.equal(result.todayBuy[0].symbol, 'SAVED');
  assert.equal(result.scanCompletedAt, null);
});

test('scanner snapshot does not launch a scan or reuse yesterday results', () => {
  const scanner = new ScannerService(...Array(10).fill({}) as [any, any, any, any, any, any, any, any, any, any]);
  assert.equal(scanner.latestReport('u'), null);
  const reports = (scanner as any).reports;
  reports.set('u', { rows: [], completedAt: new Date(Date.now() - 86_400_000).toISOString(), coverage: {} });
  assert.equal(scanner.latestReport('u'), null);
  reports.set('u', { rows: [], completedAt: new Date().toISOString(), coverage: {} });
  assert.ok(scanner.latestReport('u'));
});
