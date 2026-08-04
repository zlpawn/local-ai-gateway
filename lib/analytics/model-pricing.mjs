import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const LITELLM_TIMEOUT_MS = 5000;
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const CACHE_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7d
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

/** Built-in fallback prices for the most common models (per 1M tokens). */
const DEFAULT_MODEL_PRICES = {
  "gpt-4o": { currency: "usd", prompt: 2.5, completion: 10, cache_read: 1.25, vendor: "openai" },
  "gpt-4o-mini": { currency: "usd", prompt: 0.15, completion: 0.6, cache_read: 0.075, vendor: "openai" },
  "gpt-4-turbo": { currency: "usd", prompt: 10, completion: 30, vendor: "openai" },
  "claude-3-5-sonnet": { currency: "usd", prompt: 3, completion: 15, cache_creation: 3.75, cache_read: 0.3, vendor: "anthropic" },
  "claude-3-5-haiku": { currency: "usd", prompt: 0.8, completion: 4, cache_creation: 1, cache_read: 0.08, vendor: "anthropic" },
  "claude-3-opus": { currency: "usd", prompt: 15, completion: 75, cache_creation: 18.75, cache_read: 1.5, vendor: "anthropic" },
  "deepseek-chat": { currency: "cny", prompt: 2, completion: 8, cache_read: 0.5, vendor: "deepseek" },
  "deepseek-v3": { currency: "cny", prompt: 2, completion: 8, cache_read: 0.5, vendor: "deepseek" },
  "gemini-2.0-flash": { currency: "usd", prompt: 0.1, completion: 0.4, vendor: "google" },
  "gemini-1.5-pro": { currency: "usd", prompt: 1.25, completion: 5, vendor: "google" },
};

/** Known alias mappings (normalized name -> canonical name). */
const ALIASES = {
  "chatglm-4": "glm-4",
  "glm-4": "glm-4",
  "doubao-seed-2": "doubao-seed-2.0-pro",
  "deepseek-v3-0324": "deepseek-v3",
};

/** Vendors that use Anthropic-style cache pricing defaults. */
const ANTHROPIC_PATTERN = /^claude/i;

/** Normalize a model name for matching: lowercase, strip prefixes, version suffixes, apply aliases. */
export function normalizeModelName(rawName) {
  let name = String(rawName || "").trim().toLowerCase();
  // Strip provider prefix (e.g. "deepseek-ai/DeepSeek-V3" -> "deepseek-v3")
  name = name.replace(/^[a-z0-9_-]+\//, "");
  // Strip date/version suffixes (e.g. "claude-3-5-sonnet-20241022" -> "claude-3-5-sonnet")
  name = name.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "");
  // Apply known aliases
  if (ALIASES[name]) name = ALIASES[name];
  return name;
}

/** Apply vendor-specific cache price defaults when the entry lacks them. */
function applyCacheDefaults(entry) {
  const result = { ...entry };
  const prompt = Number(entry.prompt || 0);
  if (ANTHROPIC_PATTERN.test(entry.vendor || entry.model || "")) {
    result.cache_creation ??= Number((prompt * 1.25).toFixed(4));
    result.cache_read ??= Number((prompt * 0.1).toFixed(4));
  } else if ((entry.vendor || "").includes("openai") || (entry.model || "").startsWith("gpt")) {
    result.cache_read ??= Number((prompt * 0.5).toFixed(4));
  }
  return result;
}

/** Parse litellm model_prices_and_context_window.json into a flat price map. */
function parseLitellmResponse(data) {
  const map = {};
  if (!data || typeof data !== "object") return map;
  for (const [name, info] of Object.entries(data)) {
    if (!info || typeof info !== "object") continue;
    if (name === "sample_spec") continue;
    const inputCost = parseFloat(info.input_cost_per_token);
    const outputCost = parseFloat(info.output_cost_per_token);
    if (isNaN(inputCost) && isNaN(outputCost)) continue;
    const entry = {
      currency: "usd",
      prompt: (inputCost || 0) * 1_000_000,
      completion: (outputCost || 0) * 1_000_000,
      vendor: info.litellm_provider || "litellm",
      source: "litellm",
    };
    const cacheCreate = parseFloat(info.cache_creation_input_cost_per_token);
    if (!isNaN(cacheCreate) && cacheCreate > 0) {
      entry.cache_creation = cacheCreate * 1_000_000;
    }
    const cacheRead = parseFloat(info.cache_read_input_cost_per_token);
    if (!isNaN(cacheRead) && cacheRead > 0) {
      entry.cache_read = cacheRead * 1_000_000;
    }
    map[name.toLowerCase()] = entry;
  }
  return map;
}

