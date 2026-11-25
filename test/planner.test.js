import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlanner } from '../src/planner.js';
import { delhi, delhiAir, family, geminiPlan, quiet } from './fixtures.js';

const fakeAir = { lookup: async () => delhiAir() };
const fakeGemini = (impl) => {
  const gemini = {
    enabled: true,
    calls: 0,
    plan: async (ctx) => {
      gemini.calls++;
      return impl(ctx);
    },
    ask: async () => ({ answer: 'Stay in.', model: 'm' }),
  };
  return gemini;
};

test('Gemini writes the plan when it can, and the same request is served from cache', async () => {
  const gemini = fakeGemini(async () => ({ plan: geminiPlan, model: 'gemini-test' }));
  const planner = createPlanner({ air: fakeAir, gemini, log: quiet });
  const first = await planner.plan(delhi, family);
  assert.equal(first.source, 'gemini');
  assert.equal(first.model, 'gemini-test');
  assert.equal(first.commute.current.kgPerWeek, 18);
  await planner.plan(delhi, family);
  assert.equal(gemini.calls, 1);
  await planner.plan(delhi, { ...family, purifier: true });
  assert.equal(gemini.calls, 2, 'a different household is a different plan');
});

test('when Gemini fails the family still gets a plan, marked as built-in', async () => {
  const warnings = [];
  const planner = createPlanner({
    air: fakeAir,
    gemini: fakeGemini(async () => {
      throw new Error('quota');
    }),
    log: (sev, msg) => warnings.push(msg),
  });
  const result = await planner.plan(delhi, family);
  assert.equal(result.source, 'rules');
  assert.ok(result.plan.routine.length >= 3);
  assert.match(warnings[0], /Gemini plan failed/);
});

test('a failed answer becomes the same friendly offline message', async () => {
  const gemini = {
    ...fakeGemini(),
    ask: async () => {
      throw new Error('quota exceeded');
    },
  };
  const planner = createPlanner({ air: fakeAir, gemini, log: quiet });
  await assert.rejects(
    planner.ask(delhi, family, 'Go out?'),
    (err) => err.status === 503 && !/quota/.test(err.message),
  );
});

test('follow-up questions need Gemini and say so when it is offline', async () => {
  const offline = createPlanner({ air: fakeAir, gemini: { enabled: false }, log: quiet });
  await assert.rejects(
    offline.ask(delhi, family, 'Go out?'),
    (err) => err.status === 503 && /offline/.test(err.message),
  );
  const online = createPlanner({ air: fakeAir, gemini: fakeGemini(), log: quiet });
  assert.deepEqual(await online.ask(delhi, family, 'Go out?'), { answer: 'Stay in.', model: 'm' });
});
