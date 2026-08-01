export function createModelDiscoveryCache({ ttlMs = 60_000, now = () => Date.now() } = {}) {
  const store = new Map();

  return {
    get(key) {
      const hit = store.get(String(key));
      if (!hit) return null;
      if (hit.expiresAt <= now()) {
        // Keep last good value available via getStale for failure fallback.
        return null;
      }
      return hit.value;
    },
    getStale(key) {
      const hit = store.get(String(key));
      return hit ? hit.value : null;
    },
    set(key, value) {
      store.set(String(key), {
        value,
        expiresAt: now() + ttlMs,
      });
    },
    clear() {
      store.clear();
    },
  };
}
