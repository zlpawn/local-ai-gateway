# Chat Model Discovery & Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let chat endpoints discover upstream models and offer elegant suggestions for upstream model lists and mapping targets, plus a lightweight Claude official model catalog for Desktop mapping sources.

**Architecture:** Gateway-owned `ModelDiscoveryService` with open/closed strategy plugins discovers models for chat endpoints. Config panel consumes one discovery API for suggestions and never auto-overwrites user lists. Claude Desktop mapping sources come from built-in + user-maintained Claude catalog.

**Tech Stack:** Node.js ESM gateway, existing `desktop/config-panel.html` single-page UI, node:test, local config panel APIs.

## Global Constraints
- Branch only: `codex/node-config-and-mini-tool-ui` (never modify `main`).
- Scope only chat model endpoints this phase.
- Suggestions are optional; never auto-replace `endpoint.models`.
- Subscription discovery must cover `codex-subscription`, `antigravity`, `grok`/`grok-subscription`.
- Provider-specific discovery belongs in strategy modules, not route/UI condition forests.
- UI must be polished inside existing HTML panel; no React rewrite.
- Do not commit secrets (`gateway.secrets.json`, `antigravity.secrets.json`) or local-only config unless explicitly requested.

---

## File Map

### Create
- `lib/models/discovery-service.mjs` — orchestrates strategy selection, cache, normalize, response shaping
- `lib/models/normalize.mjs` — normalize arbitrary upstream payloads to `{id,name}[]`
- `lib/models/cache.mjs` — short TTL cache by endpoint id
- `lib/models/strategies/openai-compatible.mjs`
- `lib/models/strategies/codex-subscription.mjs`
- `lib/models/strategies/antigravity.mjs`
- `lib/models/strategies/grok-subscription.mjs`
- `lib/models/strategies/index.mjs` — registry
- `lib/config/claude-official-models.mjs` — built-in Claude ids + merge helpers
- `tests/unit/model-discovery-*.test.mjs` and related panel/catalog tests

### Modify
- `server.js` — register discovery route; reuse existing secret/config loading helpers
- `lib/config/gateway-config-store.mjs` — persist `tools.claude_model_catalog` safely if needed
- `desktop/config-panel.html` — chat endpoint suggestion UX + mini-tool
- `tests/unit/config-panel.test.mjs` — UI wiring assertions
- `docs/superpowers/plans/2026-08-02-chat-model-discovery-mapping-status.md` — phase status updates

---

### Task 1: Discovery core (normalize/cache/service/openai strategy/route)

**Files:**
- Create: `lib/models/normalize.mjs`
- Create: `lib/models/cache.mjs`
- Create: `lib/models/discovery-service.mjs`
- Create: `lib/models/strategies/openai-compatible.mjs`
- Create: `lib/models/strategies/index.mjs`
- Create: `tests/unit/model-discovery-core.test.mjs`
- Modify: `server.js`
- Modify: status board

**Interfaces:**
- Produces:
  - `normalizeDiscoveredModels(input) -> Array<{id:string,name:string}>`
  - `createModelDiscoveryCache({ ttlMs=60000 })`
  - `createModelDiscoveryService({ strategies, cache, fetchImpl, now })`
  - `service.discoverEndpointModels({ client, endpoint, refresh=false, context })`
  - route `GET /v1/config/endpoints/:endpointId/models?client=&refresh=`

- [ ] **Step 1: Write failing unit tests for normalize + strategy selection + openai-compatible parse**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDiscoveredModels } from "../../lib/models/normalize.mjs";
import { createModelDiscoveryService } from "../../lib/models/discovery-service.mjs";
import { openaiCompatibleStrategy } from "../../lib/models/strategies/openai-compatible.mjs";

test("normalizeDiscoveredModels accepts OpenAI list payload", () => {
  const models = normalizeDiscoveredModels({ data: [{ id: "glm-5.2" }, { id: "minimax-m3", name: "MiniMax" }] });
  assert.deepEqual(models, [
    { id: "glm-5.2", name: "glm-5.2" },
    { id: "minimax-m3", name: "MiniMax" },
  ]);
});

