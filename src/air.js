// Live air quality and place search. Google's Air Quality API is the primary source (current conditions, the
// official local index such as India's CPCB NAQI, health advice per group, and an hourly forecast). Open-Meteo
// needs no key and answers when no Maps key is configured or Google fails, so the app never goes dark.
/** @import { AirReading, AirService, AirSummary, HealthAdvice, HourlyAqi, Logger, Place } from './types.js' */
import { aqiFromPm25, bandFor, whoMultiple, forecastWindows, indiaAqi } from './aqi.js';
import { ttlCache } from './cache.js';
import { UpstreamError, PlaceNotFound } from './errors.js';
import { log as defaultLog } from './log.js';
import { roundTo, MINUTE_MS, HOUR_MS } from './util.js';

const GOOGLE_AQ = 'https://airquality.googleapis.com/v1';
const OPEN_METEO_AQ = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const OPEN_METEO_GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';

/**
 * Pollutant codes both providers report, with display names.
 * @type {Record<string, string>}
 */
const POLLUTANTS = { pm25: 'PM2.5', pm10: 'PM10', no2: 'NO₂', o3: 'O₃', co: 'CO', so2: 'SO₂' };

/** Open-Meteo's field for each pollutant code. */
const OPEN_METEO_FIELDS = { pm25: 'pm2_5', pm10: 'pm10', no2: 'nitrogen_dioxide', o3: 'ozone' };

/** Providers update hourly, so a reading stays fresh for 10 minutes; place names hardly ever change. */
const READING_TTL_MS = 10 * MINUTE_MS;
const PLACE_TTL_MS = 24 * HOUR_MS;
/** Hours of forecast asked for after the current one: with it, a full day ahead. */
const FORECAST_HOURS = 23;
/** Most forecast hours shown and used for the windows. */
const MAX_FORECAST_HOURS = 24;
/** Geocoding matches to choose from when the user names a country or state after a comma. */
const GEOCODE_CANDIDATES = 5;
/** Time zones that mean the place is in India, where the CPCB index is the one people know. */
const INDIA_TIME_ZONES = new Set(['Asia/Kolkata', 'Asia/Calcutta']);

// The parts of each provider's answer that AirWise reads.
/** @typedef {{ code: string, concentration?: { value: number, units: string } }} GooglePollutant */
/** @typedef {{ code: string, displayName: string, aqi: number, category: string, dominantPollutant?: string }} GoogleIndex */
/**
 * @typedef {object} GoogleCurrent  currentConditions:lookup
 * @property {string} dateTime
 * @property {GoogleIndex[]} [indexes]
 * @property {GooglePollutant[]} [pollutants]
 * @property {HealthAdvice} [healthRecommendations]
 */
/** @typedef {{ hourlyForecasts?: { dateTime: string, pollutants?: GooglePollutant[] }[] }} GoogleForecast */
/**
 * @typedef {object} OpenMeteoAir  air-quality, with unix times
 * @property {Record<string, number | null | undefined>} [current]
 * @property {{ time?: number[], pm2_5?: (number | null)[] }} [hourly]
 */
/**
 * @typedef {object} GeocodeResult
 * @property {string} name
 * @property {number} latitude
 * @property {number} longitude
 * @property {string} [timezone]
 * @property {string} [country]
 * @property {string} [country_code]
 * @property {string} [admin1]  state or province
 */
/** @typedef {(url: string, init?: RequestInit) => Promise<any>} GetJson */

/**
 * GETs or POSTs JSON with a timeout; any network failure or non-2xx answer becomes an UpstreamError.
 * @param {typeof fetch} fetchFn
 * @param {number} timeoutMs
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<any>}
 */
async function fetchJson(fetchFn, timeoutMs, url, init = {}) {
  const host = new URL(url).hostname;
  let response;
  try {
    response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new UpstreamError(`${host}: ${/** @type {Error} */ (err).name}`);
  }
  if (!response.ok) throw new UpstreamError(`${host} answered ${response.status}`);
  return response.json();
}

/**
 * Current conditions and the next 23 hours from Google, fetched in parallel. A missing forecast is not fatal.
 * @param {{ getJson: GetJson, mapsKey: string, now: () => number, log: Logger }} deps
 * @param {Place} place
 * @returns {Promise<AirReading>}
 */
