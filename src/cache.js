// A small time-limited cache that also shares in-flight work: ten people in the same neighbourhood asking at once
// cause one upstream call, not ten.
// ponytail: memory of one Cloud Run instance; move to Memorystore if many instances need to share hits.

/**
 * @param {{ ttlMs: number, max?: number, now?: () => number }} options  entries live `ttlMs`; at most `max` are kept
 */
export function ttlCache({ ttlMs, max = 500, now = Date.now }) {
  /** @type {Map<string, { value: unknown, expires: number }>} */
  const entries = new Map();

  /**
   * The live value for `key`, or undefined when it is missing or expired.
   * @param {string} key
   */
  function get(key) {
    const hit = entries.get(key);
    if (!hit) return undefined;
    if (hit.expires <= now()) {
      entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  /**
   * Stores `value` under `key`, dropping the oldest entry when the cache is full.
   * @template T
   * @param {string} key
   * @param {T} value
   * @returns {T}
   */
  function set(key, value) {
    const oldest = entries.keys().next();
    if (entries.size >= max && !oldest.done) entries.delete(oldest.value);
    entries.set(key, { value, expires: now() + ttlMs });
    return value;
  }

  /**
   * Returns the cached promise for `key`, or starts `work()` and caches its promise. Failures are not cached.
   * @template T
   * @param {string} key
   * @param {() => T | Promise<T>} work
   * @returns {Promise<T>}
   */
  function remember(key, work) {
    const hit = /** @type {Promise<T> | undefined} */ (get(key));
    if (hit) return hit;
    const promise = set(key, Promise.resolve().then(work));
    promise.catch(() => entries.delete(key));
    return promise;
  }

  return { get, set, delete: (/** @type {string} */ key) => entries.delete(key), remember };
}
