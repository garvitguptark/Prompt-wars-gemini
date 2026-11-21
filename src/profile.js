// Validates everything that arrives from the browser. Anything that reaches Gemini or an upstream API passes
// through here first: numbers are range-checked, choices must come from fixed lists, and free text is trimmed,
// length-capped and stripped of control characters and angle brackets (so it can't close the prompt's tags).
import { MODES } from './impact.js';

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

export class InputError extends Error {
  status = 400;
}

const fail = (message) => {
  throw new InputError(message);
};

/** Trims, collapses whitespace and removes control characters and angle brackets. */
export function cleanText(value, max) {
  return String(value ?? '')
    .replace(/[\p{Cc}<>]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function number(value, name, min, max) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max)
    fail(`${name} must be a number from ${min} to ${max}.`);
  return n;
}

const oneOf = (value, table, name) =>
  Object.hasOwn(table, value) ? value : fail(`${name} is not a supported choice.`);

export function isTimeZone(tz) {
  if (typeof tz !== 'string' || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A city or area name: letters in any script, digits, spaces and light punctuation, 2–80 characters. */
export function readCityQuery(q) {
  const city = cleanText(q, 80);
  if (!/^[\p{L}\p{M}\p{N} .,'()-]{2,80}$/u.test(city)) fail('Enter a city or area name (2–80 letters).');
  return city;
}

/** Coordinates, time zone and display name of the place a plan is for. Coordinates are rounded to ~1 km. */
export function readPlace(input) {
  if (!input || typeof input !== 'object') fail('place is required.');
  const round = (n) => Math.round(n * 100) / 100;
  return {
    lat: round(number(input.lat, 'Latitude', -90, 90)),
    lon: round(number(input.lon, 'Longitude', -180, 180)),
    tz: isTimeZone(input.tz) ? input.tz : 'UTC',
    name: cleanText(input.name, 80) || 'your area',
  };
}

/** The household profile behind a plan, with defaults for anything left out. */
export function readProfile(input = {}) {
  if (typeof input !== 'object' || input === null) fail('profile must be an object.');
  const household = Array.isArray(input.household) ? input.household : [];
  if (household.length > Object.keys(HOUSEHOLD).length) fail('household has too many entries.');
  const commute = input.commute ?? {};
  const mode = oneOf(commute.mode ?? 'wfh', MODES, 'Commute');
  return {
    household: [...new Set(household.map((h) => oneOf(h, HOUSEHOLD, 'Household member')))],
    commute: {
      mode,
      km: mode === 'wfh' ? 0 : Math.round(number(commute.km ?? 0, 'Commute distance', 0, 150) * 10) / 10,
      days: mode === 'wfh' ? 0 : Math.round(number(commute.days ?? 5, 'Commute days', 0, 7)),
    },
    exercise: oneOf(input.exercise ?? 'none', EXERCISE, 'Exercise'),
    purifier: input.purifier === true,
    cooking: oneOf(input.cooking ?? 'gas', COOKING, 'Cooking'),
    notes: cleanText(input.notes, 200),
    language: oneOf(input.language ?? 'en', LANGUAGES, 'Language'),
  };
}

/** A follow-up question for the assistant: 3–300 characters of plain text. */
export function readQuestion(q) {
  const question = cleanText(q, 300);
  if (question.length < 3) fail('Ask a question of at least 3 characters.');
  return question;
}