test("service rejects capability endpoints", async () => {
  const service = createModelDiscoveryService({ strategies: [openaiCompatibleStrategy] });
  await assert.rejects(
    () => service.discoverEndpointModels({
      client: "codex",
      endpoint: { id: "ep1", purpose: "image_generation", base_url: "https://x" },
    }),
    /chat/i,
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/model-discovery-core.test.mjs`
Expected: FAIL module not found / export missing

- [ ] **Step 3: Implement normalize/cache/openai strategy/service/registry**

Key behavior:
- chat endpoint means `!isCapabilityEndpoint(endpoint)`
- openai strategy supports endpoints with non-empty `base_url` and not handled by special strategies
- fetch `{baseUrl}/v1/models` with endpoint auth headers
- cache key = `${client}:${endpoint.id}`
- refresh bypasses cache; on failure return last good cache + error when available

- [ ] **Step 4: Wire route in server.js**

```js
// conceptual
if (reqPath.match(/^\/v1\/config\/endpoints\/[^/]+\/models$/) && req.method === "GET") {
  // resolve client+endpoint from live config
  // call discovery service
  // return JSON contract from spec
}
```

- [ ] **Step 5: Re-run unit tests and a focused route smoke if available**

Run: `node --test tests/unit/model-discovery-core.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit checkpoint**

```bash
git add lib/models tests/unit/model-discovery-core.test.mjs server.js docs/superpowers/plans/2026-08-02-chat-model-discovery-mapping-status.md
git commit -m "feat(models): add chat endpoint model discovery core"
```

---

### Task 2: Subscription strategies (codex/antigravity/grok)

**Files:**
- Create: `lib/models/strategies/codex-subscription.mjs`
- Create: `lib/models/strategies/antigravity.mjs`
- Create: `lib/models/strategies/grok-subscription.mjs`
- Modify: `lib/models/strategies/index.mjs`
- Create: `tests/unit/model-discovery-subscriptions.test.mjs`
- Modify: status board

**Interfaces:**
- Consumes: discovery service registry
- Produces: strategies with `supports(endpoint)` + `discover(endpoint, context)`

- [ ] **Step 1: Write failing tests for strategy supports() matrix**

```js
test("subscription strategies win over base_url strategy", () => {
  assert.equal(codexSubscriptionStrategy.supports({ type: "codex-subscription" }), true);
  assert.equal(antigravityStrategy.supports({ type: "antigravity" }), true);
  assert.equal(grokSubscriptionStrategy.supports({ type: "grok" }), true);
  assert.equal(grokSubscriptionStrategy.supports({ type: "grok-subscription" }), true);
});
```

- [ ] **Step 2: Run tests to verify fail/pass gaps**

Run: `node --test tests/unit/model-discovery-subscriptions.test.mjs`

- [ ] **Step 3: Implement strategies using existing local sources where possible**
- codex: reuse official model helpers / models_cache patterns already in gateway
- antigravity: reuse subscription auth capabilities / known model listing path if present; otherwise structured error with actionable message
- grok: reuse local grok models cache / provider assumptions; no user base_url required

- [ ] **Step 4: Ensure registry order is special strategies first, openai-compatible fallback last**

- [ ] **Step 5: Tests pass + commit**

```bash
git add lib/models/strategies tests/unit/model-discovery-subscriptions.test.mjs docs/superpowers/plans/2026-08-02-chat-model-discovery-mapping-status.md
git commit -m "feat(models): add subscription model discovery strategies"
```

---

### Task 3: Chat endpoint suggestion UX

**Files:**
- Modify: `desktop/config-panel.html`
- Modify: `tests/unit/config-panel.test.mjs`
- Modify: status board

**Interfaces:**
- Consumes: `GET /v1/config/endpoints/:id/models`
- Produces: suggestion popovers for upstream models + mapping target; Desktop source uses Claude catalog helper

- [ ] **Step 1: Add failing panel tests for discovery wiring markers**

Assert presence of:
- discovery refresh control
- suggestion helpers
- no auto-assign into `endpoint.models` from discovery payload

- [ ] **Step 2: Implement polished suggestion UI in chat endpoint detail only**
- auto-fetch when opening chat endpoint detail
- refresh button
- loading/empty/error states
- selecting suggestion adds model/mapping value optionally
- mapping source policy by client

- [ ] **Step 3: Keep Enter-to-add manual path intact**

- [ ] **Step 4: Run panel tests**

Run: `node --test tests/unit/config-panel.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add desktop/config-panel.html tests/unit/config-panel.test.mjs docs/superpowers/plans/2026-08-02-chat-model-discovery-mapping-status.md
git commit -m "feat(ui): add chat model discovery suggestions"
```

---

### Task 4: Claude official model catalog mini-tool

**Files:**
- Create: `lib/config/claude-official-models.mjs`
- Modify: `lib/config/gateway-config-store.mjs` (if persistence normalization needed)
- Modify: `desktop/config-panel.html`
- Modify: `tests/unit/config-panel.test.mjs`
- Create: `tests/unit/claude-official-models.test.mjs`
- Modify: status board

**Interfaces:**
- Produces:
  - `BUILTIN_CLAUDE_OFFICIAL_MODELS: string[]`
  - `mergeClaudeOfficialModels({ userModels, disabledBuiltinModels }) -> string[]`

- [ ] **Step 1: Write tests for built-in merge/de-dupe**

```js
test("mergeClaudeOfficialModels unions builtin and user models", () => {
  const models = mergeClaudeOfficialModels({ userModels: ["claude-opus-4-8", "my-claude"] });
  assert.ok(models.includes("claude-opus-4-8"));
  assert.ok(models.includes("my-claude"));
});
```

- [ ] **Step 2: Implement module + mini-tool UI**
- card under mini-tools
- detail shows builtin badges + user editable list
- save via existing config save flow under `tools.claude_model_catalog`

- [ ] **Step 3: Wire Desktop mapping source suggestions to merged catalog**

- [ ] **Step 4: Tests pass + commit**

```bash
git add lib/config/claude-official-models.mjs lib/config/gateway-config-store.mjs desktop/config-panel.html tests/unit/config-panel.test.mjs tests/unit/claude-official-models.test.mjs docs/superpowers/plans/2026-08-02-chat-model-discovery-mapping-status.md
git commit -m "feat(tools): add Claude official model catalog mini-tool"
```

---

### Task 5: Hardening, verification, handoff

**Files:**
- Modify: status board
- Possibly small bugfix files only

- [ ] **Step 1: Run focused unit suites**

```bash
node --test tests/unit/model-discovery-core.test.mjs tests/unit/model-discovery-subscriptions.test.mjs tests/unit/claude-official-models.test.mjs tests/unit/config-panel.test.mjs
```

- [ ] **Step 2: Manual verify on 8788**
- open chat endpoint
- auto suggestions load
- refresh works
- add upstream model from suggestion
- mapping target suggestion works
- Desktop source shows Claude catalog
- mini-tool add/remove user model persists

- [ ] **Step 3: Update status board acceptance notes and final summary**

- [ ] **Step 4: Final commit if needed**

```bash
git add docs/superpowers/plans/2026-08-02-chat-model-discovery-mapping-status.md
git commit -m "docs: mark chat model discovery phases complete"
```

---

## Spec Coverage Check
- Discovery API + strategies: Tasks 1-2
- Chat suggestion UX: Task 3
- Claude catalog mini-tool: Task 4
- Extensibility/open-closed: Task 1 registry + Task 2 strategy files
- No auto-overwrite: Task 3 tests/behavior
- Staged status board: all tasks update status file
- UI polish without React rewrite: Task 3/4 constraints

## Execution note
User authorized immediate implementation after plan creation and will inspect results later. Proceed inline on this branch with frequent status updates and phase commits.
