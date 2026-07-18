# Gateway Configuration and Secret Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace legacy provider/model configuration and inline endpoint keys with canonical endpoint configuration plus an ignored endpoint-ID-keyed secret store.

**Architecture:** Put migration, persistence, ID generation, visibility selection,
and conflict validation in a focused configuration module. Keep protocol routing
in `server.js`, injecting resolved credentials only after an endpoint is chosen.
The UI edits public config and submits credential replacements separately.

**Tech Stack:** Node.js ESM, built-in `node:test`, JSON files, browser JavaScript.

## Global Constraints

- Endpoint IDs use `ep_${crypto.randomUUID()}` and are globally unique.
- `gateway.config.json` must contain no `api_key`, `providers`, `models`, or `official_models`.
- `gateway.secrets.json` is ignored and keyed by endpoint ID.
- One default endpoint per client; model visibility follows the opt-in-or-all fallback rule.
- Duplicate public model IDs reject saves and include endpoint-name-based suggestions.
- Implement behavior test-first and preserve all existing test suites.

---

### Task 1: Configuration store and migration

**Files:**
- Create: `lib/config/gateway-config-store.mjs`
- Create: `scripts/gateway-config-store.test.mjs`
- Modify: `.gitignore`
- Modify: `package.json`

**Interfaces:**
- Produces `loadGatewayState`, `saveGatewayState`, `validateGatewayConfig`,
  `selectExposedEndpoints`, and `getEndpointApiKey`.

- [ ] Write failing tests for ID generation, old-shape removal, key extraction,
  backups, unchanged saves, duplicate IDs/models, suggestions, defaults, and
  exposure fallback.
- [ ] Run `node --test scripts/gateway-config-store.test.mjs` and confirm failure.
- [ ] Implement the minimal store using atomic JSON writes and `.bak` backups.
- [ ] Run the focused test and confirm it passes.
- [ ] Add the test to `test:codex:unit` and commit.

### Task 2: Runtime integration

**Files:**
- Modify: `server.js`
- Modify: `lib/codex/model-catalog.mjs`
- Modify: `scripts/codex-model-catalog.test.mjs`
- Modify: `scripts/codex-catalog-write.test.mjs`
- Modify: `scripts/codex-gateway.integration.test.mjs`

**Interfaces:**
- Consumes the configuration-store interfaces from Task 1.
- Produces secret-free `/v1/config`, credential-aware routing, canonical save,
  audit logging, and exposure-aware model catalogs.

- [ ] Write failing catalog and HTTP tests for exposure selection, secret-free
  reads, key persistence, unchanged saves, and conflict responses.
- [ ] Run focused tests and confirm the expected failures.
- [ ] Replace direct config reads/writes and endpoint `api_key` access with the
  store and resolved runtime credentials.
- [ ] Aggregate Claude Desktop models from selected endpoints.
- [ ] Run focused tests and commit.

### Task 3: Configuration panel

**Files:**
- Modify: `desktop/config-panel.html`
- Modify: `desktop/lib/desktop-smoke.test.mjs`

**Interfaces:**
- Consumes endpoint `id`, `has_api_key`, `is_default`, and `expose_models`.
- Sends optional `api_key` replacements only in save requests.

- [ ] Write failing smoke assertions for read-only IDs, credential status,
  exposure controls, and conflict suggestions.
- [ ] Run `npm run desktop:test` and confirm failure.
- [ ] Implement ID creation, secret input behavior, independent visibility
  controls, and detailed save-error rendering.
- [ ] Run Desktop tests and commit.

### Task 4: Canonical repository config and documentation

**Files:**
- Modify: `gateway.config.json`
- Modify: `README.md`
- Modify: `scripts/validate-config.mjs`
- Modify: `scripts/doctor.mjs`

- [ ] Write failing validation coverage for canonical config and forbidden
  legacy/inline-secret fields.
- [ ] Update the tracked config to canonical secret-free endpoints with stable IDs.
- [ ] Update validation, Doctor output, migration instructions, and secret-file docs.
- [ ] Run config validation against a temporary canonical fixture and commit.

### Task 5: Full verification

- [ ] Run `npm run check`.
- [ ] Run `npm run desktop:test`.
- [ ] Run `npm run test:adapters:node`.
- [ ] Run `npm run test:codex:unit`.
- [ ] Run `npm run test:codex:catalog-write`.
- [ ] Run `npm run test:codex:integration`.
- [ ] Run `npm run test:codex:e2e`.
- [ ] Run credential and diff checks, confirm a clean worktree, and commit any
  final documentation-only corrections.
