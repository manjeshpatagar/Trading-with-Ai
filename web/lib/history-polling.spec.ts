import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import { startHistoryPolling } from './history-polling';

test('frequent price cache writes cannot postpone status/exit polling; requests do not overlap', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const client = new QueryClient();
  let calls = 0;
  let release!: () => void;
  const stop = startHistoryPolling(() => { calls++; return new Promise<void>(resolve => { release = resolve; }); });
  try {
    for (let i = 0; i < 10; i++) {
      client.setQueryData(['ai-signal-history'], { currentPrice: i });
      client.setQueryData(['signal-history-demo'], { currentPrice: i });
      t.mock.timers.tick(500);
      await Promise.resolve();
    }
    assert.equal(calls, 1);
    t.mock.timers.tick(5000);
    await Promise.resolve();
    assert.equal(calls, 1);
    release();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    t.mock.timers.tick(5000);
    await Promise.resolve();
    assert.equal(calls, 2);
    release();
    stop();
    t.mock.timers.tick(10000);
    assert.equal(calls, 2);
  } finally { stop(); client.clear(); }
});
