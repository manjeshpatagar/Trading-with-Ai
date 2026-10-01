import { MarketPricesService } from './market-prices.service';
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateDemoIntradayPosition, PaperTradingService } from './paper-trading.service';
import { PaperOrderExecutionService } from './paper-order-execution.service';

const account = { enabled: true, autoDemoTrading: true, startingBalance: 10_000, realizedPnl: 0, maxOpenTrades: 1, riskPerTrade: 2 };
const signal = (status: string) => ({ id: `signal-${status}`, userId: 'user-1', instrumentKey: 'NSE_EQ|TEST', symbol: 'TEST', side: 'SELL', entryPrice: 100, currentPrice: 98, confidence: 95, aiScore: 95, riskReward: 2, signalTime: new Date(Date.now() - 1_000), status, entryTriggeredAt: new Date(), runningAt: ['RUNNING', 'TARGET1_HIT'].includes(status) ? new Date() : null, target1At: status === 'TARGET1_HIT' ? new Date() : null, stopLossAt: null, completedAt: null, aiStrategyListed: true, aiStrategyListedAt: new Date(0) });

test('intraday quantity obeys the risk budget before margin', () => {
  const sizing = calculateDemoIntradayPosition({ capital: 10_000, accountBalance: 10_000, entryPrice: 100, stopLoss: 99, riskPercent: 1, leverage: 5 });
  assert.equal(sizing.marginQuantity, 500);
  assert.equal(sizing.riskQuantity, 100);
  assert.equal(sizing.quantity, 100);
  assert.equal(sizing.marginUsed, 2_000);
  assert.equal(sizing.notionalValue, 10_000);
});

test('strategy capture only queues Target 1 signals', async () => {
  const queued: string[] = [];
  const prisma = { demoTradeQueue: { findUnique: async () => null, upsert: async ({ create }: any) => { queued.push(create.signalId); return create; } }, paperOrder: { findFirst: async () => null }, aiSignal: { findUnique: async () => signal('TARGET1_HIT') } };
  const service = new PaperTradingService(prisma as never, new PaperOrderExecutionService());
  (service as any).account = async () => account;
  (service as any).drainDemoQueueUnlocked = async () => false;
  await service.captureTriggeredDemoSignals('user-1', [signal('WAITING'), signal('ENTRY_TRIGGERED'), signal('RUNNING'), signal('TARGET1_HIT')] as never);
  assert.deepEqual(queued, ['signal-TARGET1_HIT']);
});

