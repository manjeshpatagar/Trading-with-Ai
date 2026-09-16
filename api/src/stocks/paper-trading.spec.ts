import { MarketPricesService } from './market-prices.service';
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateDemoIntradayPosition, PaperTradingService } from './paper-trading.service';
import { PaperOrderExecutionService } from './paper-order-execution.service';

const account = { enabled: true, autoDemoTrading: true, startingBalance: 10_000, realizedPnl: 0, maxOpenTrades: 1, riskPerTrade: 2 };
const signal = (status: string) => ({ id: `signal-${status}`, userId: 'user-1', instrumentKey: 'NSE_EQ|TEST', symbol: 'TEST', side: 'SELL', entryPrice: 100, currentPrice: 98, confidence: 95, aiScore: 95, riskReward: 2, signalTime: new Date(Date.now() - 1_000), status, entryTriggeredAt: new Date(), runningAt: ['RUNNING', 'TARGET1_HIT'].includes(status) ? new Date() : null, target1At: status === 'TARGET1_HIT' ? new Date() : null, stopLossAt: null, completedAt: null, aiStrategyListed: true, aiStrategyListedAt: new Date(0) });

test('intraday quantity uses all available capital through margin', () => {
  const sizing = calculateDemoIntradayPosition({ capital: 10_000, accountBalance: 10_000, entryPrice: 100, stopLoss: 99, riskPercent: 1, leverage: 5 });
  assert.equal(sizing.marginQuantity, 500);
  assert.equal(sizing.riskQuantity, 100);
  assert.equal(sizing.quantity, 500);
  assert.equal(sizing.marginUsed, 10_000);
  assert.equal(sizing.notionalValue, 50_000);
});

test('strategy capture only queues Target 1 signals', async () => {
  const queued: string[] = [];
  const prisma = { demoTradeQueue: { findUnique: async () => null, upsert: async ({ create }: any) => { queued.push(create.signalId); return create; } }, paperOrder: { findFirst: async () => null }, aiSignal: { findUnique: async () => signal('TARGET1_HIT') } };
  const service = new PaperTradingService(prisma as never, new PaperOrderExecutionService());
  (service as any).account = async () => account;
  (service as any).drainDemoQueue = async () => false;
  await service.captureTriggeredDemoSignals('user-1', [signal('WAITING'), signal('ENTRY_TRIGGERED'), signal('RUNNING'), signal('TARGET1_HIT')] as never);
  assert.deepEqual(queued, ['signal-TARGET1_HIT']);
});

test('a live signal that jumps through Target 1 to Target 2 still enters the queue', async () => {
  const queued: string[] = [];
  const jumped = { ...signal('TARGET1_HIT'), id: 'signal-TARGET2_HIT', status: 'TARGET2_HIT' };
  const prisma = { demoTradeQueue: { findUnique: async () => null, upsert: async ({ create }: any) => { queued.push(create.signalId); return create; } }, paperOrder: { findFirst: async () => null }, aiSignal: { findUnique: async () => jumped } } as any;
  const service = new PaperTradingService(prisma as never, new PaperOrderExecutionService());
  (service as any).account = async () => account;
  (service as any).drainDemoQueue = async () => false;
  await service.captureTriggeredDemoSignals('user-1', [jumped] as never);
  assert.deepEqual(queued, ['signal-TARGET2_HIT']);
});

test('legacy/manual create path cannot create a paper order', async () => {
  let creates = 0;
  const service = new PaperTradingService({ paperOrder: { create: async () => { creates += 1; } } } as never, new PaperOrderExecutionService());
  assert.equal(await service.createTrade('user-1', { instrumentKey: 'NSE_EQ|TEST' }), false);
  assert.equal(creates, 0);
});


