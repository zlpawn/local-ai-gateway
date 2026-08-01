# Chat Model Discovery & Mapping — Execution Status

**Branch:** `codex/node-config-and-mini-tool-ui`
**Spec:** `docs/superpowers/specs/2026-08-02-chat-model-discovery-mapping-design.md`
**Last updated:** 2026-08-02
**Current owner:** planning

## How to use this board
- Update task status only on this branch.
- Keep statuses in: `pending | in_progress | blocked | done`
- When switching models/sessions, read this file first, then the spec.
- Do not start coding a later phase before earlier phase acceptance notes are filled.

## Phase status

| Phase | Name | Status | Notes |
|---|---|---|---|
| 0 | Spec & task board | in_progress | design captured; waiting user review |
| 1 | Discovery core | pending | strategy interface + openai-compatible + route |
| 2 | Subscription strategies | pending | codex / antigravity / grok |
| 3 | Chat endpoint suggestion UX | pending | elegant UI required |
| 4 | Claude catalog mini-tool | pending | lightweight built-in + user list |
| 5 | Hardening & handoff | pending | tests/docs/final polish |

## Task checklist

### Phase 0 — Spec & task board
- [x] Align product requirements with user
- [x] Choose architecture approach B (gateway discovery service)
- [x] Write design spec
- [ ] User reviews/approves spec
- [ ] Write implementation plan from approved spec

### Phase 1 — Discovery core
- [ ] Create strategy interface + registry
- [ ] Implement response normalizer
- [ ] Implement short-lived cache
- [ ] Implement OpenAI-compatible `/v1/models` strategy
- [ ] Add gateway route `GET /v1/config/endpoints/:endpointId/models`
- [ ] Unit tests for selection/normalize/cache/route basics
- [ ] Commit checkpoint

### Phase 2 — Subscription strategies
- [ ] Codex subscription strategy
- [ ] Antigravity strategy
- [ ] Grok subscription strategy
- [ ] Fixture-based tests for each strategy
- [ ] Ensure registry remains open for extension
- [ ] Commit checkpoint

### Phase 3 — Chat endpoint suggestion UX
- [ ] Auto-fetch on chat endpoint open
- [ ] Manual refresh action
- [ ] Upstream model suggestion UI (no auto-overwrite)
- [ ] Mapping target suggestion UI
- [ ] Client policy:
  - Desktop source = Claude catalog
  - Codex/others source free text
- [ ] Loading / empty / error polish
- [ ] Panel unit tests
- [ ] Commit checkpoint

### Phase 4 — Claude catalog mini-tool
- [ ] Built-in official model module
- [ ] Config section for user models
- [ ] Mini-tool card + detail UI
- [ ] Wire Desktop mapping source suggestions
- [ ] Tests for merge/de-dupe behavior
- [ ] Commit checkpoint

### Phase 5 — Hardening & handoff
- [ ] End-to-end manual verification on port 8788
- [ ] Regression around existing mapping/save flows
- [ ] Final docs pass
- [ ] Ready-for-review summary

## Acceptance notes
_Fill these as phases complete._

### Phase 0
- Pending user review of design doc.

### Phase 1
- 

### Phase 2
- 

### Phase 3
- 

### Phase 4
- 

### Phase 5
- 

## Risks / watchlist
- Config panel is monolithic HTML; UI polish must reuse local design system rather than forcing React rewrite.
- Subscription discovery sources may differ in payload shape; keep normalization strict and tested.
- Avoid accidental commits of local secrets/config while implementing.
- Keep main branch untouched; all work stays on `codex/node-config-and-mini-tool-ui`.

## Handoff snippet for next model
1. Read this status file.
2. Read the design spec linked above.
3. Continue the first `pending` / `in_progress` phase only.
4. Update this board after every completed task group.
5. Prefer small commits per phase checkpoint.
