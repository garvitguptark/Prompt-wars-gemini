// The air card: the reading now, the official local index, health advice and the 24-hour forecast bars.
import { $, h } from './dom.js';

const HEALTH_GROUPS = {
  generalPopulation: 'Everyone',
  children: 'Children',
  elderly: 'Older adults',
  lungDiseasePopulation: 'Lung conditions',
  heartDiseasePopulation: 'Heart conditions',
  pregnantWomen: 'Pregnancy',
  athletes: 'Exercise',
};

const hourFormat = (timeZone) => {
  const fmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', timeZone });
  return (iso) => fmt.format(new Date(iso)).toLowerCase();
};

function renderFacts(air) {
  const facts = [
    ['PM2.5', `${air.pm25} µg/m³`],
    ['WHO daily guideline', air.whoMultiple > 1 ? `${air.whoMultiple}× over` : 'Within it'],
    air.localIndex && [air.localIndex.name, `${air.localIndex.aqi} · ${air.localIndex.category}`],
    air.dominant && ['Main pollutant', air.dominant],
  ].filter(Boolean);
  $('air-facts').replaceChildren(
    ...facts.map(([dt, dd]) => h('div', {}, h('dt', { text: dt }), h('dd', { text: dd }))),
  );
}

function renderForecast(air, hour) {
  const { windows, hourly } = air;
  $('forecast').hidden = hourly.length === 0;
  const span = (w) => `${hour(w.start)}–${hour(w.end)}, AQI ${w.avgAqi}`;
  $('windows').replaceChildren(
    ...(windows
      ? [
          h('span', { class: 'win clean' }, h('b', { text: 'Cleanest ' }), span(windows.cleanest)),
          h('span', { class: 'win worst' }, h('b', { text: 'Worst ' }), span(windows.worst)),
        ]
      : []),
  );
  const clean = windows && [Date.parse(windows.cleanest.start), Date.parse(windows.cleanest.end)];
  $('bars').replaceChildren(
    ...hourly.map((pt, i) => {
      const t = Date.parse(pt.time);
      const inClean = clean && t >= clean[0] && t < clean[1];
      // Every third hour is labelled on screen; every hour is read out in full to screen readers.
      const labelClass = i % 3 === 0 ? `bar-label${i % 6 === 0 ? ' major' : ''}` : 'sr';
      return h(
        'li',
        {
          class: inClean ? 'bar is-clean' : 'bar',
          'data-band': pt.band.key,
          vars: { '--v': Math.min(pt.aqi, 500) / 500 },
        },
        h('span', { class: 'bar-fill', 'aria-hidden': 'true' }),
        h('span', { class: labelClass, text: hour(pt.time) }),
        h('span', { class: 'sr', text: `: AQI ${pt.aqi}, ${pt.band.label}${inClean ? ', cleanest window' : ''}` }),
      );
    }),
  );
}

function renderHealth(air) {
  const advice = Object.entries(air.health ?? {}).filter(([group, text]) => HEALTH_GROUPS[group] && text);
  $('health').hidden = advice.length === 0;
  $('health-list').replaceChildren(
    ...advice.map(([group, text]) => h('li', {}, h('strong', { text: `${HEALTH_GROUPS[group]}: ` }), text)),
  );
}

/** Fills the air card for `place` from an /api/air or /api/plan reading. */
export function renderAir(place, air) {
  $('air').dataset.band = air.band.key;
  $('air-place').textContent = place.name;
  $('aqi-num').textContent = air.aqi;
  $('aqi-band').textContent = air.band.label;
  renderFacts(air);
  renderForecast(air, hourFormat(place.tz));
  renderHealth(air);
  const updated = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: place.tz })
    .format(new Date(air.updated))
    .toLowerCase();
  const india = air.localIndex?.name.startsWith('India')
    ? ' India AQI uses CPCB breakpoints on current PM2.5 and PM10.'
    : '';
  $('air-source').textContent =
    `Source: ${air.source}, updated ${updated} local time. AQI is the US EPA index computed from PM2.5.${india}`;
}