const at = new Date('2026-09-10T05:00:00Z');
function setup(sides = ['BUY', 'SELL']) {
  const signals = sides.map((side, index) => ({ ...signal('TARGET1_HIT'), id: `signal-${index}`, side,
    signalTime: new Date(at.getTime() - 120_000), target1At: new Date(at.getTime() - 90_000), updatedAt: at,
    top100Selected: true, events: [{ type: 'TARGET1_HIT', eventTime: new Date(at.getTime() - 90_000) }], currentPrice: 100, target1: side === 'BUY' ? 99 : 101, stopLoss: side === 'BUY' ? 95 : 105, target3: side === 'BUY' ? 105 : 95 }));
  const queue: any[] = signals.map((row, index) => ({ id: `queue-${index}`, signalId: row.id, status: 'WAITING_FOR_CAPITAL', queuedAt: row.target1At }));
  const orders: any[] = [];
  const wallet = { ...account };
  const prisma: any = {
    paperOrder: {
      findMany: async ({ where }: any) => where.status ? orders.filter(row => row.status === where.status) : orders,
      findUnique: async ({ where }: any) => orders.find(row => row.signalId === where.signalId_portfolio.signalId) ?? null,
      findUniqueOrThrow: async ({ where }: any) => orders.find(row => row.id === where.id),
      create: async ({ data }: any) => { const row = { id: `order-${orders.length}`, ...data }; orders.push(row); return row; },
      update: async ({ where, data }: any) => Object.assign(orders.find(row => row.id === where.id), data),
    },
    demoTradeQueue: {
      findMany: async () => queue,
      upsert: async ({ where, create, update }: any) => { const existing = queue.find(row => row.signalId === where.signalId_portfolio.signalId); if (existing) return Object.assign(existing, update); const added = { id: `queue-${queue.length}`, ...create }; queue.push(added); return added; },
      findFirst: async ({ where }: any) => queue.find(row => row.status === 'WAITING_FOR_CAPITAL' && !where.id.notIn.includes(row.id)),
      update: async ({ where, data }: any) => Object.assign(queue.find(row => row.id === where.id), data),
    },
    aiSignal: { findUnique: async ({ where }: any) => signals.find(row => row.id === where.id), findMany: async () => signals.filter(row => row.events.length > 0) },
    paperTradingAccount: { update: async ({ data }: any) => { if (data.realizedPnl) wallet.realizedPnl += data.realizedPnl.increment; return wallet; } },
    $transaction: async (operations: any) => typeof operations === 'function' ? operations(prisma) : Promise.all(operations),
  };
  const prices = new MarketPricesService();
  for (const row of signals) prices.accept('user-1', row.instrumentKey, row.currentPrice, at.getTime());
  const service = new PaperTradingService(prisma, new PaperOrderExecutionService(), prices);
  (service as any).account = async () => wallet;
  (service as any).reconcileTriggeredDemoSignals = async (userId: string, time: Date) => service.drainDemoQueue(userId, time, 'SIGNAL_HISTORY');
  return { service, signals, queue, orders, wallet, prices };
}

test('BUY and SELL enter at current price with full margin even when Target 1 is older than 60 seconds', async () => {
  for (const side of ['BUY', 'SELL']) {
    const { service, orders } = setup([side]);
    assert.equal(await service.drainDemoQueue('user-1', at, 'SIGNAL_HISTORY'), true);
    assert.equal(orders[0].side, side);
    assert.equal(orders[0].entryPrice, 100);
    assert.equal(orders[0].quantity, 500);
    assert.equal(orders[0].budget, 10_000);
    assert.equal(orders[0].investment, 50_000);
  }
});

test('concurrent drains open only one position and preserve the next candidate', async () => {
  const { service, orders, queue } = setup();
  await Promise.all([service.drainDemoQueue('user-1', at, 'SIGNAL_HISTORY'), service.drainDemoQueue('user-1', at, 'SIGNAL_HISTORY')]);
  assert.equal(orders.length, 1);
  assert.equal(queue[1].status, 'WAITING_FOR_CAPITAL');
  assert.equal(await service.drainDemoQueue('user-1', at, 'SIGNAL_HISTORY'), false);
});

test('closing one position opens the next and credits its P&L only once', async () => {
  const { service, orders, wallet } = setup();
  await service.drainDemoQueue('user-1', at, 'SIGNAL_HISTORY');
  await Promise.all([(service as any).close(orders[0].id, 105, 'TARGET', at), (service as any).close(orders[0].id, 105, 'TARGET', at)]);
  assert.equal(orders.length, 2);
  assert.equal(orders.filter(row => row.status === 'OPEN').length, 1);
  assert.equal(orders[1].side, 'SELL');
  assert.equal(wallet.realizedPnl, 2500);
  assert.equal(orders[1].budget, 12500);
});

