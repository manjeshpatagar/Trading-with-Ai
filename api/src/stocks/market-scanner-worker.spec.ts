import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { marketClock } from './market-clock';
import { MarketScannerWorkerService } from './market-scanner-worker.service';
import { ScannerService } from './scanner.service';

const at = (time: string) => new Date(`2026-09-15T${time}+05:30`);

test('scans throughout market hours including opening protection and after entry cutoff', () => {
  for (const time of ['09:15:00', '09:24:00', '15:16:00', '15:29:59']) assert.equal(marketClock(at(time)).canScan, true);
  for (const time of ['09:14:59', '15:30:00']) assert.equal(marketClock(at(time)).canScan, false);
  assert.equal(marketClock(new Date('2026-09-19T10:00:00+05:30')).canScan, false);
});

test('worker retries failed users and lookup failures without requiring demo accounts', async () => {
  let lookups = 0;
  const calls: string[] = [];
  const worker = new MarketScannerWorkerService({ token: { findMany: async () => {
    if (++lookups === 1) throw new Error('temporary database failure');
    return [{ userId: 'a' }, { userId: 'b' }];
  } } } as any, { scan: async (user: string, force: boolean) => { assert.equal(force, true, 'scheduled scans bypass cached results'); calls.push(user); if (calls.length === 1) throw new Error('temporary provider failure'); return [{}]; } } as any);
  await worker.monitor(at('09:00:00'));
  assert.equal(lookups, 0);
  await worker.monitor(at('10:00:00'));
  await worker.monitor(at('10:00:30'));
  await worker.monitor(at('10:01:00'));
  assert.deepEqual(calls, ['a', 'b', 'a', 'b']);
});

test('worker skips overlapping scans and resumes after completion', async () => {
  let release!: () => void;
  let calls = 0;
  const worker = new MarketScannerWorkerService({ token: { findMany: async () => [{ userId: 'a' }] } } as any,
    { scan: async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); return [{}]; } } as any);
  const first = worker.monitor(at('10:00:00'));
  await new Promise(resolve => setImmediate(resolve));
  await worker.monitor(at('10:00:30'));
  assert.equal(calls, 1);
  release();
  await first;
  const next = worker.monitor(at('10:01:00'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  release();
  await next;
});

test('worker remains running between passes and reports missing heartbeat and market close honestly', async () => {
  const worker = new MarketScannerWorkerService({ token: { findMany: async () => [{ userId: 'a' }] } } as any,
    { scan: async () => [{}] } as any);
  assert.equal(worker.status('a', at('10:00:00')).state, 'RECOVERING');
  await worker.monitor(at('10:00:00'));
  assert.equal(worker.status('a', at('10:00:23')).state, 'RUNNING');
  assert.equal(worker.status('a', at('10:00:23')).phase, 'MONITORING');
  await worker.monitor(at('10:00:30'));
  assert.equal(worker.status('a', at('10:00:53')).state, 'RUNNING');
  assert.equal(worker.status('a', at('10:02:00')).state, 'RECOVERING');
  assert.equal(worker.status('a', at('15:30:00')).state, 'CLOSED');
});

test('worker reports scan failures and empty provider data then recovers on the next pass', async () => {
  let passes = 0;
  const worker = new MarketScannerWorkerService({ token: { findMany: async () => [{ userId: 'a' }] } } as any,
    { scan: async () => { if (++passes === 1) throw new Error('network failure'); return passes === 2 ? [] : [{}]; } } as any);
  await worker.monitor(at('10:00:00'));
  assert.equal(worker.status('a', at('10:00:01')).state, 'RETRYING');
  await worker.monitor(at('10:00:30'));
  assert.equal(worker.status('a', at('10:00:31')).state, 'RETRYING');
  await worker.monitor(at('10:01:00'));
  assert.equal(worker.status('a', at('10:01:01')).state, 'RUNNING');
});

test('worker identifies a delayed scan without launching overlapping work', async () => {
  let release!: () => void;
  const worker = new MarketScannerWorkerService({ token: { findMany: async () => [{ userId: 'a' }] } } as any,
    { scan: async () => { await new Promise<void>(resolve => { release = resolve; }); return [{}]; } } as any);
  const first = worker.monitor(at('10:00:00'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.status('a', at('10:00:01')).phase, 'SCANNING');
  await worker.monitor(at('10:03:30'));
  assert.equal(worker.status('a', at('10:03:31')).state, 'DELAYED');
  release();
  await first;
  assert.equal(worker.status('a', at('10:03:32')).state, 'RUNNING');
});

test('scanner shares concurrent requests and releases failed work for retry', async () => {
  const scanner = new ScannerService(...Array(10).fill({}) as [any, any, any, any, any, any, any, any, any, any]);
  let calls = 0;
  let reject!: (error: Error) => void;
  (scanner as any).performScan = () => { calls++; return new Promise((_resolve, fail) => { reject = fail; }); };
  const first = scanner.scan('a');
  const second = scanner.scan('a', true);
  assert.equal(calls, 1);
  reject(new Error('temporary failure'));
  const results = await Promise.allSettled([first, second]);
  assert.ok(results.every(result => result.status === 'rejected'));
  (scanner as any).performScan = async () => { calls++; return []; };
  assert.deepEqual(await scanner.scan('a'), []);
  assert.equal(calls, 2);
});
