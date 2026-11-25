// Air-quality maths. Every data source is converted to one scale here, the US EPA AQI computed from PM2.5,
// because winter smog is mostly fine particles and families should see the same number whichever source answered.
/** @import { Band, AqiWindow, ForecastWindows, LocalIndex } from './types.js' */
import { roundTo, HOUR_MS } from './util.js';

/** @typedef {[cLow: number, cHigh: number, iLow: number, iHigh: number]} Breakpoint  µg/m³ range -> index range */

/**
 * US EPA PM2.5 breakpoints (2024 revision).
 * @type {Breakpoint[]}
 */
const EPA_PM25 = [
  [0, 9.0, 0, 50],
  [9.1, 35.4, 51, 100],
  [35.5, 55.4, 101, 150],
  [55.5, 125.4, 151, 200],
  [125.5, 225.4, 201, 300],
  [225.5, 325.4, 301, 500],
];

export const BANDS = [
  { max: 50, key: 'good', label: 'Good' },
  { max: 100, key: 'moderate', label: 'Moderate' },
  { max: 150, key: 'sensitive', label: 'Unhealthy for sensitive groups' },
  { max: 200, key: 'unhealthy', label: 'Unhealthy' },
  { max: 300, key: 'very-unhealthy', label: 'Very unhealthy' },
  { max: Infinity, key: 'hazardous', label: 'Hazardous' },
];

/** The top of every AQI scale here; readings beyond the last breakpoint are reported as this. */
const MAX_INDEX = 500;

/** Local hours when people can act on advice: a "cleanest window" never falls at 3 a.m. */
const WAKING_HOURS = { from: 6, to: 22 };

/** WHO 2021 air-quality guideline for 24-hour mean PM2.5, in µg/m³. */
export const WHO_PM25_24H = 15;

/**
 * True for a usable concentration: a finite number that isn't negative.
 * @param {unknown} value
 * @returns {value is number}
 */
const isConcentration = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * The index for a concentration, by linear interpolation inside its breakpoint row.
 * @param {Breakpoint[]} table
 * @param {number} concentration
 */
function interpolate(table, concentration) {
  const row = table.find(([, cHigh]) => concentration <= cHigh);
  if (!row) return MAX_INDEX;
  const [cLow, cHigh, iLow, iHigh] = row;
  return Math.round(iLow + ((iHigh - iLow) / (cHigh - cLow)) * (concentration - cLow));
}

/**
 * US EPA AQI (0–500) for a PM2.5 concentration in µg/m³, or null when the reading is unusable.
 * @param {number | null | undefined} pm25
 * @returns {number | null}
 */
export function aqiFromPm25(pm25) {
  if (!isConcentration(pm25)) return null;
  const truncated = Math.floor(pm25 * 10) / 10; // the EPA truncates to one decimal before looking up the breakpoint
  return interpolate(EPA_PM25, truncated);
}

/**
 * The band (key and label) an AQI value falls in.
 * @param {number} aqi
 * @returns {Band}
 */
export function bandFor(aqi) {
  const { key, label } = BANDS.find((band) => aqi <= band.max) ?? BANDS[BANDS.length - 1];
  return { key, label };
}

/**
 * How many times the WHO 24-hour guideline a PM2.5 reading is, to one decimal.
 * @param {number} pm25
 */
export const whoMultiple = (pm25) => roundTo(pm25 / WHO_PM25_24H, 1);

/**
 * The time `hours` after an ISO time, as an ISO time.
 * @param {string} iso
 * @param {number} hours
 */
const addHours = (iso, hours) => new Date(new Date(iso).getTime() + hours * HOUR_MS).toISOString();

/**
 * The cleanest and worst `size`-hour stretches in an hourly forecast (oldest first).
 * Only stretches inside waking hours at the place count as "cleanest", since nobody should be told to air the
 * house at 3 a.m.; the worst stretch can fall at any time.
 * @param {{ time: string, aqi: number }[]} hours
 * @param {string} timeZone  the place's IANA time zone
 * @param {number} [size]  hours per stretch
 * @returns {ForecastWindows | null}  null when the forecast is shorter than one stretch
 */
