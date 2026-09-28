import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { RealOrderStreamService } from './real-order-stream.service';

test('portfolio stream applies order updates immediately and publishes a dashboard refresh', async () => {
  const applied: any[] = [];
  const emitted: any[] = [];
  const service = new RealOrderStreamService({} as never, {} as never, {
    applyBrokerOrder: async (...args: any[]) => { applied.push(args); return true; },
    drive: async () => {},
  } as never, { server: { to: (room: string) => ({ emit: (event: string, body: unknown) => emitted.push({ room, event, body }) }) } } as never);
  const receivedAt = new Date('2026-09-21T10:00:00.250+05:30');
  await (service as any).receive('user-1', JSON.stringify({ update_type: 'order', order_id: 'one', status: 'complete', filled_quantity: 10, average_price: 101 }), receivedAt);
  assert.equal(applied.length, 1);
  assert.equal(applied[0][0], 'user-1');
  assert.equal(applied[0][2], 'STREAM');
  assert.equal(applied[0][3], receivedAt);
  assert.equal(service.status('user-1').lastMessageAt, receivedAt.toISOString());
  assert.equal(emitted.at(-1)?.event, 'real-trading-updated');
});

test('portfolio stream ignores malformed and unrelated messages', async () => {
  let calls = 0;
  const service = new RealOrderStreamService({} as never, {} as never, {
    applyBrokerOrder: async () => { calls++; }, drive: async () => { calls++; },
  } as never, { server: { to: () => ({ emit: () => {} }) } } as never);
  await (service as any).receive('user-1', 'not-json', new Date());
  await (service as any).receive('user-1', JSON.stringify({ update_type: 'holding' }), new Date());
  assert.equal(calls, 0);
});
