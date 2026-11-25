// Validates everything that arrives from the browser. Anything that reaches Gemini or an upstream API passes
// through here first: numbers are range-checked, choices must come from fixed lists, and free text is trimmed,
// length-capped and stripped of control characters and angle brackets (so it can't close the prompt's tags).
/** @import { Place, Profile } from './types.js' */
import { MODES } from './impact.js';
import { InputError } from './errors.js';
import { roundTo } from './util.js';

export const LANGUAGES = {
  en: 'English',
  hi: 'Hindi',
  bn: 'Bengali',
  pa: 'Punjabi',
  ur: 'Urdu',
  mr: 'Marathi',
  ta: 'Tamil',
  te: 'Telugu',
};
export const HOUSEHOLD = {
  children: 'children',
  elderly: 'older adults (65+)',
  respiratory: 'someone with asthma or a lung or heart condition',
  pregnant: 'someone who is pregnant',
};
export const EXERCISE = {
  none: 'none outdoors',
  morning: 'outdoors in the morning',
  evening: 'outdoors in the evening',
};
export const COOKING = { gas: 'gas or LPG stove', induction: 'induction or electric', biomass: 'wood, coal or dung' };

/** Longest free text kept from the browser, per field. */
const MAX_CHARS = { city: 80, placeName: 80, notes: 200, question: 300 };
/** Shortest question worth sending to Gemini. */
const MIN_QUESTION_CHARS = 3;

/** Commute limits: one-way distance in km and days a week. */
const COMMUTE_KM = { min: 0, max: 150 };
const COMMUTE_DAYS = { min: 0, max: 7, default: 5 };
/** Longest IANA time zone name accepted; real ones are far shorter. */
const MAX_TIME_ZONE_CHARS = 64;

/**
 * Rejects the request with a message the user can act on.
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new InputError(message);
}

/**
 * Trims, collapses whitespace and removes control characters and angle brackets.
 * @param {unknown} value
 * @param {number} max  longest result, in characters
 */
export function cleanText(value, max) {
  return String(value ?? '')
    .replace(/[\p{Cc}<>]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * A number in [min, max]. Numeric strings are accepted, as query parameters arrive as text.
 * @param {unknown} value
 * @param {string} name  used in the error message
 * @param {number} min
 * @param {number} max
 */
function number(value, name, min, max) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) {
    fail(`${name} must be a number from ${min} to ${max}.`);
  }
  return n;
}

/**
 * One of the keys of `table`, or a 400.
 * @template {object} T
 * @param {unknown} value
 * @param {T} table
 * @param {string} name  used in the error message
 * @returns {keyof T}
 */
function oneOf(value, table, name) {
  if (typeof value === 'string' && Object.hasOwn(table, value)) return /** @type {keyof T} */ (value);
  return fail(`${name} is not a supported choice.`);
}

/**
 * True for an IANA time zone this runtime knows, such as "Asia/Kolkata".
 * @param {unknown} tz
 * @returns {tz is string}
 */
export function isTimeZone(tz) {
  if (typeof tz !== 'string' || tz.length > MAX_TIME_ZONE_CHARS) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * A city or area name: letters in any script, digits, spaces and light punctuation, 2–80 characters.
 * @param {unknown} query
 */
export function readCityQuery(query) {
  const city = cleanText(query, MAX_CHARS.city);
  if (!/^[\p{L}\p{M}\p{N} .,'()-]{2,}$/u.test(city)) fail('Enter a city or area name (2–80 letters).');
  return city;
}

/**
 * Coordinates, time zone and display name of the place a plan is for. Coordinates are rounded to ~1 km.
 * @param {any} input  untrusted JSON or query values
 * @returns {Place}
 */
export function readPlace(input) {
  if (!input || typeof input !== 'object') fail('place is required.');
  return {
    lat: roundTo(number(input.lat, 'Latitude', -90, 90), 2),
    lon: roundTo(number(input.lon, 'Longitude', -180, 180), 2),
    tz: isTimeZone(input.tz) ? input.tz : 'UTC',
    name: cleanText(input.name, MAX_CHARS.placeName) || 'your area',
  };
}

/**
 * The household profile behind a plan, with defaults for anything left out.
 * @param {any} [input]  untrusted JSON
 * @returns {Profile}
 */
export function readProfile(input = {}) {
  if (typeof input !== 'object' || input === null) fail('profile must be an object.');
  /** @type {unknown[]} */
  const household = Array.isArray(input.household) ? input.household : [];
  if (household.length > Object.keys(HOUSEHOLD).length) fail('household has too many entries.');
  const commute = input.commute ?? {};
  const mode = oneOf(commute.mode ?? 'wfh', MODES, 'Commute');
  const atHome = mode === 'wfh';
  return {
    household: [...new Set(household.map((member) => oneOf(member, HOUSEHOLD, 'Household member')))],
    commute: {
      mode,
      km: atHome ? 0 : roundTo(number(commute.km ?? 0, 'Commute distance', COMMUTE_KM.min, COMMUTE_KM.max), 1),
      days: atHome
        ? 0
        : Math.round(number(commute.days ?? COMMUTE_DAYS.default, 'Commute days', COMMUTE_DAYS.min, COMMUTE_DAYS.max)),
    },
    exercise: oneOf(input.exercise ?? 'none', EXERCISE, 'Exercise'),
    purifier: input.purifier === true,
    cooking: oneOf(input.cooking ?? 'gas', COOKING, 'Cooking'),
    notes: cleanText(input.notes, MAX_CHARS.notes),
    language: oneOf(input.language ?? 'en', LANGUAGES, 'Language'),
  };
}

/**
 * A follow-up question for the assistant: 3–300 characters of plain text.
 * @param {unknown} query
 */
export function readQuestion(query) {
  const question = cleanText(query, MAX_CHARS.question);
  if (question.length < MIN_QUESTION_CHARS) fail('Ask a question of at least 3 characters.');
  return question;
}
