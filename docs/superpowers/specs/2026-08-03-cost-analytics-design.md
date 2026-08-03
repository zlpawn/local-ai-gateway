# Design Spec: Zero-Config Dual-Currency Cost Analytics

**Date:** 2026-08-03  
**Status:** Draft (Revision 2)  
**Scope:** Local AI Gateway (`Shrimp`) Token Cost Analytics  
**Supersedes:** Revision 1 (approved draft) - see §10 for change log

---

## 1. Overview & Purpose

The goal of this feature is to introduce **zero-configuration, dual-currency cost calculation and visualization** into the Shrimp AI Gateway's existing **Token Analytics** dashboard (`/config` UI, `#section-analytics`).

Users will no longer need to manually input model pricing rules. The gateway will automatically resolve model prices (for OpenAI, Anthropic, DeepSeek, Qwen/GLM, Grok, Doubao, Minimax, etc.), compute per-request costs upon completion - including **prompt-cache discounts** - store cost records permanently in SQLite, and render clear **USD ($)** and **RMB (Y)** totals (both native and converted) in the Web UI dashboard.

### 1.1 Design Principles

1. **Native currency is the source of truth.** Every model has a native billing currency. The native cost is computed from official per-million-token prices and stored permanently; it never changes after the fact.
2. **Converted currency is derived at query time.** The dashboard shows both the native total and an "equivalent" total converted at a configurable exchange rate. The rate is refreshed periodically and is applied at display time, not stored per-row, so historical rows are re-valued consistently as the rate updates.
3. **Cache tokens are first-class.** Anthropic prompt caching and OpenAI cached tokens are billed at different rates than standard input; the schema and pricing engine account for this explicitly.
4. **Graceful degradation.** Missing prices, failed fetches, and unknown models degrade to `0` cost with a visible "unknown" marker - never a crash.

---

## 2. Architecture & Components

```
+-------------------------------------------------------------------+
|                        Shrimp AI Gateway                          |
|                                                                   |
|   +--------------------------+     +--------------------------+   |
|   |   Price Source Registry  |     | Built-in Fallback Prices |   |
|   | (OpenRouter + CN vendored|     | (DEFAULT_MODEL_PRICES)   |   |
|   |  + custom_prices override)    |                          |   |
|   +------------+-------------+     +------------+-------------+   |
|                |                                |                 |
|                +---------------+----------------+                 |
|                                v                                  |
|                 +----------------------------+                    |
|                 |  Model Pricing Engine      |                    |
|                 | (lib/analytics/            |                    |
|                 |  model-pricing.mjs)        |                    |
|                 +--------------+-------------+                    |
|                                |                                  |
|                 +--------------v-------------+                    |
|                 |  Exchange Rate Service     |                    |
|                 | (lib/analytics/fx-rate.mjs)|                    |
|                 +--------------+-------------+                    |
|                                |                                  |
|                                v                                  |
|                 +----------------------------+                    |
|                 |    TokenTracker Engine     |                    |
|                 |    (token-tracker.mjs)     |                    |
|                 +--------------+-------------+                    |
|                                |                                  |
|                                v                                  |
|                 +----------------------------+                    |
|                 |    SQLite Database         |                    |
|                 |  token_usage_logs          |                    |
|                 | (cost_native + cost_usd    |                    |
|                 |  + cache token columns)    |                    |
|                 +--------------+-------------+                    |
|                                |                                  |
|                                v                                  |
|                 +----------------------------+                    |
|                 |    Web UI Dashboard        |                    |
|                 | (#section-analytics)       |                    |
|                 +----------------------------+                    |
+-------------------------------------------------------------------+
```

### 2.1 Model Pricing Engine (`lib/analytics/model-pricing.mjs`)

#### Price Source Registry

The engine resolves prices through a layered registry, checked in order (first match wins):

