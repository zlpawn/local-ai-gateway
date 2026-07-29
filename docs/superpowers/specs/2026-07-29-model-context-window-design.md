# Third-Party Model Context Window Configuration Design

## Goal

Provide per-model `context_window` configuration in `local-ai-gateway` for third-party models, resolving context truncation and premature compaction issues across Codex, Claude Desktop, Claude Code, and OpenAI-compatible clients.

## Context Resolution Logic

The context window for any third-party model is evaluated using a strict two-tier resolution order:

1. **Model-level configuration (Highest priority)**:
   Value specified in `endpoint.model_capabilities[model_id].context_window`.
2. **Global default fallback (Default)**:
   `1,000,000` Tokens (1M Tokens).

There are no intermediate node-type or provider-level hardcoded overrides. If a model's `context_window` is not explicitly set in `model_capabilities`, it defaults to `1000000`.

## Configuration Schema

In `gateway.config.json`, context windows are stored per-model inside the Endpoint's `model_capabilities` object alongside existing model capability flags (such as `image`):

```json
{
  "name": "huoshan-codingplan",
  "type": "openai-responses",
  "models": [
    "glm-5.2",
    "minimax-m3",
    "grok-4.5"
  ],
  "model_capabilities": {
    "glm-5.2": {
      "context_window": 1000000,
      "image": false
    },
    "grok-4.5": {
      "context_window": 500000
    }
  }
}
```

Validation rules:
- `context_window`, when present, must be a positive integer > 0.
- Invalid or non-numeric values are rejected during config validation (`validateGatewayConfig`).

## Client Distribution

### 1. Codex (`gateway-model-catalog.json` & `/codex/v1/models`)

- `lib/codex/model-catalog.mjs` populates `context_window` and `max_context_window` for custom models using the resolved value (`capabilities?.context_window || 1000000`).
- When writing `~/.codex/gateway-model-catalog.json` or serving `/codex/v1/models`, Codex receives the accurate model context limit, ensuring its context compaction and summarization thresholds are calculated accurately.

### 2. OpenAI / Claude Discovery (`/v1/models`)

- `server.js` (`modelDiscovery()`) includes `context_window` on each model object returned in the `/v1/models` endpoint payload.

## Web UI Configuration Panel (`desktop/config-panel.html`)

The Web UI config panel provides a Context Window selector for each model under an Endpoint:

- **Preset Dropdown Options**:
  - `1M (1,000,000 Tokens)` (Default)
  - `500K (500,000 Tokens)`
  - `256K (256,000 Tokens)`
  - `128K (128,000 Tokens)`
  - `64K (64,000 Tokens)`
  - `Custom` (reveals a numeric input field for custom Token count)

## Verification Plan

1. **Unit Tests**:
   - `tests/unit/codex-model-catalog.test.mjs`: Verify custom models adopt configured `context_window` or fallback to 1M default.
   - `tests/unit/gateway-config-store.test.mjs`: Verify config validation accepts valid positive integer `context_window` values and rejects invalid entries.
   - `tests/unit/config-panel.test.mjs`: Verify config panel rendering and saving of `context_window`.
2. **Integration Tests**:
   - `tests/integration/codex-catalog-write.test.mjs`: Verify `writeCodexModelCatalog` correctly writes configured `context_window` values into `gateway-model-catalog.json`.
   - `tests/integration/basic-routes.test.mjs`: Verify `/v1/models` and `/codex/v1/models` endpoints emit `context_window`.

## Root Cause & Field Semantics (Verified 2026-07-29)

### The Bug

Today, `buildCustomModel` in `lib/codex/model-catalog.mjs` derives every third-party model's context fields from `reference` (the first official Codex model), so all custom models inherit the official Codex product quota: `context_window = 272000`, `max_context_window = 272000`, `effective_context_window_percent = 95`. The real third-party models, however, ship with 500K-1M windows (see Verified Model Specs below). Because Codex computes its compaction threshold from these inherited values (`full_context_window_limit`, `auto_compact_scope_tokens`), it believes the window is only ~258K and triggers premature compaction at roughly a quarter of the model's actual capacity. The gateway itself never computes compaction thresholds; it only forwards these fields to Codex via `gateway-model-catalog.json` and `/codex/v1/models`, so the fix is to forward the correct per-model values.

