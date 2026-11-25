// The plan: summary and alerts, the three sections of actions, the commute chart, ticking actions and sharing.
/** @import { Child } from './dom.js' */
/**
 * @import { CommuteAlternative, CommuteImpact, CurrentCommute, ImpactType, Language, Place, Plan, PlanItem,
 *   PlanResult, Profile } from '../src/types.js'
 */
import { byId, h, store, today, loadingLine } from './dom.js';

/** @type {Record<ImpactType, string>} */
const IMPACT_LABEL = { exposure: 'Less exposure', emissions: 'Less pollution', both: 'Less exposure and pollution' };
const doneKey = () => `airwise:done:${today()}`;

/** Shows the plan section with a skeleton while Gemini writes. */
export function renderPlanLoading() {
  byId('plan-by').textContent = '';
  const body = byId('plan-body');
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
  byId('plan').hidden = false;
  byId('ask').hidden = true;
}

/**
 * Replaces the skeleton with the error and a retry button.
 * @param {string} message
 * @param {() => void} retry
 */
export function renderPlanError(message, retry) {
  const body = byId('plan-body');
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

/**
 * Says honestly who wrote the plan: Gemini, or the built-in rules.
 * @param {PlanResult} result
 * @param {Language} language  the language asked for
 */
function sourceLine(result, language) {
  if (result.source === 'gemini') {
    return h('span', { class: 'by-gemini', text: `Written by Gemini (${result.model}) from the live readings above` });
  }
  const english = language === 'en' ? '' : ' and is in English';
  return h('span', {
    class: 'by-rules',
    text: `Built-in guidance: Gemini is unavailable right now, so this plan follows fixed rules${english}.`,
  });
}

/**
 * One action: what to do, why, its impact, and a box to tick it for today.
 * @param {PlanItem} action
 * @param {Set<string>} done  titles already ticked today
 * @param {boolean} withTime
 */
function actionItem(action, done, withTime) {
  return h(
    'li',
    { class: done.has(action.title) ? 'act is-done' : 'act' },
    withTime && action.time ? h('p', { class: 'act-time', text: action.time }) : null,
    h('h4', { class: 'act-title', text: action.title }),
    h('p', { class: 'act-do', text: action.action }),
    action.why ? h('p', { class: 'act-why' }, h('b', { text: 'Why: ' }), action.why) : null,
    action.impact
      ? h(
          'p',
          { class: 'act-impact', 'data-type': action.impactType },
          h('span', { class: 'tag', text: IMPACT_LABEL[action.impactType] }),
          action.impact,
        )
      : null,
    h(
      'label',
      { class: 'act-check' },
      h('input', {
        type: 'checkbox',
        checked: done.has(action.title),
        onchange: (/** @type {Event} */ event) =>
          toggleDone(action.title, /** @type {HTMLInputElement} */ (event.currentTarget)),
      }),
      h('span', { text: "I'll do this today" }),
    ),
  );
}

/**
 * @param {string} title
 * @param {string} subtitle
 * @param {...Child} content
 */
const section = (title, subtitle, ...content) =>
  h(
    'section',
    { class: 'sec' },
    h('div', { class: 'sec-head' }, h('h3', { text: title }), h('p', { text: subtitle })),
    ...content,
  );

/**
 * @param {'ol' | 'ul'} tag
 * @param {string} className
 * @param {PlanItem[]} items
 * @param {Set<string>} done
 * @param {boolean} [withTime]
 */
const list = (tag, className, items, done, withTime = false) =>
  h(
    tag,
    { class: className, role: 'list' },
    items.map((item) => actionItem(item, done, withTime)),
  );

/**
 * The commute now and its alternatives as bars of kg CO2e a week, with every number also in text.
 * @param {CommuteImpact | undefined} commute
 */
function commuteChart(commute) {
  if (!commute || commute.current.mode === 'wfh' || commute.alternatives.length === 0) return null;
  /** @type {(CurrentCommute | CommuteAlternative)[]} */
  const rows = [commute.current, ...commute.alternatives];
  const max = Math.max(...rows.map((option) => option.kgPerWeek)) || 1;
  /**
   * @param {CurrentCommute | CommuteAlternative} r
   * @param {number} i  0 is the current commute
   */
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
        text: 'savedKgPerYear' in r ? `${r.kgPerWeek} kg, saves ${r.savedKgPerYear} kg a year` : `${r.kgPerWeek} kg`,
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

/**
 * Remembers today's ticked actions on this device.
 * @param {string} title
 * @param {HTMLInputElement} box
 */
function toggleDone(title, box) {
  const done = new Set(store.get(doneKey()) ?? []);
  if (box.checked) done.add(title);
  else done.delete(title);
  store.set(doneKey(), [...done]);
  box.closest('.act')?.classList.toggle('is-done', box.checked);
  updateCommitCount();
}

function updateCommitCount() {
  const n = document.querySelectorAll('#plan-body .act-check input:checked').length;
  byId('commit-count').textContent = n
    ? `You've picked ${n} ${n === 1 ? 'action' : 'actions'} for today.`
    : 'Tick the actions you will do today, then share the plan with your family.';
}

/**
 * Shares the routine with the system share sheet, or copies it where there is none.
 * @param {Plan} plan
 * @param {Place} place
 */
async function sharePlan(plan, place) {
  const lines = plan.routine.map((item) => `• ${item.time ? `${item.time}: ` : ''}${item.title}. ${item.action}`);
  const text = [`AirWise plan for ${place.name}`, plan.summary, '', ...lines].join('\n');
  const status = byId('share-status');
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Our air plan for today', text });
    } else {
      await navigator.clipboard.writeText(text);
      status.textContent = 'Copied. Paste it into your family chat.';
    }
  } catch (err) {
    if (/** @type {Error} */ (err).name !== 'AbortError')
      status.textContent = "Couldn't share from this browser. Try copying the text instead.";
  }
}

/**
 * Renders an /api/plan result. Plans in Urdu are laid out right to left.
 * @param {PlanResult} result
 * @param {Profile} profile
 * @param {Place} place
 */
export function renderPlan(result, profile, place) {
  const { plan, commute } = result;
  const body = byId('plan-body');
  const lang = result.source === 'gemini' ? profile.language : 'en';
  body.lang = lang;
  body.dir = lang === 'ur' ? 'rtl' : 'ltr';
  byId('plan-by').replaceChildren(sourceLine(result, profile.language));

  /** @type {Set<string>} */
  const done = new Set(store.get(doneKey()) ?? []);
  const alerts = plan.alerts.length
    ? h(
        'ul',
        { class: 'alerts', role: 'list' },
        plan.alerts.map((alert) => h('li', { text: alert })),
      )
    : null;
  body.replaceChildren(
    h('div', { class: 'card summary' }, h('p', { text: plan.summary }), alerts),
    section(
      'Low-emission routine',
      "Your day, timed around today's cleanest and worst hours.",
      list('ol', 'timeline', plan.routine, done, true),
    ),
    // replaceChildren() would print a null as the text "null", so an empty section is left out instead.
    ...(plan.indoor.length > 0
      ? [
          section(
            'Indoor air hacks',
            'Keep the air inside cleaner than the air outside.',
            list('ul', 'tiles', plan.indoor, done),
          ),
        ]
      : []),
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
