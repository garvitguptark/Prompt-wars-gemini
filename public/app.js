// AirWise in the browser: plain DOM, no framework or build step.
// Text from the API (and so from Gemini) is only ever set with textContent, never parsed as HTML.

const $ = (id) => document.getElementById(id);
const store = {
  get(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: nothing is remembered */ }
  },
};
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const BAND_LABEL = {
  good: 'Good', moderate: 'Moderate', sensitive: 'Unhealthy for sensitive groups', unhealthy: 'Unhealthy',
  'very-unhealthy': 'Very unhealthy', hazardous: 'Hazardous',
};
const IMPACT_LABEL = { exposure: 'Less exposure', emissions: 'Less pollution', both: 'Less exposure and pollution' };
const HEALTH_GROUPS = {
  generalPopulation: 'Everyone', children: 'Children', elderly: 'Older adults', lungDiseasePopulation: 'Lung conditions',
  heartDiseasePopulation: 'Heart conditions', pregnantWomen: 'Pregnancy', athletes: 'Exercise',
};
const SUGGESTIONS = [
  'Is it safe for the kids to play outside today?',
  'Which mask should we buy, and how should it fit?',
  'How do I pick an air purifier for one room?',
];

/** Builds an element. `text` sets textContent, `vars` sets CSS custom properties, `on…` adds listeners. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'vars') for (const [name, v] of Object.entries(value)) el.style.setProperty(name, v);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

async function api(path, body) {
  const init = body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined;
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error("Couldn't reach AirWise. Check your connection and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}). Please try again.`);
  return data;
}

const state = { coords: null, place: null, profile: null, plan: null };
const form = $('plan-form');
const announce = (message) => { $('status').textContent = message; };
const today = () => new Date().toISOString().slice(0, 10);

function show(el) {
  el.hidden = false;
  el.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
  el.querySelector('[tabindex="-1"]')?.focus({ preventScroll: true });
}

// ---------- the form ----------
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
  for (const box of form.querySelectorAll('[name="household"]')) box.checked = Boolean(saved.household?.includes(box.value));
  for (const [id, value] of [['mode', saved.commute?.mode], ['km', saved.commute?.km], ['days', saved.commute?.days], ['cooking', saved.cooking], ['language', saved.language], ['notes', saved.notes]]) {
    if (value != null && value !== '' && $(id)) $(id).value = value;
  }
  const radio = form.querySelector(`[name="exercise"][value="${CSS.escape(saved.exercise ?? 'none')}"]`);
  if (radio) radio.checked = true;
  $('purifier').checked = Boolean(saved.purifier);
}

function syncCommute() {
  const home = $('mode').value === 'wfh';
  for (const el of form.querySelectorAll('.commute-detail')) el.hidden = home;
}

function syncNotes() {
  $('notes-count').textContent = `${$('notes').value.length} of 200 characters`;
}

function setLocStatus(text) {
  $('loc-status').textContent = text;
}

$('locate').addEventListener('click', () => {
  if (!navigator.geolocation) return setLocStatus("This browser can't share your location. Type your city instead.");
  setLocStatus('Finding your location…');
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      state.coords = { lat: coords.latitude, lon: coords.longitude };
      $('city').value = '';
      $('city').placeholder = 'Using your current location';
      setLocStatus('Using your current location. Type a city to look somewhere else.');
    },
    (err) => setLocStatus(err.code === err.PERMISSION_DENIED
      ? 'Location access is blocked. Type your city instead.'
      : "Couldn't find your location. Type your city instead."),
    { enableHighAccuracy: false, timeout: 10_000, maximumAge: 600_000 },
  );
});

$('city').addEventListener('input', () => {
  if (!state.coords) return;
  state.coords = null;
  $('city').placeholder = 'e.g. Delhi, Lahore, Kolkata';
  setLocStatus('');
});
$('mode').addEventListener('change', syncCommute);
$('notes').addEventListener('input', syncNotes);

form.addEventListener('submit', async (event) => {
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
  store.set('airwise:form', { ...profile, city });

  const submit = $('submit');
  submit.disabled = true;
  submit.textContent = 'Checking the air…';
  try {
    const query = city
      ? new URLSearchParams({ q: city })
      : new URLSearchParams({ lat: state.coords.lat, lon: state.coords.lon, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
    const { place, air } = await api(`/api/air?${query}`);
    Object.assign(state, { place, profile, plan: null });
    renderAir(place, air);
    $('empty').hidden = true;
    show($('air'));
    announce(`US AQI in ${place.name} is ${air.aqi}, ${air.band.label}. Writing your plan.`);

    submit.textContent = 'Writing your plan…';
    renderPlanLoading();
    try {
      const result = await api('/api/plan', { place, profile });
      state.plan = result.plan;
      renderAir(place, result.air);
      renderPlan(result, profile);
      announce('Your plan for today is ready.');
    } catch (err) {
      renderPlanError(err.message);
    }
  } catch (err) {
    error.textContent = err.message;
  } finally {
    submit.disabled = false;
    submit.textContent = "Get today's plan";
  }
});

// ---------- air ----------
function hourIn(timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', timeZone });
  return (iso) => fmt.format(new Date(iso)).toLowerCase();
}

function renderAir(place, air) {
  const hour = hourIn(place.tz);
  $('air').dataset.band = air.band.key;
  $('air-place').textContent = place.name;
  $('aqi-num').textContent = air.aqi;
  $('aqi-band').textContent = air.band.label;

  const facts = [
    ['PM2.5', `${air.pm25} µg/m³`],
    ['WHO daily guideline', air.whoMultiple > 1 ? `${air.whoMultiple}× over` : 'Within it'],
    air.localIndex && [air.localIndex.name, `${air.localIndex.aqi} · ${air.localIndex.category}`],
    air.dominant && ['Main pollutant', air.dominant],
  ].filter(Boolean);
  $('air-facts').replaceChildren(...facts.map(([dt, dd]) => h('div', {}, h('dt', { text: dt }), h('dd', { text: dd }))));

  const { windows, hourly } = air;
  $('forecast').hidden = hourly.length === 0;
  $('windows').replaceChildren(...(windows ? [
    h('span', { class: 'win clean' }, h('b', { text: 'Cleanest ' }), `${hour(windows.cleanest.start)}–${hour(windows.cleanest.end)}, AQI ${windows.cleanest.avgAqi}`),
    h('span', { class: 'win worst' }, h('b', { text: 'Worst ' }), `${hour(windows.worst.start)}–${hour(windows.worst.end)}, AQI ${windows.worst.avgAqi}`),
  ] : []));
  const clean = windows && [Date.parse(windows.cleanest.start), Date.parse(windows.cleanest.end)];
  $('bars').replaceChildren(...hourly.map((pt, i) => {
    const t = Date.parse(pt.time);
    const inClean = clean && t >= clean[0] && t < clean[1];
    return h('li', { class: inClean ? 'bar is-clean' : 'bar', 'data-band': pt.band, vars: { '--v': Math.min(pt.aqi, 500) / 500 } },
      h('span', { class: 'bar-fill', 'aria-hidden': 'true' }),
      h('span', { class: i % 3 === 0 ? `bar-label${i % 6 === 0 ? ' major' : ''}` : 'sr', text: hour(pt.time) }),
      h('span', { class: 'sr', text: `: AQI ${pt.aqi}, ${BAND_LABEL[pt.band]}${inClean ? ', cleanest window' : ''}` }));
  }));

  const advice = Object.entries(air.health ?? {}).filter(([group, text]) => HEALTH_GROUPS[group] && text);
  $('health').hidden = advice.length === 0;
  $('health-list').replaceChildren(...advice.map(([group, text]) => h('li', {}, h('strong', { text: `${HEALTH_GROUPS[group]}: ` }), text)));

  const updated = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: place.tz }).format(new Date(air.updated)).toLowerCase();
  $('air-source').textContent = `Source: ${air.source}, updated ${updated} local time. AQI is the US EPA index computed from PM2.5.`;
}

// ---------- plan ----------
function renderPlanLoading() {
  $('plan-by').textContent = '';
  const body = $('plan-body');
  body.setAttribute('aria-busy', 'true');
  body.replaceChildren(h('div', { class: 'card loading' },
    h('p', { class: 'loading-row' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Gemini is writing a plan for your household…'),
    h('div', { class: 'skel' }), h('div', { class: 'skel w80' }), h('div', { class: 'skel w60' })));
  $('plan').hidden = false;
  $('ask').hidden = true;
}

function renderPlanError(message) {
  const body = $('plan-body');
  body.setAttribute('aria-busy', 'false');
  body.replaceChildren(h('div', { class: 'card' }, h('p', { class: 'error', text: message }),
    h('button', { class: 'btn line', type: 'button', text: 'Try again', onclick: () => form.requestSubmit() })));
}

function renderPlan({ plan, source, model, commute }, profile) {
  const body = $('plan-body');
  const lang = source === 'gemini' ? profile.language : 'en';
  body.lang = lang;
  body.dir = lang === 'ur' ? 'rtl' : 'ltr';
  $('plan-by').replaceChildren(source === 'gemini'
    ? h('span', { class: 'by-gemini', text: `Written by Gemini (${model}) from the live readings above` })
    : h('span', { class: 'by-rules', text: `Built-in guidance: Gemini is unavailable right now, so this plan follows fixed rules${profile.language === 'en' ? '' : ' and is in English'}.` }));

  const done = new Set(store.get(`airwise:done:${today()}`) ?? []);
  const item = (it, withTime) => h('li', { class: done.has(it.title) ? 'act is-done' : 'act' },
    withTime && it.time ? h('p', { class: 'act-time', text: it.time }) : null,
    h('h4', { class: 'act-title', text: it.title }),
    h('p', { class: 'act-do', text: it.action }),
    it.why ? h('p', { class: 'act-why' }, h('b', { text: 'Why: ' }), it.why) : null,
    it.impact ? h('p', { class: 'act-impact', 'data-type': it.impactType }, h('span', { class: 'tag', text: IMPACT_LABEL[it.impactType] }), it.impact) : null,
    h('label', { class: 'act-check' },
      h('input', { type: 'checkbox', checked: done.has(it.title), onchange: (e) => toggleDone(it.title, e.target) }),
      h('span', { text: "I'll do this today" })));
  const section = (title, subtitle, ...content) => h('section', { class: 'sec' },
    h('div', { class: 'sec-head' }, h('h3', { text: title }), h('p', { text: subtitle })), ...content);

  body.replaceChildren(
    h('div', { class: 'card summary' }, h('p', { text: plan.summary }),
      plan.alerts.length ? h('ul', { class: 'alerts', role: 'list' }, plan.alerts.map((a) => h('li', { text: a }))) : null),
    section('Low-emission routine', "Your day, timed around today's cleanest and worst hours.",
      h('ol', { class: 'timeline', role: 'list' }, plan.routine.map((it) => item(it, true)))),
    plan.indoor.length ? section('Indoor air hacks', 'Keep the air inside cleaner than the air outside.',
      h('ul', { class: 'tiles', role: 'list' }, plan.indoor.map((it) => item(it)))) : null,
    section('Sustainable swaps', 'Cut the pollution your household adds, and see what it saves.',
      commuteChart(commute), plan.swaps.length ? h('ul', { class: 'tiles', role: 'list' }, plan.swaps.map((it) => item(it))) : null),
    h('div', { class: 'card commit' },
      h('p', { id: 'commit-count', 'aria-live': 'polite' }),
      h('button', { class: 'btn line', type: 'button', text: 'Share with family', onclick: sharePlan }),
      h('p', { id: 'share-status', class: 'hint', 'aria-live': 'polite' })),
  );
  body.setAttribute('aria-busy', 'false');
  updateCommitCount();
  renderAsk();
}

function commuteChart(commute) {
  if (!commute || commute.current.mode === 'wfh' || commute.alternatives.length === 0) return null;
  const rows = [commute.current, ...commute.alternatives];
  const max = Math.max(...rows.map((r) => r.kgPerWeek)) || 1;
  return h('figure', { class: 'card chart' },
    h('figcaption', {}, h('strong', { text: 'Your commute, kg CO₂e a week' }), h('span', { class: 'hint', text: `${commute.current.weeklyKm} km a week` })),
    h('ul', { class: 'chart-rows', role: 'list' }, rows.map((r, i) => h('li', { class: i === 0 ? 'row is-current' : 'row' },
      h('span', { class: 'row-label' }, i === 0 ? `${r.label} (now)` : r.label, h('small', { text: `${r.exposure} smog exposure` })),
      h('span', { class: 'row-track', 'aria-hidden': 'true' }, h('span', { class: 'row-fill', vars: { '--w': r.kgPerWeek / max } })),
      h('span', { class: 'row-val', text: i === 0 ? `${r.kgPerWeek} kg` : `${r.kgPerWeek} kg, saves ${r.savedKgPerYear} kg a year` })))),
    h('p', { class: 'hint', text: 'CO₂e from typical Indian fuel use and occupancy, for comparison rather than accounting. Exposure is how much traffic smog you breathe on the way.' }));
}

function toggleDone(title, box) {
  const key = `airwise:done:${today()}`;
  const done = new Set(store.get(key) ?? []);
  if (box.checked) done.add(title); else done.delete(title);
  store.set(key, [...done]);
  box.closest('.act').classList.toggle('is-done', box.checked);
  updateCommitCount();
}

function updateCommitCount() {
  const n = document.querySelectorAll('#plan-body .act-check input:checked').length;
  $('commit-count').textContent = n
    ? `You've picked ${n} ${n === 1 ? 'action' : 'actions'} for today.`
    : 'Tick the actions you will do today, then share the plan with your family.';
}

async function sharePlan() {
  const { plan, place } = state;
  if (!plan) return;
  const text = [`AirWise plan for ${place.name}`, plan.summary, '',
    ...plan.routine.map((it) => `• ${it.time ? `${it.time}: ` : ''}${it.title}. ${it.action}`)].join('\n');
  const status = $('share-status');
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Our air plan for today', text });
    } else {
      await navigator.clipboard.writeText(text);
      status.textContent = 'Copied. Paste it into your family chat.';
    }
  } catch (err) {
    if (err.name !== 'AbortError') status.textContent = "Couldn't share from this browser. Try copying the text instead.";
  }
}

// ---------- ask ----------
function renderAsk() {
  $('suggest').replaceChildren(...SUGGESTIONS.map((q) => h('button', {
    type: 'button', text: q, onclick: () => { $('question').value = q; $('ask-form').requestSubmit(); },
  })));
  $('answer').replaceChildren();
  $('ask').hidden = false;
}

$('ask-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const question = $('question').value.trim();
  const answer = $('answer');
  if (question.length < 3) {
    answer.replaceChildren(h('p', { class: 'error', text: 'Type a question first.' }));
    $('question').focus();
    return;
  }
  const button = $('ask-submit');
  button.disabled = true;
  answer.setAttribute('aria-busy', 'true');
  answer.replaceChildren(h('p', { class: 'loading-row' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Thinking…'));
  try {
    const result = await api('/api/ask', { place: state.place, profile: state.profile, question });
    const lang = state.profile.language;
    answer.replaceChildren(
      h('p', { lang, dir: lang === 'ur' ? 'rtl' : 'ltr', text: result.answer }),
      h('p', { class: 'by by-gemini', text: `Answered by Gemini (${result.model})` }));
  } catch (err) {
    answer.replaceChildren(h('p', { class: 'error', text: err.message }));
  } finally {
    button.disabled = false;
    answer.setAttribute('aria-busy', 'false');
  }
});

// ---------- start ----------
restoreForm();
syncCommute();
syncNotes();