1. **`custom_prices`** from `gateway.config.json` - user-defined overrides for private/local endpoints. See §2.2 for schema.
2. **Vendored CN model prices** - a hand-maintained JSON file bundled in-repo at `lib/analytics/data/cn-model-prices.json`, covering models sold on Volcengine Ark, Zhipu BigModel, Moonshot, Minimax, DeepSeek official, and Qwen DashScope. These vendors are either absent from OpenRouter or use incompatible model IDs (e.g. `doubao-seed-2.0-pro` is a Volcengine-specific name). The file is versioned in git and updated manually when vendors change pricing.
3. **OpenRouter prices** - fetched from `https://openrouter.ai/api/v1/models` at startup and every 24h, cached locally. Covers OpenAI, Anthropic, Google, Grok/xAI, DeepSeek (OpenRouter-listed), and other international models.
4. **`DEFAULT_MODEL_PRICES`** - a minimal built-in constant in `model-pricing.mjs` with conservative estimates for the most common models, used when all above sources are unavailable.

#### Price Cache Location

The fetched OpenRouter JSON is cached at a path **co-located with the gateway database**, not a hardcoded `~/.shrimp/`. This respects the existing configurable path convention:

```
<configDir>/model_prices_cache.json
```

where `configDir` = `path.dirname(GATEWAY_CONFIG_FILE)`, the same directory that holds `gateway.db` today (see `server.js` line 6071). This is resolved via the existing `resolveProjectPath()` helper.

#### Fetch & Refresh

- On server initialization: attempt a fetch with a **5-second timeout**. On timeout, invalid JSON, or network error, fall back to the cached file (if it exists and is <7 days old) or the vendored/built-in defaults.
- Every 24 hours: an asynchronous background refresh runs. Failures are logged at `warn` level via the existing `logInfo`/`logWarn` convention and do not propagate.
- If the cached file is stale (>7 days) and a fresh fetch fails, the engine continues using the stale cache but flags `prices_stale: true` in the pricing context, which the UI can surface.

#### Resolution Algorithm

```
resolvePrice(modelName) -> { currency, prompt, completion, cache_creation, cache_read, source }
```

1. **Exact match** against `custom_prices`, then vendored CN prices, then OpenRouter cache, then `DEFAULT_MODEL_PRICES`.
2. **Alias & pattern match** - a normalization step that strips provider prefixes (`deepseek-ai/DeepSeek-V3` -> `deepseek-v3`), version suffixes (`claude-3-5-sonnet-20241022` -> `claude-3-5-sonnet`), and applies known aliases (`glm-4` <-> `chatglm-4`, `doubao-seed-2` -> `doubao-seed-2.0-pro`).
3. **Currency detection** - the price entry declares its native currency (`usd` or `cny`). OpenRouter prices are always USD; vendored CN prices declare per-entry. `custom_prices` entries must declare `currency`.
4. **Cache price defaults** - if a price entry lacks `cache_creation` / `cache_read`, the engine applies vendor-specific defaults:
   - Anthropic: cache_creation = prompt x 1.25, cache_read = prompt x 0.10
   - OpenAI: cache_read = prompt x 0.50 (no cache_creation concept)
   - Others: no cache pricing (cache tokens billed at standard prompt rate)

If no match is found, returns `{ currency: null, prompt: 0, completion: 0, ..., source: "unknown" }`.

### 2.2 Custom Price Override Schema

Added to `gateway.config.json` as an optional top-level key:

```json
{
  "custom_prices": [
    {
      "model": "doubao-seed-2.0-pro",
      "currency": "cny",
      "prompt": 4.0,
      "completion": 16.0,
      "cache_creation": 5.0,
      "cache_read": 1.0
    },
    {
      "model": "my-local-llama",
      "currency": "usd",
      "prompt": 0.0,
      "completion": 0.0
    }
  ]
}
```

All price fields are **per 1M tokens**. `cache_creation` and `cache_read` are optional. Entries here always take precedence over fetched and built-in prices.

### 2.3 Exchange Rate Service (`lib/analytics/fx-rate.mjs`)

