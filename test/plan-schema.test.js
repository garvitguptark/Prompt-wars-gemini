import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePlan, cleanAnswer, PLAN_SCHEMA, PLAN_ITEMS } from '../src/plan-schema.js';

test('model output is trimmed, capped and checked before anyone sees it', () => {
  const plan = sanitizePlan({
    summary: '  Bad air.  ',
    alerts: ['a', '', 'b', 'c', 'd'],
    routine: [
      { time: '7 am', title: 'T', action: 'A'.repeat(1000), why: 'W', impact: 'I', impactType: 'nonsense' },
      { title: '', action: 'no title' },
    ],
    indoor: 'not a list',
  });
  assert.equal(plan.summary, 'Bad air.');
  assert.deepEqual(plan.alerts, ['a', 'b']);
  assert.equal(plan.routine.length, 1);
  assert.equal(plan.routine[0].action.length, 320);
  assert.equal(plan.routine[0].impactType, 'both');
  assert.deepEqual(plan.indoor, []);
  assert.throws(() => sanitizePlan({ summary: 'x', routine: [] }), /incomplete/);
  assert.throws(() => sanitizePlan(null), /incomplete/);
});

test('answers lose markdown but keep paragraphs', () => {
  assert.equal(cleanAnswer('**Stay in.**\n\n\n\n## Later\nGo out at `2 pm`.'), 'Stay in.\n\n Later\nGo out at 2 pm.');
});

test('the schema Gemini follows and the clean-up use the same item limits', () => {
  for (const section of ['routine', 'indoor', 'swaps']) {
    assert.equal(PLAN_SCHEMA.properties[section].maxItems, String(PLAN_ITEMS[section].max), section);
    assert.equal(PLAN_SCHEMA.properties[section].minItems, String(PLAN_ITEMS[section].min), section);
  }
  const tooMany = Array.from({ length: 10 }, (_, i) => ({ title: `T${i}`, action: 'A' }));
  const plan = sanitizePlan({ summary: 'S', routine: tooMany, indoor: tooMany, swaps: tooMany, alerts: tooMany });
  assert.equal(plan.routine.length, PLAN_ITEMS.routine.max);
  assert.equal(plan.swaps.length, PLAN_ITEMS.swaps.max);
});
