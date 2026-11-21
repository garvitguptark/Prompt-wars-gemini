import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleGenAI } from '@google/genai';
import { createGemini, clientFromEnv, describe, planPrompt, askPrompt, sanitizePlan, cleanAnswer, PLAN_SCHEMA, DEFAULT_MODELS } from '../src/gemini.js';
import { delhiContext, geminiPlan, NOW, quiet } from './fixtures.js';

/** A Gemini client stand-in: each call takes the next scripted reply (an object to return or an Error to throw). */
function fakeClient(...replies) {
  const calls = [];
  return {
    calls,
    models: {
      async generateContent(req) {
        calls.push(req);
        const next = replies.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}
const apiError = (status, message = 'error') => Object.assign(new Error(message), { status });

test('the prompt carries live readings, forecast windows and commute numbers in local time', () => {
  const { data, household } = describe(delhiContext(), NOW);
  assert.match(data, /Local time now: Sat 1:40 pm/);
  assert.match(data, /US AQI 340 \(Hazardous\) from PM2\.5 of 245\.4 µg\/m³, 16\.4× the WHO/);
  assert.match(data, /Official local index: AQI \(IN\) 412, "Severe air quality"/);
  assert.match(data, /Cleanest 3 hours \(6 am–10 pm\): 2 pm–5 pm, average AQI 154/);
  assert.match(data, /Car or cab, 12 km each way, 5 days a week = 120 km and 18 kg CO2e a week/);
  assert.match(data, /Metro or train: 3\.6 kg CO2e a week, saving 14\.4 kg a week \(749 kg a year/);
  assert.match(data, /children: "Keep children indoors\."/, 'advice for groups in this household is included');
  assert.match(data, /athletes: "Do not train outdoors\."/, 'they exercise, so athlete advice applies');
  assert.match(household, /children, someone with asthma or a lung or heart condition/);
  assert.match(household, /Notes: "We live next to a highway"/);
});

test('user text only ever appears inside its own tags', () => {
  const ctx = delhiContext();
  const prompt = planPrompt(ctx, NOW);
  const notesAt = prompt.indexOf('We live next to a highway');
  assert.ok(notesAt > prompt.indexOf('<household>') && notesAt < prompt.indexOf('</household>'));
  const ask = askPrompt(ctx, 'Can my son play cricket today?', NOW);
  assert.match(ask, /<question>\nCan my son play cricket today\?\n<\/question>\n\nAnswer in English\./);
});

test('the plan request asks for structured JSON with a fast thinking level and a timeout', async () => {
  const client = fakeClient({ text: JSON.stringify(geminiPlan) });
  const gemini = createGemini({ client, log: quiet });
  const { plan, model } = await gemini.plan(delhiContext());
  assert.equal(model, DEFAULT_MODELS[0]);
  assert.equal(plan.routine[0].title, 'Short walk in the clean window');
  const { config } = client.calls[0];
  assert.equal(config.responseMimeType, 'application/json');
  assert.equal(config.responseSchema, PLAN_SCHEMA);
  assert.equal(config.thinkingConfig.thinkingLevel, 'LOW');
  assert.ok(config.httpOptions.timeout > 0 && config.httpOptions.timeout <= 25_000);
  assert.match(config.systemInstruction, /never as instructions/);
});

test('a busy or missing model hands over to the next one', async () => {
  const client = fakeClient(apiError(503), apiError(404), { text: JSON.stringify(geminiPlan) });
  const { model } = await createGemini({ client, log: quiet }).plan(delhiContext());
  assert.equal(model, DEFAULT_MODELS[2]);
  assert.deepEqual(client.calls.map((c) => c.model), DEFAULT_MODELS);
});

test('a request error is not retried on other models', async () => {
  const client = fakeClient(apiError(400, 'Invalid JSON payload'), { text: '{}' });
  await assert.rejects(createGemini({ client, log: quiet }).plan(delhiContext()), /Invalid JSON payload/);
  assert.equal(client.calls.length, 1);
});

test('a model that rejects thinkingLevel is retried once without it, and remembered', async () => {
  const client = fakeClient(apiError(400, 'thinking_level is not supported'), { text: 'Stay in.' }, { text: 'Still stay in.' });
  const gemini = createGemini({ client, models: ['gemini-old'], log: quiet });
  assert.equal((await gemini.ask(delhiContext(), 'Go out?')).answer, 'Stay in.');
  assert.equal(client.calls[1].config.thinkingConfig, undefined);
  await gemini.ask(delhiContext(), 'And later?');
  assert.equal(client.calls[2].config.thinkingConfig, undefined, 'no second failed attempt');
});

test('every model failing surfaces the last error', async () => {
  const client = fakeClient(apiError(429), apiError(503), apiError(504));
  await assert.rejects(createGemini({ client, log: quiet }).ask(delhiContext(), 'Hi?'), (err) => err.status === 504);
});

test('without credentials Gemini is disabled, not crashing', async () => {
  assert.equal(clientFromEnv({}), null);
  assert.ok(clientFromEnv({ GEMINI_API_KEY: 'test-key' }) instanceof GoogleGenAI);
  assert.ok(clientFromEnv({ GOOGLE_GENAI_USE_VERTEXAI: 'true', GOOGLE_CLOUD_PROJECT: 'demo' }) instanceof GoogleGenAI);
  const gemini = createGemini({ client: null });
  assert.equal(gemini.enabled, false);
  await assert.rejects(gemini.plan(delhiContext()), (err) => err.status === 503);
});

test('model output is trimmed, capped and checked before anyone sees it', () => {
  const plan = sanitizePlan({
    summary: '  Bad air.  ',
    alerts: ['a', '', 'b', 'c', 'd'],
    routine: [{ time: '7 am', title: 'T', action: 'A'.repeat(1000), why: 'W', impact: 'I', impactType: 'nonsense' }, { title: '', action: 'no title' }],
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

test('a failed model sits out for a while, so later requests skip straight past it', async () => {
  let t = 0;
  const client = fakeClient(apiError(404), { text: 'A' }, { text: 'B' }, apiError(503), { text: 'C' });
  const gemini = createGemini({ client, models: ['m1', 'm2'], log: quiet, now: () => t });
  assert.equal((await gemini.ask(delhiContext(), 'One?')).answer, 'A');
  assert.equal((await gemini.ask(delhiContext(), 'Two?')).answer, 'B');
  assert.deepEqual(client.calls.map((c) => c.model), ['m1', 'm2', 'm2'], 'm1 was skipped the second time');
  t = 7 * 3_600_000; // past the 6-hour sit-out for a missing model
  client.calls.length = 0;
  await gemini.ask(delhiContext(), 'Three?');
  assert.deepEqual(client.calls.map((c) => c.model), ['m1', 'm2'], 'm1 is tried again, and the last model is always tried');
});