A lightweight module that provides the USD<->CNY rate used for currency conversion at query/display time.

#### Source

- Fetches from a free public API: `https://api.exchangerate-api.com/v4/latest/USD` (no key required) with a **5-second timeout**.
- Fallback: a built-in conservative default rate (e.g. `7.25`) embedded as `DEFAULT_FX_RATE` in the module.
- The fetched rate is cached in memory and refreshed every **6 hours** (more frequent than prices, since FX volatility is higher and the cost of a stale rate is visible mis-valuation).

#### Behavior

- `getRate(): { usd_to_cny: number, source: "api" | "default" | "cached", updated_at: number }`
- If the API call fails, uses the last successfully cached rate if <48h old; otherwise falls back to `DEFAULT_FX_RATE` and flags `source: "default"`.
- The rate is **never persisted per-row**. It is read at query time when the dashboard requests aggregated costs, so all historical rows are re-valued at the current rate consistently.

---

## 3. Data Storage & Schema

### 3.1 Schema Migration (Idempotent)

The migration runs in `db.mjs` inside `openGatewayDatabase()`, **after** the existing `CREATE TABLE IF NOT EXISTS` block. SQLite does not support `ADD COLUMN IF NOT EXISTS`, so the migration checks `PRAGMA table_info` and adds columns only when missing:

```js
function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

ensureColumn(db, "token_usage_logs", "cost_native", "REAL NOT NULL DEFAULT 0.0");
ensureColumn(db, "token_usage_logs", "cost_usd", "REAL NOT NULL DEFAULT 0.0");
ensureColumn(db, "token_usage_logs", "native_currency", "TEXT NOT NULL DEFAULT ''");
ensureColumn(db, "token_usage_logs", "cache_creation_tokens", "INTEGER NOT NULL DEFAULT 0");
ensureColumn(db, "token_usage_logs", "cache_read_tokens", "INTEGER NOT NULL DEFAULT 0");
ensureColumn(db, "token_usage_logs", "price_source", "TEXT NOT NULL DEFAULT ''");
```

This is fully idempotent: new databases get the columns via `ALTER` on first run; existing databases get them added once and skipped thereafter; repeated starts never error.

**Why `cost_native` + `cost_usd` (not `cost_usd` + `cost_cny`):** Revision 1 stored `cost_usd` and `cost_cny` as parallel columns, with one always 0. This made the two summary cards disjoint (the USD card only reflected USD-native models; the RMB card only reflected CNY-native models) and prevented any meaningful "total spend" figure. Revision 2 instead stores:
- `cost_native` - the cost in the model's native currency (computed from official prices, immutable).
- `cost_usd` - the cost converted to USD at the rate **captured at request time** (for a stable historical reference).
- `native_currency` - `"usd"` or `"cny"`, so the UI can label the native amount correctly.

The **CNY equivalent at display time** is derived via the live FX rate (§2.3), not stored. This gives the dashboard a consistent "equivalent total" regardless of how many models of each currency are mixed.

### 3.2 Cost Calculation Logic

Upon request completion, `token-tracker.mjs` receives the usage data and the resolved model price, then computes:

```
native_cost = (cache_creation_tokens x cache_creation_price
             + cache_read_tokens x cache_read_price
             + max(0, prompt_tokens - cache_creation_tokens - cache_read_tokens) x prompt_price
             + completion_tokens x completion_price) / 1_000_000
```

Notes:
- Cache tokens are subtracted from the standard prompt count to avoid double-charging. For providers that report `prompt_tokens` inclusive of cached tokens (Anthropic), the capture layer (§3.3) normalizes this so the subtraction is correct.
- If `cache_creation_tokens` and `cache_read_tokens` are both 0, the formula reduces to the standard `(prompt x prompt_price + completion x completion_price) / 1e6`.

Then:
```
cost_usd = native_currency === "usd" ? native_cost : native_cost / fxRate.usd_to_cny
```

