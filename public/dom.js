// Small DOM and network helpers shared by the page's modules.

export const $ = (id) => document.getElementById(id);
export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
export const scrollBehavior = () => (reducedMotion.matches ? 'auto' : 'smooth');
export const today = () => new Date().toISOString().slice(0, 10);
export const announce = (message) => {
  $('status').textContent = message;
};

/** localStorage that never throws (private browsing, blocked storage): it just forgets. */
export const store = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* nothing is remembered */
    }
  },
};

/**
 * Builds an element. `text` sets textContent, `vars` sets CSS custom properties and `on…` adds listeners.
 * Text, including anything from the API or Gemini, is only ever set as text, never parsed as HTML.
 */
export function h(tag, props = {}, ...children) {
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

/** Calls the AirWise API and returns its JSON, or throws an Error with a message fit to show people. */
export async function api(path, body) {
  const init = body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined;
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

/** A short spinner line, used while the plan or an answer is on its way. */
export const loadingLine = (text) =>
  h('p', { class: 'loading-row' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text);
