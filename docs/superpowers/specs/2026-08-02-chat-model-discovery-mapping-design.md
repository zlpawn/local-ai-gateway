# Chat Model Discovery & Mapping UX Design

**Date:** 2026-08-02
**Branch:** `codex/node-config-and-mini-tool-ui`
**Status:** Draft for implementation planning
**Scope:** Chat model endpoints only this phase

## 1. Goal

Reduce configuration friction for chat model endpoints by:

1. Discovering upstream model lists automatically.
2. Using discovered models as selectable suggestions.
3. Making model mapping easier, especially for Claude Desktop.
4. Providing a lightweight mini-tool to maintain Claude official model aliases.

This phase intentionally does **not** implement media/embedding/search endpoint discovery.

## 2. Confirmed Requirements

### 2.1 In scope
- Chat model endpoints only.
- Upstream model list input remains free-form.
- Discovered models appear as suggestions the user can optionally add.
- Mapping target suggestions come from discovered upstream models.
- Claude Desktop mapping source suggestions come from Claude official model list.
- Codex and other non-desktop clients only need mapping-target suggestions.
- Claude Code automatic mapping remains gateway-managed; no major UX rewrite this phase.
- Discovery on open + manual refresh.
- Subscription discovery must cover:
  - `codex-subscription`
  - `antigravity`
  - `grok` / `grok-subscription` (match existing endpoint type/provider naming)
- Architecture must follow open/closed principle and be easy to extend.
- UI must be polished and modern.
- Work must be staged with durable task status for handoff across models/sessions.

### 2.2 Out of scope this phase
- Image / video / TTS / embedding / web-search endpoints.
- Auto-overwriting user model lists.
- Online scraping of Anthropic marketing pages as a runtime dependency.
- Full Claude model catalog CMS (sorting, import/export, grouping beyond lightweight edit).

## 3. Product Behavior

### 3.1 Upstream model list
For a chat endpoint detail panel:

- User can still type a model id and press Enter to add.
- A suggestion popover/dropdown shows discovered models.
- Selecting a suggestion adds it to `endpoint.models` if not already present.
- Suggestions never auto-replace existing values.

### 3.2 Model mapping
Mapping remains `requested_model -> upstream_model`.

| Client | Left (requested / source) | Right (mapped / target) |
|---|---|---|
| `desktop` (Claude Desktop) | Claude official model candidates | Discovered upstream models |
| `codex` | Free text (current behavior) | Discovered upstream models |
| other custom clients | Free text (same as codex) | Discovered upstream models |
| `code` (Claude Code) | No major redesign; keep current gateway-managed mapping flow | Optional reuse of upstream suggestions only if already cheap |

### 3.3 Claude official model list mini-tool
Add a lightweight mini-tool card:

- Name: `Claude 模型列表` / `Claude Model Catalog`
- Shows built-in defaults.
- Allows user-defined extra model ids.
- Allows removing user-defined entries.
- Built-in entries are visible and not permanently deleted by user action; user may hide them later only if we keep a simple disabled list, but v1 can keep built-ins always present.
- Final candidate list for Desktop mapping source = built-in ∪ user-defined, de-duplicated.

## 4. Architecture

### 4.1 Chosen approach
**Gateway-owned model discovery service + frontend suggestion UX.**

Frontend never talks directly to upstream providers with secrets.

```text
Config Panel (chat endpoint detail)
  -> GET /v1/config/endpoints/:endpointId/models?client=...&refresh=0|1
  -> ModelDiscoveryService
       -> Strategy registry
            -> OpenAICompatibleModelsStrategy
            -> CodexSubscriptionModelsStrategy
            -> AntigravityModelsStrategy
            -> GrokSubscriptionModelsStrategy
       -> normalize + cache + error mapping
  -> suggestions for models / mapping target

Claude Model Catalog mini-tool
  -> read/write gateway config section
  -> feeds Claude Desktop mapping source suggestions
```

### 4.2 Extensibility (Open/Closed)
All provider-specific discovery must live behind a strategy interface.

```js
// conceptual interface
{
  id: string,
  supports(endpoint): boolean,
  discover(endpoint, context): Promise<DiscoveredModel[]>
}
```

