import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateDemoIntradayPosition, PaperTradingService } from './paper-trading.service';
import { PaperOrderExecutionService } from './paper-order-execution.service';

const account = { enabled: true, autoDemoTrading: true, startingBalance: 10_000, realizedPnl: 0, maxOpenTrades: 1, riskPerTrade: 2 };
const signal = (status: string) => ({ id: `signal-${status}`, userId: 'user-1', instrumentKey: 'NSE_EQ|TEST', symbol: 'TEST', side: 'SELL', entryPrice: 100, currentPrice: 98, confidence: 95, aiScore: 95, riskReward: 2, signalTime: new Date(), status, entryTriggeredAt: new Date(), runningAt: ['RUNNING', 'TARGET1_HIT'].includes(status) ? new Date() : null, target1At: status === 'TARGET1_HIT' ? new Date() : null, stopLossAt: null, completedAt: null });

test('intraday quantity is capped by both margin capacity and risk', () => {
  const sizing = calculateDemoIntradayPosition({ capital: 10_000, accountBalance: 10_000, entryPrice: 100, stopLoss: 99, riskPercent: 1, leverage: 5 });
  assert.equal(sizing.marginQuantity, 500);
  assert.equal(sizing.riskQuantity, 100);
  assert.equal(sizing.quantity, 100);
  assert.equal(sizing.marginUsed, 2_000);
  assert.equal(sizing.notionalValue, 10_000);
});

test('only TARGET1_HIT signals enter the persisted Demo queue', async () => {
  const queued: string[] = [];
  const prisma = { demoTradeQueue: { upsert: async ({ create }: any) => { queued.push(create.signalId); return create; } } };
  const service = new PaperTradingService(prisma as never, new PaperOrderExecutionService());
  (service as any).account = async () => account;
  (service as any).drainDemoQueue = async () => false;
  await service.captureTriggeredDemoSignals('user-1', [signal('WAITING'), signal('ENTRY_TRIGGERED'), signal('RUNNING'), signal('TARGET1_HIT')] as never);
  assert.deepEqual(queued, ['signal-TARGET1_HIT']);
});

test('legacy/manual create path cannot create a paper order', async () => {
  let creates = 0;
  const service = new PaperTradingService({ paperOrder: { create: async () => { creates += 1; } } } as never, new PaperOrderExecutionService());
  assert.equal(await service.createTrade('user-1', { instrumentKey: 'NSE_EQ|TEST' }), false);
  assert.equal(creates, 0);
});

test('TARGET1_HIT creates one linked SELL order and repeated drains do not duplicate it', async () => {
  const target1Hit = { ...signal('TARGET1_HIT'), stopLoss: 102, target3: 94 };
  let queueStatus = 'WAITING_FOR_CAPITAL';
  const orders: any[] = [];
  const queued = { id: 'queue-1', signalId: target1Hit.id, userId: 'user-1', status: queueStatus, confidence: 95, aiScore: 95, riskReward: 2, signalTime: target1Hit.signalTime };
  const prisma: any = {
    paperOrder: {
      findMany: async () => orders.filter((order) => order.status === 'OPEN'),
      findUnique: async ({ where }: any) => orders.find((order) => order.signalId === where.signalId) ?? null,
      create: ({ data }: any) => Promise.resolve(data).then((value) => { orders.push(value); return value; }),
    },
    demoTradeQueue: {
      findFirst: async () => queueStatus === 'WAITING_FOR_CAPITAL' ? queued : null,
      update: ({ data }: any) => Promise.resolve(data).then((value) => { queueStatus = value.status; return value; }),
    },
    aiSignal: { findUnique: async () => target1Hit },
    $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
  };
  const service = new PaperTradingService(prisma, new PaperOrderExecutionService());
  (service as any).account = async () => account;
  const at = new Date('2026-08-14T06:00:00.000Z');
  assert.equal(await service.drainDemoQueue('user-1', at), true);
  assert.equal(await service.drainDemoQueue('user-1', at), false);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].signalId, target1Hit.id);
  assert.equal(orders[0].side, 'SELL');
  assert.equal(orders[0].status, 'OPEN');
  assert.ok(orders[0].budget <= 10_000);
  assert.ok(orders[0].investment > orders[0].budget, 'intraday notional uses leverage while budget stores margin used');
});
