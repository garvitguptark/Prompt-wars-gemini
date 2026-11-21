// AirWise in the browser: plain ES modules, no framework or build step.
// This file owns the planner form; the views live in air-view.js, plan-view.js and ask.js.
import { $, store, api, announce, scrollBehavior } from './dom.js';
import { renderAir } from './air-view.js';
import { renderPlan, renderPlanLoading, renderPlanError } from './plan-view.js';
import { initAsk, showAsk } from './ask.js';
import { initLanding } from './landing.js';

const form = $('plan-form');
const submitLabel = $('submit').textContent;
const state = { coords: null, place: null, profile: null };

function readForm() {
  const f = new FormData(form);
  return {
    household: f.getAll('household'),
    commute: { mode: f.get('mode'), km: Number(f.get('km')) || 0, days: Number(f.get('days')) || 0 },
    exercise: f.get('exercise'),
    purifier: f.get('purifier') === 'on',
    cooking: f.get('cooking'),
    notes: String(f.get('notes') ?? '').trim(),
    language: f.get('language'),
  };
}

function restoreForm() {
  const saved = store.get('airwise:form');
  if (!saved) return;
  $('city').value = saved.city ?? '';
  for (const box of form.querySelectorAll('[name="household"]'))
    box.checked = Boolean(saved.household?.includes(box.value));
  const fields = {
    mode: saved.commute?.mode,
    km: saved.commute?.km,
    days: saved.commute?.days,
    cooking: saved.cooking,
    language: saved.language,
    notes: saved.notes,
  };
  for (const [id, value] of Object.entries(fields)) if (value != null && value !== '') $(id).value = value;
  const radio = form.querySelector(`[name="exercise"][value="${CSS.escape(saved.exercise ?? 'none')}"]`);
  if (radio) radio.checked = true;
  $('purifier').checked = Boolean(saved.purifier);
}

function syncCommute() {
  const atHome = $('mode').value === 'wfh';
  for (const el of form.querySelectorAll('.commute-detail')) el.hidden = atHome;
}

const setLocStatus = (text) => {
  $('loc-status').textContent = text;
};

function useMyLocation() {
  if (!navigator.geolocation) return setLocStatus("This browser can't share your location. Type your city instead.");
  setLocStatus('Finding your location…');
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      state.coords = { lat: coords.latitude, lon: coords.longitude };
      $('city').value = '';
      $('city').placeholder = 'Using your current location';
      setLocStatus('Using your current location. Type a city to look somewhere else.');
    },
    (err) =>
      setLocStatus(
        err.code === err.PERMISSION_DENIED
          ? 'Location access is blocked. Type your city instead.'
          : "Couldn't find your location. Type your city instead.",
      ),
    { enableHighAccuracy: false, timeout: 10_000, maximumAge: 600_000 },
  );
}

function forgetLocationOnTyping() {
  if (!state.coords) return;
  state.coords = null;
  $('city').placeholder = 'Your city or area';
  setLocStatus('');
}

/** Shows a section, scrolls to it and moves focus to its heading so keyboard and screen-reader users follow. */
function reveal(el) {
  el.hidden = false;
  el.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  el.querySelector('[tabindex="-1"]')?.focus({ preventScroll: true });
}

const airQuery = (city) =>
  city
    ? new URLSearchParams({ q: city })
    : new URLSearchParams({
        lat: state.coords.lat,
        lon: state.coords.lon,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });

async function loadPlan(place, profile) {
  renderPlanLoading();
  try {
    const result = await api('/api/plan', { place, profile });
    renderAir(place, result.air); // the freshest reading
    renderPlan(result, profile, place);
    showAsk();
    announce('Your plan for today is ready.');
  } catch (err) {
    renderPlanError(err.message, () => form.requestSubmit());
  }
}

async function onSubmit(event) {
  event.preventDefault();
  const city = $('city').value.trim();
  const error = $('form-error');
  if (!city && !state.coords) {
    error.textContent = 'Type your city or area, or use your location.';
    $('city').focus();
    return;
  }
  error.textContent = '';
  const profile = readForm();
  store.set('airwise:form', $('remember').checked ? { ...profile, city } : null);

  const submit = $('submit');
  submit.disabled = true;
  submit.textContent = 'Checking the air…';
  try {
    const { place, air } = await api(`/api/air?${airQuery(city)}`);
    Object.assign(state, { place, profile });
    renderAir(place, air);
    reveal($('air'));
    announce(`US AQI in ${place.name} is ${air.aqi}, ${air.band.label}. Writing your plan.`);
    submit.textContent = 'Writing your plan…';
    await loadPlan(place, profile);
  } catch (err) {
    error.textContent = err.message;
  } finally {
    submit.disabled = false;
    submit.textContent = submitLabel;
  }
}

$('locate').addEventListener('click', useMyLocation);
$('city').addEventListener('input', forgetLocationOnTyping);
$('mode').addEventListener('change', syncCommute);
form.addEventListener('submit', onSubmit);
initAsk(() => state);
initLanding();
restoreForm();
syncCommute();