where `fxRate` is the rate at request time (fetched once and held for the request). The live CNY equivalent at display time is:
```
cost_cny_display = native_currency === "cny" ? cost_native : cost_native x fxRate.usd_to_cny
```

**Rationale:** Native cost is immutable historical truth. `cost_usd` gives a stable per-row USD reference. The display-time CNY uses the current rate so the dashboard total reflects present-day value - which is what a user checking "how much have I spent" actually wants.

### 3.3 Usage Capture Enhancement (`lib/analytics/response-usage-capture.mjs`)

The current capture layer only extracts `prompt_tokens`, `completion_tokens`, and `total_tokens`. It must also capture cache-related token counts:

**Anthropic (SSE events):**
- `message_start` -> `message.usage.input_tokens` (includes cache) and `cache_creation_input_tokens`, `cache_read_input_tokens`.
- `message_delta` -> `usage.output_tokens`.

**OpenAI (JSON response):**
- `usage.prompt_tokens_details.cached_tokens` (OpenAI reports cache reads only, no cache creation).

The `normalizeUsage()` function is extended to return:
```js
{
  prompt_tokens,
  completion_tokens,
  total_tokens,
  cache_creation_tokens,  // 0 when not reported
  cache_read_tokens,      // 0 when not reported
}
```

For Anthropic, where `input_tokens` **includes** cached tokens, the capture layer records:
- `prompt_tokens` = `input_tokens` (as reported, for parity with the upstream bill)
- `cache_creation_tokens` = `cache_creation_input_tokens`
- `cache_read_tokens` = `cache_read_input_tokens`

The pricing engine then subtracts cache tokens from prompt before applying the standard rate (see §3.2), so the total billed amount matches the vendor's invoice.

---

## 4. TokenTracker Changes (`lib/analytics/token-tracker.mjs`)

### 4.1 `recordUsage(log)`

The method signature gains the resolved price and FX rate so it can compute and store costs:

```js
recordUsage(log = {}) {
  // ...existing field extraction...

  const price = log.price || null;   // resolved by model-pricing engine
  const fxRate = log.fxRate || null; // from fx-rate service

  let cost_native = 0;
  let cost_usd = 0;
  let native_currency = "";
  let price_source = "unknown";

  if (price && price.currency) {
    const cacheCreation = Math.max(0, Number(log.cache_creation_tokens || 0));
    const cacheRead = Math.max(0, Number(log.cache_read_tokens || 0));
    const billablePrompt = Math.max(0, prompt_tokens - cacheCreation - cacheRead);

    cost_native = (cacheCreation * (price.cache_creation || 0)
                 + cacheRead * (price.cache_read || 0)
                 + billablePrompt * (price.prompt || 0)
                 + completion_tokens * (price.completion || 0)) / 1_000_000;

    native_currency = price.currency;
    price_source = price.source || "unknown";
    cost_usd = price.currency === "usd"
      ? cost_native
      : (fxRate?.usd_to_cny ? cost_native / fxRate.usd_to_cny : 0);
  }

  insertStmt.run(
    ts, date_str, hour_str, minute_str,
    client, endpoint_id, endpoint_name, purpose, model,
    prompt_tokens, completion_tokens, total_tokens,
    cache_creation_tokens, cache_read_tokens,
    cost_native, cost_usd, native_currency, price_source
  );
}
```

The `INSERT` statement and prepared statement are updated to include the 7 new columns.

### 4.2 `queryUsage(options)`

All aggregation queries (`summary`, `timeline`, `purpose_breakdown`, `client_breakdown`, `endpoint_breakdown`, `model_breakdown`, `detail_breakdown`) are extended to also `SUM(cost_native)` and `SUM(cost_usd)`.

The `summary` object returns:

