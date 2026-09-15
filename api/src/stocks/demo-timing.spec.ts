import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { SignalHistoryService } from './signal-history.service';
import { PaperTradingService } from './paper-trading.service';
import { PaperOrderExecutionService } from './paper-order-execution.service';

test('new BUY and SELL setups already beyond Target 1 are never created', async () => {
  for (const side of ['BUY', 'SELL']) {
    let creates = 0;
    const service = new SignalHistoryService({ aiSignal: {
      findFirst: async () => null, create: async () => { creates++; },
    } } as never, {} as never);
    (service as any).persistStrategyList = async () => ({});
    const buy = side === 'BUY';
    await service.recordScannerSignals('u', [{ tags: [], indicators: {}, universeRank: 1, price: 100, signal: side, instrumentKey: 'key', entry: 100,
      stopLoss: buy ? 95 : 105, target1: buy ? 101 : 99, target2: buy ? 102 : 98, target3: buy ? 103 : 97, riskReward: 2,
    }] as never, () => buy ? 104 : 96);
    assert.equal(creates, 0);
  }
});

test('ticks wait for list publication before loading newly created signals', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let loaded = false;
  const service = new SignalHistoryService({ aiSignal: { findMany: async () => { loaded = true; return []; } } } as never, {} as never);
  const publication = (service as any).publishSerial('u', () => pending);
  const tick = service.processTick('u', 'key', 100);
  await Promise.resolve();
  assert.equal(loaded, false);
  release();
  await publication;
  await tick;
  assert.equal(loaded, true);
});

test('strategy stop loss exits on its price tick even with AI wait enabled', async () => {
  for (const side of ['BUY', 'SELL']) {
    const order = { id: 'order', portfolio: 'STRATEGY', side, entryPrice: 100, quantity: 10, target: side === 'BUY' ? 110 : 90, stopLoss: side === 'BUY' ? 95 : 105 };
    const service = new PaperTradingService({
      paperTradingAccount: { findMany: async () => [{ portfolio: 'STRATEGY', enabled: true, allowAiWait: true }] },
      paperOrder: { findMany: async () => [order] },
    } as never, new PaperOrderExecutionService());
    const exits: any[] = [];
    (service as any).close = async (...args: any[]) => exits.push(args);
    assert.equal(await service.processTick('u', 'key', order.stopLoss), true);
    assert.equal(exits[0][2], 'STOP LOSS');
  }
});
