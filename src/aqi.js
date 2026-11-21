// Air-quality maths. Every data source is converted to one scale here, the US EPA AQI computed from PM2.5,
// because winter smog is mostly fine particles and families should see the same number whichever source answered.

// US EPA PM2.5 breakpoints (2024 revision): [concentration low, high (µg/m³), index low, high].
const BREAKPOINTS = [
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

/** WHO 2021 air-quality guideline for 24-hour mean PM2.5, in µg/m³. */
export const WHO_PM25_24H = 15;

/** US EPA AQI (0–500) for a PM2.5 concentration in µg/m³, or null when the reading is unusable. */
export function aqiFromPm25(pm25) {
  if (!Number.isFinite(pm25) || pm25 < 0) return null;
  const c = Math.floor(pm25 * 10) / 10; // the EPA truncates to one decimal before looking up the breakpoint
  const row = BREAKPOINTS.find(([, high]) => c <= high);
  if (!row) return 500; // beyond the top of the scale
  const [cLow, cHigh, iLow, iHigh] = row;
  return Math.round(((iHigh - iLow) / (cHigh - cLow)) * (c - cLow) + iLow);
}

/** The band (key and label) an AQI value falls in. */
export function bandFor(aqi) {
  const { key, label } = BANDS.find((b) => aqi <= b.max);
  return { key, label };
}

/** How many times the WHO 24-hour guideline a PM2.5 reading is, to one decimal. */
export const whoMultiple = (pm25) => Math.round((pm25 / WHO_PM25_24H) * 10) / 10;

/**
 * The cleanest and worst `size`-hour stretches in an hourly forecast ([{ time, aqi }], oldest first).
 * Only stretches inside waking hours (06:00–22:00 at the place) count as "cleanest", since nobody
 * should be told to air the house at 3 a.m.; the worst stretch can fall at any time.
 */
export function forecastWindows(hours, timeZone, size = 3) {
  if (hours.length < size) return null;
  const localHour = (iso) =>
    Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(new Date(iso)));
  const spans = [];
  for (let i = 0; i + size <= hours.length; i++) {
    const slice = hours.slice(i, i + size);
    const avg = Math.round(slice.reduce((sum, h) => sum + h.aqi, 0) / size);
    const startHour = localHour(slice[0].time);
    spans.push({ start: slice[0].time, end: addHours(slice[size - 1].time, 1), avgAqi: avg, waking: startHour >= 6 && startHour + size <= 22 });
  }
  const waking = spans.filter((s) => s.waking);
  const pick = (list, better) => list.reduce((best, s) => (better(s.avgAqi, best.avgAqi) ? s : best));
  const strip = ({ waking: _waking, ...s }) => ({ ...s, band: bandFor(s.avgAqi) });
  return {
    cleanest: strip(pick(waking.length ? waking : spans, (a, b) => a < b)),
    worst: strip(pick(spans, (a, b) => a > b)),
  };
}

const addHours = (iso, n) => new Date(new Date(iso).getTime() + n * 3_600_000).toISOString();

/** "2 pm" at the place, for prompts and fallback advice. */
export const hourLabel = (iso, timeZone) =>
  new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: true, timeZone }).format(new Date(iso)).toLowerCase();

/** "2 pm–5 pm" for a forecast window at the place. */
export const rangeLabel = (window, timeZone) => `${hourLabel(window.start, timeZone)}–${hourLabel(window.end, timeZone)}`;