```js
summary: {
  total_requests,
  prompt_tokens,
  completion_tokens,
  total_tokens,
  cache_creation_tokens,
  cache_read_tokens,
  cost_native_total,     // SUM(cost_native) across all rows - mixed currency, see note
  cost_usd_total,        // SUM(cost_usd)
  cost_cny_equivalent,   // cost_usd_total x liveFxRate (computed in server.js)
}
```

**Important:** `cost_native_total` is a sum across mixed currencies and is labeled "native" only for informational purposes. The two meaningful totals for the UI are `cost_usd_total` (stable historical USD) and `cost_cny_equivalent` (live USD->CNY conversion). The UI uses these two.

Each breakdown row also gains `cost_native`, `cost_usd`, and `native_currency` fields so the table can show a per-row cost with the correct currency label.

---

## 5. Server Wiring (`server.js`)

### 5.1 Price & FX Resolution at Record Time

In `recordRequestTokenUsage()` (currently `server.js` line ~5849), the resolved price and FX rate are injected before calling `recordUsage`:

```js
function recordRequestTokenUsage(opts = {}) {
  try {
    const ep = opts.endpoint || {};
    const usage = opts.usage || {};
    const model = opts.model || ep.upstream_model || "unknown";
    const price = globalPricingEngine.resolvePrice(model);
    const fxRate = globalFxRateService.getRate();

    globalTokenTracker.recordUsage({
      // ...existing fields...
      cache_creation_tokens: usage.cache_creation_tokens || 0,
      cache_read_tokens: usage.cache_read_tokens || 0,
      price,
      fxRate,
    });
  } catch {}
}
```

### 5.2 Live FX Injection at Query Time

In the `/v1/analytics/token-usage` handler (currently `server.js` line ~1639), after `queryUsage` returns, the server injects the live CNY equivalent:

```js
const result = globalTokenTracker.queryUsage({ granularity, range, purpose, client, model });
const fxRate = globalFxRateService.getRate();
result.summary.cost_cny_equivalent = Number(result.summary.cost_usd_total || 0) * fxRate.usd_to_cny;
result.fx = { usd_to_cny: fxRate.usd_to_cny, source: fxRate.source, updated_at: fxRate.updated_at };
sendJson(res, 200, result);
```

### 5.3 Initialization

Near the existing `globalTokenTracker` initialization (line ~6070):

```js
const globalPricingEngine = createModelPricingEngine({
  configDir: path.dirname(GATEWAY_CONFIG_FILE),
  customPrices: GATEWAY_CONFIG.custom_prices || [],
});
const globalFxRateService = createFxRateService();
```

Both are initialized synchronously (the pricing engine loads vendored + cached data; the FX service starts with the default rate and refreshes asynchronously).

---

## 6. Web UI Integration (`desktop/config-panel.html`)

### 6.1 Summary Cards

Replace the current 4-card row with a 6-card row (or keep 4 token cards and add 2 cost cards below). The two new cards:

1. **Total Cost (USD)**: `#stat-cost-usd` - displays `summary.cost_usd_total` as `$X.XX`.
2. **Total Cost (CNY)**: `#stat-cost-cny` - displays `summary.cost_cny_equivalent` as `Y X.XX`.

A small subtitle under each cost card shows the FX rate source and update time (e.g., `Rate 7.18 - updated 14:30`), so the user knows whether the CNY figure is live or from a fallback default.

### 6.2 Breakdown Tables

Each breakdown table (`renderAnalyticsBreakdownTable` and `renderAnalyticsDetailBreakdown`) gains a new **"Cost"** column. The column displays:

- If the row's `native_currency` is `usd`: `$X.XX` (and optionally `~ YY.YY` in muted text for the converted amount).
- If the row's `native_currency` is `cny`: `Y X.XX` (and optionally `~ $Y.YY` in muted text).
- If `native_currency` is empty (unknown model): `-` with a tooltip "Model price not found".

The secondary converted amount uses the same live FX rate returned in `result.fx`.

### 6.3 No New Sections

All changes are within the existing `#section-analytics` section. No new tabs, no new pages. The cost columns are additive to the existing token columns, preserving the current layout.

