import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { stubApi, getPlan, planResponse } from './helpers.js';
import { rulesPlan } from '../src/planner.js';
import { delhiContext } from '../test/fixtures.js';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
// Audit only once entrance animations have finished: half-faded text would read as low contrast.
async function audit(page) {
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
  );
  return (await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations.map((v) => `${v.id}: ${v.help}`);
}

test.beforeEach(async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
});

test('the landing page meets WCAG 2.2 AA (axe)', async ({ page }) => {
  expect(await audit(page)).toEqual([]);
});

test('a full plan meets WCAG 2.2 AA too', async ({ page }) => {
  await getPlan(page);
  await page.locator('#ask').waitFor();
  expect(await audit(page)).toEqual([]);
});

test('keyboard only: skip link, a chip, the form and focus on the results', async ({ page }) => {
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
  await page.locator('input[value="children"]').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('input[value="children"]')).toBeChecked();
  await page.locator('#city').focus();
  await page.keyboard.type('Delhi');
  await page.keyboard.press('Enter');
  await expect(page.locator('#air-title')).toBeFocused();
  await expect(page.locator('#status')).toHaveText('Your plan for today is ready.');
});

test('the plan shows its source, each step with why and impact, and the commute numbers', async ({ page }) => {
  await getPlan(page);
  await expect(page.locator('#aqi-num')).toHaveText('340');
  await expect(page.locator('#plan-by')).toContainText('Written by Gemini (gemini-test)');
  const first = page.locator('#plan-body .timeline .act').first();
  await expect(first.locator('.act-why')).toContainText('Why:');
  await expect(first.locator('.act-impact .tag')).toBeVisible();
  await expect(page.locator('.chart')).toContainText('saves 749 kg a year');
  await expect(page.locator('#bars li')).toHaveCount(24);
});

test('model output is shown as text, never run as HTML', async ({ page }) => {
  const plan = { ...rulesPlan(delhiContext()), summary: '<img src=x onerror="window.pwned=1">Stay in.' };
  await page.unroute('**/api/**');
  await stubApi(page, { '/api/plan': { json: planResponse(plan) } });
  await getPlan(page);
  await expect(page.locator('#plan-body .summary p')).toContainText('<img src=x');
  expect(await page.locator('#plan-body img').count()).toBe(0);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
});

test('when the plan fails, the page says so and offers a retry', async ({ page }) => {
  await page.unroute('**/api/**');
  await stubApi(page, { '/api/plan': { status: 503, json: { error: 'The assistant is offline right now.' } } });
  await page.fill('#city', 'Delhi');
  await page.locator('#submit').click();
  await expect(page.locator('#plan-body .error')).toHaveText('The assistant is offline right now.');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('follow-up questions get an answer', async ({ page }) => {
  await getPlan(page);
  await page.locator('#suggest button').first().click();
  await expect(page.locator('#answer')).toContainText('Keep them indoors until 2 pm.');
});

test('turning off "remember me" forgets the answers on this device', async ({ page }) => {
  await getPlan(page);
  expect(await page.evaluate(() => localStorage.getItem('airwise:form'))).toContain('Delhi');
  await page.locator('label.switch').click();
  expect(await page.evaluate(() => localStorage.getItem('airwise:form'))).toBe('null');
});

test('no sideways scrolling, even at 320 px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await getPlan(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
});

test('reduced motion turns animation off', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  const seconds = await page
    .locator('.btn.primary')
    .first()
    .evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration));
  expect(seconds).toBeLessThan(0.01);
});
