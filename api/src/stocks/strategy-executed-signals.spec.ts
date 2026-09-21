import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { SignalHistoryService } from './signal-history.service';

const signal = (id: string, overrides: object = {}) => ({
  id, userId: 'user-1', instrumentKey: 'NSE_EQ|PNB', symbol: 'PNB', stockName: 'Punjab National Bank',
  timeframe: '5m', side: 'BUY', currentPrice: 118.77, entryPrice: 118, stopLoss: 117,
  target1: 118.23, target2: 118.5, target3: 118.77, confidence: 95, aiScore: 80,
  riskReward: 2, strategy: 'Momentum', status: 'COMPLETED', aiStrategyListed: false,
  top100Selected: false, signalTime: new Date('2026-09-16T04:00:00Z'),
  completedAt: new Date('2026-09-16T04:30:00Z'), events: [], ...overrides,
});
const order = (signalId: string) => ({ id: `order-${signalId}`, signalId, status: 'CLOSED',
  entryPrice: 118.23, exitPrice: 118.77, quantity: 518, pnl: 279.72 });

test('completed PNB remains visible by original signalId outside scanner ranking, session and status filters', async () => {
  const queries: any[] = [];
  const prisma: any = {
    paperOrder: { findMany: async (query: any) => { queries.push(query); return [order('original'), order('newer')]; } },
    aiSignal: { findMany: async (query: any) => { queries.push(query); return [signal('newer', { currentPrice: 650 }), signal('original')]; } },
  };
  const rows = await new SignalHistoryService(prisma, {} as never).executedStrategySignals('user-1');
  assert.deepEqual(rows.map(row => row.signalId), ['original', 'newer']);
  assert.equal(rows[0].tradeId, rows[0].paperTrade.signalId);
  assert.equal(rows[0].tradeStatus, 'COMPLETED');
  assert.equal(rows[1].price, 650);
  assert.deepEqual(queries[0].where, { userId: 'user-1', portfolio: 'STRATEGY', entryTime: { not: null }, signalId: { not: null } });
  assert.deepEqual(queries[1].where, { userId: 'user-1', id: { in: ['original', 'newer'] } });
});

test('missing canonical records never create a separate Demo signal', async () => {
  const prisma: any = { paperOrder: { findMany: async () => [order('missing')] }, aiSignal: { findMany: async () => [] } };
  assert.deepEqual(await new SignalHistoryService(prisma, {} as never).executedStrategySignals('user-1'), []);
});

test('no executed orders needs no signal query', async () => {
  const prisma: any = { paperOrder: { findMany: async () => [] } };
  assert.deepEqual(await new SignalHistoryService(prisma, {} as never).executedStrategySignals('user-1'), []);
});
