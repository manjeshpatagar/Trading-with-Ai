import { MarketPricesService } from './market-prices.service';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PaperTradingService } from './paper-trading.service';
import { PaperOrderExecutionService } from './paper-order-execution.service';
import { PrismaService } from '../prisma.service';
import { DemoTradingWorkerService } from './demo-trading-worker.service';

const directory = mkdtempSync(join(tmpdir(), 'demo-target-priority-'));
const url = `file:${join(directory, 'test.db')}`;
const db = new PrismaClient({ datasources: { db: { url } } });
const at = (time: string) => new Date(`2026-09-16T${time}+05:30`);
const noon = at('12:00:00');
const prices = new MarketPricesService();
const service = () => new PaperTradingService(db as PrismaService, new PaperOrderExecutionService(), prices);

before(async () => {
  const sql = execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', join(__dirname, '../../prisma/schema.prisma'), '--script'], {
    encoding: 'utf8', env: { ...process.env, DATABASE_URL: url },
  });
  for (const statement of sql.split(';').map(item => item.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
});
after(async () => { await db.$disconnect(); rmSync(directory, { recursive: true, force: true }); });

async function account() {
  const user = await db.user.create({ data: { upstoxUserId: randomUUID(), name: 'Priority test' } });
  await service().account(user.id, 'SIGNAL_HISTORY');
  return user.id;
}
async function stock(userId: string, symbol: string, hit: string | null, extra: Record<string, any> = {}) {
  const row = await db.aiSignal.create({ data: {
    userId, signalKey: randomUUID(), instrumentKey: symbol, stockName: symbol, symbol, strategy: 'Momentum', timeframe: '5m', side: 'BUY',
    signalTime: at('09:30:00'), currentPrice: 106, entryPrice: 100, stopLoss: 95, target1: 105, target2: 110, target3: 115,
    confidence: 80, aiScore: 80, riskReward: 3, top100Selected: true, status: 'TARGET1_HIT', updatedAt: noon,
    // This deliberately disagrees with the confirmed event to catch scalar sorting.
    target1At: at('09:35:00'), entryTriggeredAt: at('09:31:00'), runningAt: at('09:31:01'),
    ...extra,
    ...(hit ? { events: { create: { type: 'TARGET1_HIT', eventTime: at(hit), triggerPrice: 105, executedPrice: 105, profitPercent: 5, holdingMinutes: 1 } } } : {}),
  }, include: { events: true } });
  prices.accept(userId, symbol, row.currentPrice, row.updatedAt.getTime());
  return row;
}
async function open(userId: string) {
  return db.paperOrder.findMany({ where: { userId, portfolio: 'SIGNAL_HISTORY', status: 'OPEN' } });
}
async function oldQueue(signal: Awaited<ReturnType<typeof stock>>, extra: Record<string, any> = {}) {
  return db.demoTradeQueue.create({ data: { userId: signal.userId, portfolio: 'SIGNAL_HISTORY', signalId: signal.id, instrumentKey: signal.instrumentKey, symbol: signal.symbol, side: signal.side, entryPrice: signal.entryPrice, confidence: signal.confidence, aiScore: signal.aiScore, riskReward: signal.riskReward, signalTime: signal.signalTime, queuedAt: at('12:30:00'), ...extra } });
}

test('real database queue executes C then B then A by confirmed hit time and never re-executes a consumed signal', async () => {
  const user = await account();
  const a = await stock(user, 'A', '10:00:00', { confidence: 99, aiScore: 99, signalTime: at('09:55:00'), target1At: noon });
  await stock(user, 'B', '10:30:00', { confidence: 95, aiScore: 95 });
  await stock(user, 'C', '11:05:00', { confidence: 60, aiScore: 60, target1At: null });
  await oldQueue(a); // Corrupt legacy queue time must not put A first.
  const paper = service();
  await paper.reconcileTriggeredDemoSignals(user, noon);
  assert.deepEqual((await open(user)).map(order => order.symbol), ['C']);
  assert.equal((await open(user))[0].entryPrice, 106, 'fill at current price, not historical T1');
  assert.deepEqual((await paper.historyTargetQueue(user, noon)).map(item => item.symbol), ['B', 'A']);
  for (const [symbol, next, second] of [['C', 'B', '01'], ['B', 'A', '02']] as const) {
    await paper.processTick(user, symbol, 115, at(`12:00:${second}`));
    assert.deepEqual((await open(user)).map(order => order.symbol), [next]);
  }
  await paper.processTick(user, 'A', 115, at('12:00:03'));
  await paper.reconcileTriggeredDemoSignals(user, at('12:00:04'));
  assert.equal((await open(user)).length, 0);
  assert.equal(await db.paperOrder.count({ where: { userId: user, portfolio: 'SIGNAL_HISTORY' } }), 3);
});

