import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { matchesStatusFilter, statusFilterDefinition } from './signal-status-filter';

test('Trade Completed maps to COMPLETED', () => {
  assert.deepEqual(statusFilterDefinition('Trade Completed')?.statuses, ['COMPLETED']);
  assert.equal(matchesStatusFilter({ status: 'COMPLETED' }, 'Trade Completed'), true);
});

test('Stop Loss Hit accepts persisted status and exit-reason variants', () => {
  for (const status of ['STOP_LOSS', 'STOP_LOSS_HIT', 'STOPLOSS_HIT', 'STOPLOSS_CONFIRMED'])
    assert.equal(matchesStatusFilter({ status }, 'Stop Loss Hit'), true);
  assert.equal(matchesStatusFilter({ status: 'CLOSED', exitReason: 'STOP LOSS' }, 'Stop Loss Hit'), true);
  assert.equal(matchesStatusFilter({ status: 'CLOSED', eventTypes: ['STOPLOSS_HIT'] }, 'Stop Loss Hit'), true);
});

test('Target Hit accepts target statuses and exit events', () => {
  for (const status of ['TARGET', 'TARGET_HIT', 'TARGET1_HIT', 'TARGET2_HIT', 'TARGET3_HIT'])
    assert.equal(matchesStatusFilter({ status }, 'Target Hit'), true);
  assert.equal(matchesStatusFilter({ status: 'COMPLETED', exitReason: 'TARGET' }, 'Target Hit'), true);
});

test('AI Exit maps status and exitReason', () => {
  assert.equal(matchesStatusFilter({ status: 'AI_EXIT' }, 'AI Exit'), true);
  assert.equal(matchesStatusFilter({ status: 'CLOSED', exitReason: 'AI EXIT' }, 'AI Exit'), true);
});

test('Manual Exit maps status and exitReason', () => {
  assert.equal(matchesStatusFilter({ status: 'MANUAL_EXIT' }, 'Manual Exit'), true);
  assert.equal(matchesStatusFilter({ status: 'CLOSED', exitReason: 'MANUAL EXIT' }, 'Manual Exit'), true);
});

test('unrelated trades do not match', () => {
  assert.equal(matchesStatusFilter({ status: 'COMPLETED', exitReason: 'TARGET' }, 'Stop Loss Hit'), false);
});
