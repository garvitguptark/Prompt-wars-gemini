// Stubbed API answers built from the unit tests' recorded-shape fixtures, so browser tests need no network or keys.
import { delhi, delhiAir, delhiContext, family } from '../test/fixtures.js';
import { rulesPlan } from '../src/rules-plan.js';
import { commuteImpact } from '../src/impact.js';

export const airResponse = { place: delhi, air: delhiAir() };
export const planResponse = (plan = rulesPlan(delhiContext())) => ({
  place: delhi,
  air: delhiAir(),
  commute: commuteImpact(family.commute),
  source: 'gemini',
  model: 'gemini-test',
  plan,
});

/** Answers /api/* from fixtures; `overrides` maps a path to a { status, json } reply. */
export async function stubApi(page, overrides = {}) {
  const replies = {
    '/api/air': { json: airResponse },
    '/api/plan': { json: planResponse() },
    '/api/ask': { json: { answer: 'Keep them indoors until 2 pm.', model: 'gemini-test' } },
    ...overrides,
  };
  await page.route('**/api/**', (route) => {
    const reply = replies[new URL(route.request().url()).pathname];
    return reply ? route.fulfill(reply) : route.abort();
  });
}

/** Fills the planner the way a person would and asks for a plan. */
export async function getPlan(page) {
  await page.fill('#city', 'Delhi');
  await page.locator('label.chip', { hasText: 'Children' }).click();
  await page.locator('#submit').click();
  await page.locator('#plan-body .act').first().waitFor();
}