---

## 7. Vendored CN Model Price File

`lib/analytics/data/cn-model-prices.json` - a versioned, hand-maintained JSON file. Structure:

```json
{
  "version": "2026-08-03",
  "models": {
    "doubao-seed-2.0-pro": {
      "currency": "cny",
      "prompt": 4.0,
      "completion": 16.0,
      "cache_creation": 5.0,
      "cache_read": 1.0,
      "vendor": "volcengine"
    },
    "doubao-embedding-vision": {
      "currency": "cny",
      "prompt": 0.3,
      "completion": 0,
      "vendor": "volcengine"
    },
    "glm-5.2": {
      "currency": "cny",
      "prompt": 2.0,
      "completion": 8.0,
      "vendor": "zhipu"
    },
    "deepseek-v4-pro": {
      "currency": "cny",
      "prompt": 2.0,
      "completion": 8.0,
      "cache_read": 0.5,
      "vendor": "deepseek"
    },
    "minimax-m3": {
      "currency": "cny",
      "prompt": 10.0,
      "completion": 10.0,
      "vendor": "minimax"
    },
    "grok-4.5": {
      "currency": "usd",
      "prompt": 5.0,
      "completion": 15.0,
      "vendor": "xai"
    }
  }
}
```

Prices are per 1M tokens, in the model's native currency. This file is the fallback for CN models that OpenRouter does not list. It is updated manually by checking vendor pricing pages; a `scripts/update-cn-prices.mjs` helper (future work) can scrape vendor pages to flag drift, but is out of scope for this revision.

**Note:** The example prices above are illustrative placeholders. Actual values must be verified against each vendor's official pricing page before the file is committed. The file includes a `version` date so staleness is detectable.

---

## 8. Verification & Testing

All tests use `node:test` and are placed in `tests/unit/`, matching the existing convention. The project has no root `npm test` script - tests are run via `node --test <file>` or the specific `npm run test:*` scripts.

### 8.1 Unit Tests

1. **`tests/unit/model-pricing.test.mjs`** - Tests:
   - Exact match against `custom_prices` (override takes precedence).
   - Alias resolution (`deepseek-ai/DeepSeek-V3` -> `deepseek-v3`, `claude-3-5-sonnet-20241022` -> `claude-3-5-sonnet`).
   - Currency detection (USD from OpenRouter, CNY from vendored file).
   - Cache price defaults (Anthropic 1.25x/0.10x, OpenAI 0.50x).
   - Fallback to `DEFAULT_MODEL_PRICES` when all sources miss.
   - `source: "unknown"` return shape.

2. **`tests/unit/fx-rate.test.mjs`** - Tests:
   - `getRate()` returns default rate when API is unreachable (mock fetch).
   - Cached rate is used when <48h old.
   - Stale cache (>48h) falls back to default with `source: "default"`.

3. **`tests/unit/token-tracker-cost.test.mjs`** - Tests:
   - Schema migration is idempotent (open DB twice, no error).
   - `recordUsage` with a known USD model stores correct `cost_native` and `cost_usd`.
   - `recordUsage` with a CNY model converts to `cost_usd` correctly.
   - `recordUsage` with cache tokens applies cache pricing and subtracts from prompt.
   - `recordUsage` with unknown model stores `cost_native = 0`, `native_currency = ""`, `price_source = "unknown"`.
   - `queryUsage` returns `cost_usd_total` and per-breakdown `cost_usd` / `native_currency`.

4. **`tests/unit/response-usage-capture-cache.test.mjs`** - Tests:
   - Anthropic SSE: `message_start` + `message_delta` yields correct `cache_creation_tokens` and `cache_read_tokens`.
   - OpenAI JSON: `prompt_tokens_details.cached_tokens` is captured as `cache_read_tokens`.
   - Non-cache responses still return `cache_creation_tokens = 0` and `cache_read_tokens = 0`.

