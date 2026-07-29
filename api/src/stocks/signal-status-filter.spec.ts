import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { matchesStatusFilter, resolveSignalStatuses } from './signal-status-filter';

test('completed trades retain reached lifecycle milestones except active entry triggered', () => {
  const trade = {
    status: 'COMPLETED',
    entryTriggeredAt: new Date(),
    runningAt: new Date(),
    target1At: new Date(),
    target2At: new Date(),
    target3At: new Date(),
    completedAt: new Date(),
    events: [{ type: 'ENTRY_TRIGGERED' }, { type: 'RUNNING' }, { type: 'TARGET1_HIT' }, { type: 'TARGET2_HIT' }, { type: 'TARGET3_HIT' }, { type: 'COMPLETED' }],
  };
  assert.equal(matchesStatusFilter(trade, 'ENTRY_TRIGGERED'), false);
  for (const status of ['RUNNING', 'TARGET1_HIT', 'TARGET2_HIT', 'TARGET3_HIT', 'COMPLETED'])
    assert.equal(matchesStatusFilter(trade, status), true);
});

test('waiting to entry triggered appears only during the active entry stage', () => {
  const entryTriggered = { status: 'ENTRY_TRIGGERED', entryTriggeredAt: new Date(), entryExecutedPrice: 100, events: [{ type: 'SIGNAL_GENERATED' }, { type: 'ENTRY_TRIGGERED' }] };
  assert.equal(matchesStatusFilter(entryTriggered, 'ENTRY_TRIGGERED'), true);
});

test('entry triggered to running is removed from entry triggered', () => {
  const running = { status: 'RUNNING', entryTriggeredAt: new Date(), runningAt: new Date(), events: [{ type: 'ENTRY_TRIGGERED' }, { type: 'RUNNING' }] };
  assert.equal(matchesStatusFilter(running, 'ENTRY_TRIGGERED'), false);
});

test('target one is not shown in entry triggered', () => {
  const target = { status: 'TARGET1_HIT', entryTriggeredAt: new Date(), target1At: new Date(), events: [{ type: 'ENTRY_TRIGGERED' }, { type: 'RUNNING' }, { type: 'TARGET1_HIT' }] };
  assert.equal(matchesStatusFilter(target, 'ENTRY_TRIGGERED'), false);
});

test('stop loss is not shown in entry triggered', () => {
  const stopped = { status: 'STOPLOSS_CONFIRMED', entryTriggeredAt: new Date(), stopLossAt: new Date(), completedAt: new Date(), events: [{ type: 'ENTRY_TRIGGERED' }, { type: 'STOPLOSS_CONFIRMED' }] };
  assert.equal(matchesStatusFilter(stopped, 'ENTRY_TRIGGERED'), false);
});

test('completed and manually exited trades are not shown in entry triggered', () => {
  const completed = { status: 'COMPLETED', entryTriggeredAt: new Date(), completedAt: new Date(), events: [{ type: 'ENTRY_TRIGGERED' }, { type: 'COMPLETED' }] };
  const manual = { status: 'COMPLETED', entryTriggeredAt: new Date(), completedAt: new Date(), postTradeAnalysis: { exitReason: 'MANUAL EXIT' } };
  assert.equal(matchesStatusFilter(completed, 'ENTRY_TRIGGERED'), false);
  assert.equal(matchesStatusFilter(manual, 'ENTRY_TRIGGERED'), false);
});

test('stop loss resolver searches status, events, timeline, and post-trade analysis', () => {
  const variants = [
    { status: 'STOPLOSS_CONFIRMED' },
    { status: 'COMPLETED', events: [{ type: 'STOPLOSS_TOUCHED' }] },
    { status: 'COMPLETED', stopLossDecision: { timeline: [{ type: 'STOPLOSS_CONFIRMED' }] } },
    { status: 'COMPLETED', postTradeAnalysis: { exitReason: 'STOP LOSS' } },
    { status: 'COMPLETED', tradeAnalysis: { exitReason: 'STOP_LOSS' } },
  ];
  for (const trade of variants) assert.equal(matchesStatusFilter(trade, 'Stop Loss Hit'), true);
});

test('all terminal exit reasons resolve to completed', () => {
  for (const exitReason of ['TARGET 1', 'TARGET 2', 'TARGET 3', 'STOP LOSS', 'MANUAL EXIT', 'MARKET CLOSE', 'TRAILING STOP', 'AI EXIT', 'BREAK EVEN'])
    assert.equal(resolveSignalStatuses({ status: 'CLOSED', exitReason }).has('COMPLETED'), true);
});

test('unrelated completed target trade does not match stop loss', () => {
  assert.equal(matchesStatusFilter({ status: 'COMPLETED', postTradeAnalysis: { exitReason: 'TARGET 3' } }, 'Stop Loss Hit'), false);
});
