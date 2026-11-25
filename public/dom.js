// Small DOM and network helpers shared by the page's modules.

/**
 * The element with this id. Every id the scripts use is in index.html, so a missing one is a bug worth failing on.
 * Pass the element class to get that type back, checked: `byId('city', HTMLInputElement).value`.
 * @template {HTMLElement} [T=HTMLElement]
 * @param {string} id
 * @param {{ new (): T }} [type]
 * @returns {T}
 */
export function byId(id, type) {
  const element = document.getElementById(id);
  if (!element || (type && !(element instanceof type))) throw new Error(`#${id} is missing from the page`);
  return /** @type {T} */ (element);
}

export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
export const scrollBehavior = () => (reducedMotion.matches ? 'auto' : 'smooth');
export const today = () => new Date().toISOString().slice(0, 10);

/**
 * Says something to screen-reader users through the page's polite live region.
 * @param {string} message
 */
export const announce = (message) => {
  byId('status').textContent = message;
};

/** localStorage that never throws (private browsing, blocked storage): it just forgets. */
export const store = {
  /**
   * @param {string} key
   * @returns {any}  the stored JSON value, or null
   */
  get(key) {
    try {
      return JSON.parse(localStorage.getItem(key) ?? 'null');
    } catch {
      return null;
    }
  },
  /**
   * @param {string} key
   * @param {unknown} value  stored as JSON
   */
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* nothing is remembered */
    }
  },
};

/** @typedef {Node | string | null | undefined | false} Child  falsy children are skipped */

/**
 * Builds an element. `text` sets textContent, `vars` sets CSS custom properties and `on…` adds listeners.
 * Text, including anything from the API or Gemini, is only ever set as text, never parsed as HTML.
 * @param {string} tag
 * @param {Record<string, unknown>} [props]
 * @param {...(Child | Child[])} children
 * @returns {HTMLElement}
 */
export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') element.className = String(value);
    else if (key === 'text') element.textContent = String(value);
    else if (key === 'vars') {
      for (const [name, v] of Object.entries(/** @type {object} */ (value))) element.style.setProperty(name, String(v));
    } else if (key.startsWith('on')) element.addEventListener(key.slice(2), /** @type {EventListener} */ (value));
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  element.append(...children.flat().filter((child) => child != null && child !== false));
  return element;
}

/**
 * Calls the AirWise API and returns its JSON, or throws an Error with a message fit to show people.
 * @param {string} path
 * @param {object} [body]  sent as JSON with POST; without it the call is a GET
 * @returns {Promise<any>}
 */
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

/**
 * A short spinner line, used while the plan or an answer is on its way.
 * @param {string} text
 */
export const loadingLine = (text) =>
  h('p', { class: 'loading-row' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text);
