// Recorded-shape sample responses shared by the tests. No test calls a real API.
import { parseGoogle, summarize } from '../src/air.js';
import { readProfile } from '../src/profile.js';
import { commuteImpact } from '../src/impact.js';

export const NOW = Date.parse('2026-11-21T08:10:00Z'); // 1:40 pm in Delhi
export const hourIso = (h) => new Date(Date.parse('2026-11-21T08:00:00Z') + h * 3_600_000).toISOString();
export const delhi = { lat: 28.61, lon: 77.21, tz: 'Asia/Kolkata', name: 'New Delhi, Delhi, India' };

export const googleCurrent = {
  dateTime: '2026-11-21T08:00:00Z',
  regionCode: 'in',
  indexes: [
    { code: 'uaqi', displayName: 'Universal AQI', aqi: 4, category: 'Poor air quality', dominantPollutant: 'pm25' },
    { code: 'ind_cpcb', displayName: 'AQI (IN)', aqi: 412, category: 'Severe air quality', dominantPollutant: 'pm25' },
  ],
  pollutants: [
    { code: 'pm25', concentration: { value: 245.37, units: 'MICROGRAMS_PER_CUBIC_METER' } },
    { code: 'no2', concentration: { value: 61.2, units: 'PARTS_PER_BILLION' } },
    { code: 'nh3', concentration: { value: 20, units: 'PARTS_PER_BILLION' } },
  ],
  healthRecommendations: {
    generalPopulation: 'Avoid outdoor activity.',
    children: 'Keep children indoors.',
    athletes: 'Do not train outdoors.',
  },
};

// Cleanest stretch: 2–6 pm Delhi time (hours 1–4 ahead), at 60 µg/m³; worst overnight.
export const googleForecast = {
  hourlyForecasts: Array.from({ length: 24 }, (_, h) => ({
    dateTime: hourIso(h + 1),
    pollutants: [{ code: 'pm25', concentration: { value: h <= 3 ? 60 : h >= 9 && h <= 14 ? 280 : 200, units: 'MICROGRAMS_PER_CUBIC_METER' } }],
  })),
};

export const openMeteo = {
  current: { time: NOW / 1000, interval: 3600, pm2_5: 180.4, pm10: 260, nitrogen_dioxide: 70.1, ozone: null },
  hourly: { time: Array.from({ length: 26 }, (_, h) => Date.parse(hourIso(h - 1)) / 1000), pm2_5: Array.from({ length: 26 }, () => 150) },
};

export const delhiAir = () => summarize(parseGoogle(googleCurrent, googleForecast), delhi.tz, NOW);

export const family = readProfile({
  household: ['children', 'respiratory'],
  commute: { mode: 'car', km: 12, days: 5 },
  exercise: 'morning',
  purifier: false,
  cooking: 'gas',
  notes: 'We live next to a highway',
  language: 'en',
});

export const delhiContext = () => ({ place: delhi, air: delhiAir(), profile: family, commute: commuteImpact(family.commute) });

/** A plan shaped like Gemini's structured output. */
export const geminiPlan = {
  summary: 'Severe smog today. Keep your child indoors and plan outings for 2–5 pm.',
  alerts: ['Keep your child indoors this morning.'],
  routine: [
    { time: '2–5 pm', title: 'Short walk in the clean window', action: 'Take your child out for 20 minutes.', why: 'AQI averages 154 then.', impact: 'Halves the dose compared with now.', impactType: 'exposure' },
  ],
  indoor: [{ title: 'Box-fan filter', action: 'Strap a MERV-13 filter to a fan.', why: 'Traps fine particles.', impact: 'Substantially cuts PM2.5.', impactType: 'exposure' }],
  swaps: [{ title: 'Metro twice a week', action: 'Take the metro on Tuesdays and Thursdays.', why: 'Cars emit 5× more per km.', impact: 'Saves 7.2 kg CO2e a week.', impactType: 'both' }],
};

/** A fetch stand-in: routes are [urlFragment, status, body]; unmatched URLs fail like a dead network. */
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const route = routes.find(([match]) => String(url).includes(match));
    if (!route) throw new TypeError('fetch failed');
    const [, status, body] = route;
    return { ok: status < 400, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

export const quiet = () => {};
