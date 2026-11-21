import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ttlCache } from '../src/cache.js';
import { log } from '../src/log.js';

test('entries expire after their time and the oldest is dropped when full', () => {
  let now = 0;
  const cache = ttlCache({ ttlMs: 100, max: 2, now: () => now });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.equal(cache.get('a'), undefined, 'oldest evicted');
  assert.equal(cache.get('b'), 2);
  now = 100;
  assert.equal(cache.get('b'), undefined, 'expired');
});

test('remember shares one piece of in-flight work and forgets failures', async () => {
  const cache = ttlCache({ ttlMs: 1000 });
  let runs = 0;
  const work = async () => { runs++; return 'ok'; };
  assert.deepEqual(await Promise.all([cache.remember('k', work), cache.remember('k', work)]), ['ok', 'ok']);
  assert.equal(runs, 1);
  await assert.rejects(cache.remember('bad', async () => { throw new Error('nope'); }));
  assert.equal(await cache.remember('bad', async () => 'second try'), 'second try');
});

test('logs are one JSON object per line, errors on stderr', (t) => {
  const out = t.mock.method(console, 'log', () => {});
  const err = t.mock.method(console, 'error', () => {});
  log('INFO', 'hello', { httpRequest: { status: 200 } });
  log('ERROR', 'boom');
  assert.deepEqual(JSON.parse(out.mock.calls[0].arguments[0]), { severity: 'INFO', message: 'hello', httpRequest: { status: 200 } });
  assert.deepEqual(JSON.parse(err.mock.calls[0].arguments[0]), { severity: 'ERROR', message: 'boom' });
});