test('completed, stopped and prior-session signals cannot open positions', async () => {
  for (const invalid of [{ completedAt: at }, { stopLossAt: at }, { signalTime: new Date('2026-09-09T05:00:00Z') }]) {
    const { service, signals, orders, queue } = setup(['BUY']);
    Object.assign(signals[0], invalid);
    await service.drainDemoQueue('user-1', at, 'SIGNAL_HISTORY');
    assert.equal(orders.length, 0);
    assert.equal(queue[0].status, 'REJECTED');
  }
});

test('the newest candidate waits for a fresh quote without falling back to an older candidate', async () => {
  for (const invalid of [{ updatedAt: new Date(at.getTime() - 61_000) }]) {
    const { service, signals, orders, queue, prices } = setup();
    Object.assign(signals[0], invalid);
    prices.get('user-1', signals[0].instrumentKey)!.receivedAt = Date.now() - 61_000;
    await service.drainDemoQueue('user-1', at, 'SIGNAL_HISTORY');
    assert.equal(orders.length, 0);
    assert.equal(queue[0].status, 'WAITING_FOR_CAPITAL');
    signals[0].updatedAt = at;
    prices.accept('user-1', signals[0].instrumentKey, 100, at.getTime() + 1);
    await service.drainDemoQueue('user-1', at, 'SIGNAL_HISTORY');
    assert.equal(orders[0].side, 'BUY');
  }
});

test('the entry window prevents new positions after intraday cutoff', async () => {
  const { service, orders } = setup();
  assert.equal(await service.drainDemoQueue('user-1', new Date('2026-09-10T10:00:00Z')), false);
  assert.equal(orders.length, 0);
});


test('legacy busy/stale rejections are restored while a history trade is active', async () => {
  for (const reason of ['Stale Target 1 event is not eligible for backfill', 'Another demo trade (TEST) is active', 'Signal must be listed on the AI Trade Strategy page before Target 1 and still be listed at entry']) {
    const { service, queue, orders } = setup(['BUY']);
    Object.assign(queue[0], { status: 'REJECTED', rejectReason: reason });
    orders.push({ id: 'busy', status: 'OPEN', signalId: 'other' });
    await service.drainDemoQueue('user-1', at, 'SIGNAL_HISTORY');
    assert.equal(queue[0].status, 'WAITING_FOR_CAPITAL');
    assert.equal(queue[0].rejectReason, null);
    assert.equal(orders.length, 1);
  }
});

test('strategy entries reject signals not currently listed', async () => {
  for (const invalid of [{ aiStrategyListed: false }, { aiStrategyListedAt: null }]) {
    const { service, signals, orders, queue } = setup(['BUY']);
    Object.assign(signals[0], invalid);
    assert.equal(await service.drainDemoQueue('user-1', at, 'STRATEGY', [signals[0].id]), false);
    assert.equal(orders.length, 0);
    assert.equal(queue[0].status, 'REJECTED');
  }
});


test('a listed SELL with Target 1 already hit enters despite later publication', async () => {
  const { service, signals, orders, prices } = setup(['SELL']);
  Object.assign(signals[0], { symbol: 'HINDCOPPER', currentPrice: 528.15, target1: 527.65, target3: 524.8, stopLoss: 532.4, aiStrategyListedAt: at });
  prices.accept('user-1', signals[0].instrumentKey, 528.15, at.getTime() + 1);
  assert.equal(await service.drainDemoQueue('user-1', at, 'SIGNAL_HISTORY'), true);
  assert.equal(orders[0].entryPrice, 528.15);
});

test('BUY Target 1 hit remains an entry trigger after price retraces', async () => {
  const { service, signals, orders, prices } = setup(['BUY']);
  signals[0].currentPrice = 98;
  prices.accept('user-1', signals[0].instrumentKey, 98, at.getTime() + 1);
  assert.equal(await service.drainDemoQueue('user-1', at, 'SIGNAL_HISTORY'), true);
  assert.equal(orders[0].entryPrice, 98);
});

 test('history execution rejects missing confirmed Target 1 events and running signals', async () => {
  for (const invalid of [{ events: [] }, { status: 'RUNNING' }]) {
    const { service, signals, orders, queue } = setup(['BUY']);
    Object.assign(signals[0], invalid);
    await service.drainDemoQueue('user-1', at, 'SIGNAL_HISTORY');
    assert.equal(orders.length, 0);
    assert.equal(queue[0].status, 'REJECTED');
  }
});