Rules:
- Adding a provider = add a strategy file + register it.
- Do not add provider branches to route handlers or UI render code.
- Shared concerns (auth header construction, caching, response normalization, timeout) stay in the service core.
- Strategies only encode provider-specific transport and parsing.

### 4.3 Discovery routing
1. If a subscription/special strategy supports the endpoint, use it.
2. Else if endpoint has `base_url`, use OpenAI-compatible `/v1/models`.
3. Else return a structured error: missing discovery source.

Supported special strategies this phase:
- `codex-subscription`
- `antigravity`
- `grok` / `grok-subscription`

### 4.4 API contract
`GET /v1/config/endpoints/:endpointId/models`

Query:
- `client` required or inferred from config ownership
- `refresh=1` forces bypass cache

Response:

```json
{
  "endpoint_id": "ep_xxx",
  "client": "desktop",
  "source": "base_url" | "subscription" | "cache",
  "strategy": "openai-compatible" | "codex-subscription" | "antigravity" | "grok-subscription",
  "models": [
    { "id": "glm-5.2", "name": "glm-5.2" }
  ],
  "fetched_at": "2026-08-02T01:00:00.000Z",
  "error": null
}
```

Error cases remain HTTP 200 with `error` payload when partial UX is preferred, or 4xx for invalid endpoint/not chat. Prefer:
- 404 unknown endpoint
- 400 non-chat endpoint
- 200 + `error` for upstream discovery failure so UI can keep manual entry usable

### 4.5 Caching
- Default open uses short TTL cache per endpoint id.
- Manual refresh bypasses cache.
- On refresh failure, return last good cache if present plus error message.

## 5. UI Design Direction

### 5.1 Constraints
Current config panel is a large single HTML/CSS/JS surface (`desktop/config-panel.html`), not a React/shadcn app.

Therefore this phase should:
- Keep implementation inside the existing panel architecture.
- Deliver polished custom components matching current design tokens.
- Reuse the newly introduced custom select/popover language where appropriate.
- Optionally extract small pure helper modules for discovery client logic if tests benefit.

Using local shadcn / Magic UI is allowed for **visual reference and interaction patterns**, but do **not** force a full React rewrite of the config panel in this phase.

### 5.2 Visual quality bar
Must feel elegant, dense but calm, and consistent with existing mini-tool / add-node popovers:

- Soft elevated popovers
- Clear selected states
- Readable long model ids (ellipsis + full title tooltip)
- Inline refresh action with loading/error/empty states
- Keyboard friendly Enter-to-add still works
- No ugly native selects for the new suggestion surfaces

### 5.3 Chat endpoint interactions
In chat endpoint detail:

1. Upstream models field:
   - tag list of current models
   - input with suggestion popover from discovery
   - refresh button near label/help text

2. Mapping row:
   - source input
   - arrow
   - target input
   - both support suggestions where required by client policy

3. Discovery states:
   - loading skeleton/spinner
   - empty: “暂无上游模型，可手动输入”
   - error: short message + retry

### 5.4 Claude model catalog mini-tool
Lightweight tool page:

- Built-in list (read-only badges)
- User list (editable)
- Add input
- Remove user entry
- Short explanation: used by Claude Desktop mapping source suggestions

## 6. Data Model

### 6.1 Existing fields (unchanged semantics)
- `endpoint.models: string[]`
- `endpoint.model_mapping: Record<string, string>`

### 6.2 New config section
Suggested:

```json
{
  "tools": {
    "claude_model_catalog": {
      "user_models": ["claude-custom-alias"],
      "disabled_builtin_models": []
    }
  }
}
```

If existing config root conventions prefer another namespace, follow current gateway config style, but keep a single dedicated section.

Built-in defaults live in code, e.g. `lib/config/claude-official-models.mjs`.

Initial built-in seed should include currently known ids already used in this repo/templates, such as:
- `claude-opus-4-8`
- `claude-opus-4-7`
- `claude-sonnet-4-5`
- `claude-haiku-4-0`
- `claude-haiku-4-5-20251001`
- shorter aliases already present in templates (`claude-opus`, `claude-sonnet`, `claude-haiku`, `claude-fable`) if still relevant to Desktop/gateway validation