export function createModelPricingEngine({ configDir = ".", customPrices = [] } = {}) {
  // Load vendored CN prices
  let vendoredPrices = {};
  try {
    const vendoredPath = path.join(__dirname, "data", "cn-model-prices.json");
    const raw = JSON.parse(fs.readFileSync(vendoredPath, "utf8"));
    for (const [key, val] of Object.entries(raw.models || {})) {
      vendoredPrices[key.toLowerCase()] = { ...val, source: "vendored" };
    }
  } catch {
    // Non-fatal: vendored file missing or invalid
  }

  // Build custom prices map
  const customPricesMap = {};
  for (const entry of customPrices) {
    if (entry?.model) {
      customPricesMap[entry.model.toLowerCase()] = { ...entry, source: "custom" };
    }
  }

  // litellm cache state
  const cachePath = path.join(configDir, "model_prices_cache.json");
  let litellmPrices = {};
  let cacheTimestamp = 0;
  let pricesStale = false;
  let refreshTimer = null;

  /** Load cached litellm prices from disk. */
  function loadCache() {
    try {
      const raw = fs.readFileSync(cachePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.timestamp && parsed?.models) {
        cacheTimestamp = parsed.timestamp;
        litellmPrices = parsed.models;
        const age = Date.now() - cacheTimestamp;
        pricesStale = age > CACHE_STALE_MS;
      }
    } catch {
      // No cache file or invalid - will fetch fresh
    }
  }

  /** Fetch litellm prices with timeout. Returns true on success. */
  async function fetchLitellm() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LITELLM_TIMEOUT_MS);
      const res = await fetch(LITELLM_URL, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return false;
      const data = await res.json();
      const parsed = parseLitellmResponse(data);
      if (Object.keys(parsed).length === 0) return false;
      litellmPrices = parsed;
      cacheTimestamp = Date.now();
      pricesStale = false;
      // Persist cache
      try {
        fs.writeFileSync(cachePath, JSON.stringify({ timestamp: cacheTimestamp, models: parsed }, null, 2), "utf8");
      } catch {
        // Non-fatal: can't persist cache
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Schedule background refresh every 24h. */
  function scheduleRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      fetchLitellm().catch(() => {});
    }, REFRESH_INTERVAL_MS);
    refreshTimer.unref?.();
  }

  // Initialize: load cache, then async fetch
  loadCache();
  fetchLitellm().catch(() => {});
  scheduleRefresh();

  /**
   * Resolve the price for a model.
   * @param {string} modelName
   * @returns {{ currency: string|null, prompt: number, completion: number, cache_creation: number, cache_read: number, source: string }}
   */
  function resolvePrice(modelName) {
    const normalized = normalizeModelName(modelName);

    // 1. Custom prices (highest priority)
    if (customPricesMap[normalized]) {
      const entry = applyCacheDefaults(customPricesMap[normalized]);
      return {
        currency: entry.currency,
        prompt: Number(entry.prompt || 0),
        completion: Number(entry.completion || 0),
        cache_creation: Number(entry.cache_creation || 0),
        cache_read: Number(entry.cache_read || 0),
        source: "custom",
      };
    }

    // 2. Vendored CN prices
    if (vendoredPrices[normalized]) {
      const entry = applyCacheDefaults(vendoredPrices[normalized]);
      return {
        currency: entry.currency,
        prompt: Number(entry.prompt || 0),
        completion: Number(entry.completion || 0),
        cache_creation: Number(entry.cache_creation || 0),
        cache_read: Number(entry.cache_read || 0),
        source: "vendored",
      };
    }

    // 3. litellm cache (try both normalized and raw)
    const ltEntry = litellmPrices[normalized] || litellmPrices[String(modelName || "").toLowerCase()];
    if (ltEntry) {
      const entry = applyCacheDefaults({ ...ltEntry, model: modelName });
      return {
        currency: entry.currency,
        prompt: Number(entry.prompt || 0),
        completion: Number(entry.completion || 0),
        cache_creation: Number(entry.cache_creation || 0),
        cache_read: Number(entry.cache_read || 0),
        source: "litellm",
      };
    }

    // 4. Built-in defaults
    if (DEFAULT_MODEL_PRICES[normalized]) {
      const entry = applyCacheDefaults({ ...DEFAULT_MODEL_PRICES[normalized], model: modelName });
      return {
        currency: entry.currency,
        prompt: Number(entry.prompt || 0),
        completion: Number(entry.completion || 0),
        cache_creation: Number(entry.cache_creation || 0),
        cache_read: Number(entry.cache_read || 0),
        source: "default",
      };
    }

    // Unknown model
    return {
      currency: null,
      prompt: 0,
      completion: 0,
      cache_creation: 0,
      cache_read: 0,
      source: "unknown",
    };
  }

  /**
   * Rebuild the custom prices map. Called after config save so runtime
   * changes to custom_prices take effect without restarting the gateway.
   */
  function updateCustomPrices(newPrices) {
    // Clear & rebuild
    for (const key of Object.keys(customPricesMap)) delete customPricesMap[key];
    for (const entry of (newPrices || [])) {
      if (entry?.model) {
        customPricesMap[entry.model.toLowerCase()] = { ...entry, source: "custom" };
      }
    }
  }

  return {
    resolvePrice,
    updateCustomPrices,
    isStale: () => pricesStale,
    refresh: fetchLitellm,
    listPrices() {
      const all = {};
      for (const [key, val] of Object.entries(DEFAULT_MODEL_PRICES)) {
        all[key] = applyCacheDefaults({ ...val, source: "default" });
      }
      for (const [key, val] of Object.entries(vendoredPrices)) {
        all[key] = applyCacheDefaults({ ...val });
      }
      for (const [key, val] of Object.entries(litellmPrices)) {
        all[key] = applyCacheDefaults({ ...val });
      }
      for (const [key, val] of Object.entries(customPricesMap)) {
        all[key] = applyCacheDefaults({ ...val });
      }
      let vendoredVersion = null;
      try {
        vendoredVersion = JSON.parse(
          fs.readFileSync(path.join(__dirname, "data", "cn-model-prices.json"), "utf8")
        ).version;
      } catch {}
      return {
        stale: pricesStale,
        vendored_version: vendoredVersion,
        models: Object.entries(all).map(([name, entry]) => ({
          model: name,
          currency: entry.currency,
          prompt: Number(entry.prompt || 0),
          completion: Number(entry.completion || 0),
          cache_creation: Number(entry.cache_creation || 0),
          cache_read: Number(entry.cache_read || 0),
          source: entry.source,
          vendor: entry.vendor || null,
        })).sort((a, b) => a.model.localeCompare(b.model)),
      };
    },
  };
}