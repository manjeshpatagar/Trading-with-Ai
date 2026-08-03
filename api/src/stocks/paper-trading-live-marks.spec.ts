import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaperOrderExecutionService } from './paper-order-execution.service';
import { PaperTradingService } from './paper-trading.service';

const openOrder = (overrides: Record<string, unknown> = {}) => ({
  id: 'order-1',
  userId: 'user-1',
  signalId: 'signal-1',
  instrumentKey: 'NSE_EQ|TEST',
  symbol: 'TEST',
  status: 'OPEN',
  side: 'BUY',
  entryPrice: 100,
  entryTime: new Date('2026-08-03T03:45:00.000Z'),
  currentPrice: 100,
  quantity: 100,
  pnl: 0,
  pnlPercent: 0,
  target: 120,
  target1: 110,
  target2: 115,
  stopLoss: 90,
  ...overrides,
});

function harness(order: ReturnType<typeof openOrder>) {
  const updates: any[] = [];
  const accountUpdates: any[] = [];
  const prisma = {
    paperTradingAccount: {
      findUnique: async () => ({ enabled: true }),
      update: async (args: any) => { accountUpdates.push(args); return {}; },
    },
    paperOrder: {
      findMany: async ({ where }: any) => where.createdAt?.lt ? [] : [order],
      findUniqueOrThrow: async () => order,
      update: async (args: any) => { updates.push(args); return { ...order, ...args.data }; },
    },
    aiSignal: { findUnique: async () => ({ id: 'signal-1', target1: 110, target2: 115, stopLossDecision: null, managementDecision: null }) },
    demoTradeQueue: { findFirst: async () => null, updateMany: async () => ({ count: 0 }) },
    $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
  };
  const service = new PaperTradingService(prisma as never, new PaperOrderExecutionService());
  (service as any).drainDemoQueue = async () => false;
  return { service, updates, accountUpdates };
}

test('persists every open-position live price, P&L, market value, and duration', async () => {
  const order = openOrder();
  const { service, updates } = harness(order);
  const changed = await service.processTick('user-1', order.instrumentKey, 105, new Date('2026-08-03T04:00:00.000Z'));

  assert.equal(changed, true);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].data, {
    currentPrice: 105,
    marketValue: 10_500,
    pnl: 500,
    pnlPercent: 5,
    unrealizedPnl: 500,
    unrealizedPnlPercent: 5,
    durationMinutes: 15,
    tradeStage: 'RUNNING',
  });
});

test('closes a SELL position on the exact stop-crossing tick and realizes P&L', async () => {
  const order = openOrder({ side: 'SELL', entryPrice: 318.75, quantity: 31, stopLoss: 322.14, target1: 315, target2: 312, target: 309 });
  const { service, updates, accountUpdates } = harness(order);
  const at = new Date('2026-08-03T04:00:00.000Z');
  const changed = await service.processTick('user-1', order.instrumentKey, 324.55, at);

  assert.equal(changed, true);
  assert.equal(updates.length, 2);
  assert.equal(updates[0].data.currentPrice, 324.55);
  assert.equal(updates[1].data.status, 'CLOSED');
  assert.equal(updates[1].data.exitPrice, 324.55);
  assert.equal(updates[1].data.exitReason, 'STOP LOSS');
  assert.equal(accountUpdates.length, 1);
  assert.ok(accountUpdates[0].data.realizedPnl.increment < 0);
});
