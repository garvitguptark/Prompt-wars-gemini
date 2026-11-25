import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe, planPrompt, askPrompt } from '../src/prompts.js';
import { delhiContext, NOW } from './fixtures.js';

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
