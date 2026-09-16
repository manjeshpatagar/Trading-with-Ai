import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { LivePriceBook } from './live-prices';
const key = 'NSE_EQ|APTUS';
const order = { instrumentKey: key, status: 'OPEN', side: 'SELL', currentPrice: 238.26, entryPrice: 238.26, plannedEntry: 238.26, quantity: 100, pnl: 0, pnlPercent: 0, budget: 1000 };
const dashboard = { openPositions: [order], waitingOrders: [], summary: { virtualBalance: 10000, usedCapital: 1000, availableCapital: 9000, todayPnl: 0 }, performance: { todayProfit: 0, todayLoss: 0 } };
test('history and demo share each tick, and delayed HTTP/DB snapshots cannot overwrite it', () => {
  const prices = new LivePriceBook();
  for (const [sequence, ltp] of [238.26, 237.8, 237.5].entries()) {
    prices.accept({ instrumentKey: key, ltp, timestamp: 1000 + sequence, sequence: sequence + 1, receivedAt: 2000 });
    const demo = prices.demo(dashboard);
    const history = prices.history({ signals: [{ instrumentKey: key, currentPrice: 238.26 }] });
    assert.equal(demo.openPositions[0].currentPrice, ltp);
    assert.equal(history.signals[0].currentPrice, ltp);
    assert.equal(demo.summary.todayPnl, demo.openPositions[0].pnl);
  }
  assert.equal(prices.accept({ instrumentKey: key, ltp: 999, timestamp: 1001, sequence: 99, receivedAt: 2001 }), false);
  const stale = { ...order, marketTimestamp: 1000, marketSequence: 1, marketReceivedAt: 2000 };
  assert.equal(prices.demo({ ...dashboard, openPositions: [stale] }).openPositions[0].currentPrice, 237.5);
  assert.equal(prices.history({ signals: [stale] }).signals[0].currentPrice, 237.5);
});
test('equal timestamps use sequence order and invalid unstamped prices are ignored', () => {
  const prices = new LivePriceBook();
  const quote = { instrumentKey: key, ltp: 237.8, timestamp: 1000, sequence: 2, receivedAt: 2000 };
  assert.equal(prices.accept(quote), true);
  assert.equal(prices.accept({ ...quote, ltp: 238.26, sequence: 1 }), false);
  assert.equal(prices.accept({ ...quote, ltp: 237.5, sequence: 3 }), true);
  assert.equal(prices.history({ signals: [{ ...order, currentPrice: 999 }] }).signals[0].currentPrice, 237.5);
  assert.equal(prices.accept({ ...quote, timestamp: NaN, sequence: 99 }), false);
});
