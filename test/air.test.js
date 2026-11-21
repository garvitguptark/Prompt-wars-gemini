import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAirService, parseGoogle, parseOpenMeteo, summarize, UpstreamError, PlaceNotFound } from '../src/air.js';
import { NOW, hourIso, delhi, googleCurrent, googleForecast, openMeteo, fakeFetch, quiet } from './fixtures.js';

test('Google readings are parsed into one shape', () => {
  const raw = parseGoogle(googleCurrent, googleForecast);
  assert.equal(raw.source, 'Google Air Quality API');
  assert.equal(raw.pm25, 245.37);
  assert.deepEqual(raw.localIndex, { name: 'AQI (IN)', aqi: 412, category: 'Severe air quality' });
  assert.equal(raw.dominant, 'PM2.5');
  assert.deepEqual(raw.pollutants.map((p) => `${p.name} ${p.value} ${p.units}`), ['PM2.5 245.4 µg/m³', 'NO₂ 61.2 ppb']);
  assert.equal(raw.hourly.length, 24);
  assert.throws(() => parseGoogle({ pollutants: [] }, null), UpstreamError);
});

test('Open-Meteo readings are parsed into the same shape', () => {
  const raw = parseOpenMeteo(openMeteo);
  assert.equal(raw.source, 'Open-Meteo');
  assert.equal(raw.updated, new Date(NOW).toISOString());
  assert.deepEqual(raw.pollutants.map((p) => p.code), ['pm25', 'pm10', 'no2'], 'missing ozone is left out');
  assert.equal(raw.localIndex, null);
  assert.throws(() => parseOpenMeteo({ current: {} }), UpstreamError);
});

test('summaries put every source on the EPA scale and drop past hours', () => {
  const s = summarize(parseOpenMeteo(openMeteo), 'Asia/Kolkata', NOW);
  assert.equal(s.aqi, 255);
  assert.equal(s.band.key, 'very-unhealthy');
  assert.equal(s.whoMultiple, 12);
  assert.equal(s.hourly.length, 24);
  assert.equal(s.hourly[0].time, hourIso(0), 'the hour already gone is dropped, the current one kept');
  assert.ok(s.windows.cleanest && s.windows.worst);
});

test('with a Maps key, Google is asked first with the key in a header', async () => {
  const fetch = fakeFetch([['currentConditions', 200, googleCurrent], ['forecast', 200, googleForecast]]);
  const air = createAirService({ mapsKey: 'test-key', fetch, now: () => NOW, log: quiet });
  const s = await air.lookup(delhi);
  assert.equal(s.source, 'Google Air Quality API');
  assert.equal(s.aqi, 340);
  assert.equal(s.windows.cleanest.avgAqi, aqiOf(60));
  assert.equal(s.windows.worst.avgAqi, aqiOf(280));
  assert.ok(fetch.calls.every((c) => !c.url.includes('test-key') && c.init.headers['x-goog-api-key'] === 'test-key'));
});

test('falls back to Open-Meteo when Google fails, and caches the answer', async () => {
  const fetch = fakeFetch([['airquality.googleapis.com', 403, {}], ['open-meteo', 200, openMeteo]]);
  const air = createAirService({ mapsKey: 'bad-key', fetch, now: () => NOW, log: quiet });
  const [a, b] = await Promise.all([air.lookup(delhi), air.lookup({ ...delhi, lat: 28.6101 })]);
  assert.equal(a.source, 'Open-Meteo');
  assert.equal(b.aqi, a.aqi);
  assert.equal(fetch.calls.filter((c) => c.url.includes('open-meteo')).length, 1, 'concurrent lookups share one request');
});

test('a dead upstream becomes a clear 502, and is not cached', async () => {
  const fetch = fakeFetch([]);
  const air = createAirService({ fetch, now: () => NOW, log: quiet });
  await assert.rejects(air.lookup(delhi), (err) => err instanceof UpstreamError && err.status === 502);
  await assert.rejects(air.lookup(delhi), UpstreamError);
  assert.equal(fetch.calls.length, 2, 'failure was retried, not served from cache');
});

test('geocoding prefers the country named after a comma', async () => {
  const results = [
    { name: 'Hyderabad', admin1: 'Telangana', country: 'India', country_code: 'IN', latitude: 17.384, longitude: 78.4564, timezone: 'Asia/Kolkata' },
    { name: 'Hyderabad', admin1: 'Sindh', country: 'Pakistan', country_code: 'PK', latitude: 25.396, longitude: 68.3578, timezone: 'Asia/Karachi' },
  ];
  const fetch = fakeFetch([['geocoding', 200, { results }]]);
  const air = createAirService({ fetch, log: quiet });
  assert.deepEqual(await air.geocode('Hyderabad, Pakistan'), { name: 'Hyderabad, Sindh, Pakistan', lat: 25.4, lon: 68.36, tz: 'Asia/Karachi' });
  assert.equal((await air.geocode('Hyderabad, Sindh')).tz, 'Asia/Karachi', '"in" inside "Sindh" is not India');
  assert.equal((await air.geocode('Hyderabad, PK')).tz, 'Asia/Karachi');
  assert.equal((await air.geocode('Hyderabad')).tz, 'Asia/Kolkata');
  assert.ok(fetch.calls[0].url.includes('name=Hyderabad&'), 'only the city part is searched');
});

test('an unknown place is a 404 with a helpful message', async () => {
  const air = createAirService({ fetch: fakeFetch([['geocoding', 200, {}]]), log: quiet });
  await assert.rejects(air.geocode('Atlantis'), (err) => err instanceof PlaceNotFound && err.status === 404 && /Atlantis/.test(err.message));
});

function aqiOf(pm) {
  return summarize({ pm25: pm, hourly: [] }, 'UTC').aqi;
}
