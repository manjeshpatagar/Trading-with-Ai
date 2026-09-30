import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as protobuf from 'protobufjs';
import { MarketPricesService } from './market-prices.service';
import { MarketGateway } from './market.gateway';
import { PaperTradingService } from './paper-trading.service';
import { PaperOrderExecutionService } from './paper-order-execution.service';
import { markPosition } from './live-price';

const key = 'NSE_EQ|INE852O01025';
const now = Date.now();
test('live marks are ordered and account/instrument isolated; late polls cannot roll back a tick', () => {
  const prices = new MarketPricesService();
  const first = prices.accept('u', key, 238.26, now)!;
  const second = prices.accept('u', key, 237.8, now + 1)!;
  assert.equal(prices.accept('u', key, 238.26, now), null);
  assert.equal(prices.accept('u', key, 238.26, now + 2, now + 2, first.sequence), null);
  assert.equal(prices.accept('u', key, 238.26, now + 1)!.ltp, 238.26, 'ordered same-time stream prices are retained');
  const revision = prices.get('u', key)!.sequence;
  assert.equal(prices.accept('u', key, 239, now + 1, now + 2, revision), null, 'same-time conflicting REST snapshot is rejected');
  assert.ok(prices.accept('u', key, 237.5, now + 2)!.sequence > second.sequence);
  assert.equal(prices.get('u', key)!.ltp, 237.5);
  assert.equal(prices.get('other', key), undefined);
  assert.equal(prices.accept('u', 'NSE_EQ|OTHER', 0, now), null);
  prices.get('u', key)!.receivedAt = now - 16_000;
  assert.equal(prices.fresh('u', key, now), undefined);
});

test('BUY and SELL marks recalculate P&L on every quote and never alter closed fills', () => {
  const order = { instrumentKey: key, status: 'OPEN', side: 'SELL', currentPrice: 238.26, entryPrice: 238.26, plannedEntry: 238.26, quantity: 100, pnl: 0, pnlPercent: 0 };
  for (const ltp of [238.26, 237.8, 237.5]) {
    const quote = { instrumentKey: key, ltp, timestamp: now, sequence: 1, receivedAt: now };
    const sell = markPosition(order, quote), buy = markPosition({ ...order, side: 'BUY' }, quote);
    assert.ok(Math.abs(sell.pnl - (238.26 - ltp) * 100) < 1e-8);
    assert.ok(Math.abs(sell.pnl + buy.pnl) < 1e-8);
    assert.equal(sell.pnlPercent, sell.pnl / 23826 * 100);
    const closed = { ...order, status: 'CLOSED' };
    assert.equal(markPosition(closed, quote), closed);
  }
});

function gateway(prices: MarketPricesService, upstox: any = {}) {
  const emitted: any[] = [], processed: any[] = [];
  const gateway = new MarketGateway(upstox, {} as never, {} as never, {} as never, prices);
  gateway.server = { to: () => ({ emit: (event: string, data: any) => emitted.push({ event, data }) }), sockets: { adapter: { rooms: new Map() } } } as never;
  (gateway as any).queueTradingTick = async (...args: any[]) => { processed.push(args); };
  return { gateway, emitted, processed };
}
const proto = protobuf.parse('syntax="proto3"; message LTPC { double ltp=1; int64 ltt=2; } message Feed { LTPC ltpc=1; } message FeedResponse { map<string, Feed> feeds=2; int64 currentTs=3; }').root.lookupType('FeedResponse');
function tick(price: number, timestamp: number) { return Buffer.from(proto.encode(proto.create({ feeds: { [key]: { ltpc: { ltp: price, ltt: timestamp } } }, currentTs: timestamp })).finish()); }

test('gateway rejects late exchange ticks before broadcasting or evaluating targets/stops', () => {
  const { gateway: market, emitted, processed } = gateway(new MarketPricesService());
  for (const [price, offset] of [[238.26, 0], [237.8, 1], [237.5, 2], [239, 1]]) (market as any).handle('u', tick(price, now + offset));
  assert.deepEqual(emitted.filter(item => item.event === 'market-price-updated').map(item => item.data.ltp), [238.26, 237.8, 237.5]);
  assert.deepEqual(processed.map(args => args[2]), [238.26, 237.8, 237.5]);
  assert.equal(market.latestPrice(key), 237.5);
});

