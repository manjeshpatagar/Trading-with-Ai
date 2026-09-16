import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { targetOneDocument, type TargetOneReport } from './target-one-report';

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const fonts = { regular: readFileSync(resolve(__dirname, '../public/fonts/report-regular.ttf')).toString('base64'), bold: readFileSync(resolve(__dirname, '../public/fonts/report-bold.ttf')).toString('base64') };

const report: TargetOneReport = {
  generatedAt: '2026-09-15T19:00:00Z',
  summary: { reachedTarget1: 2, stocks: 2, stopLossHits: 1, completed: 1, wins: 0, losses: 1, breakeven: 0, running: 1, unknown: 0 },
  rows: [{ id: '1', symbol: 'STOCKA', stockName: 'Company {A} \\ India', side: 'BUY', entryPrice: 100, target1Price: 110, target1At: '2026-09-15T04:30:00Z', target1ObservedPrice: 111, stopLossAt: '2026-09-15T05:00:00Z', stopLossHitPrice: 105, completedAt: '2026-09-15T05:00:00Z', exitPrice: 105, exitReason: 'STOP LOSS', profitPercent: -4.54545, outcome: 'LOSS', minutesAfterTarget1: 30 },
    { id: '2', symbol: 'STOCKB', stockName: 'Company B', side: 'SELL', entryPrice: 120, target1Price: 110, target1At: '2026-09-15T04:30:00Z', target1ObservedPrice: 110, stopLossAt: null, stopLossHitPrice: null, completedAt: null, exitPrice: null, exitReason: null, profitPercent: null, outcome: 'RUNNING', minutesAfterTarget1: null }],
};
test('creates a real PDF with an IST filename and embedded fonts', async () => {
  const doc = await targetOneDocument(report, fonts);
  assert.equal(doc.filename, 'QuantPulse-Target1-Results-2026-09-16.pdf');
  assert.ok(Buffer.from(doc.content).toString('latin1').startsWith('%PDF-'));
  assert.ok(Buffer.from(doc.content).toString('latin1').includes('/FontFile2'));
  assert.equal(doc.pageCount, 1);
  writeFileSync('/tmp/quantpulse-pdf-small.pdf', Buffer.from(doc.content));
});
test('includes every row in a multipage PDF and handles empty reports', async () => {
  const rows = Array.from({ length: 35 }, (_, index) => ({ ...report.rows[index % 2], id: String(index), symbol: `STOCK${String(index + 1).padStart(2, '0')}`, stockName: index === 0 ? 'SAMPLE COMPANY WITH A LONG NAME FOR WRAPPING CHECK' : 'Sample Company Limited' }));
  const doc = await targetOneDocument({ ...report, rows, summary: { ...report.summary, reachedTarget1: 35, stocks: 35, completed: 18, losses: 18, running: 17, stopLossHits: 18 } }, fonts);
  assert.ok(doc.pageCount > 1);
  writeFileSync('/tmp/quantpulse-pdf-preview.pdf', Buffer.from(doc.content));
  assert.equal((await targetOneDocument({ ...report, rows: [] }, fonts)).pageCount, 1);
  await assert.rejects(targetOneDocument({ ...report, generatedAt: 'invalid' }, fonts), /Refresh/);
});

test('demo PDF includes a daily summary and all seven date sections with execution P&L', async () => {
  const rows = report.rows.map((row, index) => ({ ...row, entryAt: '2026-09-16T04:30:00Z', quantity: 20, target2: 115, target3: 120, demoTarget: 120, stopLossLevel: 105, currentPrice: 112, profitAmount: index === 0 ? -100 : 40, durationMinutes: index === 0 ? 30 : null }));
  const summary = { ...report.summary, trades: 2, realizedProfit: 0, realizedLoss: 100, realizedPnl: -100, unrealizedPnl: 40 };
  const days = Array.from({ length: 7 }, (_, i) => ({ date: `2026-09-${16 - i}`, rows: i === 0 ? rows : [], summary: i === 0 ? summary : { reachedTarget1: 0, stocks: 0, stopLossHits: 0, completed: 0, wins: 0, losses: 0, breakeven: 0, running: 0, unknown: 0 } }));
  const pdf = await targetOneDocument({ ...report, rows, summary, days }, fonts, true);
  assert.equal(pdf.filename, 'QuantPulse-Signal-History-Demo-2026-09-16.pdf');
  assert.equal(pdf.pageCount, 8);
  writeFileSync('/tmp/quantpulse-demo-pdf-preview.pdf', Buffer.from(pdf.content));
});