5. **`tests/unit/analytics-api-cost.test.mjs`** - Tests the `/v1/analytics/token-usage` handler returns `cost_cny_equivalent` and `fx` fields (extends existing `analytics-api.test.mjs` or new file).

### 8.2 Integration Verification

- Run `npm run check` (syntax check - this script exists and verifies `server.js` and key scripts).
- Run `node --test tests/unit/model-pricing.test.mjs tests/unit/fx-rate.test.mjs tests/unit/token-tracker-cost.test.mjs tests/unit/response-usage-capture-cache.test.mjs tests/unit/analytics-api-cost.test.mjs`.
- Run `node --test tests/unit/config-panel.test.mjs` to verify UI test coverage still passes after HTML changes.
- Trigger mock requests through the gateway (one USD model, one CNY model) and verify `#section-analytics` displays correct cost totals in both currencies, with the FX rate subtitle visible.

### 8.3 Migration Safety

- Test against an **existing** `gateway.db` that has rows with the old schema (no cost columns). Verify the migration adds columns without data loss and that old rows show `cost_native = 0.0` (the column default).
- Test that querying old + new rows together produces correct aggregates (old rows contribute 0 to cost sums).

---

## 9. Out of Scope

- **Historical backfill.** Rows logged before this feature shipped will have `cost_native = 0` and cannot be retroactively costed unless token counts and model are known. A future `scripts/backfill-costs.mjs` could re-derive costs for historical rows using current prices, but this is explicitly deferred.
- **Per-model custom exchange rates.** Some users may want to track actual RMB paid (which differs from interbank rate due to payment-provider markups). Not supported in this revision.
- **Budget alerts / spending limits.** Out of scope; this revision is observability only.
- **Automatic CN price scraping.** The vendored JSON is manually maintained. Automation is future work.

---

## 10. Change Log (Revision 1 -> Revision 2)

1. **Added FX rate service (§2.3).** Rev 1 had no exchange rate mechanism at all, making true dual-currency display impossible.
2. **Changed storage model from `cost_usd` + `cost_cny` to `cost_native` + `cost_usd` + `native_currency` (§3.1).** Rev 1's parallel-zero approach made the two summary cards disjoint and prevented a meaningful total. Rev 2 stores native cost (immutable) and a USD reference; CNY is derived live at display time.
3. **Made schema migration idempotent (§3.1).** Rev 1 used bare `ALTER TABLE ADD COLUMN` which errors on repeated startup. Rev 2 uses `PRAGMA table_info` guard.
4. **Added cache token coverage (§3.2, §3.3).** Rev 1's cost formula only used `prompt_tokens`, overcharging for cached requests. Rev 2 captures `cache_creation_tokens` / `cache_read_tokens` and applies vendor-specific cache pricing.
5. **Added vendored CN model price file (§7).** Rev 1 relied solely on OpenRouter, which does not list Volcengine/Zhipu/Minimax models. Rev 2 adds a hand-maintained fallback keyed to the actual model names in `gateway.config.json`.
6. **Fixed price cache path (§2.1).** Rev 1 hardcoded `~/.shrimp/`. Rev 2 co-locates with `gateway.db` in the config directory, respecting the existing `resolveProjectPath` / `GATEWAY_CONFIG_FILE` convention.
7. **Fixed test commands (§8).** Rev 1 referenced `npm test` which does not exist. Rev 2 uses `npm run check` + explicit `node --test` invocations matching the project's actual script structure.
8. **Added `custom_prices` schema (§2.2).** Rev 1 mentioned overrides but gave no structure. Rev 2 specifies the JSON schema with per-1M-token fields and currency declaration.
9. **Added cache price defaults (§2.1).** Rev 1 had no cache pricing. Rev 2 specifies Anthropic (1.25x/0.10x) and OpenAI (0.50x) defaults.
10. **Added migration safety testing (§8.3).** Rev 1 did not address upgrading existing databases.
