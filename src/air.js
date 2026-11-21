// Live air quality and place search. Google's Air Quality API is the primary source (current conditions, the
// official local index such as India's CPCB NAQI, health advice per group, and an hourly forecast). Open-Meteo
// needs no key and answers when no Maps key is configured or Google fails, so the app never goes dark.
import { aqiFromPm25, bandFor, whoMultiple, forecastWindows } from './aqi.js';
import { ttlCache } from './cache.js';
import { log as defaultLog } from './log.js';

const GOOGLE_AQ = 'https://airquality.googleapis.com/v1';
const OPEN_METEO_AQ = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const OPEN_METEO_GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const POLLUTANTS = { pm25: 'PM2.5', pm10: 'PM10', no2: 'NO₂', o3: 'O₃', co: 'CO', so2: 'SO₂' };
const HOUR = 3_600_000;

export class UpstreamError extends Error {
  status = 502;
  constructor(detail) {
    super('Air-quality data is unavailable right now. Please try again in a minute.');
    this.detail = detail;
  }
}

export class PlaceNotFound extends Error {
  status = 404;
}

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/** GETs or POSTs JSON with a timeout; any network failure or non-2xx answer becomes an UpstreamError. */
async function fetchJson(fetchFn, timeoutMs, url, init = {}) {
  let res;
  try {
    res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new UpstreamError(`${new URL(url).hostname}: ${err.name}`);
  }
  if (!res.ok) throw new UpstreamError(`${new URL(url).hostname} answered ${res.status}`);
  return res.json();
}

/** Current conditions and the next 23 hours from Google, fetched in parallel. A missing forecast is not fatal. */
async function googleReading({ getJson, mapsKey, now, log }, { lat, lon }) {
  const headers = { 'content-type': 'application/json', 'x-goog-api-key': mapsKey }; // header, so the key never sits in a URL
  const location = { latitude: lat, longitude: lon };
  const start = new Date(Math.ceil(now() / HOUR) * HOUR);
  const post = (path, body) => getJson(`${GOOGLE_AQ}/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const [current, forecast] = await Promise.allSettled([
    post('currentConditions:lookup', {
      location,
      languageCode: 'en',
      extraComputations: [
        'HEALTH_RECOMMENDATIONS',
        'POLLUTANT_CONCENTRATION',
        'LOCAL_AQI',
        'DOMINANT_POLLUTANT_CONCENTRATION',
      ],
    }),
    post('forecast:lookup', {
      location,
      period: { startTime: start.toISOString(), endTime: new Date(start.getTime() + 23 * HOUR).toISOString() },
      extraComputations: ['POLLUTANT_CONCENTRATION'],
    }),
  ]);
  if (current.status === 'rejected') throw current.reason;
  if (forecast.status === 'rejected') log('WARNING', 'Google forecast unavailable', { detail: forecast.reason.detail });
  return parseGoogle(current.value, forecast.status === 'fulfilled' ? forecast.value : null);
}

async function openMeteoReading(getJson, { lat, lon }) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current: 'pm2_5,pm10,nitrogen_dioxide,ozone',
    hourly: 'pm2_5',
    forecast_days: '2', // two days always covers the next 24 hours
    timeformat: 'unixtime',
    timezone: 'GMT',
  });
  return parseOpenMeteo(await getJson(`${OPEN_METEO_AQ}?${params}`));
}

/**
 * Picks the geocoding result that fits the words after a comma ("Hyderabad, Pakistan" or "Hyderabad, PK"),
 * else the first. Country codes must match a whole word, so "in" inside "Sindh" is not India.
 */
export function pickPlace(results, hints) {
  const hint = hints.join(' ').toLowerCase();
  const words = hint.split(/\s+/);
  const fits = (r) =>
    words.includes(r.country_code?.toLowerCase()) ||
    [r.country, r.admin1].some((v) => v && hint.includes(v.toLowerCase()));
  return (hint && results.find(fits)) || results[0];
}

/**
 * @param {object} deps
 * @param {string} [deps.mapsKey]  Google Maps Platform key with the Air Quality API enabled (optional)
 * @param {typeof fetch} [deps.fetch]
 */
export function createAirService({
  mapsKey = '',
  fetch = globalThis.fetch,
  timeoutMs = 8000,
  now = Date.now,
  log = defaultLog,
} = {}) {
  const readings = ttlCache({ ttlMs: 10 * 60_000, now }); // providers update hourly; 10 minutes keeps it fresh
  const places = ttlCache({ ttlMs: 24 * HOUR, now });
  const getJson = (url, init) => fetchJson(fetch, timeoutMs, url, init);

  async function freshReading(place) {
    if (mapsKey) {
      try {
        return await googleReading({ getJson, mapsKey, now, log }, place);
      } catch (err) {
        log('WARNING', 'Google Air Quality API failed, using Open-Meteo', { detail: err.detail ?? err.message });
      }
    }
    return openMeteoReading(getJson, place);
  }

  /** Current air and the next 24 hours at a place ({ lat, lon, tz }), on the US EPA PM2.5 scale. */
  async function lookup(place) {
    const raw = await readings.remember(`${place.lat.toFixed(2)},${place.lon.toFixed(2)}`, () => freshReading(place));
    return summarize(raw, place.tz, now());
  }

  /** Finds a city or area by name. "Delhi, India" searches "Delhi" and prefers a match in India. */
  function geocode(query) {
    return places.remember(query.toLowerCase(), async () => {
      const [name, ...hints] = query
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      const params = new URLSearchParams({ name, count: '5', language: 'en', format: 'json' });
      const { results = [] } = await getJson(`${OPEN_METEO_GEOCODE}?${params}`);
      const match = pickPlace(results, hints);
      if (!match) throw new PlaceNotFound(`We couldn't find "${query}". Try a nearby city name.`);
      return {
        name: [...new Set([match.name, match.admin1, match.country].filter(Boolean))].join(', '),
        lat: round2(match.latitude),
        lon: round2(match.longitude),
        tz: match.timezone || 'UTC',
      };
    });
  }

  return { lookup, geocode, source: mapsKey ? 'Google Air Quality API' : 'Open-Meteo' };
}

