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

// Fixtures deliberately score 80 below the configured 95 minimum: Target 1 must bypass that gate.
test('strategy live hits survive processing delay, retain observed-price fills and cannot be replayed', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(noon.getTime() + 10_000) });
  for (const side of ['BUY', 'SELL']) {
    const user = await account();
    const signal = await stock(user, `LIVE-${side}`, '12:00:00', {
      side, target1At: noon, aiStrategyListed: true, aiStrategyListedAt: at('09:30:00'),
      ...(side === 'SELL' ? { entryPrice: 110, stopLoss: 115, target2: 100, target3: 85 } : {}),
    });
    const paper = service();
    assert.equal(await (paper as any).capturePortfolio(user, 'STRATEGY', [signal], noon), true);
    const orders = await db.paperOrder.findMany({ where: { userId: user, portfolio: 'STRATEGY' } });
    assert.equal(orders.length, 1);
    assert.equal(orders[0].entryPrice, signal.currentPrice);
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
  for (const portfolio of ['SIGNAL_HISTORY', 'STRATEGY'] as const) {
    await service().account(user.id, portfolio);
    await db.paperTradingAccount.update({ where: { userId_portfolio: { userId: user.id, portfolio } }, data: { autoDemoTrading: true, entryMode: 'TARGET1', riskPerTrade: 2, minimumConfidence: 95, slippageBps: 0, spreadBps: 0 } });
  }
  return user.id;
}
async function stock(userId: string, symbol: string, hit: string | null, extra: Record<string, any> = {}) {
  const row = await db.aiSignal.create({ data: {
    userId, signalKey: randomUUID(), instrumentKey: symbol, stockName: symbol, symbol, strategy: 'Momentum', timeframe: '5m', side: 'BUY',
    signalTime: at('09:30:00'), currentPrice: 106, entryPrice: 100, stopLoss: 95, target1: 105, target2: 110, target3: 125,
    confidence: 80, aiScore: 80, riskReward: 3, top100Selected: true, aiStrategyListed: true, aiStrategyListedAt: at('09:20:00'), status: 'TARGET1_HIT', updatedAt: hit ? at(hit) : noon,
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
    const levels = side === 'SELL' ? { side, entryPrice: 110, stopLoss: 115, target2: 100, target3: 85 } : { side };
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
  await paper.processTick(user, 'FIRST', 125, at('10:30:00'));
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
  assert.equal(orders[1].entryPrice, hindcopper.currentPrice);
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


test('strategy takes fresh hits after each exit even after stocks leave the current Top 10', async () => {
  for (const side of ['BUY', 'SELL']) {
    const user = await account();
    const paper = service();
    const levels = side === 'SELL' ? { side, entryPrice: 110, stopLoss: 115, target2: 100, target3: 85 } : { side };
    for (const [index, time] of ['10:00:00', '10:10:00', '10:20:00', '10:30:00', '10:40:00'].entries()) {
      const hit = await liveHit(user, `NEXT-${index}`, time, {
        ...levels, aiStrategyListed: index === 0, aiStrategyListedAt: at('09:30:00'),
      });
      assert.equal(await (paper as any).capturePortfolio(user, 'STRATEGY', [hit], hit.target1At), true);
      const order = await db.paperOrder.findUniqueOrThrow({ where: { signalId_portfolio: { signalId: hit.id, portfolio: 'STRATEGY' } } });
      assert.equal(order.entryTime?.getTime(), hit.target1At!.getTime());
      assert.equal(order.entryPrice, hit.currentPrice);
      await paper.processTick(user, hit.instrumentKey, hit.target3, new Date(hit.target1At!.getTime() + 1000));
      assert.equal(await db.paperOrder.count({ where: { userId: user, portfolio: 'STRATEGY', status: 'OPEN' } }), 0);
    }
    assert.equal(await db.paperOrder.count({ where: { userId: user, portfolio: 'STRATEGY', status: 'CLOSED' } }), 5);
  }
});

test('listing a stock after its Target 1 event never grants a late strategy entry', async () => {
  const user = await account();
  const signal = await stock(user, 'LATE-LIST', '10:00:00', {
    target1At: at('10:00:00'), aiStrategyListed: true, aiStrategyListedAt: at('10:01:00'),
  });
  assert.equal(await (service() as any).capturePortfolio(user, 'STRATEGY', [signal], at('10:01:00')), false);
  assert.equal(await db.paperOrder.count({ where: { userId: user, portfolio: 'STRATEGY' } }), 0);
});

test('strategy enters at 15:19:59, auto-exits at 15:20, and rejects a new cutoff hit', async () => {
  const user = await account();
  const paper = service();
  const last = await liveHit(user, 'LAST', '15:19:59');
  assert.equal(await (paper as any).capturePortfolio(user, 'STRATEGY', [last], last.target1At), true);
  assert.equal(await paper.processTick(user, last.instrumentKey, last.target1, at('15:20:00')), true);
  const order = await db.paperOrder.findFirstOrThrow({ where: { userId: user, portfolio: 'STRATEGY' } });
  assert.equal(order.status, 'CLOSED - EOD EXIT');
  assert.equal(order.exitTime?.getTime(), at('15:20:00').getTime());
  const late = await liveHit(user, 'LATE', '15:20:01');
  assert.equal(await (paper as any).capturePortfolio(user, 'STRATEGY', [late], late.target1At), false);
  assert.equal(await db.paperOrder.count({ where: { userId: user, portfolio: 'STRATEGY' } }), 1);
});

test('09:20 entry and 09:40 exit skip 09:30 hits and admit only a fresh post-exit hit', async () => {
  for (const side of ['BUY', 'SELL']) for (const reason of ['TARGET', 'STOP LOSS']) {
    const user = await account();
    const paper = service();
    const levels = { side, signalTime: at('09:18:00'), aiStrategyListedAt: at('09:18:00'),
      ...(side === 'SELL' ? { entryPrice: 110, stopLoss: 115, target2: 100, target3: 85 } : {}) };
    const first = await liveHit(user, 'FIRST', '09:20:00', levels);
    assert.equal(await (paper as any).capturePortfolio(user, 'STRATEGY', [first], first.target1At), true);
    const busy = await liveHit(user, 'BUSY', '09:30:00', levels);
    assert.equal(await (paper as any).capturePortfolio(user, 'STRATEGY', [busy], busy.target1At), false);
    await paper.processTick(user, first.instrumentKey, reason === 'TARGET' ? first.target3 : first.stopLoss, at('09:40:00'));
    const restored = service();
    // Neither a previously rejected hit nor an unprocessed older hit can replay.
    assert.equal(await (restored as any).capturePortfolio(user, 'STRATEGY', [busy], busy.target1At), false);
    for (const time of ['09:19:00', '09:39:59', '09:40:00']) {
      const old = await liveHit(user, `OLD-${time}`, time, levels);
      assert.equal(await (restored as any).capturePortfolio(user, 'STRATEGY', [old], old.target1At), false);
    }
    await restored.drainDemoQueue(user, at('09:40:00'), 'STRATEGY');
    assert.equal(await db.paperOrder.count({ where: { userId: user, portfolio: 'STRATEGY', status: 'OPEN' } }), 0);
    const next = await liveHit(user, 'NEXT', '09:40:01', { ...levels, aiStrategyListed: false });
    assert.equal(await (restored as any).capturePortfolio(user, 'STRATEGY', [next], next.target1At), true);
    await (restored as any).capturePortfolio(user, 'STRATEGY', [next], next.target1At);
    const orders = await db.paperOrder.findMany({ where: { userId: user, portfolio: 'STRATEGY' }, orderBy: { entryTime: 'asc' } });
    assert.deepEqual(orders.map(order => order.symbol), ['FIRST', 'NEXT']);
    assert.equal(orders[0].exitTime?.getTime(), at('09:40:00').getTime());
    assert.equal(orders[1].entryTime?.getTime(), at('09:40:01').getTime());
  }
});


test('history-only hits never enter strategy, while a shared signal can enter both accounts', async () => {
  for (const side of ['BUY', 'SELL']) {
    const user = await account();
    const paper = service();
    const levels = side === 'SELL' ? { side, entryPrice: 110, stopLoss: 115, target2: 100, target3: 85 } : { side };
    const historyOnly = await liveHit(user, 'HISTORY-ONLY', '10:00:00', {
      ...levels, aiStrategyListed: false, aiStrategyListedAt: null,
    });
    await paper.captureTriggeredDemoSignals(user, [historyOnly], at('10:00:00'));
    assert.equal(await db.paperOrder.count({ where: { userId: user, portfolio: 'STRATEGY' } }), 0);
    assert.equal((await open(user)).length, 1);
    const rejected = await db.demoTradeQueue.findUniqueOrThrow({ where: { signalId_portfolio: { signalId: historyOnly.id, portfolio: 'STRATEGY' } } });
    assert.match(rejected.rejectReason!, /appeared on the AI Strategy page/);

    const shared = await liveHit(user, 'SHARED', '10:01:00', levels);
    await paper.captureTriggeredDemoSignals(user, [shared], at('10:01:00'));
    assert.equal(await db.paperOrder.count({ where: { signalId: shared.id, portfolio: 'STRATEGY' } }), 1);
    assert.equal(await db.paperOrder.count({ where: { signalId: shared.id, portfolio: 'SIGNAL_HISTORY' } }), 0);
    await paper.processTick(user, historyOnly.instrumentKey, historyOnly.target3, at('10:02:00'));
    await paper.processTick(user, shared.instrumentKey, shared.target3, at('10:02:00'));

    const both = await liveHit(user, 'BOTH-FREE', '10:03:00', levels);
    await paper.captureTriggeredDemoSignals(user, [both], at('10:03:00'));
    assert.equal(await db.paperOrder.count({ where: { signalId: both.id } }), 2);
  }
});

// Regression coverage for durable strategy execution (never historical backfill).
test('a saved live hit survives a failed fill and a service restart exactly once', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: noon });
  const { SignalHistoryService } = await import('./signal-history.service');
  const user = await account();
  const signal = await stock(user, 'RECOVER', null, { status: 'RUNNING', target1At: null });
  const lifecycle = new SignalHistoryService(db as any, {} as never);
  prices.accept(user, signal.instrumentKey, 105, noon.getTime());
  const trades = await lifecycle.processTick(user, signal.instrumentKey, 105, noon);
  const request = await db.demoTradeQueue.findUniqueOrThrow({ where: { signalId_portfolio: { signalId: signal.id, portfolio: 'STRATEGY' } } });
  assert.equal(request.status, 'PENDING_EXECUTION');
  const execution = new PaperOrderExecutionService();
  execution.fill = async () => { throw new Error('temporary execution failure'); };
  await assert.rejects((new PaperTradingService(db as any, execution, prices) as any).capturePortfolio(user, 'STRATEGY', trades, noon), /temporary execution failure/);
  assert.equal(await db.paperOrder.count({ where: { signalId: signal.id } }), 0);
  assert.equal((await db.demoTradeQueue.findUniqueOrThrow({ where: { id: request.id } })).status, 'PENDING_EXECUTION');
  t.mock.timers.tick(1000);
  const restored = service();
  assert.equal(await restored.reconcileTriggeredDemoSignals(user, new Date(), 'STRATEGY'), true);
  await restored.reconcileTriggeredDemoSignals(user, new Date(), 'STRATEGY');
  const orders = await db.paperOrder.findMany({ where: { signalId: signal.id, portfolio: 'STRATEGY' } });
  assert.equal(orders.length, 1);
  assert.equal(orders[0].entryPrice, 105);
  assert.equal(orders[0].entryTime?.getTime(), noon.getTime());
});

test('registration commits eligibility before a hit occurring during a 213 ms publication delay', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: noon });
  const { SignalHistoryService } = await import('./signal-history.service');
  const user = await account();
  const lifecycle = new SignalHistoryService(db as any, {} as never);
  const row = { instrumentKey: 'CELLO-RACE', symbol: 'CELLO-RACE', company: 'CELLO race regression', sector: 'NSE Equity',
    timeframe: '5m', universeRank: 1, selectionScore: 90, price: 340.05, signal: 'BUY', entry: 339.05,
    stopLoss: 338.03, target1: 340.575725, target2: 341.3385875, target3: 345,
    confidence: 69, aiScore: 90, riskReward: 3, volume: 1000, indicators: {}, tags: [] };
  const original = (lifecycle as any).persistStrategyList.bind(lifecycle);
  let tick!: ReturnType<InstanceType<typeof SignalHistoryService>['processTick']>;
  (lifecycle as any).persistStrategyList = async (...args: any[]) => {
    const registered = await db.aiSignal.findFirstOrThrow({ where: { userId: user } });
    assert.equal(registered.aiStrategyListed, true);
    assert.equal(registered.aiStrategyListedAt?.getTime(), registered.signalTime.getTime());
    t.mock.timers.tick(380);
    prices.accept(user, row.instrumentKey, 340.65, Date.now());
    tick = lifecycle.processTick(user, row.instrumentKey, 340.65, new Date());
    t.mock.timers.tick(213);
    return original(...args);
  };
  await lifecycle.recordScannerSignals(user, [row] as any);
  const trades = await tick;
  assert.equal(trades.length, 1);
  assert.equal(await (service() as any).capturePortfolio(user, 'STRATEGY', trades, new Date(noon.getTime() + 380)), true);
  const order = await db.paperOrder.findFirstOrThrow({ where: { userId: user, portfolio: 'STRATEGY' } });
  assert.equal(order.entryPrice, 340.65);
});

