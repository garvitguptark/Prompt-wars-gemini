// AirWise in the browser: plain ES modules, no framework or build step.
// This file owns the planner form; the views live in air-view.js, plan-view.js and ask.js.
/** @import { Place, Profile } from '../src/types.js' */
import { byId, store, api, announce, scrollBehavior } from './dom.js';
import { renderAir } from './air-view.js';
import { renderPlan, renderPlanLoading, renderPlanError } from './plan-view.js';
import { initAsk, showAsk } from './ask.js';
import { initLanding } from './landing.js';

const FORM_KEY = 'airwise:form';
/** The browser may answer from a location fix up to 10 minutes old, and should give up after 10 seconds. */
const GEOLOCATION = { enableHighAccuracy: false, timeout: 10_000, maximumAge: 600_000 };

const form = byId('plan-form', HTMLFormElement);
const city = byId('city', HTMLInputElement);
const submit = byId('submit', HTMLButtonElement);
const remember = byId('remember', HTMLInputElement);
const submitLabel = submit.textContent;

/** @type {{ coords: { lat: number, lon: number } | null, place: Place | null, profile: Profile | null }} */
const state = { coords: null, place: null, profile: null };

/**
 * The household profile as the form holds it. The server validates every field again.
 * @returns {Profile}
 */
function readForm() {
  const fields = new FormData(form);
  return /** @type {Profile} */ ({
    household: fields.getAll('household'),
    commute: { mode: fields.get('mode'), km: Number(fields.get('km')) || 0, days: Number(fields.get('days')) || 0 },
    exercise: fields.get('exercise'),
    purifier: fields.get('purifier') === 'on',
    cooking: fields.get('cooking'),
    notes: String(fields.get('notes') ?? '').trim(),
    language: fields.get('language'),
  });
}

/** Fills the form with the answers remembered on this device, if any. */
function restoreForm() {
  const saved = store.get(FORM_KEY);
  if (!saved) return;
  city.value = saved.city ?? '';
  for (const box of form.querySelectorAll('input[name="household"]')) {
    const checkbox = /** @type {HTMLInputElement} */ (box);
    checkbox.checked = Boolean(saved.household?.includes(checkbox.value));
  }
  const fields = {
    mode: saved.commute?.mode,
    km: saved.commute?.km,
    days: saved.commute?.days,
    cooking: saved.cooking,
    language: saved.language,
    notes: saved.notes,
  };
  for (const [id, value] of Object.entries(fields)) {
    if (value == null || value === '') continue;
    /** @type {HTMLInputElement | HTMLSelectElement} */ (byId(id)).value = String(value);
  }
  const radio = form.querySelector(`input[name="exercise"][value="${CSS.escape(saved.exercise ?? 'none')}"]`);
  if (radio instanceof HTMLInputElement) radio.checked = true;
  byId('purifier', HTMLInputElement).checked = Boolean(saved.purifier);
}

/** Hides the distance and days when the household works from home. */
function syncCommute() {
  const atHome = byId('mode', HTMLSelectElement).value === 'wfh';
  for (const detail of form.querySelectorAll('.commute-detail')) /** @type {HTMLElement} */ (detail).hidden = atHome;
}

/** @param {string} text */
const setLocationStatus = (text) => {
  byId('loc-status').textContent = text;
};

function useMyLocation() {
  if (!navigator.geolocation) {
    setLocationStatus("This browser can't share your location. Type your city instead.");
    return;
  }
  setLocationStatus('Finding your location…');
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      state.coords = { lat: coords.latitude, lon: coords.longitude };
      city.value = '';
      city.placeholder = 'Using your current location';
      setLocationStatus('Using your current location. Type a city to look somewhere else.');
    },
    (err) =>
      setLocationStatus(
        err.code === err.PERMISSION_DENIED
          ? 'Location access is blocked. Type your city instead.'
          : "Couldn't find your location. Type your city instead.",
      ),
    GEOLOCATION,
  );
}

function forgetLocationOnTyping() {
  if (!state.coords) return;
  state.coords = null;
  city.placeholder = 'Your city or area';
  setLocationStatus('');
}

/**
 * Shows a section, scrolls to it and moves focus to its heading so keyboard and screen-reader users follow.
 * @param {HTMLElement} section
 */
function reveal(section) {
  section.hidden = false;
  section.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  /** @type {HTMLElement | null} */ (section.querySelector('[tabindex="-1"]'))?.focus({ preventScroll: true });
}

/**
 * The /api/air query: the typed city, else the browser's coordinates and time zone.
 * @param {string} cityName
 * @param {{ lat: number, lon: number } | null} coords
 */
const airQuery = (cityName, coords) =>
  cityName || !coords
    ? new URLSearchParams({ q: cityName })
    : new URLSearchParams({
        lat: String(coords.lat),
        lon: String(coords.lon),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });

/**
 * Asks for the plan and shows it, or shows why it failed with a retry.
 * @param {Place} place
 * @param {Profile} profile
 */
async function loadPlan(place, profile) {
  renderPlanLoading();
  try {
    const result = await api('/api/plan', { place, profile });
    renderAir(place, result.air); // the freshest reading
    renderPlan(result, profile, place);
    showAsk();
    announce('Your plan for today is ready.');
  } catch (err) {
    renderPlanError(/** @type {Error} */ (err).message, () => form.requestSubmit());
  }
}

/** @param {SubmitEvent} event */
async function onSubmit(event) {
  event.preventDefault();
  const cityName = city.value.trim();
  const error = byId('form-error');
  const coords = state.coords;
  if (!cityName && !coords) {
    error.textContent = 'Type your city or area, or use your location.';
    city.focus();
    return;
  }
  error.textContent = '';
  const profile = readForm();
  store.set(FORM_KEY, remember.checked ? { ...profile, city: cityName } : null);

  submit.disabled = true;
  submit.textContent = 'Checking the air…';
  try {
    const { place, air } = await api(`/api/air?${airQuery(cityName, coords)}`);
    Object.assign(state, { place, profile });
    renderAir(place, air);
    reveal(byId('air'));
    announce(`US AQI in ${place.name} is ${air.aqi}, ${air.band.label}. Writing your plan.`);
    submit.textContent = 'Writing your plan…';
    await loadPlan(place, profile);
  } catch (err) {
    error.textContent = /** @type {Error} */ (err).message;
  } finally {
    submit.disabled = false;
    submit.textContent = submitLabel;
  }
}

byId('locate').addEventListener('click', useMyLocation);
city.addEventListener('input', forgetLocationOnTyping);
byId('mode').addEventListener('change', syncCommute);
form.addEventListener('submit', onSubmit);
initAsk(() => state);
initLanding();
restoreForm();
syncCommute();
