import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaperOrderExecutionService } from './paper-order-execution.service';
import { ExecutionEngine } from './execution-engine.service';
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
  remainingQuantity: 100,
  partialRealizedPnl: 0,
  pnl: 0,
  pnlPercent: 0,
  target: 120,
  target1: 110,
  target2: 115,
  stopLoss: 90,
  initialStopLoss: 90,
  trailingStop: 90,
  strategy: 'Target 1 Confirmation',
  tradeStage: 'TARGET1_CONFIRMED',
  target2HitAt: null,
  target3HitAt: null,
  ...overrides,
});

function harness(order: ReturnType<typeof openOrder>) {
  const updates: any[] = [];
  const accountUpdates: any[] = [];
  const voiceAlerts: any[] = [];
  const prisma = {
    paperTradingAccount: {
      findUnique: async () => ({ enabled: true, startingBalance: 10_000, realizedPnl: 0 }),
      update: async (args: any) => { accountUpdates.push(args); return {}; },
    },
    paperOrder: {
      findMany: async ({ where }: any) => where.createdAt?.lt ? [] : [order],
      findUniqueOrThrow: async () => order,
      update: async (args: any) => { updates.push(args); return { ...order, ...args.data }; },
    },
    aiSignal: { findUnique: async () => ({ id: 'signal-1', userId: 'user-1', instrumentKey: 'NSE_EQ|TEST', symbol: 'TEST', side: order.side, entryPrice: 100, currentPrice: order.currentPrice, confidence: 95, aiScore: 95, riskReward: 3, volume: 1000, signalTime: new Date(), status: 'TARGET1_HIT', stopLoss: order.stopLoss, target1: 110, target2: 115, target3: 120, runningAt: new Date(), target1At: new Date(), stopLossDecision: null, managementDecision: null }) },
    demoExecutionDecision: { upsert: async (args: any) => args.create },
    demoTradeQueue: { findFirst: async () => null, updateMany: async () => ({ count: 0 }) },
    paperVoiceAlert: { create: async (args: any) => { voiceAlerts.push(args.data); return args.data; } },
    $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
  };
  const intraday = { estimateRoundTripCharges: async () => ({ total: 0 }) };
  const service = new PaperTradingService(prisma as never, new PaperOrderExecutionService(), new ExecutionEngine(), intraday as never);
  (service as any).drainDemoQueue = async () => false;
  return { service, updates, accountUpdates, voiceAlerts };
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
    tradeStage: 'TARGET1_CONFIRMED',
    stopLoss: 90,
    trailingStop: 90,
    target2HitAt: null,
    target3HitAt: null,
  });
});

test('closes a SELL position on the exact stop-crossing tick and realizes P&L', async () => {
  const order = openOrder({ side: 'SELL', entryPrice: 318.75, quantity: 31, stopLoss: 322.14, target1: 315, target2: 312, target: 309 });
  const { service, updates, accountUpdates, voiceAlerts } = harness(order);
  const at = new Date('2026-08-03T04:00:00.000Z');
  const changed = await service.processTick('user-1', order.instrumentKey, 324.55, at);

  assert.equal(changed, true);
  assert.equal(updates.length, 2);
  assert.equal(updates[0].data.currentPrice, 324.55);
  assert.equal(updates[1].data.status, 'COMPLETED');
  assert.equal(updates[1].data.exitPrice, 324.55);
  assert.equal(updates[1].data.exitReason, 'STOPLOSS');
  assert.equal(accountUpdates.length, 1);
  assert.ok(accountUpdates[0].data.realizedPnl.increment < 0);
  assert.deepEqual(voiceAlerts.map((alert) => alert.eventName), ['STOP_LOSS_HIT', 'TRADE_CLOSED']);
});

test('moves stop to breakeven without a partial exit and completes when a tick jumps to Target 3', async () => {
  const order = openOrder();
  const { service, voiceAlerts } = harness(order);
  await service.processTick('user-1', order.instrumentKey, 121, new Date('2026-08-03T04:00:00.000Z'));
  assert.deepEqual(voiceAlerts.map((alert) => alert.eventName), ['TARGET2_REACHED', 'TRAILING_STOP_ACTIVATED', 'TARGET3_REACHED', 'TRADE_CLOSED']);
});
