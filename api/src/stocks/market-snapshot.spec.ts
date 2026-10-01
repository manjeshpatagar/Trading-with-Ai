import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { completedCandles, sameTimeRelativeVolume } from './market-snapshot';
import { IndicatorService } from './indicator.service';

const at = Date.parse('2026-09-16T05:00:00Z');
const bar = (time: number, volume = 100) => ({ time: new Date(time).toISOString(), open: 100, high: 102, low: 99, close: 101, volume });
test('snapshot excludes incomplete/future/malformed bars, sorts and deduplicates without mutation', () => {
  const old = bar(at - 600_000), latest = bar(at - 300_000);
  const rows = [latest, old, { ...old }, bar(at - 1), bar(at + 1), { ...old, time: 'invalid' }, { ...bar(at - 900_000), close: 110 }];
  const copy = JSON.stringify(rows);
  assert.deepEqual(completedCandles(rows, at), [old, latest]);
  assert.equal(JSON.stringify(rows), copy);
  assert.deepEqual(completedCandles([old, { ...old, volume: 200 }], at), []);
});
test('relative volume uses prior sessions at the same time, excluding current session and future days', () => {
  const rows = [bar(at - 3 * 86400_000, 100), bar(at - 2 * 86400_000, 200), bar(at - 86400_000, 300), bar(at - 300_000, 9000), bar(at, 400)];
  assert.equal(sameTimeRelativeVolume(rows)?.ratio, 2);
  assert.equal(sameTimeRelativeVolume(rows.slice(-2)), null);
});
test('EMA RSI MACD ATR ADX and volume match an analytically known rising series', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ time: new Date(at - (200 - i) * 300_000).toISOString(), open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 100 }));
  const output = new IndicatorService().calculate(rows);
  assert.equal(output.ema20, 289.5);
  assert.equal(output.ema50, 274.5);
  assert.equal(output.ema200, 199.5);
  assert.equal(output.rsi, 100);
  assert.ok(Math.abs(output.macd!.MACD! - 7) < 1e-8);
  assert.ok(Math.abs(output.macd!.histogram!) < 1e-8);
  assert.equal(output.atr, 2);
  assert.equal(output.adx, 100);
  assert.equal(output.volumeSma, 100);
  assert.equal(output.averageVolume, 100);
  const session = rows.filter(row => row.time.slice(0, 10) === rows.at(-1)!.time.slice(0, 10));
  assert.equal(output.vwap, session.reduce((sum, row) => sum + row.close, 0) / session.length);
  assert.deepEqual(new IndicatorService().calculate(rows.slice(0, 49)), {});
});
