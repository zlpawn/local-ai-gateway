const FX_API_URL = "https://api.exchangerate-api.com/v4/latest/USD";
const FX_TIMEOUT_MS = 5000;
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const CACHE_MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48h

const DEFAULT_FX_RATE = 7.25;

export function createFxRateService() {
  let rate = DEFAULT_FX_RATE;
  let source = "default";
  let updatedAt = Date.now();
  let refreshTimer = null;

  /** Fetch the latest USD->CNY rate. Returns true on success. */
  async function fetchRate() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FX_TIMEOUT_MS);
      const res = await fetch(FX_API_URL, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return false;
      const data = await res.json();
      const usdToCny = Number(data?.rates?.CNY);
      if (isNaN(usdToCny) || usdToCny <= 0) return false;
      rate = usdToCny;
      source = "api";
      updatedAt = Date.now();
      return true;
    } catch {
      return false;
    }
  }

  /** Schedule background refresh every 6h. */
  function scheduleRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      fetchRate().catch(() => {});
    }, REFRESH_INTERVAL_MS);
    refreshTimer.unref?.();
  }

  // Initialize: async fetch, start with default
  fetchRate().catch(() => {});
  scheduleRefresh();

  /**
   * Get the current USD->CNY rate.
   * @returns {{ usd_to_cny: number, source: "api" | "default" | "cached", updated_at: number }}
   */
  function getRate() {
    const age = Date.now() - updatedAt;
    if (source === "api" || source === "cached") {
      if (age > CACHE_MAX_AGE_MS) {
        // Cache too old, fall back to default
        return {
          usd_to_cny: DEFAULT_FX_RATE,
          source: "default",
          updated_at: updatedAt,
        };
      }
      return {
        usd_to_cny: rate,
        source: age > REFRESH_INTERVAL_MS ? "cached" : source,
        updated_at: updatedAt,
      };
    }
    return {
      usd_to_cny: rate,
      source: "default",
      updated_at: updatedAt,
    };
  }

  return { getRate, refresh: fetchRate };
}