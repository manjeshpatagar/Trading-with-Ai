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

const directory = mkdtempSync(join(tmpdir(), 'demo-target-priority-'));
const url = `file:${join(directory, 'test.db')}`;
const db = new PrismaClient({ datasources: { db: { url } } });
const at = (time: string) => new Date(`2026-09-16T${time}+05:30`);
const noon = at('12:00:00');
const prices = new MarketPricesService();
const service = () => new PaperTradingService(db as PrismaService, new PaperOrderExecutionService(), prices);

test('strategy live hits survive processing delay, retain exact T1 fills and cannot be replayed', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(noon.getTime() + 10_000) });
  for (const side of ['BUY', 'SELL']) {
    const user = await account();
    const signal = await stock(user, `LIVE-${side}`, '12:00:00', {
      side, target1At: noon, aiStrategyListed: true, aiStrategyListedAt: at('09:30:00'),
      ...(side === 'SELL' ? { entryPrice: 110, stopLoss: 115, target2: 100, target3: 95 } : {}),
    });
    const paper = service();
    assert.equal(await (paper as any).capturePortfolio(user, 'STRATEGY', [signal], noon), true);
    const orders = await db.paperOrder.findMany({ where: { userId: user, portfolio: 'STRATEGY' } });
    assert.equal(orders.length, 1);
    assert.equal(orders[0].entryPrice, signal.target1);
    assert.equal(orders[0].entryTime?.getTime(), noon.getTime());
    await (paper as any).capturePortfolio(user, 'STRATEGY', [signal], noon);
    assert.equal(await db.paperOrder.count({ where: { userId: user, portfolio: 'STRATEGY' } }), 1);

    const missedUser = await account();
    const missed = await stock(missedUser, `MISSED-${side}`, '12:00:00', {
      side, target1At: noon, aiStrategyListed: true, aiStrategyListedAt: at('09:30:00'),
    });
    await (paper as any).capturePortfolio(missedUser, 'STRATEGY', [missed], at('12:00:10'));
    assert.equal(await db.paperOrder.count({ where: { userId: missedUser, portfolio: 'STRATEGY' } }), 0);
  }
});

test('live strategy execution waits for a busy drain instead of dropping the hit', { timeout: 15_000 }, async () => {
  const user = await account();
  const signal = await stock(user, 'BUSY', '12:00:00', { target1At: noon, aiStrategyListed: true, aiStrategyListedAt: at('09:30:00') });
  const paper = service();
  const wallet = await paper.account(user, 'STRATEGY');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let markBusy!: () => void;
  const started = new Promise<void>(resolve => { markBusy = resolve; });
  let calls = 0;
  paper.account = async () => {
    if (++calls === 1) { markBusy(); await gate; return { ...wallet, enabled: false }; }
    return wallet;
  };
  const busy = paper.drainDemoQueue(user, noon, 'STRATEGY');
  await started;
  const live = (paper as any).capturePortfolio(user, 'STRATEGY', [signal], noon);
  // Capture must wait before making its eligibility/slot decision.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await db.demoTradeQueue.count({ where: { signalId: signal.id, portfolio: 'STRATEGY' } }), 0);
  release();
  await busy;
  assert.equal(await live, true);
  assert.equal(await db.paperOrder.count({ where: { userId: user, portfolio: 'STRATEGY' } }), 1);
});

test('overlapping strategy hits consume one slot and record the other as skipped', async () => {
  const user = await account();
  const signals = await Promise.all(['FIRST', 'SECOND'].map(symbol => stock(user, symbol, '12:00:00', {
    target1At: noon, aiStrategyListed: true, aiStrategyListedAt: at('09:30:00'),
  })));
  const paper = service();
  await Promise.all(signals.map(signal => (paper as any).capturePortfolio(user, 'STRATEGY', [signal], noon)));
  assert.equal(await db.paperOrder.count({ where: { userId: user, portfolio: 'STRATEGY', status: 'OPEN' } }), 1);
  const queue = await db.demoTradeQueue.findMany({ where: { userId: user, portfolio: 'STRATEGY' } });
  assert.deepEqual(queue.map(item => item.status).sort(), ['EXECUTED', 'REJECTED']);
  assert.match(queue.find(item => item.status === 'REJECTED')!.rejectReason!, /slot occupied/);
});

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
    confidence: 80, aiScore: 80, riskReward: 3, top100Selected: true, aiStrategyListed: true, aiStrategyListedAt: at('09:20:00'), status: 'TARGET1_HIT', updatedAt: noon,
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

