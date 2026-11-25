// The page around the planner: city shortcuts, the quick check, the scroll-driven numbers and the two carousels.
import { byId, store, reducedMotion, scrollBehavior } from './dom.js';

/** How long a "why it matters" number takes to count up. */
const COUNT_UP_MS = 900;
/** How far one press of a myth arrow scrolls, as a share of the row's width. */
const MYTH_SCROLL_SHARE = 0.8;

function initShortcuts() {
  const city = byId('city', HTMLInputElement);
  for (const button of document.querySelectorAll('button[data-city]')) {
    button.addEventListener('click', () => {
      city.value = /** @type {HTMLButtonElement} */ (button).dataset.city ?? '';
      city.dispatchEvent(new Event('input'));
      city.focus();
    });
  }
  for (const button of document.querySelectorAll('.quick-check')) {
    button.addEventListener('click', () => {
      byId('planner').scrollIntoView({ behavior: scrollBehavior() });
      byId('locate').click();
    });
  }
  const remember = byId('remember', HTMLInputElement);
  remember.addEventListener('change', () => {
    if (!remember.checked) store.set('airwise:form', null);
  });
}

/**
 * Counts a number up from zero, easing out, once. Skipped with reduced motion: the final number is already there.
 * @param {HTMLElement} element  carries the target in data-count
 */
function countUp(element) {
  if (reducedMotion.matches || element.dataset.done) return;
  element.dataset.done = '1';
  const end = Number(element.dataset.count);
  const start = performance.now();
  /** @param {number} now */
  const tick = (now) => {
    const progress = Math.min((now - start) / COUNT_UP_MS, 1);
    element.textContent = Math.round(end * (1 - (1 - progress) ** 3)).toLocaleString('en-IN');
    if (progress < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/**
 * "Why it matters" pins to the screen and shows one number per stretch of scrolling. Without this script the
 * numbers are simply listed, and every number stays in the page for screen readers either way.
 */
function initImpact() {
  const impact = byId('impact');
  const stats = [...impact.querySelectorAll('.stats li')];
  impact.classList.add('is-scrolly');
  const sync = () => {
    const rect = impact.getBoundingClientRect();
    const progress = Math.min(Math.max(-rect.top / (rect.height - innerHeight), 0), 0.999);
    const active = Math.floor(progress * stats.length);
    if (impact.dataset.active === String(active)) return;
    impact.dataset.active = String(active);
    stats.forEach((li, i) => li.classList.toggle('is-on', i === active));
    const counter = stats[active].querySelector('[data-count]');
    if (counter instanceof HTMLElement) countUp(counter);
  };
  addEventListener('scroll', sync, { passive: true });
  addEventListener('resize', sync);
  sync();
}

/** Habits carousel: one card in colour at a time. */
function initHabits() {
  const cards = [...document.querySelectorAll('.habit')];
  /** @param {Element} card */
  const pictureOf = (card) => /** @type {HTMLElement} */ (card.querySelector('.habit-pic'));
  /** @param {number} i  any index; it wraps around */
  const show = (i) => {
    const index = (i + cards.length) % cards.length;
    cards.forEach((card, n) => {
      card.classList.toggle('is-active', n === index);
      pictureOf(card).setAttribute('aria-pressed', String(n === index));
    });
    cards[index].scrollIntoView({ behavior: scrollBehavior(), block: 'nearest', inline: 'center' });
  };
  const activeIndex = () => cards.findIndex((card) => card.classList.contains('is-active'));
  cards.forEach((card, n) => {
    const picture = pictureOf(card);
    picture.setAttribute('aria-pressed', String(card.classList.contains('is-active')));
    picture.addEventListener('click', () => show(n));
  });
  for (const button of document.querySelectorAll('button[data-habit]')) {
    const step = Number(/** @type {HTMLButtonElement} */ (button).dataset.habit);
    button.addEventListener('click', () => show(activeIndex() + step));
  }
}

function initMyths() {
  const row = byId('myth-row');
  for (const button of document.querySelectorAll('button[data-myth]')) {
    const direction = Number(/** @type {HTMLButtonElement} */ (button).dataset.myth);
    button.addEventListener('click', () => {
      row.scrollBy({ left: direction * row.clientWidth * MYTH_SCROLL_SHARE, behavior: scrollBehavior() });
    });
  }
}

export function initLanding() {
  initShortcuts();
  initImpact();
  initHabits();
  initMyths();
}