async function googleReading({ getJson, mapsKey, now, log }, { lat, lon }) {
  const headers = { 'content-type': 'application/json', 'x-goog-api-key': mapsKey }; // header, so the key never sits in a URL
  const location = { latitude: lat, longitude: lon };
  const start = new Date(Math.ceil(now() / HOUR_MS) * HOUR_MS);
  /**
   * @param {string} path
   * @param {object} body
   */
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
      period: {
        startTime: start.toISOString(),
        endTime: new Date(start.getTime() + FORECAST_HOURS * HOUR_MS).toISOString(),
      },
      extraComputations: ['POLLUTANT_CONCENTRATION'],
    }),
  ]);
  if (current.status === 'rejected') throw current.reason;
  if (forecast.status === 'rejected') log('WARNING', 'Google forecast unavailable', { detail: forecast.reason.detail });
  return parseGoogle(current.value, forecast.status === 'fulfilled' ? forecast.value : null);
}

/**
 * Current conditions and two days of hourly PM2.5 from Open-Meteo, which needs no key.
 * @param {GetJson} getJson
 * @param {Place} place
 * @returns {Promise<AirReading>}
 */
async function openMeteoReading(getJson, { lat, lon }) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: Object.values(OPEN_METEO_FIELDS).join(','),
    hourly: OPEN_METEO_FIELDS.pm25,
    forecast_days: '2', // two days always covers the next 24 hours
    timeformat: 'unixtime',
    timezone: 'GMT',
  });
  return parseOpenMeteo(await getJson(`${OPEN_METEO_AQ}?${params}`));
}

/**
 * Picks the geocoding result that fits the words after a comma ("Hyderabad, Pakistan" or "Hyderabad, PK"),
 * else the first. Country codes must match a whole word, so "in" inside "Sindh" is not India.
 * @param {GeocodeResult[]} results
 * @param {string[]} hints  the parts of the query after the first comma
 * @returns {GeocodeResult | undefined}
 */
export function pickPlace(results, hints) {
  const hint = hints.join(' ').toLowerCase();
  const words = hint.split(/\s+/);
  /** @param {GeocodeResult} result */
  const fits = (result) =>
    words.includes(result.country_code?.toLowerCase() ?? '') ||
    [result.country, result.admin1].some((name) => name && hint.includes(name.toLowerCase()));
  return (hint && results.find(fits)) || results[0];
}

/**
 * The air-quality service: cached lookups by place and by name.
 * @param {object} [deps]
 * @param {string} [deps.mapsKey]  Google Maps Platform key with the Air Quality API enabled (optional)
 * @param {typeof fetch} [deps.fetch]
 * @param {number} [deps.timeoutMs]  longest wait for one upstream call
 * @param {() => number} [deps.now]
 * @param {Logger} [deps.log]
 * @returns {AirService}
 */
export function createAirService({
  mapsKey = '',
  fetch = globalThis.fetch,
  timeoutMs = 8000,
  now = Date.now,
  log = defaultLog,
} = {}) {
  const readings = ttlCache({ ttlMs: READING_TTL_MS, now });
  const places = ttlCache({ ttlMs: PLACE_TTL_MS, now });
  /** @type {GetJson} */
  const getJson = (url, init) => fetchJson(fetch, timeoutMs, url, init);

  /**
   * Google first when there is a key, Open-Meteo otherwise or when Google fails.
   * @param {Place} place
   * @returns {Promise<AirReading>}
   */
  async function freshReading(place) {
    if (mapsKey) {
      try {
        return await googleReading({ getJson, mapsKey, now, log }, place);
      } catch (err) {
        const { detail, message } = /** @type {{ detail?: string, message?: string }} */ (err);
        log('WARNING', 'Google Air Quality API failed, using Open-Meteo', { detail: detail ?? message });
      }
    }
    return openMeteoReading(getJson, place);
  }

  /** @type {AirService['lookup']} */
  async function lookup(place) {
    const cell = `${place.lat.toFixed(2)},${place.lon.toFixed(2)}`; // about 1 km: neighbours share one reading
    const raw = await readings.remember(cell, () => freshReading(place));
    return summarize(raw, place.tz, now());
  }

  /** @type {AirService['geocode']} "Delhi, India" searches "Delhi" and prefers a match in India. */
  function geocode(query) {
    return places.remember(query.toLowerCase(), async () => {
      const [name, ...hints] = query
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      const params = new URLSearchParams({
        name,
        count: String(GEOCODE_CANDIDATES),
        language: 'en',
        format: 'json',
      });
      /** @type {{ results?: GeocodeResult[] }} */
      const { results = [] } = await getJson(`${OPEN_METEO_GEOCODE}?${params}`);
      const match = pickPlace(results, hints);
      if (!match) throw new PlaceNotFound(`We couldn't find "${query}". Try a nearby city name.`);
      return {
        name: [...new Set([match.name, match.admin1, match.country].filter(Boolean))].join(', '),
        lat: roundTo(match.latitude, 2),
        lon: roundTo(match.longitude, 2),
        tz: match.timezone || 'UTC',
      };
    });
  }

  return { lookup, geocode, source: mapsKey ? 'Google Air Quality API' : 'Open-Meteo' };
}