const pm25Of = (pollutants) => pollutants?.find((p) => p.code === 'pm25')?.concentration?.value;

export function parseGoogle(current, forecast) {
  const pm25 = pm25Of(current.pollutants);
  if (!finite(pm25)) throw new UpstreamError('Google returned no PM2.5 reading');
  const local = current.indexes?.find((i) => i.code !== 'uaqi');
  const main = local ?? current.indexes?.find((i) => i.code === 'uaqi');
  return {
    source: 'Google Air Quality API',
    updated: current.dateTime,
    pm25,
    pollutants: (current.pollutants ?? [])
      .filter((p) => POLLUTANTS[p.code] && finite(p.concentration?.value))
      .map((p) => ({
        code: p.code,
        name: POLLUTANTS[p.code],
        value: round1(p.concentration.value),
        units: p.concentration.units === 'PARTS_PER_BILLION' ? 'ppb' : 'µg/m³',
      })),
    dominant: POLLUTANTS[main?.dominantPollutant] ?? null,
    localIndex: local ? { name: local.displayName, aqi: local.aqi, category: local.category } : null,
    health: current.healthRecommendations ?? null,
    hourly: (forecast?.hourlyForecasts ?? []).map((h) => ({ time: h.dateTime, pm25: pm25Of(h.pollutants) })),
  };
}

export function parseOpenMeteo(data) {
  const c = data.current ?? {};
  if (!finite(c.pm2_5)) throw new UpstreamError('Open-Meteo returned no PM2.5 reading');
  const fields = [
    ['pm25', 'pm2_5'],
    ['pm10', 'pm10'],
    ['no2', 'nitrogen_dioxide'],
    ['o3', 'ozone'],
  ];
  const times = data.hourly?.time ?? [];
  return {
    source: 'Open-Meteo',
    updated: new Date(c.time * 1000).toISOString(),
    pm25: c.pm2_5,
    pollutants: fields
      .filter(([, f]) => finite(c[f]))
      .map(([code, f]) => ({ code, name: POLLUTANTS[code], value: round1(c[f]), units: 'µg/m³' })),
    dominant: null,
    localIndex: null,
    health: null,
    hourly: times.map((t, i) => ({ time: new Date(t * 1000).toISOString(), pm25: data.hourly.pm2_5?.[i] })),
  };
}

/** Puts a provider reading on the common scale and works out the cleanest and worst hours ahead. */
export function summarize(raw, timeZone, nowMs = Date.now()) {
  const aqi = aqiFromPm25(raw.pm25);
  const hourly = raw.hourly
    .filter((h) => finite(h.pm25) && Date.parse(h.time) > nowMs - HOUR) // keep the current hour onward
    .slice(0, 24)
    .map((h) => {
      const hourAqi = aqiFromPm25(h.pm25);
      return { time: h.time, aqi: hourAqi, band: bandFor(hourAqi) }; // label included, so the page needs no copy
    });
  return {
    ...raw,
    pm25: round1(raw.pm25),
    aqi,
    band: bandFor(aqi),
    whoMultiple: whoMultiple(raw.pm25),
    hourly,
    windows: forecastWindows(hourly, timeZone),
  };
}