Exact final seed list should be centralized and unit-tested.

## 7. Frontend Integration Points

Files likely involved:
- `desktop/config-panel.html`
- tests under `tests/unit/config-panel.test.mjs`
- gateway route wiring in `server.js`
- new modules under `lib/models/` or `lib/config/`

UI responsibilities only:
- request discovery
- render suggestions
- add selected values into existing config fields
- read/write Claude catalog section

No provider secret handling in the browser.

## 8. Backend Integration Points

### 8.1 New modules
Suggested layout:

```text
lib/models/
  discovery-service.mjs
  normalize.mjs
  cache.mjs
  strategies/
    openai-compatible.mjs
    codex-subscription.mjs
    antigravity.mjs
    grok-subscription.mjs
    index.mjs
lib/config/
  claude-official-models.mjs
```

### 8.2 Server route
Register under config/authenticated local admin surface, same trust model as other config panel APIs.

### 8.3 Strategy notes
- OpenAI-compatible: `GET {base_url}/v1/models` with endpoint auth.
- Codex subscription: reuse existing official/local catalog sources already used by gateway.
- Antigravity: reuse existing subscription auth/session capabilities.
- Grok: reuse existing grok subscription/base assumptions; no user-configured base_url required for subscription mode.

## 9. Error Handling & Edge Cases

- Non-chat endpoint discovery: reject cleanly.
- Missing API key on base_url endpoint: return actionable error.
- Upstream 401/403/404/timeout: surface concise Chinese UI message.
- Malformed upstream payload: treat as empty + error.
- Duplicate model add: no-op.
- Mapping create with empty either side: ignore/reject with toast.
- Claude Desktop source suggestion missing user-entered value: still allow free typing.
- Refresh during in-flight request: latest request wins.

## 10. Testing Strategy

### Backend
- strategy selection tests
- openai-compatible parser tests
- each subscription strategy smoke test with fixtures
- cache hit/refresh bypass tests
- non-chat rejection tests

### Frontend / panel
- discovery suggestion markup/wiring present for chat endpoints
- Claude Desktop source uses catalog helper
- codex/other clients do not require Claude source catalog
- mini-tool card/detail exists and persists user models
- no auto-overwrite of existing endpoint.models

### Manual verification
- open chat endpoint on 8788
- verify auto load suggestions
- refresh
- add upstream model from suggestion
- create mapping using suggestions
- maintain Claude catalog and see Desktop source update

## 11. Phased Delivery

### Phase 0 — Spec & task board
- freeze requirements
- write durable status board

### Phase 1 — Discovery core
- strategy interface + registry
- openai-compatible strategy
- service + route + unit tests

### Phase 2 — Subscription strategies
- codex / antigravity / grok strategies
- fixtures + tests

### Phase 3 — Chat endpoint suggestion UX
- upstream model suggestions
- mapping target suggestions
- refresh/loading/error UI polish

### Phase 4 — Claude catalog mini-tool
- built-in list module
- mini-tool UI
- Desktop mapping source integration

### Phase 5 — Hardening & handoff
- regression tests
- docs polish
- commit checkpoints

## 12. Success Criteria

- User can configure a third-party chat endpoint with much less manual model typing.
- Claude Desktop mapping no longer requires remembering official Claude model ids from scratch.
- Codex/other clients get upstream target suggestions.
- Adding a new provider discovery source requires a new strategy file, not scattered edits.
- UI looks intentional and premium, not like raw browser selects.
- Another model/session can resume from the status board without rediscovering intent.

## 13. Non-goals / Guardrails

- Do not rewrite the entire config panel into React this phase.
- Do not silently mutate `endpoint.models` from discovery.
- Do not hardcode provider branches into `server.js` request handlers beyond route registration.
- Do not expand into non-chat endpoint types in the same implementation slice.

## 14. Open Implementation Details (resolved during planning, not product-ambiguous)

These are engineering choices left to the implementation plan, not unresolved product questions:

- exact cache TTL
- exact route auth middleware reuse
- whether suggestions use datalist, custom popover, or hybrid
- whether Claude built-ins can be hidden in v1 or only user entries are removable

Product requirements above are otherwise frozen for planning.
