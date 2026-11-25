// The shape of a plan, both ways: the response schema Gemini must follow, and the clean-up every reply goes
// through before anyone sees it. Both use the same limits, so the schema and the clean-up can't disagree.
/** @import { Plan, PlanItem, ImpactType } from './types.js' */
import { Type } from '@google/genai';

/** Most items per section, and fewest where a section must not be empty. */
export const PLAN_ITEMS = {
  alerts: { max: 3 },
  routine: { min: 3, max: 7 },
  indoor: { min: 2, max: 5 },
  swaps: { min: 1, max: 4 },
};

/** Longest text kept per field. The schema asks for far less; these only stop a runaway reply. */
const MAX_CHARS = { time: 40, title: 80, field: 320, summary: 700, answer: 1200 };

const IMPACT_TYPES = ['exposure', 'emissions', 'both'];

/** @param {string} description */
const text = (description) => ({ type: Type.STRING, description });

const ITEM_FIELDS = {
  title: text('At most 6 words'),
  action: text('Exactly what to do, at most 30 words'),
  why: text('How it works, at most 30 words'),
  impact: text('The effect on exposure and/or emissions in one sentence; numbers only from the data or facts'),
  impactType: { type: Type.STRING, enum: IMPACT_TYPES },
};

/**
 * An array of plan items; routine items also carry a time.
 * @param {{ min?: number, max: number }} count
 * @param {boolean} [withTime]
 */
function itemList({ min = 0, max }, withTime = false) {
  const properties = withTime ? { time: text('Local time or range, e.g. "7–9 am"'), ...ITEM_FIELDS } : ITEM_FIELDS;
  const keys = Object.keys(properties);
  return {
    type: Type.ARRAY,
    items: { type: Type.OBJECT, properties, required: keys, propertyOrdering: keys },
    minItems: String(min),
    maxItems: String(max),
  };
}

export const PLAN_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: text("2–3 sentences: what today's air means for this household and the single most important thing to do"),
    alerts: {
      type: Type.ARRAY,
      items: text('An urgent warning for a sensitive person'),
      maxItems: String(PLAN_ITEMS.alerts.max),
    },
    routine: itemList(PLAN_ITEMS.routine, true),
    indoor: itemList(PLAN_ITEMS.indoor),
    swaps: itemList(PLAN_ITEMS.swaps),
  },
  required: ['summary', 'alerts', 'routine', 'indoor', 'swaps'],
  propertyOrdering: ['summary', 'alerts', 'routine', 'indoor', 'swaps'],
};

/**
 * Text with whitespace collapsed, trimmed and cut to `max` characters.
 * @param {unknown} value
 * @param {number} max
 */
const clip = (value, max) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/**
 * Well-formed items only: fields clipped, unknown impact types read as "both", untitled items dropped.
 * @param {unknown} list
 * @param {number} max
 * @param {boolean} [withTime]
 * @returns {PlanItem[]}
 */
function sanitizeItems(list, max, withTime = false) {
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, max)
    .filter((item) => item !== null && typeof item === 'object')
    .map((item) => ({
      ...(withTime ? { time: clip(item.time, MAX_CHARS.time) } : {}),
      title: clip(item.title, MAX_CHARS.title),
      action: clip(item.action, MAX_CHARS.field),
      why: clip(item.why, MAX_CHARS.field),
      impact: clip(item.impact, MAX_CHARS.field),
      impactType: IMPACT_TYPES.includes(item.impactType) ? item.impactType : 'both',
    }))
    .filter((item) => item.title && item.action);
}

/**
 * Keeps only well-formed fields, caps lengths and counts, and refuses a plan with nothing to do.
 * @param {any} raw  parsed JSON from the model
 * @returns {Plan}
 */
export function sanitizePlan(raw) {
  const alerts = Array.isArray(raw?.alerts) ? raw.alerts.slice(0, PLAN_ITEMS.alerts.max) : [];
  const plan = {
    summary: clip(raw?.summary, MAX_CHARS.summary),
    alerts: alerts.map((/** @type {unknown} */ alert) => clip(alert, MAX_CHARS.field)).filter(Boolean),
    routine: sanitizeItems(raw?.routine, PLAN_ITEMS.routine.max, true),
    indoor: sanitizeItems(raw?.indoor, PLAN_ITEMS.indoor.max),
    swaps: sanitizeItems(raw?.swaps, PLAN_ITEMS.swaps.max),
  };
  if (!plan.summary || plan.routine.length === 0) throw new Error('Gemini returned an incomplete plan');
  return plan;
}

/**
 * Plain text for the answer box: no markdown symbols, at most two line breaks in a row.
 * @param {unknown} raw
 */
export const cleanAnswer = (raw) =>
  String(raw ?? '')
    .replace(/[*#`]+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_CHARS.answer);
