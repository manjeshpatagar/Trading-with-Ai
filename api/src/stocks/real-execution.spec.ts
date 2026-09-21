import { test, before, beforeEach, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { RealExecutionService } from './real-execution.service';
import { MarketPricesService } from './market-prices.service';
import { brokerTerminal, liveSource, realExitReason } from './real-trading-rules';
import { MarketGateway } from './market.gateway';

const directory = mkdtempSync(join(tmpdir(), 'real-execution-'));
const url = `file:${join(directory, 'test.db')}`;
const db = new PrismaClient({ datasources: { db: { url } } });
const at = (time: string) => new Date(`2026-09-21T${time}+05:30`);
before(async () => {
  const sql = execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', join(__dirname, '../../prisma/schema.prisma'), '--script'], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: url } });
  for (const statement of sql.split(';').map(item => item.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
});
beforeEach(async () => { await db.realTradingControl.deleteMany(); await db.realTrade.deleteMany(); });
after(async () => { await db.$disconnect(); rmSync(directory, { recursive: true, force: true }); });

class Broker {
  cash = 20000;
  marginPerShare = 20;
  orders: any[] = [];
  positionsData: any[] = [];
  submitted: any[] = [];
  loseAcknowledgement = false;
  holdEntry = false;
  rejectEntry = false;
  preflight?: () => Promise<void>;
  profile = async () => ({ status: 'success', data: {} });
  funds = async () => { await this.preflight?.(); return { data: { equity: { available_margin: this.cash } } }; };
  positions = async () => ({ status: 'success', data: this.positionsData });
  orderBook = async () => ({ status: 'success', data: this.orders });
  intradayMargin = async (_user: string, _key: string, _side: string, quantity: number) => quantity * this.marginPerShare;
  realOrderDetails = async (_user: string, id: string) => ({ data: this.orders.find(order => order.order_id === id) });
  cancelRealOrder = async (_user: string, id: string) => { this.orders.find(order => order.order_id === id).status = 'cancelled'; return { status: 'success' }; };
  placeIntradayMarket = async (_user: string, key: string, side: string, quantity: number, tag: string) => {
    this.submitted.push({ key, side, quantity, tag });
    const entry = this.orders.length === 0;
    const held = entry && this.holdEntry;
    const rejected = entry && this.rejectEntry;
    const order = { order_id: randomUUID(), instrument_token: key, product: 'I', tag, status: rejected ? 'rejected' : held ? 'open' : 'complete', filled_quantity: held || rejected ? 0 : quantity, average_price: 101, status_message: rejected ? 'Broker rejected order' : null };
    this.orders.push(order);
    if (!held && !rejected) {
      const previous = this.positionsData.find(row => row.instrument_token === key);
      const signed = side === 'BUY' ? quantity : -quantity;
      if (previous) previous.quantity += signed;
      else this.positionsData.push({ instrument_token: key, product: 'I', quantity: signed });
    }
    if (this.loseAcknowledgement) { this.loseAcknowledgement = false; throw new Error('Timeout after broker accepted order'); }
    return { status: 'success', data: { order_ids: [order.order_id] } };
  };
}
async function fixture(t: any, side = 'BUY') {
  t.mock.timers.enable({ apis: ['Date'], now: at('10:00:00').getTime() });
  const user = await db.user.create({ data: { upstoxUserId: randomUUID() } });
  const broker = new Broker();
  const prices = new MarketPricesService();
  const service = new RealExecutionService(db as never, broker as never, prices);
  (service as any).startedAt = at('09:59:00');
  await service.control(user.id);
  await db.realTradingControl.update({ where: { userId: user.id }, data: { strategyEnabledAt: at('09:59:00'), historyEnabledAt: at('09:59:00') } });
  const signal = await stock(user.id, 'FIRST', side);
  prices.accept(user.id, signal.instrumentKey, 101, at('10:00:00').getTime());
  return { user: user.id, broker, prices, service, signal };
}
async function stock(userId: string, symbol: string, side = 'BUY', extra: Record<string, any> = {}) {
  return db.aiSignal.create({ data: { userId, signalKey: randomUUID(), instrumentKey: `NSE_EQ|${symbol}`, symbol, stockName: symbol, strategy: 'Momentum', timeframe: '5m', side,
    signalTime: at('09:30:00'), target1At: at('10:00:00'), currentPrice: 101, entryPrice: 100,
    target1: side === 'BUY' ? 101 : 102, target2: side === 'BUY' ? 105 : 98, target3: side === 'BUY' ? 110 : 95,
    stopLoss: side === 'BUY' ? 95 : 110, confidence: 95, aiScore: 95, riskReward: 2,
    aiStrategyListed: true, aiStrategyListedAt: at('09:30:00'), top100Selected: true, status: 'TARGET1_HIT', ...extra } });
}
async function settle(service: RealExecutionService, user: string) {
  for (let i = 0; i < 10000 && (service as any).running.has(user); i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal((service as any).running.has(user), false, 'broker work completed');
}
async function capture(f: Awaited<ReturnType<typeof fixture>>, signal = f.signal) {
  await f.service.capture(f.user, [signal.id], signal.target1At!);
  await settle(f.service, f.user);
}

test('fresh T1 eligibility is page-specific and requires activation before the hit', () => {
  const signal: any = { side: 'BUY', instrumentKey: 'NSE_EQ|TEST', signalTime: at('09:30:00'), target1At: at('10:00:00'), stopLossAt: null, completedAt: null, aiStrategyListed: false, aiStrategyListedAt: null, top100Selected: true, currentPrice: 101, target3: 110, stopLoss: 95 };
  const controls = { strategyEnabledAt: at('09:59:00'), historyEnabledAt: null };
  assert.equal(liveSource(signal, controls, at('10:00:00'), at('10:00:01')), null);
  assert.equal(liveSource(signal, { ...controls, historyEnabledAt: at('09:59:00') }, at('10:00:00'), at('10:00:01')), 'SIGNAL_HISTORY');
  assert.equal(liveSource(signal, { ...controls, historyEnabledAt: at('10:00:00') }, at('10:00:00'), at('10:00:01')), null);
  assert.equal(liveSource(signal, { ...controls, historyEnabledAt: at('09:59:00') }, at('10:00:00'), at('10:00:06')), null);
  assert.equal(realExitReason({ side: 'SELL', target: 95, stopLoss: 110 }, 111), 'STOP LOSS');
  assert.equal(brokerTerminal('open'), false);
});

test('both enabled pages share one slot, one order, broker margin and no duplicate hit', async t => {
  const f = await fixture(t);
  const second = await stock(f.user, 'SECOND', 'BUY', { aiStrategyListed: false, aiStrategyListedAt: null });
  f.prices.accept(f.user, second.instrumentKey, 101, at('10:00:00').getTime());
  await f.service.capture(f.user, [f.signal.id], at('10:00:00'));
  await f.service.capture(f.user, [second.id], at('10:00:00'));
  await settle(f.service, f.user);
  assert.equal(f.broker.submitted.length, 1);
  assert.equal(f.broker.submitted[0].quantity, 980); // 20,000 available, broker margin 20/share, 2% reserve
  await capture(f);
  assert.equal(f.broker.submitted.length, 1);
  assert.equal((await db.realTrade.findUniqueOrThrow({ where: { userId_signalId: { userId: f.user, signalId: second.id } } })).status, 'SKIPPED');
  await f.service.drive(f.user);
  assert.equal((await f.service.state(f.user)).trades.find(trade => trade.signalId === f.signal.id)?.status, 'OPEN');
});

test('OFF keeps exit management; subsequent fresh entries require an enabled page', async t => {
  const f = await fixture(t);
  await capture(f); await f.service.drive(f.user);
  await f.service.setEnabled(f.user, 'STRATEGY', false);
  await f.service.setEnabled(f.user, 'SIGNAL_HISTORY', false);
  assert.equal(f.broker.submitted.length, 1, 'OFF does not submit exit');
  t.mock.timers.setTime(at('10:01:00').getTime());
  await f.service.onPrice(f.user, f.signal.instrumentKey, 110, Date.now());
  await settle(f.service, f.user); await f.service.drive(f.user);
  assert.equal(f.broker.submitted.length, 2);
  assert.equal(f.broker.submitted[1].side, 'SELL');
  assert.equal((await f.service.state(f.user)).activeTradeId, null);
  const next = await stock(f.user, 'NEXT', 'BUY', { target1At: at('10:01:01') });
  t.mock.timers.setTime(at('10:01:01').getTime());
  await capture(f, next);
  assert.equal(f.broker.submitted.length, 2);
});

test('OFF during margin lookup cancels the entry before broker submission', async t => {
  const f = await fixture(t);
  f.broker.preflight = async () => { await f.service.setEnabled(f.user, 'STRATEGY', false); };
  await capture(f);
  assert.equal(f.broker.submitted.length, 0);
  assert.equal((await f.service.state(f.user)).activeTradeId, null);
});

test('uncertain broker acknowledgement is recovered by tag without a duplicate submission', async t => {
  const f = await fixture(t);
  f.broker.loseAcknowledgement = true;
  await capture(f);
  assert.equal(f.broker.submitted.length, 1);
  await f.service.drive(f.user);
  assert.equal(f.broker.submitted.length, 1);
  assert.equal((await f.service.state(f.user)).trades[0].status, 'OPEN');
});

test('partial entry is cancelled before exit and only its confirmed filled quantity closes', async t => {
  const f = await fixture(t);
  f.broker.holdEntry = true;
  await capture(f);
  const order = f.broker.orders[0];
  order.filled_quantity = 3;
  f.broker.positionsData = [{ instrument_token: f.signal.instrumentKey, product: 'I', quantity: 3 }];
  t.mock.timers.setTime(at('10:00:01').getTime());
  await f.service.onPrice(f.user, f.signal.instrumentKey, 94, Date.now());
  await settle(f.service, f.user);
  assert.equal(order.status, 'cancelled');
  await f.service.drive(f.user);
  assert.equal(f.broker.submitted[1].quantity, 3);
  await f.service.drive(f.user);
  assert.equal((await f.service.state(f.user)).trades[0].status, 'CLOSED');
});

test('EOD closes a SELL even with both switches OFF', async t => {
  const f = await fixture(t, 'SELL');
  await capture(f); await f.service.drive(f.user);
  await f.service.setEnabled(f.user, 'STRATEGY', false); await f.service.setEnabled(f.user, 'SIGNAL_HISTORY', false);
  t.mock.timers.setTime(at('15:25:00').getTime());
  await f.service.monitor(); await f.service.drive(f.user);
  assert.equal(f.broker.submitted[1].side, 'BUY');
  const state = await f.service.state(f.user);
  assert.equal(state.trades[0].exitReason, 'End of Day Auto Exit');
  assert.equal(state.activeTradeId, null);
});

test('restart reconciles an accepted entry instead of submitting it again', async t => {
  const f = await fixture(t); await capture(f);
  const restored = new RealExecutionService(db as never, f.broker as never, f.prices);
  await restored.monitor();
  assert.equal(f.broker.submitted.length, 1);
  assert.equal((await restored.state(f.user)).trades[0].status, 'OPEN');
});

test('external broker position blocks a new automated entry', async t => {
  const f = await fixture(t);
  f.broker.positionsData = [{ instrument_token: 'NSE_EQ|EXTERNAL', quantity: 1, product: 'I' }];
  await capture(f);
  assert.equal(f.broker.submitted.length, 0);
  assert.match((await f.service.state(f.user)).trades[0].error!, /already has/);
});

test('real feed admission preserves arrival order despite reversed lifecycle completion', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const stamp = Date.now();
  const gateway = new MarketGateway({} as never, {} as never, { processTick: async (_user: string, key: string) => {
    if (key === 'first') await gate;
    return [{ id: key, target1At: new Date(stamp) }];
  } } as never, { processTick: async () => false, captureTriggeredDemoSignals: async () => false } as never,
  new MarketPricesService(), { onPrice: async () => {}, capture: async (_user: string, ids: string[]) => { calls.push(ids[0]); } } as never);
  (gateway as any).server = { to: () => ({ emit: () => {} }) };
  const first = (gateway as any).queueTradingTick('u', 'first', 101, stamp, 'websocket');
  const second = (gateway as any).queueTradingTick('u', 'second', 101, stamp, 'websocket');
  await second;
  assert.deepEqual(calls, []);
  release(); await first;
  await (gateway as any).realTickQueues.get('u');
  assert.deepEqual(calls, ['first', 'second']);
});

test('closing releases the shared slot for the next fresh hit, not an earlier busy hit', async t => {
  const f = await fixture(t); await capture(f); await f.service.drive(f.user);
  const busy = await stock(f.user, 'BUSY', 'BUY');
  await capture(f, busy);
  t.mock.timers.setTime(at('10:01:00').getTime());
  await f.service.onPrice(f.user, f.signal.instrumentKey, 110, Date.now());
  await settle(f.service, f.user); await f.service.drive(f.user);
  assert.equal((await f.service.state(f.user)).activeTradeId, null);
  await capture(f, busy);
  assert.equal(f.broker.submitted.length, 2);
  t.mock.timers.setTime(at('10:01:01').getTime());
  const next = await stock(f.user, 'NEW', 'BUY', { target1At: at('10:01:01'), aiStrategyListed: false });
  f.prices.accept(f.user, next.instrumentKey, 101, Date.now());
  await capture(f, next);
  assert.equal(f.broker.submitted.length, 3);
  assert.equal((await f.service.state(f.user)).trades.find(trade => trade.signalId === next.id)?.source, 'SIGNAL_HISTORY');
});

test('two service instances cannot reserve or submit two competing real trades', async t => {
  const f = await fixture(t);
  const other = await stock(f.user, 'COMPETING', 'BUY');
  f.prices.accept(f.user, other.instrumentKey, 101, Date.now());
  const service2 = new RealExecutionService(db as never, f.broker as never, f.prices);
  (service2 as any).startedAt = at('09:59:00');
  await Promise.all([f.service.capture(f.user, [f.signal.id], at('10:00:00')), service2.capture(f.user, [other.id], at('10:00:00'))]);
  await settle(f.service, f.user); await settle(service2, f.user);
  assert.equal(f.broker.submitted.length, 1);
});

test('unfilled rejected entries release the slot while unknown submissions retain it', async t => {
  const f = await fixture(t); f.broker.rejectEntry = true;
  await capture(f); await f.service.drive(f.user);
  assert.equal((await f.service.state(f.user)).activeTradeId, null);
  const other = await stock(f.user, 'UNKNOWN', 'BUY', { target1At: at('10:00:01') });
  t.mock.timers.setTime(at('10:00:01').getTime()); f.prices.accept(f.user, other.instrumentKey, 101, Date.now());
  f.broker.placeIntradayMarket = async () => { throw new Error('Network response lost'); };
  await capture(f, other); await f.service.drive(f.user);
  assert.ok((await f.service.state(f.user)).activeTradeId);
  assert.equal((await f.service.state(f.user)).trades.find(trade => trade.signalId === other.id)?.status, 'ATTENTION');
});