test('two strategy service instances reserve only one position and never overwrite its decision', async () => {
  const user = await account();
  const signals = await Promise.all(['ATOMIC-A', 'ATOMIC-B'].map(symbol => liveHit(user, symbol, '12:00:00')));
  await Promise.all(signals.map(signal => (service() as any).capturePortfolio(user, 'STRATEGY', [signal], noon)));
  const orders = await db.paperOrder.findMany({ where: { userId: user, portfolio: 'STRATEGY', status: 'OPEN' } });
  assert.equal(orders.length, 1);
  const decisions = await db.demoTradeQueue.findMany({ where: { userId: user, portfolio: 'STRATEGY' } });
  assert.deepEqual(decisions.map(row => row.status).sort(), ['EXECUTED', 'REJECTED']);
  assert.equal(decisions.find(row => row.signalId === orders[0].signalId)?.status, 'EXECUTED');
});

test('expired recovery and disabled accounts leave a visible rejection without creating orders', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: noon });
  const { SignalHistoryService } = await import('./signal-history.service');
  for (const mode of ['expired', 'disabled']) {
    const user = await account();
    const signal = await stock(user, mode, null, { status: 'RUNNING', target1At: null });
    await service().account(user, 'STRATEGY');
    await new SignalHistoryService(db as any, {} as never).processTick(user, mode, 105, noon);
    if (mode === 'disabled') await db.paperTradingAccount.update({ where: { userId_portfolio: { userId: user, portfolio: 'STRATEGY' } }, data: { enabled: false } });
    await service().reconcileTriggeredDemoSignals(user, new Date(noon.getTime() + (mode === 'expired' ? 30_001 : 1000)), 'STRATEGY');
    const decision = await db.demoTradeQueue.findUniqueOrThrow({ where: { signalId_portfolio: { signalId: signal.id, portfolio: 'STRATEGY' } } });
    assert.equal(decision.status, 'REJECTED');
    assert.match(decision.rejectReason!, mode === 'expired' ? /expired/ : /disabled/);
    assert.equal(await db.paperOrder.count({ where: { userId: user } }), 0);
  }
});

