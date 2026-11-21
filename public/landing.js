// The page around the planner: city shortcuts, the quick check, the scroll-driven numbers and the two carousels.
import { $, store, reducedMotion, scrollBehavior } from './dom.js';

function initShortcuts() {
  for (const btn of document.querySelectorAll('[data-city]')) {
    btn.addEventListener('click', () => {
      $('city').value = btn.dataset.city;
      $('city').dispatchEvent(new Event('input'));
      $('city').focus();
    });
  }
  for (const btn of document.querySelectorAll('.quick-check')) {
    btn.addEventListener('click', () => {
      $('planner').scrollIntoView({ behavior: scrollBehavior() });
      $('locate').click();
    });
  }
  $('remember').addEventListener('change', (e) => {
    if (!e.target.checked) store.set('airwise:form', null);
  });
}

function countUp(el) {
  if (reducedMotion.matches || el.dataset.done) return;
  el.dataset.done = '1';
  const end = Number(el.dataset.count);
  const start = performance.now();
  const tick = (now) => {
    const p = Math.min((now - start) / 900, 1);
    el.textContent = Math.round(end * (1 - (1 - p) ** 3)).toLocaleString('en-IN');
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/**
 * "Why it matters" pins to the screen and shows one number per stretch of scrolling. Without this script the
 * numbers are simply listed, and every number stays in the page for screen readers either way.
 */
function initImpact() {
  const impact = $('impact');
  const stats = [...impact.querySelectorAll('.stats li')];
  impact.classList.add('is-scrolly');
  const sync = () => {
    const rect = impact.getBoundingClientRect();
    const progress = Math.min(Math.max(-rect.top / (rect.height - innerHeight), 0), 0.999);
    const active = Math.floor(progress * stats.length);
    if (impact.dataset.active === String(active)) return;
    impact.dataset.active = active;
    stats.forEach((li, i) => li.classList.toggle('is-on', i === active));
    countUp(stats[active].querySelector('[data-count]'));
  };
  addEventListener('scroll', sync, { passive: true });
  addEventListener('resize', sync);
  sync();
}

/** Habits carousel: one card in colour at a time. */
function initHabits() {
  const cards = [...document.querySelectorAll('.habit')];
  const show = (i) => {
    const index = (i + cards.length) % cards.length;
    cards.forEach((card, n) => {
      card.classList.toggle('is-active', n === index);
      card.querySelector('.habit-pic').setAttribute('aria-pressed', String(n === index));
    });
    cards[index].scrollIntoView({ behavior: scrollBehavior(), block: 'nearest', inline: 'center' });
  };
  const activeIndex = () => cards.findIndex((card) => card.classList.contains('is-active'));
  cards.forEach((card, n) => {
    const pic = card.querySelector('.habit-pic');
    pic.setAttribute('aria-pressed', String(card.classList.contains('is-active')));
    pic.addEventListener('click', () => show(n));
  });
  for (const btn of document.querySelectorAll('[data-habit]')) {
    btn.addEventListener('click', () => show(activeIndex() + Number(btn.dataset.habit)));
  }
}

function initMyths() {
  const row = $('myth-row');
  for (const btn of document.querySelectorAll('[data-myth]')) {
    btn.addEventListener('click', () => {
      row.scrollBy({ left: Number(btn.dataset.myth) * row.clientWidth * 0.8, behavior: scrollBehavior() });
    });
  }
}

export function initLanding() {
  initShortcuts();
  initImpact();
  initHabits();
  initMyths();
}
