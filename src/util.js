// Small shared helpers, so a rounding rule or a unit of time is written down once.

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;

/**
 * Rounds to a fixed number of decimal places: `roundTo(2.345, 1)` is 2.3.
 * @param {number} value
 * @param {number} places
 */
export function roundTo(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