export function forecastWindows(hours, timeZone, size = 3) {
  if (hours.length < size) return null;
  const hourFormat = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone });
  /** @param {string} iso */
  const localHour = (iso) => Number(hourFormat.format(new Date(iso)));

  const spans = [];
  for (let i = 0; i + size <= hours.length; i++) {
    const stretch = hours.slice(i, i + size);
    const startHour = localHour(stretch[0].time);
    spans.push({
      start: stretch[0].time,
      end: addHours(stretch[size - 1].time, 1),
      avgAqi: Math.round(stretch.reduce((sum, hour) => sum + hour.aqi, 0) / size),
      waking: startHour >= WAKING_HOURS.from && startHour + size <= WAKING_HOURS.to,
    });
  }

  /**
   * @param {typeof spans} list
   * @param {(a: number, b: number) => boolean} isBetter
   * @returns {AqiWindow}
   */
  const best = (list, isBetter) => {
    const { start, end, avgAqi } = list.reduce((top, span) => (isBetter(span.avgAqi, top.avgAqi) ? span : top));
    return { start, end, avgAqi, band: bandFor(avgAqi) };
  };
  const waking = spans.filter((span) => span.waking);
  return {
    cleanest: best(waking.length > 0 ? waking : spans, (a, b) => a < b),
    worst: best(spans, (a, b) => a > b),
  };
}

/**
 * "2 pm" at the place, for prompts and fallback advice.
 * @param {string} iso
 * @param {string} timeZone
 */
export const hourLabel = (iso, timeZone) =>
  new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: true, timeZone }).format(new Date(iso)).toLowerCase();

/**
 * "2 pm–5 pm" for a forecast window at the place.
 * @param {{ start: string, end: string }} window
 * @param {string} timeZone
 */
export const rangeLabel = (window, timeZone) =>
  `${hourLabel(window.start, timeZone)}–${hourLabel(window.end, timeZone)}`;

// India's National AQI (CPCB). The official index uses 24-hour averages; this estimate uses the current reading so
// Indian families also see the number their news quotes.
/** @type {{ pm25: Breakpoint[], pm10: Breakpoint[] }} */
const INDIA = {
  pm25: [
    [0, 30, 0, 50],
    [30, 60, 50, 100],
    [60, 90, 100, 200],
    [90, 120, 200, 300],
    [120, 250, 300, 400],
    [250, 380, 400, 500],
  ],
  pm10: [
    [0, 50, 0, 50],
    [50, 100, 50, 100],
    [100, 250, 100, 200],
    [250, 350, 200, 300],
    [350, 430, 300, 400],
    [430, 510, 400, 500],
  ],
};

const INDIA_BANDS = [
  { max: 50, label: 'Good' },
  { max: 100, label: 'Satisfactory' },
  { max: 200, label: 'Moderate' },
  { max: 300, label: 'Poor' },
  { max: 400, label: 'Very poor' },
  { max: Infinity, label: 'Severe' },
];

/**
 * India's National AQI from PM2.5 and, when known, PM10: the higher sub-index wins, as CPCB does.
 * @param {number | null | undefined} pm25  µg/m³
 * @param {number | null | undefined} [pm10]  µg/m³
 * @returns {LocalIndex | null}  null when PM2.5 is unusable
 */
export function indiaAqi(pm25, pm10) {
  if (!isConcentration(pm25)) return null;
  const subIndexes = [interpolate(INDIA.pm25, pm25)];
  if (isConcentration(pm10)) subIndexes.push(interpolate(INDIA.pm10, pm10));
  const aqi = Math.max(...subIndexes);
  const band = INDIA_BANDS.find(({ max }) => aqi <= max) ?? INDIA_BANDS[INDIA_BANDS.length - 1];
  return { name: 'India AQI (CPCB)', aqi, category: band.label };
}