test('bursty ticks preserve Target 1 and a later Target 2, with one durable request', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: noon });
  const { SignalHistoryService } = await import('./signal-history.service');
  const user = await account();
  const signal = await stock(user, 'BURST', null, { status: 'RUNNING', target1At: null });
  const lifecycle = new SignalHistoryService(db as any, {} as never);
  await Promise.all([lifecycle.processTick(user, 'BURST', 105, noon), lifecycle.processTick(user, 'BURST', 110, new Date(noon.getTime() + 1))]);
  const saved = await db.aiSignal.findUniqueOrThrow({ where: { id: signal.id } });
  assert.equal(saved.target1At?.getTime(), noon.getTime());
  assert.equal(saved.target2At?.getTime(), noon.getTime() + 1);
  assert.equal(await db.demoTradeQueue.count({ where: { signalId: signal.id } }), 1);
});

test('a transient lifecycle database failure retries the same hit before the following pullback', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: noon });
  const { SignalHistoryService } = await import('./signal-history.service');
  const user = await account();
  const signal = await stock(user, 'DB-RETRY', null, { status: 'RUNNING', target1At: null });
  let failed = false;
  const proxy = new Proxy(db, { get(target, key) {
    if (key === '$transaction') return async (...args: any[]) => {
      if (!failed) { failed = true; throw Object.assign(new Error('temporary write conflict'), { code: 'P2034' }); }
      return (target.$transaction as any)(...args);
    };
    return Reflect.get(target, key);
  } });
  const lifecycle = new SignalHistoryService(proxy as any, {} as never);
  await Promise.all([
    lifecycle.processTick(user, signal.instrumentKey, 105, noon),
    lifecycle.processTick(user, signal.instrumentKey, 104, new Date(noon.getTime() + 1)),
  ]);
  assert.equal(failed, true);
  const persisted = await db.aiSignal.findUniqueOrThrow({ where: { id: signal.id } });
  assert.equal(persisted.target1At?.getTime(), noon.getTime());
  assert.equal(await db.aiTradeEvent.count({ where: { tradeId: signal.id, type: 'TARGET1_HIT' } }), 1);
  assert.equal(await db.demoTradeQueue.count({ where: { signalId: signal.id, status: 'PENDING_EXECUTION' } }), 1);
});


