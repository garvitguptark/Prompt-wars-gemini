import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlanner, rulesPlan } from '../src/planner.js';
import { readProfile } from '../src/profile.js';
import { commuteImpact } from '../src/impact.js';
import { summarize, parseOpenMeteo } from '../src/air.js';
import { delhi, delhiAir, delhiContext, family, geminiPlan, openMeteo, NOW, quiet } from './fixtures.js';

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

test('open-air commuters are told to mask up; induction cooks still need the exhaust', () => {
  for (const mode of ['two_wheeler', 'walk_cycle']) {
    const profile = readProfile({ commute: { mode, km: 3, days: 5 }, cooking: 'induction' });
    const text = JSON.stringify(rulesPlan({ ...delhiContext(), profile, commute: commuteImpact(profile.commute) }));
    assert.match(text, /Mask up for the ride/, mode);
    assert.match(text, /Exhaust on when frying/);
  }
  const calm = summarize(
    {
      source: 't',
      updated: new Date(NOW).toISOString(),
      pm25: 5,
      pollutants: [],
      dominant: null,
      localIndex: null,
      health: null,
      hourly: [],
    },
    delhi.tz,
    NOW,
  );
  const profile = readProfile({ commute: { mode: 'two_wheeler', km: 3, days: 5 } });
  assert.match(
    JSON.stringify(rulesPlan({ place: delhi, air: calm, profile, commute: commuteImpact(profile.commute) })),
    /Pick the quieter route/,
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

test('built-in plan for a hazardous day protects the sensitive and uses the forecast', () => {
  const plan = rulesPlan(delhiContext());
  const text = JSON.stringify(plan);
  assert.match(plan.summary, /hazardous right now \(US AQI 340\)/);
  assert.match(plan.alerts[0], /your child and anyone with asthma or a heart condition/);
  assert.equal(plan.alerts.length, 2, 'severe air also warns about symptoms');
  assert.match(text, /Exercise indoors today/, 'even the cleanest hours (AQI 154) are unhealthy');
  assert.match(text, /Skip airing out today/);
  assert.match(text, /windows shut from 11 pm to 2 am/);
  assert.match(text, /Recirculate in the car/);
  assert.match(text, /Build a box-fan filter/, 'no purifier at home');
  assert.match(text, /Lid on, exhaust on/);
  assert.match(text, /Saves 14\.4 kg a week and 749 kg a year/);
  assert.deepEqual(
    plan.swaps.map((s) => s.title),
    ['Take the metro', 'Work from home once more', 'Engine off at long signals', 'Never burn rubbish or leaves'],
  );
  for (const section of ['routine', 'indoor', 'swaps']) {
    for (const it of plan[section])
      assert.ok(
        it.title && it.action && it.why && it.impact && ['exposure', 'emissions', 'both'].includes(it.impactType),
      );
  }
});

test('built-in plan for a middling day moves the workout into the clean window', () => {
  const hours = Array.from({ length: 24 }, (_, h) => ({
    time: new Date(NOW + (h + 1) * 3_600_000).toISOString().replace(/:10:00/, ':00:00'),
    pm25: h <= 3 ? 30 : 100,
  }));
  const air = summarize(
    {
      source: 'test',
      updated: new Date(NOW).toISOString(),
      pm25: 80,
      pollutants: [],
      dominant: null,
      localIndex: null,
      health: null,
      hourly: hours,
    },
    delhi.tz,
    NOW,
  );
  const plan = rulesPlan({ ...delhiContext(), air });
  const text = JSON.stringify(plan);
  assert.match(text, /Keep windows and doors shut until 2 pm/);
  assert.match(text, /Exercise outdoors at 2 pm–5 pm instead/);
  assert.match(text, /Open the windows for 10–15 minutes at 2 pm–5 pm/);
});

test('built-in plan for a clean day says so', () => {
  const clean = summarize(
    parseOpenMeteo({
      ...openMeteo,
      current: { ...openMeteo.current, pm2_5: 6 },
      hourly: { ...openMeteo.hourly, pm2_5: openMeteo.hourly.pm2_5.map(() => 6) },
    }),
    delhi.tz,
    NOW,
  );
  const profile = readProfile({
    commute: { mode: 'metro', km: 8, days: 5 },
    exercise: 'evening',
    purifier: true,
    cooking: 'biomass',
  });
  const plan = rulesPlan({ place: delhi, air: clean, profile, commute: commuteImpact(profile.commute) });
  const text = JSON.stringify(plan);
  assert.deepEqual(plan.alerts, []);
  assert.match(plan.summary, /good right now/);
  assert.match(text, /Air the house/);
  assert.match(text, /Enjoy your workout/);
  assert.match(text, /Run the purifier right/);
  assert.match(text, /Get cooking smoke out/);
  assert.match(text, /Never burn rubbish/);
});