const liveHit = async (user: string, symbol: string, time: string, extra: Record<string, any> = {}) =>
  stock(user, symbol, time, { target1At: at(time), updatedAt: at(time), ...extra });

test('10:20 hit is skipped while busy; 10:30 exit waits for a new 10:40 hit', async () => {
  for (const side of ['BUY', 'SELL']) {
    const user = await account();
    const paper = service();
    const levels = side === 'SELL' ? { side, entryPrice: 110, stopLoss: 115, target2: 100, target3: 95 } : { side };
    const first = await liveHit(user, `FIRST-${side}`, '10:00:00', levels);
    await paper.captureTriggeredDemoSignals(user, [first], at('10:00:00'));
    assert.deepEqual((await open(user)).map(order => order.symbol), [`FIRST-${side}`]);
    const missed = await liveHit(user, `MISSED-${side}`, '10:20:00', levels);
    await paper.captureTriggeredDemoSignals(user, [missed], at('10:20:00'));
    const skipped = await db.demoTradeQueue.findUniqueOrThrow({ where: { signalId_portfolio: { signalId: missed.id, portfolio: 'SIGNAL_HISTORY' } } });
    assert.equal(skipped.status, 'REJECTED');
    assert.match(skipped.rejectReason!, /slot occupied/);
    await paper.processTick(user, first.instrumentKey, first.target3, at('10:30:00'));
    assert.equal((await open(user)).length, 0, 'closing does not execute the old 10:20 hit');
    await paper.reconcileTriggeredDemoSignals(user, at('10:35:00'));
    await paper.captureTriggeredDemoSignals(user, [missed], at('10:35:00'));
    assert.equal((await open(user)).length, 0);
    const fresh = await liveHit(user, `FRESH-${side}`, '10:40:00', levels);
    await paper.captureTriggeredDemoSignals(user, [fresh], at('10:40:00'));
    const next = (await open(user))[0];
    assert.equal(next.symbol, `FRESH-${side}`);
    assert.equal(next.entryTime?.getTime(), at('10:40:00').getTime());
    assert.equal(next.entryPrice, fresh.currentPrice);
    assert.equal(await db.paperOrder.count({ where: { userId: user, portfolio: 'SIGNAL_HISTORY' } }), 2);
  }
});

test('a delayed callback for a hit before the last exit cannot enter after close', async () => {
  const user = await account();
  const paper = service();
  const first = await liveHit(user, 'FIRST', '10:00:00');
  await paper.captureTriggeredDemoSignals(user, [first], at('10:00:00'));
  await paper.processTick(user, 'FIRST', 115, at('10:30:00'));
  const delayed = await liveHit(user, 'DELAYED', '10:20:00');
  await paper.captureTriggeredDemoSignals(user, [delayed], at('10:20:00'));
  assert.equal((await open(user)).length, 0);
  const rejection = await db.demoTradeQueue.findUniqueOrThrow({ where: { signalId_portfolio: { signalId: delayed.id, portfolio: 'SIGNAL_HISTORY' } } });
  assert.match(rejection.rejectReason!, /previous trade closed/);
});

test('refresh, restart and legacy queued hits never create history orders', async () => {
  const user = await account();
  const old = await liveHit(user, 'OLD', '10:20:00');
  await oldQueue(old);
  const restored = service();
  await restored.reconcileTriggeredDemoSignals(user, at('10:30:00'));
  await restored.drainDemoQueue(user, at('10:30:00'), 'SIGNAL_HISTORY');
  assert.deepEqual(await restored.historyTargetQueue(user, at('10:30:00')), []);
  assert.equal((await open(user)).length, 0);
  await restored.captureTriggeredDemoSignals(user, [old], at('10:30:00'));
  assert.equal((await open(user)).length, 0);
});