test('a newer live hit stays queued while busy, survives restart, and is picked on close before older hits', async () => {
  const user = await account();
  await stock(user, 'OLD', '10:00:00');
  await stock(user, 'RUNNING', '11:05:00');
  const paper = service();
  await paper.reconcileTriggeredDemoSignals(user, noon);
  const newest = await stock(user, 'NEW', '12:00:05', { updatedAt: at('12:00:05') });
  await paper.captureTriggeredDemoSignals(user, [newest], at('12:00:05'));
  await paper.captureTriggeredDemoSignals(user, [newest], at('12:00:06'));
  assert.deepEqual((await open(user)).map(order => order.symbol), ['RUNNING']);
  assert.deepEqual((await paper.historyTargetQueue(user, at('12:00:06'))).map(item => item.symbol), ['NEW', 'OLD']);
  const restored = service();
  await restored.reconcileTriggeredDemoSignals(user, at('12:00:07'));
  await restored.processTick(user, 'RUNNING', 115, at('12:00:08'));
  assert.deepEqual((await open(user)).map(order => order.symbol), ['NEW']);
  assert.deepEqual((await restored.historyTargetQueue(user, at('12:00:08'))).map(item => item.symbol), ['OLD']);
  assert.equal(await db.demoTradeQueue.count({ where: { userId: user, portfolio: 'SIGNAL_HISTORY', signalId: newest.id } }), 1);
});

test('concurrent scheduler and live drains on independent service instances reserve only one slot', async () => {
  const user = await account();
  await stock(user, 'OLDER', '10:00:00');
  await stock(user, 'LATEST', '11:59:00');
  await Promise.all([service().reconcileTriggeredDemoSignals(user, noon), service().reconcileTriggeredDemoSignals(user, noon)]);
  assert.deepEqual((await open(user)).map(order => order.symbol), ['LATEST']);
  assert.equal(await db.demoTradeQueue.count({ where: { userId: user, portfolio: 'SIGNAL_HISTORY', status: 'WAITING_FOR_CAPITAL' } }), 1);
});

test('newest hit waits for a fresh quote; it is not replaced by an older, higher-confidence hit', async () => {
  const user = await account();
  await stock(user, 'OLD', '10:00:00', { confidence: 99 });
  const newest = await stock(user, 'NEW', '11:59:00', { updatedAt: at('11:58:00'), confidence: 60 });
  prices.get(user, 'NEW')!.receivedAt = Date.now() - 61_000;
  const paper = service();
  await paper.reconcileTriggeredDemoSignals(user, noon);
  assert.equal((await open(user)).length, 0);
  await db.aiSignal.update({ where: { id: newest.id }, data: { currentPrice: 107, updatedAt: noon } });
  await paper.reconcileTriggeredDemoSignals(user, noon);
  assert.equal((await open(user)).length, 0, 'database update alone is not a live quote');
  prices.accept(user, 'NEW', 107, noon.getTime());
  await paper.reconcileTriggeredDemoSignals(user, noon);
  assert.equal((await open(user))[0].symbol, 'NEW');
  assert.equal((await open(user))[0].entryPrice, 107);
});

