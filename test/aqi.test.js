import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aqiFromPm25, bandFor, whoMultiple, forecastWindows } from '../src/aqi.js';

test('PM2.5 maps onto every US EPA breakpoint edge', () => {
  const edges = [
    [0, 0],
    [9.0, 50],
    [9.1, 51],
    [35.4, 100],
    [35.5, 101],
    [55.4, 150],
    [55.5, 151],
    [125.4, 200],
    [125.5, 201],
    [225.4, 300],
    [225.5, 301],
    [325.4, 500],
  ];
  for (const [pm, aqi] of edges) assert.equal(aqiFromPm25(pm), aqi, `PM2.5 ${pm}`);
  assert.equal(aqiFromPm25(12), 56);
  assert.equal(aqiFromPm25(9.05), 50, 'truncates to one decimal like the EPA');
});

test('readings beyond the scale cap at 500 and bad readings give null', () => {
  assert.equal(aqiFromPm25(900), 500);
  for (const bad of [-1, NaN, Infinity, undefined, '50']) assert.equal(aqiFromPm25(bad), null);
});

test('bands and WHO multiples', () => {
  assert.deepEqual(bandFor(50), { key: 'good', label: 'Good' });
  assert.equal(bandFor(51).key, 'moderate');
  assert.equal(bandFor(150).key, 'sensitive');
  assert.equal(bandFor(301).key, 'hazardous');
  assert.equal(whoMultiple(245), 16.3);
  assert.equal(whoMultiple(15), 1);
});

test('cleanest window stays in waking hours; worst window can be at night', () => {
  const start = Date.parse('2026-11-21T00:00:00Z');
  const aqiAt = (h) => (h <= 2 ? 450 : h <= 5 ? 30 : h >= 14 && h <= 16 ? 80 : 200);
  const hours = Array.from({ length: 24 }, (_, h) => ({
    time: new Date(start + h * 3_600_000).toISOString(),
    aqi: aqiAt(h),
  }));
  const w = forecastWindows(hours, 'UTC');
  assert.equal(w.cleanest.start, '2026-11-21T14:00:00.000Z', 'the 03:00–06:00 dip is skipped: people are asleep');
  assert.equal(w.cleanest.end, '2026-11-21T17:00:00.000Z');
  assert.equal(w.cleanest.avgAqi, 80);
  assert.equal(w.cleanest.band.key, 'moderate');
  assert.equal(w.worst.start, '2026-11-21T00:00:00.000Z');
  assert.equal(w.worst.avgAqi, 450);
});

test('waking hours follow the place, not the server', () => {
  // The clean stretch starts at 05:00 UTC: still night in London-time, but 10:30 in the morning in Kolkata.
  const hours = [50, 50, 50, 300].map((aqi, h) => ({
    time: new Date(Date.parse('2026-11-21T05:00:00Z') + h * 3_600_000).toISOString(),
    aqi,
  }));
  assert.equal(forecastWindows(hours, 'Asia/Kolkata').cleanest.avgAqi, 50);
  assert.equal(forecastWindows(hours, 'UTC').cleanest.avgAqi, 133);
  assert.equal(forecastWindows(hours.slice(0, 2), 'UTC'), null, 'too few hours for a window');
});