test('independent workers handling concurrent live hits reserve one history slot', async () => {
  const user = await account();
  const signals = await Promise.all(['A', 'B'].map(symbol => liveHit(user, symbol, '10:40:00')));
  await Promise.all(signals.map(signal => service().captureTriggeredDemoSignals(user, [signal], at('10:40:00'))));
  assert.equal((await open(user)).length, 1);
  const queue = await db.demoTradeQueue.findMany({ where: { userId: user, portfolio: 'SIGNAL_HISTORY' } });
  assert.deepEqual(queue.map(item => item.status).sort(), ['EXECUTED', 'REJECTED']);
});

test('stale quote rejection is permanent; updating price later cannot replay the hit', async () => {
  const user = await account();
  const signal = await liveHit(user, 'STALE', '10:40:00');
  prices.get(user, 'STALE')!.receivedAt = Date.now() - 61_000;
  const paper = service();
  await paper.captureTriggeredDemoSignals(user, [signal], at('10:40:00'));
  prices.accept(user, 'STALE', 107, at('10:41:00').getTime());
  await paper.captureTriggeredDemoSignals(user, [signal], at('10:40:00'));
  await paper.reconcileTriggeredDemoSignals(user, at('10:41:00'));
  assert.equal((await open(user)).length, 0);
});


test('PRANAV manual exit allows the next listed HINDCOPPER Target 1 hit', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: at('09:30:40') });
  const user = await account();
  const paper = service();
  const pranav = await stock(user, 'PRANAV', '09:21:18', {
    signalTime: at('09:20:08'), target1At: at('09:21:18'),
  });
  assert.equal(await (paper as any).capturePortfolio(user, 'STRATEGY', [pranav], pranav.target1At), true);
  assert.equal(await paper.manualExit(user, (await db.paperOrder.findFirstOrThrow({ where: { userId: user, portfolio: 'STRATEGY' } })).id), true);
  const hindcopper = await stock(user, 'HINDCOPPER', '09:35:53', {
    signalTime: at('09:20:10'), target1At: at('09:35:53'), aiStrategyListed: true, aiStrategyListedAt: at('09:20:10'),
  });
  assert.equal(await (paper as any).capturePortfolio(user, 'STRATEGY', [hindcopper], hindcopper.target1At), true);
  const orders = await db.paperOrder.findMany({ where: { userId: user, portfolio: 'STRATEGY' }, orderBy: { entryTime: 'asc' } });
  assert.equal(orders.length, 2);
  assert.equal(orders[0].exitTime?.getTime(), at('09:30:40').getTime());
  assert.equal(orders[1].symbol, 'HINDCOPPER');
  assert.equal(orders[1].entryPrice, hindcopper.target1);
  await (paper as any).capturePortfolio(user, 'STRATEGY', [hindcopper], hindcopper.target1At);
  assert.equal(await db.paperOrder.count({ where: { userId: user, portfolio: 'STRATEGY' } }), 2);
});

