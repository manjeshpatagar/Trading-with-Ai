import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { SignalHistoryService } from './signal-history.service';

const directory = mkdtempSync(join(tmpdir(), 'strategy-history-'));
const url = `file:${join(directory, 'test.db')}`;
const db = new PrismaClient({ datasources: { db: { url } } });
before(async () => {
  const sql = execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', join(__dirname, '../../prisma/schema.prisma'), '--script'], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: url } });
  for (const statement of sql.split(';').map(item => item.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
  for (const id of ['tick-user', 'daily-user', 'test-user']) await db.user.create({ data: { id, upstoxUserId: id } });
});

test('listed trades enter the report at T1 and retain later losses; off-page trades stay excluded', async () => {
  const now = new Date();
  const start = new Date(now.getTime() - 60_000);
  for (const id of ['tick-listed', 'tick-other']) {
    await db.aiSignal.create({ data: {
      id, signalKey: id, userId: 'tick-user', instrumentKey: id, symbol: id,
      stockName: id, strategy: 'Momentum', timeframe: '5m', side: 'BUY',
      currentPrice: 100, entryPrice: 100, stopLoss: 99, target1: 101, target2: 102, target3: 103,
      confidence: 95, aiScore: 90, riskReward: 3, signalTime: start,
      entryTriggeredAt: start, runningAt: start, status: 'RUNNING',
      aiStrategyListed: id === 'tick-listed', aiStrategyListedAt: start,
    } });
  }
  const service = new SignalHistoryService(db as any, { evaluateTouch: async () => ({ status: 'EXIT' }) } as any);
  await service.processTick('tick-user', 'tick-listed', 101, now);
  await service.processTick('tick-user', 'tick-other', 101, now);
  assert.deepEqual((await service.targetOneAnalysis('tick-user', now)).rows.map(row => row.id), ['tick-listed']);
  assert.equal((await service.targetOneAnalysis('tick-user', now)).summary.running, 1);
  await db.aiSignal.update({ where: { id: 'tick-listed' }, data: { aiStrategyListed: false } });
  const exit = new Date(now.getTime() + 1000);
  await service.processTick('tick-user', 'tick-listed', 98, exit);
  const result = await service.targetOneAnalysis('tick-user', exit);
  assert.equal(result.summary.losses, 1);
  assert.equal(result.summary.stopLossHits, 1);
  assert.equal(result.rows[0].exitPrice, 98);
  assert.equal(await db.aiStrategyResult.count({ where: { tradeId: 'tick-listed' } }), 1);
});
after(async () => { await db.$disconnect(); rmSync(directory, { recursive: true, force: true }); });

test('today retains all listed setups and their T1 results across ranking removal and reload', async () => {
  const at = new Date('2026-09-23T14:00:00+05:30');
  const start = new Date('2026-09-23T00:00:00+05:30');
  for (let i = 0; i < 29; i++) {
    const outside = i === 26 || i === 27;
    const signalTime = outside ? new Date(start.getTime() + (i === 26 ? -1 : 86_400_000)) : start;
    const waiting = i === 0;
    const loss = i === 1;
    await db.aiSignal.create({ data: {
      id: `daily-${i}`, signalKey: `daily-${i}`, userId: 'daily-user',
      instrumentKey: 'SAME-STOCK', symbol: 'SAME-STOCK', stockName: 'Repeated setups',
      strategy: 'Momentum', timeframe: '5m', side: i < 13 ? 'BUY' : 'SELL',
      signalTime, aiStrategyListed: false, aiStrategyListedAt: i === 28 ? null : signalTime,
      entryTriggeredAt: waiting ? null : signalTime,
      target1At: waiting ? null : new Date(signalTime.getTime() + 1000),
      completedAt: i <= 2 ? (loss ? new Date(start.getTime() + 2000) : null) : new Date(signalTime.getTime() + 2000),
      status: waiting ? 'WAITING' : loss ? 'STOPLOSS_CONFIRMED' : i === 2 ? 'TARGET1_HIT' : 'COMPLETED',
      exitPrice: i <= 2 ? (loss ? 98 : null) : i < 13 ? 105 : 95,
      stopLossAt: loss ? new Date(start.getTime() + 2000) : null,
      currentPrice: 700, entryPrice: 100, stopLoss: 98, target1: 101, target2: 102, target3: 103,
      confidence: 90, aiScore: 90, riskReward: 3,
    } });
  }
  const service = new SignalHistoryService(db as any, {} as never);
  const daily = await service.todayStrategySignals('daily-user', at);
  assert.equal(daily.tradingDate, '2026-09-23');
  assert.equal(daily.todayBuy.length, 13);
  assert.equal(daily.todaySell.length, 13);
  assert.equal(new Set([...daily.todayBuy, ...daily.todaySell].map(row => row.tradeId)).size, 26);
  assert.equal([...daily.todayBuy, ...daily.todaySell].filter(row => row.entryTriggeredAt).length, 25);
  const report = await service.targetOneAnalysis('daily-user', at, 'today');
  assert.equal(report.rows.length, 25);
  assert.equal(report.summary.wins, 23);
  assert.equal(report.summary.losses, 1);
  assert.equal(report.summary.running, 1);
  assert.equal((await service.targetOneAnalysis('daily-user', at)).rows.length, 0, 'legacy report still requires saved result membership');
  const restored = new SignalHistoryService(db as any, {} as never);
  assert.deepEqual(await restored.todayStrategySignals('daily-user', at), daily);
  assert.equal((await restored.todayStrategySignals('other-user', at)).todayBuy.length, 0);
  assert.equal((await restored.todayStrategySignals('daily-user', new Date('2026-09-24T00:00:00+05:30'))).todaySell.length, 1);
});

test('yesterday and completed winners survive removal and re-listing; unlisted signals stay excluded', async () => {
  const at = new Date();
  const entry = new Date(at.getTime() - 86_400_000);
  const firstListed = new Date(entry.getTime() - 60_000);
  for (const id of ['winner', 'never-listed', 'executed', 'listed-after-t1']) {
    await db.aiSignal.create({ data: {
      id, signalKey: id, userId: 'test-user', instrumentKey: id, symbol: id,
      stockName: id, strategy: 'Momentum', timeframe: '5m', side: 'BUY',
      currentPrice: 103, entryPrice: 100, stopLoss: 99, target1: 101, target2: 102, target3: 103,
      confidence: 95, aiScore: 90, riskReward: 3, signalTime: entry,
      entryTriggeredAt: entry, target1At: entry, completedAt: entry, exitPrice: 103,
      profitPercent: 3, status: 'COMPLETED', aiStrategyListed: false,
      aiStrategyListedAt: id === 'winner' ? firstListed : id === 'listed-after-t1' ? new Date(entry.getTime() + 60_000) : null,
    } });
  }
  await db.paperOrder.create({ data: {
    userId: 'test-user', signalId: 'executed', portfolio: 'STRATEGY', instrumentKey: 'executed', symbol: 'executed',
    side: 'BUY', confidence: 95, status: 'CLOSED', quantity: 1, budget: 101, plannedEntry: 101,
    entryPrice: 101, currentPrice: 103, investment: 101, target: 103, stopLoss: 99, entryTime: entry,
  } });
  await db.aiStrategyResult.create({ data: { tradeId: 'winner', observedAt: entry, source: 'VERIFIED_HISTORY' } });
  const service = new SignalHistoryService(db as any, {} as never);
  const report = await service.targetOneAnalysis('test-user', at);
  assert.deepEqual(report.rows.map(row => row.id), ['winner']);
  assert.equal(report.summary.wins, 1);
  assert.equal((await service.strategyWeekly('test-user', at)).days.reduce((n, day) => n + day.entries, 0), 3);
  (service as any).decorate = async () => [{ tradeId: 'listed-after-t1', signal: 'BUY', price: 103, aiScore: 90, target1At: entry }];
  await service.publishStrategyList('test-user', []);
  assert.equal((await db.aiSignal.findUniqueOrThrow({ where: { id: 'winner' } })).aiStrategyListedAt?.getTime(), firstListed.getTime());
  assert.deepEqual((await service.targetOneAnalysis('test-user', at)).rows.map(row => row.id).sort(), ['listed-after-t1', 'winner']);
  // Removing every stock from the current page must not erase its results.
  (service as any).decorate = async () => [];
  await service.publishStrategyList('test-user', []);
  const tomorrow = new Date(at.getTime() + 86_400_000);
  assert.equal((await service.targetOneAnalysis('test-user', tomorrow)).summary.reachedTarget1, 2);
  assert.equal(await db.aiStrategyResult.count({ where: { trade: { userId: 'test-user' } } }), 2);
  assert.equal((await service.targetOneAnalysis('another-user', at)).rows.length, 0);
});
