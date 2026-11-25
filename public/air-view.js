// The air card: the reading now, the official local index, health advice and the 24-hour forecast bars.
/** @import { AirSummary, AqiWindow, Place } from '../src/types.js' */
import { byId, h } from './dom.js';

/** @type {Record<string, string>} the provider's population groups, in plain words */
const HEALTH_GROUPS = {
  generalPopulation: 'Everyone',
  children: 'Children',
  elderly: 'Older adults',
  lungDiseasePopulation: 'Lung conditions',
  heartDiseasePopulation: 'Heart conditions',
  pregnantWomen: 'Pregnancy',
  athletes: 'Exercise',
};

/** Forecast hours shown on screen: every third one, with every sixth emphasised. */
const LABEL_EVERY = 3;
const MAJOR_LABEL_EVERY = 6;
/** The top of the AQI scale, where a forecast bar is full height. */
const MAX_AQI = 500;

/**
 * A formatter for "2 pm" at the place.
 * @param {string} timeZone
 * @returns {(iso: string) => string}
 */
const hourFormat = (timeZone) => {
  const format = new Intl.DateTimeFormat('en-US', { hour: 'numeric', timeZone });
  return (iso) => format.format(new Date(iso)).toLowerCase();
};

/** @param {AirSummary} air */
function renderFacts(air) {
  const facts = [
    ['PM2.5', `${air.pm25} µg/m³`],
    ['WHO daily guideline', air.whoMultiple > 1 ? `${air.whoMultiple}× over` : 'Within it'],
    air.localIndex && [air.localIndex.name, `${air.localIndex.aqi} · ${air.localIndex.category}`],
    air.dominant && ['Main pollutant', air.dominant],
  ].filter((fact) => Array.isArray(fact));
  byId('air-facts').replaceChildren(
    ...facts.map(([dt, dd]) => h('div', {}, h('dt', { text: dt }), h('dd', { text: dd }))),
  );
}

/**
 * The cleanest and worst windows, and one bar per forecast hour.
 * @param {AirSummary} air
 * @param {(iso: string) => string} hour  formats a time as "2 pm" at the place
 */
function renderForecast(air, hour) {
  const { windows, hourly } = air;
  byId('forecast').hidden = hourly.length === 0;
  /** @param {AqiWindow} window */
  const span = (window) => `${hour(window.start)}–${hour(window.end)}, AQI ${window.avgAqi}`;
  byId('windows').replaceChildren(
    ...(windows
      ? [
          h('span', { class: 'win clean' }, h('b', { text: 'Cleanest ' }), span(windows.cleanest)),
          h('span', { class: 'win worst' }, h('b', { text: 'Worst ' }), span(windows.worst)),
        ]
      : []),
  );
  const clean = windows && [Date.parse(windows.cleanest.start), Date.parse(windows.cleanest.end)];
  byId('bars').replaceChildren(
    ...hourly.map((point, i) => {
      const time = Date.parse(point.time);
      const inClean = clean && time >= clean[0] && time < clean[1];
      // Every third hour is labelled on screen; every hour is read out in full to screen readers.
      const labelClass = i % LABEL_EVERY === 0 ? `bar-label${i % MAJOR_LABEL_EVERY === 0 ? ' major' : ''}` : 'sr';
      return h(
        'li',
        {
          class: inClean ? 'bar is-clean' : 'bar',
          'data-band': point.band.key,
          vars: { '--v': Math.min(point.aqi, MAX_AQI) / MAX_AQI },
        },
        h('span', { class: 'bar-fill', 'aria-hidden': 'true' }),
        h('span', { class: labelClass, text: hour(point.time) }),
        h('span', {
          class: 'sr',
          text: `: AQI ${point.aqi}, ${point.band.label}${inClean ? ', cleanest window' : ''}`,
        }),
      );
    }),
  );
}

/** @param {AirSummary} air */
function renderHealth(air) {
  const advice = Object.entries(air.health ?? {}).filter(([group, text]) => HEALTH_GROUPS[group] && text);
  byId('health').hidden = advice.length === 0;
  byId('health-list').replaceChildren(
    ...advice.map(([group, text]) => h('li', {}, h('strong', { text: `${HEALTH_GROUPS[group]}: ` }), text)),
  );
}

/**
 * Fills the air card for `place` from an /api/air or /api/plan reading.
 * @param {Place} place
 * @param {AirSummary} air
 */
export function renderAir(place, air) {
  byId('air').dataset.band = air.band.key;
  byId('air-place').textContent = place.name;
  byId('aqi-num').textContent = String(air.aqi);
  byId('aqi-band').textContent = air.band.label;
  renderFacts(air);
  renderForecast(air, hourFormat(place.tz));
  renderHealth(air);
  const updated = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: place.tz })
    .format(new Date(air.updated))
    .toLowerCase();
  const india = air.localIndex?.name.startsWith('India')
    ? ' India AQI uses CPCB breakpoints on current PM2.5 and PM10.'
    : '';
  byId('air-source').textContent =
    `Source: ${air.source}, updated ${updated} local time. AQI is the US EPA index computed from PM2.5.${india}`;
}
