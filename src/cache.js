// A small time-limited cache that also shares in-flight work: ten people in the same neighbourhood asking at once
// cause one upstream call, not ten.
// ponytail: memory of one Cloud Run instance; move to Memorystore if many instances need to share hits.
export function ttlCache({ ttlMs, max = 500, now = Date.now }) {
  const entries = new Map();
  const cache = {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (hit.expires <= now()) {
        entries.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key, value) {
      if (entries.size >= max) entries.delete(entries.keys().next().value); // drop the oldest entry
      entries.set(key, { value, expires: now() + ttlMs });
      return value;
    },
    delete: (key) => entries.delete(key),
    /** Returns the cached promise for `key`, or starts `work()` and caches it. Failures are not cached. */
    remember(key, work) {
      const hit = cache.get(key);
      if (hit) return hit;
      const promise = Promise.resolve().then(work);
      cache.set(key, promise);
      promise.catch(() => cache.delete(key));
      return promise;
    },
  };
  return cache;
}