test('a live signal that jumps through Target 1 to Target 2 still enters the queue', async () => {
  const queued: string[] = [];
  const jumped = { ...signal('TARGET1_HIT'), id: 'signal-TARGET2_HIT', status: 'TARGET2_HIT' };
  const prisma = { demoTradeQueue: { findUnique: async () => null, upsert: async ({ create }: any) => { queued.push(create.signalId); return create; } }, paperOrder: { findFirst: async () => null }, aiSignal: { findUnique: async () => jumped } } as any;
  const service = new PaperTradingService(prisma as never, new PaperOrderExecutionService());
  (service as any).account = async () => account;
  (service as any).drainDemoQueueUnlocked = async () => false;
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
  const queue: any[] = signals.map((row, index) => ({ id: `queue-${index}`, signalId: row.id, status: 'PENDING_EXECUTION', queuedAt: row.target1At, portfolio: 'STRATEGY' }));
  const orders: any[] = [];
  const wallet = { ...account };
  const prisma: any = {
    paperOrder: {
      findMany: async ({ where }: any) => orders.filter(row => (!where.status || row.status === where.status) && (!where.portfolio || row.portfolio === where.portfolio) && (!where.instrumentKey || row.instrumentKey === where.instrumentKey)),
      findFirst: async ({ where }: any) => orders.find(row => row.portfolio === where.portfolio && (where.OR ? where.OR.some((rule: any) => rule.status ? row.status === rule.status : row.exitTime && row.exitTime >= rule.exitTime.gte) : row.status === where.status)) ?? null,
      findUnique: async ({ where }: any) => orders.find(row => row.signalId === where.signalId_portfolio.signalId) ?? null,
      findUniqueOrThrow: async ({ where }: any) => orders.find(row => row.id === where.id),
      create: async ({ data }: any) => { const row = { id: `order-${orders.length}`, ...data }; orders.push(row); return row; },
      update: async ({ where, data }: any) => Object.assign(orders.find(row => row.id === where.id), data),
      updateMany: async ({ where, data }: any) => { const row = orders.find(row => row.id === where.id && row.status === where.status); if (row) Object.assign(row, data); return { count: row ? 1 : 0 }; },
    },
    demoTradeQueue: {
      findUnique: async ({ where }: any) => queue.find(row => where.id ? row.id === where.id : row.signalId === where.signalId_portfolio.signalId && row.portfolio === where.signalId_portfolio.portfolio) ?? null,
      findMany: async ({ where }: any) => queue.filter(row => row.status === where.status),
      upsert: async ({ where, create, update }: any) => { const existing = queue.find(row => row.signalId === where.signalId_portfolio.signalId); if (existing) return Object.assign(existing, update); const added = { id: `queue-${queue.length}`, ...create }; queue.push(added); return added; },
      findFirst: async ({ where }: any) => queue.find(row => row.status === where.status && !where.id.notIn.includes(row.id) && (!where.signalId || where.signalId.in.includes(row.signalId))),
      update: async ({ where, data }: any) => Object.assign(queue.find(row => row.id === where.id), data),
      updateMany: async ({ where, data }: any) => {
        const matches = queue.filter(row => row.status === where.status && where.signalId.in.includes(row.signalId));
        matches.forEach(row => Object.assign(row, data));
        return { count: matches.length };
      },
    },
    aiSignal: { findUnique: async ({ where }: any) => signals.find(row => row.id === where.id), findMany: async () => signals.filter(row => row.events.length > 0) },
    paperTradingAccount: { findMany: async () => [{ ...wallet, portfolio: 'STRATEGY' }], update: async ({ data }: any) => { if (data.realizedPnl) wallet.realizedPnl += data.realizedPnl.increment; return wallet; } },
    $transaction: async (operations: any) => typeof operations === 'function' ? operations(prisma) : Promise.all(operations),
  };
  const prices = new MarketPricesService();
  for (const row of signals) prices.accept('user-1', row.instrumentKey, row.currentPrice, at.getTime());
  const service = new PaperTradingService(prisma, new PaperOrderExecutionService(), prices);
  (service as any).account = async () => wallet;
  return { service, signals, queue, orders, wallet, prices };
}

test('the entry window prevents new positions after intraday cutoff', async () => {
  const { service, orders } = setup();
  assert.equal(await service.drainDemoQueue('user-1', new Date('2026-09-10T10:00:00Z')), false);
  assert.equal(orders.length, 0);
});

test('strategy entries reject scanner signals outside the Strategy list', async () => {
  for (const membership of [{ top100Selected: true, aiStrategyListed: false, aiStrategyListedAt: null }, { top100Selected: true, aiStrategyListed: true, aiStrategyListedAt: null }, { top100Selected: true, aiStrategyListed: true, aiStrategyListedAt: new Date(at.getTime() + 1000) }]) {
    const { service, signals, orders } = setup(['BUY']);
    Object.assign(signals[0], membership, { target1At: at });
    assert.equal(await service.drainDemoQueue('user-1', at, 'STRATEGY', [signals[0].id]), false);
    assert.equal(orders.length, 0);
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
  (service as any).drainDemoQueueUnlocked = async () => false;
  await service.captureTriggeredDemoSignals('user-1', [row], at);
  assert.equal(captured.find(row => row.portfolio === 'STRATEGY').status, 'REJECTED');
  assert.equal(captured.some(row => row.portfolio === 'SIGNAL_HISTORY'), false);
});

test('strategy BUY and SELL use the observed quote on the event timestamp', async () => {
  for (const side of ['BUY', 'SELL']) {
    const { service, signals, orders, prices } = setup([side]);
    signals[0].target1At = at;
    signals[0].target1 = 279.26;
    signals[0].currentPrice = 278;
    signals[0].stopLoss = side === 'BUY' ? 275 : 283;
    signals[0].target3 = side === 'BUY' ? 290 : 270;
    prices.accept('user-1', signals[0].instrumentKey, 278, at.getTime());
    await service.drainDemoQueue('user-1', at, 'STRATEGY', [signals[0].id]);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].entryPrice, 278);
    assert.equal(orders[0].entryTime.getTime(), at.getTime());
  }
});

