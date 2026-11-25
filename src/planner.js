// Puts a plan together: live air + commute numbers + Gemini, with the built-in plan when Gemini can't answer,
// so a family always gets something useful and the page says honestly which one they got.
/** @import { AirService, GeminiService, Logger, Place, PlanContext, Planner, PlanResult, Profile } from './types.js' */
import { commuteImpact } from './impact.js';
import { rulesPlan } from './rules-plan.js';
import { ttlCache } from './cache.js';
import { ServiceUnavailable } from './errors.js';
import { log as defaultLog } from './log.js';
import { MINUTE_MS } from './util.js';

/** Same household, same reading: same plan, and no new tokens spent on it. */
const PLAN_CACHE = { ttlMs: 30 * MINUTE_MS, max: 300 };
const OFFLINE_MESSAGE =
  'The assistant is offline right now. Your plan still applies; try asking again in a few minutes.';

/**
 * @param {{ air: AirService, gemini: GeminiService, log?: Logger, now?: () => number }} deps
 * @returns {Planner}
 */
export function createPlanner({ air, gemini, log = defaultLog, now = Date.now }) {
  const plans = ttlCache({ ...PLAN_CACHE, now });

  /**
   * Everything a plan is written from: the place, its live air, the household and its commute numbers.
   * @param {Place} place
   * @param {Profile} profile
   * @returns {Promise<PlanContext>}
   */
  async function contextFor(place, profile) {
    return { place, air: await air.lookup(place), profile, commute: commuteImpact(profile.commute) };
  }

  /**
   * Gemini's plan when it answers (cached per household and reading), else the built-in plan.
   * @param {Place} place
   * @param {Profile} profile
   * @returns {Promise<PlanResult>}
   */
  async function plan(place, profile) {
    const context = await contextFor(place, profile);
    const base = { air: context.air, commute: context.commute };
    if (gemini.enabled) {
      try {
        const key = JSON.stringify([place, context.air.updated, profile]);
        const written = await plans.remember(key, () => gemini.plan(context));
        return { ...base, source: 'gemini', model: written.model, plan: written.plan };
      } catch (err) {
        log('WARNING', 'Gemini plan failed, using built-in guidance', errorFields(err));
      }
    }
    return { ...base, source: 'rules', plan: rulesPlan(context) };
  }

  /**
   * A follow-up answer. Only Gemini can answer, so any failure becomes one friendly 503.
   * @param {Place} place
   * @param {Profile} profile
   * @param {string} question
   * @returns {Promise<{ answer: string, model: string }>}
   */
  async function ask(place, profile, question) {
    if (!gemini.enabled) throw new ServiceUnavailable(OFFLINE_MESSAGE);
    const context = await contextFor(place, profile);
    try {
      return await gemini.ask(context, question);
    } catch (err) {
      log('WARNING', 'Gemini answer failed', errorFields(err));
      throw new ServiceUnavailable(OFFLINE_MESSAGE);
    }
  }

  return { plan, ask };
}

/**
 * The parts of an error worth logging.
 * @param {unknown} err
 */
function errorFields(err) {
  const { message, status } = /** @type {{ message?: string, status?: number }} */ (err);
  return { error: message, status };
}
