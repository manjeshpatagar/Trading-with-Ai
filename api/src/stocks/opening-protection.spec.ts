import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { marketClock } from './market-clock';
import { protectOpeningSignal } from './opening-protection';
import { PaperTradingService } from './paper-trading.service';
import { PaperOrderExecutionService } from './paper-order-execution.service';

const at = (time: string) => new Date(`2026-09-16T${time}+05:30`);

test('opening analysis remains available and entries unlock exactly at 09:20 IST', () => {
  assert.equal(marketClock(at('09:14:59')).canScan, false);
  for (const time of ['09:15:00', '09:19:59.999']) {
    const clock = marketClock(at(time));
    assert.equal(clock.canScan, true);
    assert.equal(clock.openingProtection, true);
    assert.equal(clock.canEnter, false);
  }
  assert.equal(marketClock(at('09:20:00')).canEnter, true);
  assert.equal(marketClock(at('09:20:00')).openingProtection, false);
  assert.equal(marketClock(at('15:15:00')).canEnter, false);
  assert.equal(marketClock(new Date('2026-09-19T09:20:00+05:30')).canEnter, false);
});

test('fresh and cached BUY/SELL setups become analysis only during protection', () => {
  for (const signal of ['BUY', 'SELL']) {
    const row = { signal, aiScore: 91, price: 100, entry: 101, target1: 110, aiDecision: signal };
    const protectedRow = protectOpeningSignal(row, at('09:19:59'));
    assert.equal(protectedRow.signal, 'HOLD');
    assert.equal(protectedRow.aiDecision, 'WAIT');
    assert.equal(protectedRow.entry, null);
    assert.equal(protectedRow.aiScore, 91);
    assert.equal(protectedRow.price, 100);
    assert.equal(protectOpeningSignal(row, at('09:20:00')), row);
    assert.equal(row.signal, signal);
  }
});

test('both demo portfolios block queued execution during opening protection', async () => {
  const service = new PaperTradingService({} as never, new PaperOrderExecutionService());
  service.account = async () => ({ enabled: true, autoDemoTrading: true }) as any;
  for (const portfolio of ['STRATEGY', 'SIGNAL_HISTORY'] as const) {
    assert.equal(await service.drainDemoQueue('user', at('09:15:00'), portfolio), false);
    assert.equal(await service.drainDemoQueue('user', at('09:19:59'), portfolio), false);
  }
});