test('strategy never drains old Target 1 signals after restart, refresh or slot release', async () => {
  const { service, orders, queue } = setup();
  queue.forEach(row => { row.status = 'WAITING_FOR_CAPITAL'; });
  await service.drainDemoQueue('user-1', at);
  assert.equal(orders.length, 0);
  assert.ok(queue.every(row => row.status !== 'EXECUTED'));
  await service.drainDemoQueue('user-1', new Date(at.getTime() + 1000));
  assert.equal(orders.length, 0);
  assert.equal(await PaperTradingService.prototype.reconcileTriggeredDemoSignals.call(service, 'user-1', at, 'STRATEGY'), false);
});

test('strategy skips a fresh Target 1 when its slot is occupied', async () => {
  const now = at;
  const row = { ...signal('TARGET1_HIT'), target1At: now };
  const captured: any[] = [];
  const prisma: any = {
    demoTradeQueue: { findUnique: async () => null, upsert: async ({ create }: any) => captured.push(create) },
    paperOrder: { findFirst: async () => ({ id: 'busy', symbol: 'OTHER' }) },
    aiSignal: { findUnique: async () => row },
  };
  const service = new PaperTradingService(prisma, new PaperOrderExecutionService());
  (service as any).account = async () => account;
  (service as any).drainDemoQueueUnlocked = async () => false;
  await service.captureTriggeredDemoSignals('user-1', [row], now);
  const skipped = captured.find(item => item.portfolio === 'STRATEGY');
  assert.equal(skipped.status, 'REJECTED');
  assert.match(skipped.rejectReason, /slot occupied/);
});

test('a gap beyond all targets cannot manufacture an entry at an earlier target', async () => {
  const { service, signals, orders, prices } = setup(['BUY']);
  prices.accept('user-1', signals[0].instrumentKey, 110, at.getTime());
  Object.assign(signals[0], { status: 'COMPLETED', target1At: at, completedAt: at, currentPrice: 110 });
  assert.equal(await service.drainDemoQueue('user-1', at, 'STRATEGY', [signals[0].id]), false);
  assert.equal(orders.length, 0);
  const old = setup(['BUY']);
  Object.assign(old.signals[0], { status: 'COMPLETED', completedAt: new Date(at.getTime() - 1000) });
  assert.equal(await old.service.drainDemoQueue('user-1', at, 'STRATEGY', [old.signals[0].id]), false);
  assert.equal(old.orders.length, 0);
});

test('history refreshes and queue drains cannot backfill old Target 1 hits', async () => {
  const { service, orders } = setup();
  assert.equal(await service.drainDemoQueue('user-1', at, 'SIGNAL_HISTORY'), false);
  assert.equal(await PaperTradingService.prototype.reconcileTriggeredDemoSignals.call(service, 'user-1', at, 'SIGNAL_HISTORY'), false);
  assert.deepEqual(await service.historyTargetQueue('user-1', at), []);
  assert.equal(orders.length, 0);
});

test('Signal History demo execution is attempted even if Strategy capture fails', async () => {
  const service = new PaperTradingService({} as never, new PaperOrderExecutionService());
  const portfolios: string[] = [];
  (service as any).capturePortfolio = async (_user: string, portfolio: string) => {
    portfolios.push(portfolio);
    if (portfolio === 'STRATEGY') throw new Error('strategy unavailable');
    return true;
  };
  assert.equal(await service.captureTriggeredDemoSignals('u', []), true);
  assert.deepEqual(portfolios, ['STRATEGY', 'SIGNAL_HISTORY']);
});
