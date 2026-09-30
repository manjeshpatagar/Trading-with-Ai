import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { CapitalBroker, CapitalTrade, simulateTargetOneCapital } from './target-one-capital';
import { UpstoxService } from './upstox.service';
const at = (time: string, date = '2026-09-28') => `${date}T${time}:00+05:30`;
const trade = (id: string, start: string, end: string | null, exit = 150, extra: Partial<CapitalTrade> = {}): CapitalTrade => ({ id, instrumentKey: id, side: 'BUY', target1At: at(start), target1ObservedPrice: 100, completedAt: end ? at(end) : null, exitPrice: end ? exit : null, ...extra });
const broker = (fee = 0): CapitalBroker => ({ margin: async (_row, qty) => qty * 1000, charges: async () => ({ total: fee, brokerage: fee }) });

test('chronological whole-capital trades compound wins/losses and reset each IST day', async () => {
  const result = await simulateTargetOneCapital([
    trade('second', '10:02', '10:03', 50), trade('first', '10:00', '10:01'),
    trade('tomorrow', '10:00', '10:01', 150, { target1At: at('10:00', '2026-09-29'), completedAt: at('10:01', '2026-09-29') }),
  ], broker());
  assert.deepEqual(result.rows.map(row => [row.capitalBefore, row.netPnl, row.capitalAfter]), [[10000, 500, 10500], [10500, -500, 10000], [10000, 500, 10500]]);
  assert.equal(result.days[1].closingBalance, 10000);
});

test('reserves entry charges, deducts both legs, and sizes the next stock with its own margin', async () => {
  const provider: CapitalBroker = { margin: async (row, qty) => qty * (row.id === 'first' ? 1000 : 2000), charges: async () => ({ total: 10, brokerage: 5 }) };
  const result = await simulateTargetOneCapital([trade('first', '10:00', '10:01'), trade('second', '10:02', '10:03', 90, { side: 'SELL' })], provider);
  const [first, second] = result.rows;
  assert.equal(first.quantity, 9); assert.equal(first.grossPnl, 450); assert.equal(first.charges, 20); assert.equal(first.brokerage, 10); assert.equal(first.capitalAfter, 10430);
  assert.equal(second.quantity, 5); assert.equal(second.grossPnl, 50); assert.equal(second.netPnl, 30); assert.equal(second.capitalAfter, 10460);
  assert.deepEqual(result.days[0], { date: '2026-09-28', startingCapital: 10000, closingBalance: 10460, grossProfit: 500, grossLoss: 0, charges: 40, netPnl: 460, traded: 2, skipped: 0, open: 0, complete: true });
});

test('overlapping and simultaneous hits never reuse occupied capital or call the broker', async () => {
  const seen = new Set<string>(); const base = broker();
  const result = await simulateTargetOneCapital([
    trade('b', '10:00', '10:10'), trade('a', '10:00', '10:05'), trade('overlap', '10:04', '10:06'), trade('same-exit', '10:05', '10:06'), trade('next', '10:06', '10:07'),
  ], { ...base, margin: async (row, qty) => { seen.add(row.id); return base.margin(row, qty); } });
  assert.deepEqual([...seen], ['a', 'next']); assert.equal(result.days[0].skipped, 3);
});

test('open positions reserve capital, record entry fees only, and cannot fabricate daily closing P&L', async () => {
  const result = await simulateTargetOneCapital([trade('open', '10:00', null), trade('blocked', '10:02', '10:03')], broker(10));
  assert.equal(result.rows[0].status, 'OPEN'); assert.equal(result.rows[0].netPnl, null); assert.equal(result.rows[0].exitCharges, null);
  assert.equal(result.rows[1].status, 'SKIPPED'); assert.equal(result.days[0].closingBalance, null); assert.equal(result.days[0].netPnl, -10);
});

test('missing observed entries or broker quotes never invent zero charges or a 5x margin', async () => {
  for (const first of [trade('missing-price', '10:00', '10:01', 150, { target1ObservedPrice: null }), trade('broker-fails', '10:00', '10:01')]) {
    const result = await simulateTargetOneCapital([first, trade('next', '10:02', '10:03')], { margin: async () => { throw new Error('unavailable'); }, charges: async () => ({ total: 0, brokerage: 0 }) });
    assert.deepEqual(result.rows.map(row => row.status), ['UNAVAILABLE', 'UNAVAILABLE']); assert.equal(result.days[0].closingBalance, null); assert.equal(result.days[0].complete, false);
  }
});

test('fees can turn a gross winner into a net loser; insufficient capital skips safely', async () => {
  const result = await simulateTargetOneCapital([trade('tiny', '10:00', '10:01', 101)], broker(10));
  assert.equal(result.rows[0].grossPnl, 9); assert.equal(result.rows[0].netPnl, -11);
  const skipped = await simulateTargetOneCapital([trade('expensive', '10:00', '10:01')], { ...broker(), margin: async () => 20000 });
  assert.equal(skipped.rows[0].status, 'SKIPPED'); assert.equal(skipped.days[0].closingBalance, 10000);
});

test('Upstox report calls pass observed price, intraday product, and preserve broker fee totals', async () => {
  const service = new UpstoxService({} as never, {} as never);
  (service as any).tradingRequest = async (_u: string, method: string, url: string, body: any) => {
    assert.equal(method, 'POST'); assert.ok(url.endsWith('/charges/margin'));
    assert.deepEqual(body.instruments[0], { instrument_key: 'stock', quantity: 10, transaction_type: 'SELL', product: 'I', price: 123 });
    return { status: 'success', data: { required_margin: 246 } };
  };
  (service as any).get = async (_u: string, path: string, params: any) => {
    assert.equal(path, '/v2/charges/brokerage'); assert.deepEqual(params, { instrument_token: 'stock', quantity: 10, product: 'I', transaction_type: 'BUY', price: 120 });
    return { status: 'success', data: { charges: { total: 7, brokerage: 5 } } };
  };
  assert.equal(await service.reportIntradayMargin('u', 'stock', 'SELL', 10, 123), 246);
  assert.deepEqual(await service.reportIntradayCharges('u', 'stock', 'BUY', 10, 120), { total: 7, brokerage: 5 });
});
