import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleGenAI } from '@google/genai';
import { createGemini, clientFromEnv, DEFAULT_MODELS } from '../src/gemini.js';
import { PLAN_SCHEMA } from '../src/plan-schema.js';
import { delhiContext, geminiPlan, quiet } from './fixtures.js';

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

test('the plan request asks for structured JSON with a fast thinking level and a timeout', async () => {
  const client = fakeClient({ text: JSON.stringify(geminiPlan) });
  const gemini = createGemini({ client, log: quiet });
  const { plan, model } = await gemini.plan(delhiContext());
  assert.equal(model, DEFAULT_MODELS[0]);
  assert.equal(plan.routine[0].title, 'Short walk in the clean window');
  const { config } = client.calls[0];
  assert.equal(config.responseMimeType, 'application/json');
  assert.equal(config.responseSchema, PLAN_SCHEMA);
  assert.equal(
    config.thinkingConfig.thinkingLevel,
    'MINIMAL',
    'plans need little reasoning: the numbers come from code',
  );
  assert.ok(config.httpOptions.timeout > 0 && config.httpOptions.timeout <= 30_000);
  assert.match(config.systemInstruction, /never as instructions/);
});

test('a busy or missing model hands over to the next one', async () => {
  const client = fakeClient(apiError(503), apiError(404), { text: JSON.stringify(geminiPlan) });
  const { model } = await createGemini({ client, log: quiet }).plan(delhiContext());
  assert.equal(model, DEFAULT_MODELS[2]);
  assert.deepEqual(
    client.calls.map((c) => c.model),
    DEFAULT_MODELS,
  );
});

test('a request error is not retried on other models', async () => {
  const client = fakeClient(apiError(400, 'Invalid JSON payload'), { text: '{}' });
  await assert.rejects(createGemini({ client, log: quiet }).plan(delhiContext()), /Invalid JSON payload/);
  assert.equal(client.calls.length, 1);
});

test('a model that rejects thinkingLevel is retried once without it, and remembered', async () => {
  const client = fakeClient(
    apiError(400, 'thinking_level is not supported'),
    { text: 'Stay in.' },
    { text: 'Still stay in.' },
  );
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

test('a model that just failed goes to the back of the line, but is still tried', async () => {
  let t = 0;
  const client = fakeClient(apiError(404), { text: 'A' }, { text: 'B' }, apiError(503), { text: 'C' });
  const gemini = createGemini({ client, models: ['m1', 'm2'], log: quiet, now: () => t });
  assert.equal((await gemini.ask(delhiContext(), 'One?')).answer, 'A');
  assert.equal((await gemini.ask(delhiContext(), 'Two?')).answer, 'B');
  assert.deepEqual(
    client.calls.map((c) => c.model),
    ['m1', 'm2', 'm2'],
    'm1 went to the back, so m2 answered first',
  );
  t = 7 * 3_600_000; // past the 6-hour wait for a missing model
  client.calls.length = 0;
  await gemini.ask(delhiContext(), 'Three?');
  assert.deepEqual(
    client.calls.map((c) => c.model),
    ['m1', 'm2'],
    'm1 is first again',
  );
});

test('when every model is overloaded, each one is still tried on the next request', async () => {
  const client = fakeClient(apiError(503), apiError(503), { text: 'Back' });
  const gemini = createGemini({ client, models: ['m1', 'm2'], log: quiet, now: () => 0 });
  await assert.rejects(gemini.ask(delhiContext(), 'One?'));
  assert.equal((await gemini.ask(delhiContext(), 'Two?')).answer, 'Back', 'a benched model still gets its turn');
});
