import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commuteImpact } from '../src/impact.js';

test('a 10 km car commute, 5 days a week', () => {
  const { current, alternatives } = commuteImpact({ mode: 'car', km: 10, days: 5 });
  assert.deepEqual(current, { mode: 'car', label: 'Car or cab', weeklyKm: 100, kgPerWeek: 15, exposure: 'medium' });
  assert.deepEqual(alternatives.map((a) => a.mode), ['metro', 'bus', 'two_wheeler', 'wfh']);
  const metro = alternatives[0];
  assert.equal(metro.savedKgPerWeek, 12);
  assert.equal(metro.savedKgPerYear, 624);
  assert.equal(metro.trees, 30);
  assert.equal(alternatives.at(-1).savedKgPerWeek, 3, 'one more home day saves one day of driving');
});

test('short trips offer walking or cycling first', () => {
  const { alternatives } = commuteImpact({ mode: 'car', km: 4, days: 5 });
  assert.equal(alternatives[0].mode, 'walk_cycle');
  assert.equal(alternatives[0].savedKgPerWeek, 6);
});

test('nothing to swap when the commute already emits least', () => {
  assert.deepEqual(commuteImpact({ mode: 'wfh', km: 0, days: 0 }).alternatives, []);
  assert.deepEqual(commuteImpact({ mode: 'walk_cycle', km: 3, days: 5 }).alternatives, []);
  const metro = commuteImpact({ mode: 'metro', km: 10, days: 5 });
  assert.ok(metro.alternatives.every((a) => a.savedKgPerWeek > 0), 'no "swap" that saves nothing');
});