test('strategy capture rejects an old Target 1 despite later publication', async () => {
  const row = { ...signal('TARGET1_HIT'), symbol: 'EPL', signalTime: new Date(at.getTime() - 120_000), target1At: new Date(at.getTime() - 90_000), aiStrategyListedAt: at };
  const captured: any[] = [];
  const prisma: any = {
    demoTradeQueue: { findUnique: async () => null, upsert: async ({ create }: any) => captured.push(create) },
    paperOrder: { findFirst: async () => null },
    aiSignal: { findUnique: async () => row },
  };
  const service = new PaperTradingService(prisma, new PaperOrderExecutionService());
  (service as any).account = async () => account;
  (service as any).drainDemoQueue = async () => false;
  await service.captureTriggeredDemoSignals('user-1', [row], at);
  assert.equal(captured.find(row => row.portfolio === 'STRATEGY').status, 'REJECTED');
  assert.equal(captured.some(row => row.portfolio === 'SIGNAL_HISTORY'), false);
});

 test('LUMINO BUY enters immediately when listing follows Target 1 by milliseconds', async () => {
  const { service, signals, orders } = setup(['BUY']);
  Object.assign(signals[0], { symbol: 'LUMINO', aiStrategyListedAt: new Date(signals[0].target1At.getTime() + 430) });
  assert.equal(await service.drainDemoQueue('user-1', at, 'SIGNAL_HISTORY'), true);
  assert.equal(orders[0].symbol, 'LUMINO');
  assert.equal(orders[0].entryTime.getTime(), at.getTime());
});

 test('strategy BUY and SELL fill exactly at Target 1 on the event timestamp', async () => {
  for (const side of ['BUY', 'SELL']) {
    const { service, signals, orders } = setup([side]);
    signals[0].target1At = at;
    signals[0].target1 = 279.26;
    signals[0].currentPrice = 278;
    await service.drainDemoQueue('user-1', at, 'STRATEGY', [signals[0].id]);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].entryPrice, 279.26);
    assert.equal(orders[0].entryTime.getTime(), at.getTime());
  }
});

test('strategy never drains old Target 1 signals after restart, refresh or slot release', async () => {
  const { service, orders, queue } = setup();
  await service.drainDemoQueue('user-1', at);
  assert.equal(orders.length, 0);
  assert.ok(queue.every(row => row.status === 'REJECTED'));
  assert.equal(await PaperTradingService.prototype.reconcileTriggeredDemoSignals.call(service, 'user-1', at, 'STRATEGY'), false);
});

test('strategy skips a fresh Target 1 when its slot is occupied', async () => {
  const now = new Date();
  const row = { ...signal('TARGET1_HIT'), target1At: now };
  const captured: any[] = [];
  const prisma: any = {
    demoTradeQueue: { findUnique: async () => null, upsert: async ({ create }: any) => captured.push(create) },
    paperOrder: { findFirst: async () => ({ id: 'busy', symbol: 'OTHER' }) },
    aiSignal: { findUnique: async () => row },
  };
  const service = new PaperTradingService(prisma, new PaperOrderExecutionService());
  (service as any).account = async () => account;
  (service as any).drainDemoQueue = async () => false;
  await service.captureTriggeredDemoSignals('user-1', [row], now);
  const skipped = captured.find(item => item.portfolio === 'STRATEGY');
  assert.equal(skipped.status, 'REJECTED');
  assert.match(skipped.rejectReason, /slot occupied/);
});

test('a fresh gap through all targets can fill at Target 1 without admitting old completed signals', async () => {
  const { service, signals, orders } = setup(['BUY']);
  Object.assign(signals[0], { status: 'COMPLETED', target1At: at, completedAt: at, currentPrice: 110 });
  assert.equal(await service.drainDemoQueue('user-1', at, 'STRATEGY', [signals[0].id]), true);
  assert.equal(orders[0].entryPrice, signals[0].target1);
  const old = setup(['BUY']);
  Object.assign(old.signals[0], { status: 'COMPLETED', completedAt: new Date(at.getTime() - 1000) });
  assert.equal(await old.service.drainDemoQueue('user-1', at, 'STRATEGY', [old.signals[0].id]), false);
  assert.equal(old.orders.length, 0);
});