test('unconfirmed, stopped, completed and previous-session hits cannot outrank eligible hits', async () => {
  const user = await account();
  const unconfirmed = await stock(user, 'NO_EVENT', null, { target1At: at('11:59:59') });
  await oldQueue(unconfirmed);
  await stock(user, 'STOPPED', '11:59:58', { stopLossAt: at('11:59:59') });
  await stock(user, 'COMPLETED', '11:59:57', { completedAt: at('11:59:59'), status: 'COMPLETED' });
  await stock(user, 'PREVIOUS_DAY', '11:59:56', { signalTime: new Date('2026-09-15T09:30:00+05:30') });
  await stock(user, 'VALID', '11:00:00');
  const paper = service();
  await paper.reconcileTriggeredDemoSignals(user, noon);
  assert.deepEqual((await open(user)).map(order => order.symbol), ['VALID']);
  assert.equal((await db.demoTradeQueue.findUniqueOrThrow({ where: { signalId_portfolio: { signalId: unconfirmed.id, portfolio: 'SIGNAL_HISTORY' } } })).status, 'REJECTED');
});

test('manual close releases capital once and automatically opens the newest remaining hit', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: noon });
  const user = await account();
  await stock(user, 'OLDER', '10:00:00');
  await stock(user, 'NEWER', '11:00:00');
  const paper = service();
  await paper.reconcileTriggeredDemoSignals(user, noon);
  const order = (await open(user))[0];
  await Promise.all([paper.manualExit(user, order.id, 'SIGNAL_HISTORY'), service().manualExit(user, order.id, 'SIGNAL_HISTORY')]);
  assert.deepEqual((await open(user)).map(item => item.symbol), ['OLDER']);
  assert.equal(await db.paperOrder.count({ where: { userId: user, portfolio: 'SIGNAL_HISTORY' } }), 2);
});

test('opening protection and end-of-day cutoff block history queue execution', async () => {
  const user = await account();
  await stock(user, 'VALID', '09:20:00', { signalTime: at('09:20:00'), updatedAt: at('09:20:00') });
  const paper = service();
  await paper.reconcileTriggeredDemoSignals(user, at('09:19:59'));
  assert.equal((await open(user)).length, 0);
  await paper.reconcileTriggeredDemoSignals(user, at('15:15:00'));
  assert.equal((await open(user)).length, 0);
  await paper.reconcileTriggeredDemoSignals(user, at('09:20:00'));
  assert.equal((await open(user)).length, 1);
});


test('scheduler refreshes queued prices and broadcasts the same newest-first selection', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: noon });
  const user = await account();
  await stock(user, 'OLD', '10:00:00');
  await stock(user, 'NEW', '11:59:00', { updatedAt: at('11:58:00') });
  prices.get(user, 'NEW')!.receivedAt = Date.now() - 61_000;
  const paper = service();
  await paper.reconcileTriggeredDemoSignals(user, noon);
  const refreshed: string[] = [];
  const notifications: string[] = [];
  const worker = new DemoTradingWorkerService({
    paperTradingAccount: { findMany: async () => [{ userId: user }] },
    aiSignal: db.aiSignal, paperOrder: db.paperOrder,
  } as never, {} as never, {
    refreshPrices: async (_user: string, keys: string[]) => {
      refreshed.push(...keys);
      for (const key of keys) prices.accept(user, key, 106, noon.getTime());
      await db.aiSignal.updateMany({ where: { userId: user, instrumentKey: { in: keys } }, data: { updatedAt: noon } });
    },
    notifyPaperTradingUpdated: (id: string) => notifications.push(id),
  } as never, paper);
  await worker.refreshOpenPositionPrices();
  assert.ok(refreshed.includes('NEW'));
  assert.deepEqual((await open(user)).map(order => order.symbol), ['NEW']);
  assert.deepEqual(notifications, [user]);
});

test('history queue fills from the shared live quote instead of the persisted signal price', async () => {
  const user = await account();
  await stock(user, 'LIVE_FILL', '11:59:00');
  prices.accept(user, 'LIVE_FILL', 108, noon.getTime() + 1);
  await service().reconcileTriggeredDemoSignals(user, noon);
  const orders = await open(user);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].entryPrice, 108);
  assert.equal((await db.aiSignal.findFirstOrThrow({ where: { userId: user } })).currentPrice, 106);
});
