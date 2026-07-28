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
