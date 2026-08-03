# Design Spec: Zero-Config Dual-Currency Cost Analytics

**Date:** 2026-08-03  
**Status:** Approved  
**Scope:** Local AI Gateway (`Shrimp`) Token Cost Analytics  

---

## 1. Overview & Purpose

The goal of this feature is to introduce **zero-configuration, dual-currency cost calculation and visualization** into the Shrimp AI Gateway's existing **Token Analytics** dashboard (`/config` UI).

Users will no longer need to manually input model pricing rules. The gateway will automatically resolve official model prices (for OpenAI, Anthropic, DeepSeek, Qwen, GLM, Grok, Kimi, etc.), compute individual request costs upon completion, store cost records permanently in SQLite, and render clear **USD ($)** and **RMB (¥)** totals in the Web UI dashboard.

---

## 2. Architecture & Components

```
+-------------------------------------------------------------------+
|                        Shrimp AI Gateway                          |
|                                                                   |
|   +--------------------------+     +--------------------------+   |
|   |   Online Price Fetcher   |     | Built-in Backup Prices   |   |
|   | (OpenRouter / CDN 24h)   |     | (DEFAULT_MODEL_PRICES)   |   |
|   +------------+-------------+     +------------+-------------+   |
|                |                                |                 |
|                +---------------+----------------+                 |
|                                v                                  |
|                 +----------------------------+                    |
|                 |  Model Pricing Engine      |                    |
|                 | (model-pricing.mjs)        |                    |
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
|                 | (cost_usd & cost_cny)      |                    |
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

* **Price Source & Auto Sync**:
  * On server initialization (and asynchronously every 24 hours), fetch official model pricing from CDN / OpenRouter API (`https://openrouter.ai/api/v1/models` or jsdelivr raw JSON).
  * Cache the fetched JSON locally at `~/.shrimp/model_prices_cache.json`.
  * If offline, timed-out (>3s), or invalid JSON, gracefully fall back to the built-in `DEFAULT_MODEL_PRICES` dictionary.
* **Resolution Algorithm**:
  1. Exact match (e.g. `deepseek-chat`, `gpt-4o`).
  2. Pattern & alias match (e.g., `deepseek-ai/DeepSeek-V3` → `deepseek-v3`, `claude-3-5-sonnet-20241022` → `claude-3-5-sonnet`).
  3. Price Currency Detection: Identify whether a model is natively billed in **USD ($)** or **RMB (¥)**.
* **Custom Override Support**:
  * Optional `custom_prices` array in `gateway.config.json` allows overrides for private/local endpoints if specified by the user.

---

## 3. Data Storage & Schema (`lib/analytics/db.mjs` & `token-tracker.mjs`)

### 3.1 Dual-Currency Schema Migration

Modify SQLite table `token_usage_logs` to store both USD and RMB costs for every request:

```sql
ALTER TABLE token_usage_logs ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0.0;
ALTER TABLE token_usage_logs ADD COLUMN cost_cny REAL NOT NULL DEFAULT 0.0;
```

### 3.2 Dual-Currency Calculation Logic

Upon request completion:
* If the model's native pricing currency is USD:
  $$\text{cost\_usd} = \left(\frac{\text{prompt\_tokens}}{10^6} \times \text{prompt\_price\_usd}\right) + \left(\frac{\text{completion\_tokens}}{10^6} \times \text{completion\_price\_usd}\right)$$
  $$\text{cost\_cny} = 0.0$$
* If the model's native pricing currency is RMB:
  $$\text{cost\_cny} = \left(\frac{\text{prompt\_tokens}}{10^6} \times \text{prompt\_price\_cny}\right) + \left(\frac{\text{completion\_tokens}}{10^6} \times \text{completion\_price\_cny}\right)$$
  $$\text{cost\_usd} = 0.0$$

**Rationale for Parallel Storage**: Fixed historical pricing in its native currency prevents historical billing distortion when daily exchange rates fluctuate or model prices drop.

---

## 4. Web UI Integration (`desktop/config-panel.html`)

Integrate directly into the existing **Token Analytics Tab (`#section-analytics`)**:

1. **Header Cards**:
   * Add 2 summary cards alongside Total Tokens:
     * **预估美元消费 (USD)**: `#stat-cost-usd` (e.g., `$0.42`)
     * **预估人民币消费 (RMB)**: `#stat-cost-cny` (e.g., `¥3.05`)
2. **Breakdown Tables**:
   * Update Client Breakdown, Endpoint Breakdown, Model Breakdown, and Detail Breakdown tables with a new **"预估费用"** column, displaying USD/RMB values based on non-zero totals.

---

## 5. Verification & Testing

* **Unit Tests**:
  * `tests/unit/model-pricing.test.mjs`: Test exact/alias resolution, USD vs RMB currency detection, fallback behaviors.
  * `tests/unit/token-tracker-cost.test.mjs`: Test SQLite migration, dual-currency `recordUsage`, and `queryUsage` aggregations.
* **Integration Verification**:
  * Run `npm run check` and `npm test`.
  * Trigger mock requests and verify Web UI `#section-analytics` displays correct USD/RMB cost totals.
