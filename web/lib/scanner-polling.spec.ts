import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { environmentManager, QueryClient, QueryObserver } from '@tanstack/query-core';
import { startScannerPolling } from './scanner-polling';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test('refreshes at 30, 60 and 90 seconds despite live prices every second', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  environmentManager.setIsServer(() => false);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  let requests = 0;
  const key = ['trade-strategy-scan'];
  const observer = new QueryObserver(client, {
    queryKey: key,
    queryFn: async () => ({ price: 100, pass: ++requests }),
  });
  const unsubscribe = observer.subscribe(() => {});
  const stop = startScannerPolling(() => client.refetchQueries({ queryKey: key }, { cancelRefetch: false }));
  try {
    await flush();
    assert.equal(requests, 1);
    for (let second = 1; second <= 90; second++) {
      client.setQueryData(key, (data: any) => ({ ...data, price: 100 + second }));
      t.mock.timers.tick(1000);
      await flush();
      assert.equal(requests, 1 + Math.floor(second / 30), `requests after ${second} seconds`);
    }
    stop();
    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(requests, 4, 'unmounted scanner no longer polls');
  } finally {
    stop();
    unsubscribe();
    client.clear();
    environmentManager.setIsServer(() => true);
  }
});

test('slow scans do not overlap and a failed scan is retried on the next cycle', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  let fail!: (error: Error) => void;
  const stop = startScannerPolling(() => {
    calls++;
    return calls === 1 ? new Promise<void>((_resolve, reject) => { fail = reject; }) : Promise.resolve();
  });
  try {
    t.mock.timers.tick(30_000);
    await flush();
    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(calls, 1);
    fail(new Error('Temporary network failure'));
    await flush();
    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(calls, 2);
    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(calls, 3);
  } finally {
    stop();
  }
});