test('target and stop exits release the slot; delayed pre-exit hits stay skipped across restart', async () => {
  for (const exit of ['TARGET', 'STOP LOSS']) {
    const user = await account();
    const paper = service();
    const first = await stock(user, 'FIRST', '09:30:00', { target1At: at('09:30:00') });
    await (paper as any).capturePortfolio(user, 'STRATEGY', [first], first.target1At);
    assert.equal(await paper.processTick(user, first.instrumentKey, exit === 'TARGET' ? first.target3 : first.stopLoss, at('09:40:00')), true);
    const closed = await db.paperOrder.findFirstOrThrow({ where: { userId: user, portfolio: 'STRATEGY' } });
    assert.equal(closed.exitReason, exit);
    const restored = service();
    const delayed = await stock(user, 'DELAYED', '09:39:00', { target1At: at('09:39:00') });
    assert.equal(await (restored as any).capturePortfolio(user, 'STRATEGY', [delayed], delayed.target1At), false);
    const rejected = await db.demoTradeQueue.findUniqueOrThrow({ where: { signalId_portfolio: { signalId: delayed.id, portfolio: 'STRATEGY' } } });
    assert.equal(rejected.status, 'REJECTED');
    assert.match(rejected.rejectReason!, /slot occupied/);
    await restored.reconcileTriggeredDemoSignals(user, at('09:40:30'), 'STRATEGY');
    await restored.drainDemoQueue(user, at('09:40:30'), 'STRATEGY');
    const next = await stock(user, 'NEXT', '09:41:00', { target1At: at('09:41:00') });
    assert.equal(await (restored as any).capturePortfolio(user, 'STRATEGY', [next], next.target1At), true);
    await (restored as any).capturePortfolio(user, 'STRATEGY', [delayed], delayed.target1At);
    assert.equal(await db.paperOrder.count({ where: { userId: user, portfolio: 'STRATEGY' } }), 2);
  }
});

test('a new strategy hit waits for an in-progress close to commit', async () => {
  const user = await account();
  const execution = new PaperOrderExecutionService();
  const paper = new PaperTradingService(db as PrismaService, execution, prices);
  const first = await stock(user, 'CLOSING', '09:30:00', { target1At: at('09:30:00') });
  await (paper as any).capturePortfolio(user, 'STRATEGY', [first], first.target1At);
  const next = await stock(user, 'AFTER-CLOSE', '09:41:00', { target1At: at('09:41:00') });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const original = execution.close.bind(execution);
  execution.close = async input => { entered(); await gate; return original(input); };
  const closing = paper.processTick(user, first.instrumentKey, first.target3, at('09:40:00'));
  await started;
  const hitting = (paper as any).capturePortfolio(user, 'STRATEGY', [next], next.target1At);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await db.demoTradeQueue.count({ where: { signalId: next.id, portfolio: 'STRATEGY' } }), 0);
  release();
  assert.equal(await closing, true);
  assert.equal(await hitting, true);
  assert.equal(await db.paperOrder.count({ where: { userId: user, portfolio: 'STRATEGY', status: 'OPEN' } }), 1);
});


test('a stock from signal history cannot open a strategy trade or replay after later listing', async () => {
  const user = await account();
  const paper = service();
  const other = await stock(user, 'OTHER-PAGE', '10:00:00', {
    target1At: at('10:00:00'), aiStrategyListed: false, aiStrategyListedAt: null,
  });
  assert.equal(await paper.captureTriggeredDemoSignals(user, [other], other.target1At!), true);
  assert.equal(await db.paperOrder.count({ where: { userId: user, portfolio: 'STRATEGY' } }), 0);
  assert.equal(await db.paperOrder.count({ where: { userId: user, portfolio: 'SIGNAL_HISTORY' } }), 1);
  const rejected = await db.demoTradeQueue.findUniqueOrThrow({ where: { signalId_portfolio: { signalId: other.id, portfolio: 'STRATEGY' } } });
  assert.equal(rejected.status, 'REJECTED');
  assert.match(rejected.rejectReason!, /Top 10/);
  const listed = await db.aiSignal.update({ where: { id: other.id }, data: { aiStrategyListed: true, aiStrategyListedAt: at('10:01:00') } });
  await (paper as any).capturePortfolio(user, 'STRATEGY', [listed], other.target1At);
  assert.equal(await db.paperOrder.count({ where: { userId: user, portfolio: 'STRATEGY' } }), 0);
});

test('listing a stock after its Target 1 event never grants a late strategy entry', async () => {
  const user = await account();
  const signal = await stock(user, 'LATE-LIST', '10:00:00', {
    target1At: at('10:00:00'), aiStrategyListed: true, aiStrategyListedAt: at('10:01:00'),
  });
  assert.equal(await (service() as any).capturePortfolio(user, 'STRATEGY', [signal], signal.target1At), false);
  assert.equal(await db.paperOrder.count({ where: { userId: user, portfolio: 'STRATEGY' } }), 0);
});