test('original entry uses its durable entry event, preserves the risk snapshot, and is idempotent', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: noon });
  const { SignalHistoryService } = await import('./signal-history.service');
  for (const side of ['BUY', 'SELL']) {
    const user = await account();
    await db.paperTradingAccount.update({ where: { userId_portfolio: { userId: user, portfolio: 'STRATEGY' } }, data: { entryMode: 'ORIGINAL_SIGNAL', riskPerTrade: 1, minimumConfidence: 0 } });
    const signal = await stock(user, `ORIGINAL-${side}`, null, { side, strategy: 'Trend Pullback', entryPrice: 100, currentPrice: 100,
      stopLoss: side === 'BUY' ? 95 : 105, target1: side === 'BUY' ? 107 : 93, target2: side === 'BUY' ? 112 : 88, target3: side === 'BUY' ? 120 : 80,
      status: 'WAITING', target1At: null, entryTriggeredAt: null, runningAt: null,
      strategyAssessment: JSON.stringify({ eligibleSetup: true, rejectionReasons: [], expiresAt: new Date(noon.getTime() + 600000).toISOString(), strategyName: 'Trend Pullback', configurationVersion: 'test-v1' }) });
    const lifecycle = new SignalHistoryService(db as any, {} as never);
    const changes = await lifecycle.processTick(user, signal.instrumentKey, 100, noon);
    const request = await db.demoTradeQueue.findUniqueOrThrow({ where: { signalId_portfolio: { signalId: signal.id, portfolio: 'STRATEGY' } } });
    assert.equal(request.entryMode, 'ORIGINAL_SIGNAL');
    assert.equal(request.status, 'PENDING_EXECUTION');
    const paper = service();
    assert.equal(await (paper as any).capturePortfolio(user, 'STRATEGY', changes, noon), true);
    const order = await db.paperOrder.findFirstOrThrow({ where: { signalId: signal.id } });
    assert.equal(order.entryPrice, 100);
    assert.equal(order.quantity, 20);
    assert.equal(order.riskAmount, 100);
    assert.equal(order.entryMode, 'ORIGINAL_SIGNAL');
    assert.equal(order.initialStopLoss, signal.stopLoss);
    const snapshot = order.configurationSnapshot;
    await paper.updateSettings(user, { riskPerTrade: .5 });
    assert.equal((await db.paperOrder.findUniqueOrThrow({ where: { id: order.id } })).configurationSnapshot, snapshot);
    await paper.reconcileTriggeredDemoSignals(user, noon, 'STRATEGY');
    await (service() as any).capturePortfolio(user, 'STRATEGY', changes, noon);
    assert.equal(await db.paperOrder.count({ where: { signalId: signal.id } }), 1);
  }
});