### Field Semantics (Codex CLI, verified from bundled binary 0.142.5)

Codex's `ModelInfo` struct carries three related fields. They are not interchangeable:

- `context_window` - the working window Codex actually activates. For official models this is OpenAI's Codex product quota, NOT the model's physical limit. Official `gpt-5.5` ships `context_window = 272000` even though its physical limit is 1M.
- `max_context_window` - the model's physical context limit. Official `gpt-5.5` ships `max_context_window = 1000000`; official `gpt-5.4` ships `context_window = 272000` but `max_context_window = 1000000`.
- `effective_context_window_percent` - the percentage of the window treated as usable before compaction (official models use `95`).
- `auto_compact_token_limit` - optional independent compaction trigger threshold (new field; `null` means derive from the window fields above).

Because the compaction threshold is derived from these fields (roughly `min(context_window, max_context_window) * effective_context_window_percent / 100`), configuring only `context_window` while leaving `max_context_window` at the inherited `272000` leaves the effective threshold unchanged. The three fields must be coordinated.

## Verified Model Specs

Real context windows for the third-party models currently in `gateway.config.json`, confirmed against vendor sources:

| Model | Physical context | Source |
|-------|------------------|--------|
| `glm-5.2` | 1,000,000 (1M) | Z.AI docs: "Context Length 1M", truly usable 1M-token context |
| `grok-4.5` | 500,000 (500K) | x.ai API spec: `maxPromptLength: 500000` |
| `minimax-m3` | 1,000,000 (1M), 512K guaranteed usable | MiniMax: MSA architecture, API supports up to 1M tokens |
| `deepseek-v4-pro` | 1,000,000 (1M) | DeepSeek: "million-token context" |

This grounds the 1M default: three of four target models are genuinely 1M, and the fourth (grok-4.5) is 500K. A 1M default is the correct fallback; per-model overrides handle the 500K case.

## Field Coordination

When a model's `context_window` is resolved (from `model_capabilities` or the 1M default), the two companion fields are set so the effective compaction threshold actually reflects the configured window:

- `max_context_window` is set to the resolved `context_window` (the third-party model's configured window IS its physical limit, unlike official Codex models where OpenAI caps the working window below the physical limit).
- `effective_context_window_percent` retains the inherited `95` (no reason to change it for third-party models).
- `auto_compact_token_limit` stays `null` (derive from the window, do not override).

Concretely in `buildCustomModel`, the current reference-inheriting lines:

```js
model.context_window ??= reference.context_window ?? 272000;
model.max_context_window ??= reference.max_context_window ?? 272000;
model.effective_context_window_percent ??= reference.effective_context_window_percent ?? 95;
```

become a per-model resolution that reads `endpoint.model_capabilities?.[id]?.context_window` first, falls back to `1000000`, and sets `max_context_window` to the same resolved value. The `?? 272000` fallbacks are removed entirely so the official quota can never leak into a third-party model.

## Configuration Decisions (Finalized 2026-07-29)

- **Default value**: 1,000,000 (1M). No built-in model spec table, no online lookup. Models without an explicit `context_window` resolve to 1M.
- **Override is manual only**: the Web UI offers preset options (1M default / 500K / 256K / 128K / 64K / Custom). Selecting 1M clears the field (no config stored); selecting any other value writes it. No auto-fill from external sources.
- **Configuration granularity**: per-client, per-endpoint, per-model - identical to the existing `image` capability flag in `model_capabilities`. The same model name (e.g. `glm-5.2`) configured under different clients or different endpoints requires independent configuration. No cross-client sync.
- **UI default state**: the dropdown's 1M option is labeled "1M (default)" so users can tell that selecting it equals "no explicit config". A modified value can be reset back to 1M to clear the stored field, mirroring the existing `updateModelImageCapability` toggle- to-reset pattern.

## Multi-Client Architecture (Verified 2026-07-29)

The three clients consume context window information through entirely different mechanisms. The gateway's control over each ranges from full to none. All three read from the same single config source (`endpoint.model_capabilities[model].context_window`), but the distribution path differs per client.

### Client 1: Codex (full control)

- **Config file written by gateway**: `~/.codex/gateway-model-catalog.json` via `writeCodexModelCatalog()`.
- **Fields consumed**: `context_window`, `max_context_window`, `effective_context_window_percent`. Codex computes its compaction threshold from these (roughly `min(context_window, max_context_window) * effective_context_window_percent / 100`).
- **Current bug**: `buildCustomModel` in `lib/codex/model-catalog.mjs:85-87` inherits all three from the official model reference (272000), ignoring the model's real capacity.
- **Fix**: Resolve `context_window` from `endpoint.model_capabilities?.[id]?.context_window`, fallback 1000000. Set `max_context_window` to the same resolved value. Remove `?? 272000` fallbacks. See Field Coordination above.

### Client 2: Claude Desktop (indirect control)

- **Config file written by gateway**: `~/Library/Application Support/Claude-3p/configLibrary/*.json` via `syncClaudeThirdPartyInferenceConfig()` (`server.js:7185`).
- **Fields consumed**: Each entry in `inferenceModels` carries `supports1m` (boolean) and `prefer1m` (boolean). Desktop reads these to decide whether to enable 1M context for that model.
- **Current behavior**: `buildClaudeInferenceModels` (`lib/config/gateway-config-store.mjs:133`) preserves existing `supports1m`/`prefer1m` via `...previousByName` spread, but never generates them from config. Values only persist if manually set or previously written by Desktop.
- **Fix**: When building inference models, set `supports1m: true` if the resolved `context_window` for that model (from `model_capabilities` or 1M default) is >= 1000000. This lets the gateway propagate the configured context window to Desktop automatically.

### Client 3: Claude Code (no direct control)

- **Config file written by gateway**: `~/.claude/settings.json` via `syncClaudeCodeSettings()` (`lib/config/claude-code-settings.mjs:17`). Injects `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL=anthropic.gateway.{endpoint}.{model}`.
- **Context window source**: Claude Code's built-in model registry, compiled into the binary. Each Claude model family has a hardcoded `context:{window:200000, supports_1m_suffix:true}` definition. `getAntRegistryContextWindow` is an empty function (returns undefined); the registry is the authority.
- **How third-party models get a window**: gateway's `model_mapping` maps third-party models to Claude family names (e.g. `glm-5.2` -> `claude-opus-4-8`). Claude Code sees `claude-opus-4-8` and uses that family's built-in window (200K, with `[1m]` suffix support to reach 1M).
- **No gateway fix possible**: The binary registry cannot be changed via config file. The only lever is `model_mapping` - mapping a third-party model to a Claude family that has the desired window. This is an architectural constraint, not a gap in this design.

### Distribution Summary

| Client | Config file | Gateway function | Context window field | Control level |
|--------|------------|------------------|---------------------|---------------|
| Codex | `gateway-model-catalog.json` | `writeCodexModelCatalog` | `context_window` / `max_context_window` / `effective_context_window_percent` | Full |
| Claude Desktop | `Claude-3p/configLibrary/*.json` | `syncClaudeThirdPartyInferenceConfig` | `supports1m` / `prefer1m` (derived from `context_window`) | Indirect |
| Claude Code | `~/.claude/settings.json` | `syncClaudeCodeSettings` | (binary registry, not configurable) | None (mapping only) |

### Implementation Scope Update

The original Client Distribution section described only the Codex path. The full implementation now covers:

1. **Codex** (`lib/codex/model-catalog.mjs`): per-model `context_window` resolution in `buildCustomModel`, as specified above.
2. **Claude Desktop** (`lib/config/gateway-config-store.mjs`): `buildClaudeInferenceModels` derives `supports1m` from the resolved `context_window` (>= 1M => `supports1m: true`). `syncClaudeThirdPartyInferenceConfig` already calls this function and writes the result.
3. **Claude Code**: no code change. Relies on existing `model_mapping` to map third-party models to Claude families with appropriate built-in windows.
4. **`/v1/models`** (`server.js` `modelDiscovery()`): NOT modified. Claude Code validates this response with a strict schema; adding fields risks `[Bootstrap] Gateway /v1/models failed validation`. Since neither Claude Code nor Desktop reads `context_window` from this endpoint, there is no benefit to modifying it.