test('poll fallback maps NSE instrument tokens and discards a response overtaken by a tick', async () => {
  const prices = new MarketPricesService();
  let resolve!: (value: any) => void;
  const { gateway: market, processed } = gateway(prices, { ltp: () => new Promise(r => { resolve = r; }) });
  const polling = (market as any).fallbackToLtp('u', 'test', [key]);
  (market as any).handle('u', tick(237.5, now + 5));
  resolve({ data: { 'NSE_EQ:APTUS': { instrument_token: key, last_price: 238.26 } } });
  await polling;
  assert.deepEqual(processed.map(args => args[2]), [237.5]);
  const correct = gateway(new MarketPricesService(), { ltp: async () => ({ data: { 'NSE_EQ:APTUS': { instrument_token: key, last_price: 237.8 } } }) });
  await (correct.gateway as any).fallbackToLtp('u', 'test', [key]);
  assert.equal(correct.processed[0][1], key);
  assert.equal(correct.processed[0][2], 237.8);
  const wrong = gateway(new MarketPricesService(), { ltp: async () => ({ data: { [key]: { instrument_token: 'NSE_EQ|OTHER', last_price: 999 } } }) });
  await (wrong.gateway as any).fallbackToLtp('u', 'test', [key]);
  assert.equal(wrong.processed.length, 0);
});

test('manual exit uses the shared live quote, and refuses a DB-only fill', async () => {
  const prices = new MarketPricesService();
  const order = { id: 'order', currentPrice: 238.26, instrumentKey: key };
  const paper = new PaperTradingService({ paperOrder: { findFirst: async () => order } } as never, new PaperOrderExecutionService(), prices);
  const fills: number[] = [];
  (paper as any).close = async (_id: string, price: number) => fills.push(price);
  assert.equal(await paper.manualExit('u', 'order', 'SIGNAL_HISTORY'), false);
  prices.accept('u', key, 237.5, Date.now());
  assert.equal(await paper.manualExit('u', 'order', 'SIGNAL_HISTORY'), true);
  assert.deepEqual(fills, [237.5]);
});

test('disconnected feed keeps short polling and schedules reconnection', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { gateway: market } = gateway(new MarketPricesService());
  const internal = market as any;
  internal.keys.set('u', new Set([key]));
  let polls = 0, reconnects = 0;
  internal.fallbackToLtp = async () => { polls++; };
  internal.connect = async () => { reconnects++; };
  internal.startHeartbeat('u');
  internal.cleanupSocket('u');
  internal.scheduleReconnect('u');
  t.mock.timers.tick(3_000);
  assert.equal(reconnects, 1);
  t.mock.timers.tick(2_000);
  assert.equal(polls, 1, 'heartbeat fallback survives socket close');
  market.onModuleDestroy();
});

test('every accepted price updates open P&L and evaluates target/stop immediately for both sides', async () => {
  for (const side of ['BUY', 'SELL']) {
    const order = { id: 'o', instrumentKey: key, portfolio: 'SIGNAL_HISTORY', side, entryPrice: 238.26, quantity: 100, currentPrice: 238.26, target: side === 'SELL' ? 237.5 : 239, stopLoss: side === 'SELL' ? 239 : 237.5 };
    const marks: any[] = [], exits: any[] = [];
    const paper = new PaperTradingService({
      paperTradingAccount: { findMany: async () => [{ portfolio: 'SIGNAL_HISTORY', enabled: true, allowAiWait: false }] },
      paperOrder: { findMany: async () => [order], update: async ({ data }: any) => marks.push(data) },
    } as never, new PaperOrderExecutionService());
    (paper as any).close = async (...args: any[]) => exits.push(args);
    await paper.processTick('u', key, 237.8);
    assert.equal(marks[0].currentPrice, 237.8);
    assert.ok(Math.abs(marks[0].pnl - (side === 'SELL' ? 46 : -46)) < 1e-8);
    await paper.processTick('u', key, 237.5);
    assert.equal(exits[0][1], 237.5);
    assert.equal(exits[0][2], side === 'SELL' ? 'TARGET' : 'STOP LOSS');
  }
});

test('zero last-trade timestamp falls back to actual provider feed time, never invented receive time',()=> {
  const {gateway:market}=gateway(new MarketPricesService());
  const buffer=(ltt:number,currentTs:number)=>Buffer.from(proto.encode(proto.create({feeds:{[key]:{ltpc:{ltp:238,ltt}}},currentTs})).finish());
  (market as any).handle('u',buffer(0,now));
  assert.equal(market.latestUserSnapshot('u',key)!.timestamp,now);
  assert.equal(market.latestUserSnapshot('u',key)!.timestampTrusted,true);
  const {gateway:missing}=gateway(new MarketPricesService());
  (missing as any).handle('u',buffer(0,0));
  assert.equal(missing.latestUserSnapshot('u',key)!.timestampTrusted,false);
});

 test('same-timestamp target touch and pullback both reach execution in arrival order', () => {
  const { gateway: market, emitted, processed } = gateway(new MarketPricesService());
  for (const price of [262.1, 263.66, 262.49, 258.74]) (market as any).handle('u', tick(price, now));
  assert.deepEqual(processed.map(args => args[2]), [262.1, 263.66, 262.49, 258.74]);
  assert.deepEqual(emitted.filter(item => item.event === 'market-price-updated').map(item => item.data.ltp), [262.1, 263.66, 262.49, 258.74]);
  assert.equal(market.latestPrice(key), 258.74);
});
