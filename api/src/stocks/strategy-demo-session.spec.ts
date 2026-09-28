import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { marketClock, strategyDemoClock } from './market-clock';
import { EodRiskManagerService } from './eod-risk-manager.service';
import { PaperTradingService } from './paper-trading.service';

const at = (time: string) => new Date(`2026-09-23T${time}+05:30`);

test('strategy demo enters from 09:20 until strictly before 15:20 and then auto-exits', () => {
  assert.equal(strategyDemoClock(at('09:19:59')).canEnter, false);
  for (const time of ['09:20:00', '15:15:00', '15:19:59']) {
    assert.equal(strategyDemoClock(at(time)).canEnter, true);
    assert.equal(strategyDemoClock(at(time)).shouldAutoExit, false);
  }
  assert.equal(strategyDemoClock(at('15:19:59')).secondsUntilAutoExit, 1);
  for (const time of ['15:20:00', '15:25:00', '21:00:00']) {
    const clock = strategyDemoClock(at(time));
    assert.equal(clock.canEnter, false);
    assert.equal(clock.shouldAutoExit, true);
    assert.equal(clock.secondsUntilAutoExit, 0);
    assert.equal(clock.autoExitAt, at('15:20:00').toISOString());
  }
  assert.equal(strategyDemoClock(new Date('2026-09-26T15:20:00+05:30')).shouldAutoExit, false);
  assert.equal(strategyDemoClock(new Date('2026-09-26T09:20:00+05:30')).canEnter, false);
  assert.equal(marketClock(at('15:15:00')).canEnter, false);
  assert.equal(marketClock(at('15:20:00')).shouldAutoExit, false);
  assert.equal(marketClock(at('15:25:00')).shouldAutoExit, true);
});

test('3:20 scheduler closes strategy only and retries a failed quote refresh', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: at('15:19:59') });
  let attempts = 0;
  const closes: string[] = [];
  const events: unknown[] = [];
  const manager = new EodRiskManagerService({ paperOrder: { findMany: async ({ where }: any) => {
    assert.deepEqual(where, { portfolio: 'STRATEGY', status: 'OPEN' });
    return [{ userId: 'u', instrumentKey: 'OPEN' }];
  } } } as never, { closeAllEod: async (time: Date, portfolio: string) => {
    assert.equal(time.getTime(), at('15:20:00').getTime());
    closes.push(portfolio); return 1;
  } } as never, {} as never, { get: () => { throw new Error('Broker schedule must not run at 15:20'); } } as never,
  { refreshPrices: async () => { if (++attempts === 1) throw new Error('Quote temporarily unavailable'); },
    emitToUser: (...args: unknown[]) => events.push(args) } as never);
  await manager.enforce();
  assert.equal(attempts, 0);
  t.mock.timers.setTime(at('15:20:00').getTime());
  await manager.enforce();
  assert.equal(closes.length, 0);
  await manager.enforce();
  assert.deepEqual(closes, ['STRATEGY']);
  assert.equal(events.length, 1);
});

test('strategy EOD close is portfolio-scoped and never fills a missing price', async () => {
  let fresh = false;
  const closed: unknown[][] = [];
  const paper = new PaperTradingService({ paperOrder: {
    findMany: async ({ where }: any) => {
      assert.deepEqual(where, { status: 'OPEN', portfolio: 'STRATEGY' });
      return [{ id: 'o', userId: 'u', instrumentKey: 'k' }];
    },
    updateMany: async ({ where }: any) => assert.deepEqual(where, { status: 'WAITING', portfolio: 'STRATEGY' }),
  } } as never, {} as never, { fresh: () => fresh ? { ltp: 101 } : undefined } as never);
  (paper as any).close = async (...args: unknown[]) => closed.push(args);
  assert.equal(await paper.closeAllEod(at('15:20:00'), 'STRATEGY'), 0);
  assert.equal(closed.length, 0);
  fresh = true;
  assert.equal(await paper.closeAllEod(at('15:20:10'), 'STRATEGY'), 1);
  assert.deepEqual(closed[0], ['o', 101, 'End of Day Auto Exit', at('15:20:10'), 'CLOSED - EOD EXIT']);
});

test('a cutoff tick closes strategy even when the entry switch is disabled', async () => {
  const closed: unknown[][] = [];
  const paper = new PaperTradingService({
    paperTradingAccount: { findMany: async () => [{ portfolio: 'STRATEGY', enabled: false }] },
    paperOrder: { findMany: async () => [{ id: 'o', portfolio: 'STRATEGY', entryTime: at('14:00:00') }] },
  } as never, {} as never);
  (paper as any).close = async (...args: unknown[]) => closed.push(args);
  assert.equal(await paper.processTick('u', 'k', 101, at('15:20:00')), true);
  assert.deepEqual(closed[0], ['o', 101, 'End of Day Auto Exit', at('15:20:00'), 'CLOSED - EOD EXIT']);
});