test('daily loss blocks new entry, while account changes do not rewrite completed trades', async () => {
  const user = await account();
  const paper = service();
  await db.paperOrder.create({ data: { userId: user, portfolio: 'STRATEGY', instrumentKey: 'LOSS', symbol: 'LOSS', side: 'BUY', confidence: 90,
    status: 'CLOSED', quantity: 10, budget: 100, plannedEntry: 100, entryPrice: 100, currentPrice: 70, investment: 1000, target: 120,
    stopLoss: 95, entryTime: at('10:00:00'), exitTime: at('10:05:00'), exitPrice: 70, pnl: -300, netPnl: -310, exitReason: 'STOP LOSS' } });
  await db.paperTradingAccount.update({ where: { userId_portfolio: { userId: user, portfolio: 'STRATEGY' } }, data: { realizedPnl: -310 } });
  const candidate = await liveHit(user, 'BLOCKED', '12:00:00');
  assert.equal(await (paper as any).capturePortfolio(user, 'STRATEGY', [candidate], noon), false);
  const decision = await db.demoTradeQueue.findUniqueOrThrow({ where: { signalId_portfolio: { signalId: candidate.id, portfolio: 'STRATEGY' } } });
  assert.match(decision.rejectReason!, /DAILY_REALIZED_LOSS_LIMIT/);
  assert.equal(await db.paperOrder.count({ where: { userId: user, status: 'OPEN' } }), 0);
});
