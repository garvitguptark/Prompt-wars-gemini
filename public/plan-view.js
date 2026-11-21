// The plan: summary and alerts, the three sections of actions, the commute chart, ticking actions and sharing.
import { $, h, store, today, loadingLine } from './dom.js';

const IMPACT_LABEL = { exposure: 'Less exposure', emissions: 'Less pollution', both: 'Less exposure and pollution' };
const doneKey = () => `airwise:done:${today()}`;

export function renderPlanLoading() {
  $('plan-by').textContent = '';
  const body = $('plan-body');
  body.setAttribute('aria-busy', 'true');
  body.replaceChildren(
    h(
      'div',
      { class: 'card loading' },
      loadingLine('Gemini is writing a plan for your household…'),
      h('div', { class: 'skel' }),
      h('div', { class: 'skel w80' }),
      h('div', { class: 'skel w60' }),
    ),
  );
  $('plan').hidden = false;
  $('ask').hidden = true;
}

export function renderPlanError(message, retry) {
  const body = $('plan-body');
  body.setAttribute('aria-busy', 'false');
  body.replaceChildren(
    h(
      'div',
      { class: 'card' },
      h('p', { class: 'error', text: message }),
      h('button', { class: 'btn line', type: 'button', text: 'Try again', onclick: retry }),
    ),
  );
}

function sourceLine(source, model, language) {
  if (source === 'gemini') {
    return h('span', { class: 'by-gemini', text: `Written by Gemini (${model}) from the live readings above` });
  }
  const english = language === 'en' ? '' : ' and is in English';
  return h('span', {
    class: 'by-rules',
    text: `Built-in guidance: Gemini is unavailable right now, so this plan follows fixed rules${english}.`,
  });
}

function actionItem(it, done, withTime) {
  return h(
    'li',
    { class: done.has(it.title) ? 'act is-done' : 'act' },
    withTime && it.time ? h('p', { class: 'act-time', text: it.time }) : null,
    h('h4', { class: 'act-title', text: it.title }),
    h('p', { class: 'act-do', text: it.action }),
    it.why ? h('p', { class: 'act-why' }, h('b', { text: 'Why: ' }), it.why) : null,
    it.impact
      ? h(
          'p',
          { class: 'act-impact', 'data-type': it.impactType },
          h('span', { class: 'tag', text: IMPACT_LABEL[it.impactType] }),
          it.impact,
        )
      : null,
    h(
      'label',
      { class: 'act-check' },
      h('input', { type: 'checkbox', checked: done.has(it.title), onchange: (e) => toggleDone(it.title, e.target) }),
      h('span', { text: "I'll do this today" }),
    ),
  );
}

const section = (title, subtitle, ...content) =>
  h(
    'section',
    { class: 'sec' },
    h('div', { class: 'sec-head' }, h('h3', { text: title }), h('p', { text: subtitle })),
    ...content,
  );

const list = (tag, cls, items, done, withTime) =>
  h(
    tag,
    { class: cls, role: 'list' },
    items.map((it) => actionItem(it, done, withTime)),
  );

function commuteChart(commute) {
  if (!commute || commute.current.mode === 'wfh' || commute.alternatives.length === 0) return null;
  const rows = [commute.current, ...commute.alternatives];
  const max = Math.max(...rows.map((r) => r.kgPerWeek)) || 1;
  const row = (r, i) =>
    h(
      'li',
      { class: i === 0 ? 'row is-current' : 'row' },
      h(
        'span',
        { class: 'row-label' },
        i === 0 ? `${r.label} (now)` : r.label,
        h('small', { text: `${r.exposure} smog exposure` }),
      ),
      h(
        'span',
        { class: 'row-track', 'aria-hidden': 'true' },
        h('span', { class: 'row-fill', vars: { '--w': r.kgPerWeek / max } }),
      ),
      h('span', {
        class: 'row-val',
        text: i === 0 ? `${r.kgPerWeek} kg` : `${r.kgPerWeek} kg, saves ${r.savedKgPerYear} kg a year`,
      }),
    );
  return h(
    'figure',
    { class: 'card chart' },
    h(
      'figcaption',
      {},
      h('strong', { text: 'Your commute, kg CO₂e a week' }),
      h('span', { class: 'hint', text: `${commute.current.weeklyKm} km a week` }),
    ),
    h('ul', { class: 'chart-rows', role: 'list' }, rows.map(row)),
    h('p', {
      class: 'hint',
      text: 'CO₂e from typical Indian fuel use and occupancy, for comparison rather than accounting. Exposure is how much traffic smog you breathe on the way.',
    }),
  );
}

function toggleDone(title, box) {
  const done = new Set(store.get(doneKey()) ?? []);
  if (box.checked) done.add(title);
  else done.delete(title);
  store.set(doneKey(), [...done]);
  box.closest('.act').classList.toggle('is-done', box.checked);
  updateCommitCount();
}

function updateCommitCount() {
  const n = document.querySelectorAll('#plan-body .act-check input:checked').length;
  $('commit-count').textContent = n
    ? `You've picked ${n} ${n === 1 ? 'action' : 'actions'} for today.`
    : 'Tick the actions you will do today, then share the plan with your family.';
}

async function sharePlan(plan, place) {
  const lines = plan.routine.map((it) => `• ${it.time ? `${it.time}: ` : ''}${it.title}. ${it.action}`);
  const text = [`AirWise plan for ${place.name}`, plan.summary, '', ...lines].join('\n');
  const status = $('share-status');
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Our air plan for today', text });
    } else {
      await navigator.clipboard.writeText(text);
      status.textContent = 'Copied. Paste it into your family chat.';
    }
  } catch (err) {
    if (err.name !== 'AbortError')
      status.textContent = "Couldn't share from this browser. Try copying the text instead.";
  }
}

/** Renders an /api/plan result. Plans in Urdu are laid out right to left. */
export function renderPlan({ plan, source, model, commute }, profile, place) {
  const body = $('plan-body');
  const lang = source === 'gemini' ? profile.language : 'en';
  body.lang = lang;
  body.dir = lang === 'ur' ? 'rtl' : 'ltr';
  $('plan-by').replaceChildren(sourceLine(source, model, profile.language));

  const done = new Set(store.get(doneKey()) ?? []);
  const alerts = plan.alerts.length
    ? h(
        'ul',
        { class: 'alerts', role: 'list' },
        plan.alerts.map((a) => h('li', { text: a })),
      )
    : null;
  body.replaceChildren(
    h('div', { class: 'card summary' }, h('p', { text: plan.summary }), alerts),
    section(
      'Low-emission routine',
      "Your day, timed around today's cleanest and worst hours.",
      list('ol', 'timeline', plan.routine, done, true),
    ),
    plan.indoor.length
      ? section(
          'Indoor air hacks',
          'Keep the air inside cleaner than the air outside.',
          list('ul', 'tiles', plan.indoor, done),
        )
      : null,
    section(
      'Sustainable swaps',
      'Cut the pollution your household adds, and see what it saves.',
      commuteChart(commute),
      plan.swaps.length ? list('ul', 'tiles', plan.swaps, done) : null,
    ),
    h(
      'div',
      { class: 'card commit' },
      h('p', { id: 'commit-count', 'aria-live': 'polite' }),
      h('button', {
        class: 'btn line',
        type: 'button',
        text: 'Share with family',
        onclick: () => sharePlan(plan, place),
      }),
      h('p', { id: 'share-status', class: 'hint', 'aria-live': 'polite' }),
    ),
  );
  body.setAttribute('aria-busy', 'false');
  updateCommitCount();
}
