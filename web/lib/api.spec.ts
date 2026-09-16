import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { api } from './api';

test('API errors show the message without exposing JSON or server stack traces', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ statusCode: 503, message: 'Instrument list temporarily unavailable.', stack: 'private server stack' }), { status: 503 }));
  await assert.rejects(api('/top-buy'), error => error instanceof Error && error.message === 'Instrument list temporarily unavailable.');
});

test('network failures get a readable connection message', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(api('/dashboard'), /Cannot connect to the trading service/);
});

test('cancellation is preserved so stale requests cannot overwrite live updates', async (t) => {
  const controller = new AbortController();
  controller.abort();
  t.mock.method(globalThis, 'fetch', async () => { throw controller.signal.reason; });
  await assert.rejects(api('/signal-history', { signal: controller.signal }), error => error === controller.signal.reason);
});
