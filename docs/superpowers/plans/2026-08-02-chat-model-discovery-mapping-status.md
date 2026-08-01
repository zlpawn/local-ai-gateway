# Chat Model Discovery & Mapping — Execution Status

**Branch:** `codex/node-config-and-mini-tool-ui`
**Spec:** `docs/superpowers/specs/2026-08-02-chat-model-discovery-mapping-design.md`
**Last updated:** 2026-08-02
**Current owner:** implementation

## How to use this board
- Update task status only on this branch.
- Keep statuses in: `pending | in_progress | blocked | done`
- When switching models/sessions, read this file first, then the spec.
- Do not start coding a later phase before earlier phase acceptance notes are filled.

## Phase status

| Phase | Name | Status | Notes |
|---|---|---|---|
| 0 | Spec & task board | done | plan approved by user go-ahead |
| 1 | Discovery core | done | service/route/tests landed |
| 2 | Subscription strategies | done | strategies registered and tested |
| 3 | Chat endpoint suggestion UX | done | auto-fetch + suggestions verified via API/UI markers |
| 4 | Claude catalog mini-tool | done | mini-tool wired; tools config persistence enabled |
| 5 | Hardening & handoff | done | unit tests pass; 8788 discovery smoke verified |

## Task checklist

### Phase 0 — Spec & task board
- [x] Align product requirements with user
- [x] Choose architecture approach B (gateway discovery service)
- [x] Write design spec
- [x] User reviews/approves spec
- [x] Write implementation plan from approved spec

### Phase 1 — Discovery core
- [x] Create strategy interface + registry
- [x] Implement response normalizer
- [x] Implement short-lived cache
- [x] Implement OpenAI-compatible `/v1/models` strategy
- [x] Add gateway route `GET /v1/config/endpoints/:endpointId/models`
- [x] Unit tests for selection/normalize/cache/route basics
- [x] Commit checkpoint

### Phase 2 — Subscription strategies
- [x] Codex subscription strategy
- [x] Antigravity strategy
- [x] Grok subscription strategy
- [x] Fixture-based tests for each strategy
- [x] Ensure registry remains open for extension
- [x] Commit checkpoint

### Phase 3 — Chat endpoint suggestion UX
- [x] Auto-fetch on chat endpoint open
- [x] Manual refresh action
- [x] Upstream model suggestion UI (no auto-overwrite)
- [x] Mapping target suggestion UI
- [ ] Client policy:
  - Desktop source = Claude catalog
  - Codex/others source free text
- [x] Loading / empty / error polish
- [x] Panel unit tests
- [x] Commit checkpoint

### Phase 4 — Claude catalog mini-tool
- [x] Built-in official model module
- [x] Config section for user models
- [x] Mini-tool card + detail UI
- [x] Wire Desktop mapping source suggestions
- [x] Tests for merge/de-dupe behavior
- [x] Commit checkpoint

### Phase 5 — Hardening & handoff
- [x] End-to-end manual verification on port 8788
- [x] Regression around existing mapping/save flows
- [x] Final docs pass
- [x] Ready-for-review summary

## Acceptance notes
_Fill these as phases complete._

### Phase 0
- User authorized implementation; plan written.

### Phase 1
- Discovery service, cache, openai-compatible strategy, route implemented and unit tested.

### Phase 2
- codex/antigravity/grok strategies registered with open/closed registry order.

### Phase 3
- Chat endpoint suggestion UI markers and refresh/discovery helpers landed.

### Phase 4
- Claude catalog mini-tool + merge helper + tools config persistence landed.

### Phase 5
- 52 unit tests passed; 8788 discovery smoke verified for grok subscription and base_url endpoints.

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
