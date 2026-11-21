import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createApp, clientIp, rateLimiter } from '../src/app.js';
import { createPlanner } from '../src/planner.js';
import { UpstreamError, PlaceNotFound } from '../src/air.js';
import { delhi, delhiAir, family, geminiPlan, quiet } from './fixtures.js';

const publicDir = join(import.meta.dirname, '..', 'public');
const fakeAir = {
  geocode: async (q) => { if (q === 'Atlantis') throw new PlaceNotFound('We couldn\'t find "Atlantis".'); return delhi; },
  lookup: async () => delhiAir(),
};
const fakeGemini = { enabled: true, plan: async () => ({ plan: geminiPlan, model: 'gemini-test' }), ask: async () => ({ answer: 'Stay in until 2 pm.', model: 'gemini-test' }) };

async function start(t, { air = fakeAir, gemini = fakeGemini, limits } = {}) {
  const planner = createPlanner({ air, gemini, log: quiet });
  const server = createServer(createApp({ air, planner, publicDir, log: quiet, ...(limits && { limits }) }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (path, init) => fetch(base + path, init);
}
const postJson = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('the page is served compressed, cacheable and behind a strict CSP', async (t) => {
  const get = await start(t);
  const res = await get('/', { headers: { 'accept-encoding': 'br' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-encoding'), 'br');
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /<h1 id="hero-title">/);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  const again = await get('/', { headers: { 'if-none-match': res.headers.get('etag') } });
  assert.equal(again.status, 304);
  const css = await get('/styles.css', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(css.headers.get('content-encoding'), 'gzip');
  assert.match(css.headers.get('cache-control'), /max-age=3600/);
});

test('only known files are served; everything else is a JSON 404 or 405', async (t) => {
  const get = await start(t);
  for (const path of ['/server.js', '/../package.json', '/%2e%2e/package.json', '/src/app.js', '/.env']) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
    assert.deepEqual(await res.json(), { error: 'Not found.' });
  }
  const res = await get('/api/plan');
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'POST');
  assert.deepEqual(await (await get('/health')).json(), { status: 'ok' });
});

test('air lookup by city or by coordinates', async (t) => {
  const get = await start(t);
  const byCity = await (await get('/api/air?q=Delhi')).json();
  assert.equal(byCity.place.name, delhi.name);
  assert.equal(byCity.air.aqi, 340);
  assert.equal(byCity.air.hourly.length, 24);
  const byCoords = await get('/api/air?lat=28.6139&lon=77.209&tz=Asia/Kolkata');
  assert.equal(byCoords.status, 200);
  assert.deepEqual((await byCoords.json()).place, { lat: 28.61, lon: 77.21, tz: 'Asia/Kolkata', name: 'your location' });
  assert.equal(byCoords.headers.get('cache-control'), 'no-store');
});

test('bad air lookups explain what is wrong', async (t) => {
  const get = await start(t);
  const cases = [['/api/air?q=%3C%3E', 400, /city/], ['/api/air?lat=200&lon=0', 400, /Latitude/], ['/api/air', 400, /Latitude/], ['/api/air?q=Atlantis', 404, /Atlantis/]];
  for (const [path, status, message] of cases) {
    const res = await get(path);
    assert.equal(res.status, status, path);
    assert.match((await res.json()).error, message);
  }
});

test('a plan comes back with its source, the commute numbers and the fresh reading', async (t) => {
  const get = await start(t);
  const res = await get('/api/plan', postJson({ place: delhi, profile: family }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.source, 'gemini');
  assert.equal(body.model, 'gemini-test');
  assert.equal(body.plan.routine[0].time, '2–5 pm');
  assert.equal(body.commute.alternatives[0].mode, 'metro');
  assert.equal(body.air.aqi, 340);
});

test('without Gemini the plan route still answers, with built-in guidance', async (t) => {
  const get = await start(t, { gemini: { enabled: false } });
  const body = await (await get('/api/plan', postJson({ place: delhi, profile: family }))).json();
  assert.equal(body.source, 'rules');
  assert.ok(body.plan.routine.length >= 3);
  const ask = await get('/api/ask', postJson({ place: delhi, profile: family, question: 'Go out?' }));
  assert.equal(ask.status, 503);
  assert.match((await ask.json()).error, /offline/);
});

test('plan and ask bodies are checked before any work is done', async (t) => {
  const get = await start(t);
  const cases = [
    [{ method: 'POST', body: '{}' }, 415],
    [{ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' }, 400],
    [{ method: 'POST', headers: { 'content-type': 'application/json' }, body: '"a string"' }, 400],
    [postJson({ place: delhi, profile: family, pad: 'x'.repeat(20_000) }), 413],
    [postJson({ place: delhi, profile: { ...family, language: 'klingon' } }), 400],
    [postJson({ profile: family }), 400],
  ];
  for (const [init, status] of cases) assert.equal((await get('/api/plan', init)).status, status, init.body?.slice?.(0, 40));
  const ask = await get('/api/ask', postJson({ place: delhi, profile: family, question: 'Can my son play cricket today?' }));
  assert.deepEqual(await ask.json(), { answer: 'Stay in until 2 pm.', model: 'gemini-test' });
  assert.equal((await get('/api/ask', postJson({ place: delhi, profile: family, question: '' }))).status, 400);
});

test('rate limits answer 429 with Retry-After, per route group', async (t) => {
  const get = await start(t, { limits: { air: [2, 60_000], ai: [1, 60_000] } });
  assert.equal((await get('/api/air?q=Delhi')).status, 200);
  assert.equal((await get('/api/air?q=Delhi')).status, 200);
  const limited = await get('/api/air?q=Delhi');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await get('/api/plan', postJson({ place: delhi, profile: family }))).status, 200, 'separate budget for AI routes');
  assert.equal((await get('/api/ask', postJson({ place: delhi, profile: family, question: 'Hi there' }))).status, 429);
});

test('upstream trouble is a friendly 502, and unexpected errors never leak details', async (t) => {
  const broken = await start(t, { air: { ...fakeAir, lookup: async () => { throw new UpstreamError('open-meteo answered 500'); } } });
  const res = await broken('/api/air?q=Delhi');
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /unavailable right now/);

  const crashing = await start(t, { air: { ...fakeAir, lookup: async () => { throw new TypeError('secret internals at /srv/x.js'); } } });
  const crash = await crashing('/api/air?q=Delhi');
  assert.equal(crash.status, 500);
  assert.deepEqual(await crash.json(), { error: 'Something went wrong on our side. Please try again.' });
});

test('the client address is the last X-Forwarded-For entry, so a forged first entry changes nothing', () => {
  const req = (xff) => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: '10.0.0.1' } });
  assert.equal(clientIp(req('6.6.6.6, 203.0.113.7')), '203.0.113.7');
  assert.equal(clientIp(req()), '10.0.0.1');
  let now = 0;
  const allow = rateLimiter(2, 1000, () => now);
  assert.deepEqual([allow('a'), allow('a'), allow('a'), allow('b')], [0, 0, 1, 0]);
  now = 1000;
  assert.equal(allow('a'), 0, 'the window resets');
});