/**
 * The PM2.5 concentration in a list of Google pollutants.
 * @param {GooglePollutant[] | undefined} pollutants
 */
const pm25Of = (pollutants) => pollutants?.find((pollutant) => pollutant.code === 'pm25')?.concentration?.value;

/**
 * Google's answers in the shared reading shape.
 * @param {GoogleCurrent} current
 * @param {GoogleForecast | null} forecast  null when the forecast call failed
 * @returns {AirReading}
 */
export function parseGoogle(current, forecast) {
  const pm25 = pm25Of(current.pollutants);
  if (pm25 === undefined || !Number.isFinite(pm25)) throw new UpstreamError('Google returned no PM2.5 reading');
  const local = current.indexes?.find((index) => index.code !== 'uaqi');
  const main = local ?? current.indexes?.find((index) => index.code === 'uaqi');
  return {
    source: 'Google Air Quality API',
    updated: current.dateTime,
    pm25,
    pollutants: (current.pollutants ?? []).flatMap(({ code, concentration }) =>
      POLLUTANTS[code] && concentration && Number.isFinite(concentration.value)
        ? [
            {
              code,
              name: POLLUTANTS[code],
              value: roundTo(concentration.value, 1),
              units: concentration.units === 'PARTS_PER_BILLION' ? 'ppb' : 'µg/m³',
            },
          ]
        : [],
    ),
    dominant: (main?.dominantPollutant && POLLUTANTS[main.dominantPollutant]) || null,
    localIndex: local ? { name: local.displayName, aqi: local.aqi, category: local.category } : null,
    health: current.healthRecommendations ?? null,
    hourly: (forecast?.hourlyForecasts ?? []).map((hour) => ({ time: hour.dateTime, pm25: pm25Of(hour.pollutants) })),
  };
}

/**
 * Open-Meteo's answer in the shared reading shape.
 * @param {OpenMeteoAir} data
 * @returns {AirReading}
 */
export function parseOpenMeteo(data) {
  const current = data.current ?? {};
  const pm25 = current[OPEN_METEO_FIELDS.pm25];
  if (typeof pm25 !== 'number' || !Number.isFinite(pm25)) {
    throw new UpstreamError('Open-Meteo returned no PM2.5 reading');
  }
  /** @param {number | null | undefined} unixSeconds */
  const isoTime = (unixSeconds) => new Date(Number(unixSeconds) * 1000).toISOString();
  return {
    source: 'Open-Meteo',
    updated: isoTime(current.time),
    pm25,
    pollutants: Object.entries(OPEN_METEO_FIELDS).flatMap(([code, field]) => {
      const value = current[field];
      return typeof value === 'number' && Number.isFinite(value)
        ? [{ code, name: POLLUTANTS[code], value: roundTo(value, 1), units: 'µg/m³' }]
        : [];
    }),
    dominant: null,
    localIndex: null,
    health: null,
    hourly: (data.hourly?.time ?? []).map((time, i) => ({
      time: isoTime(time),
      pm25: data.hourly?.pm2_5?.[i] ?? undefined,
    })),
  };
}

/**
 * Puts a provider reading on the common scale and works out the cleanest and worst hours ahead.
 * @param {AirReading} raw
 * @param {string} timeZone  the place's IANA time zone
 * @param {number} [nowMs]
 * @returns {AirSummary}
 */
export function summarize(raw, timeZone, nowMs = Date.now()) {
  const aqi = aqiFromPm25(raw.pm25);
  if (aqi === null) throw new UpstreamError(`Unusable PM2.5 reading from ${raw.source}`);
  /** @type {HourlyAqi[]} */
  const hourly = raw.hourly
    .filter((hour) => Date.parse(hour.time) > nowMs - HOUR_MS) // keep the current hour onward
    .flatMap((hour) => {
      const hourAqi = aqiFromPm25(hour.pm25);
      return hourAqi === null ? [] : [{ time: hour.time, aqi: hourAqi, band: bandFor(hourAqi) }]; // label included, so the page needs no copy
    })
    .slice(0, MAX_FORECAST_HOURS);
  const pm10 = raw.pollutants.find((pollutant) => pollutant.code === 'pm10')?.value;
  return {
    ...raw,
    localIndex: raw.localIndex ?? (INDIA_TIME_ZONES.has(timeZone) ? indiaAqi(raw.pm25, pm10) : null),
    pm25: roundTo(raw.pm25, 1),
    aqi,
    band: bandFor(aqi),
    whoMultiple: whoMultiple(raw.pm25),
    hourly,
    windows: forecastWindows(hourly, timeZone),
  };
}
