# Usage Analytics & Network Proxy Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "用量统计" (Token Analytics) and "网络代理" (Network Proxy) navigation tabs, backed by `node:sqlite` usage persistence and extensible outbound proxy resolution.

**Architecture:** 
1. `lib/analytics/db.mjs` & `lib/analytics/token-tracker.mjs`: `node:sqlite` database wrapper and decoupled token usage logger/aggregator.
2. `lib/config/proxy-resolver.mjs`: Centralized proxy agent builder and endpoint override evaluator.
3. `server.js`: API routes for `/v1/analytics/token-usage` and `/v1/config/proxy`, plus lifecycle completion hooks.
4. `desktop/config-panel.html`: "用量统计" tab with interactive SVG charts & filters, and "网络代理" tab with proxy form, connectivity probe, and endpoint status table.

**Tech Stack:** Node.js, `node:sqlite` (native), Vanilla JS / CSS in `desktop/config-panel.html`.

## Global Constraints

- Navigation tab labels MUST use 4-character Chinese names: **用量统计** (`#analytics`) and **网络代理** (`#proxy`).
- Token logging MUST NOT block or fail gateway response requests (Open-Closed Principle).
- Native `node:sqlite` DatabaseSync MUST be used without external npm C++ binary dependencies.
- Global proxy settings MUST apply to all overseas upstream requests by default while allowing per-endpoint overrides (`disabled` / `custom` / `global`).
- Port 8788 MUST be used for test execution without disturbing main branch or 8787 port.

---

### Task 1: SQLite Storage & Token Tracking Service

**Files:**
- Create: `lib/analytics/db.mjs`
- Create: `lib/analytics/token-tracker.mjs`
- Test: `tests/unit/token-tracker.test.mjs`

**Interfaces:**
- Produces: `createTokenTracker({ dbPath })` with `recordUsage(log)` and `queryUsage(options)`.

- [ ] **Step 1: Write failing unit test for token tracker service**
Create `tests/unit/token-tracker.test.mjs` testing database initialization, record insertion, and timeline aggregation queries by minute, hour, day, and purpose filters.

- [ ] **Step 2: Run test to verify it fails**
Run: `node --test .worktrees/volc-models-filter/tests/unit/token-tracker.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement `lib/analytics/db.mjs` & `lib/analytics/token-tracker.mjs`**
Create SQLite database helper and token tracking service with schema `token_usage_logs` and aggregation queries.

- [ ] **Step 4: Run test to verify it passes**
Run: `node --test .worktrees/volc-models-filter/tests/unit/token-tracker.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**
Commit changes to git.

---

### Task 2: Gateway Completion Hooks & Analytics API Route

**Files:**
- Modify: `server.js`
- Test: `tests/unit/analytics-api.test.mjs`

**Interfaces:**
- Consumes: `createTokenTracker` from Task 1.
- Produces: `GET /v1/analytics/token-usage` API and automatic token recording on completion.

- [ ] **Step 1: Write failing integration test for `/v1/analytics/token-usage`**
Create `tests/unit/analytics-api.test.mjs` testing analytics query endpoint responses and summary calculations.

- [ ] **Step 2: Run test to verify it fails**
Run: `node --test .worktrees/volc-models-filter/tests/unit/analytics-api.test.mjs`
Expected: FAIL

- [ ] **Step 3: Wire TokenTracker into `server.js` completion handlers and register `GET /v1/analytics/token-usage` route**
Inject usage logger calls on Chat, Responses, Embedding, and Media request completions.

- [ ] **Step 4: Run test to verify it passes**
Run: `node --test .worktrees/volc-models-filter/tests/unit/analytics-api.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**
Commit changes to git.

---

### Task 3: Outbound Proxy Resolver & Proxy Management APIs

**Files:**
- Create: `lib/config/proxy-resolver.mjs`
- Modify: `server.js`
- Test: `tests/unit/proxy-resolver.test.mjs`

**Interfaces:**
- Produces: `resolveOutboundProxyAgent(endpoint, globalConfig)`, `GET /v1/config/proxy`, `POST /v1/config/proxy`, `POST /v1/config/proxy/test`.

- [ ] **Step 1: Write failing unit test for Proxy Resolver and Proxy APIs**
Create `tests/unit/proxy-resolver.test.mjs` testing proxy URL formatting, override evaluation, and API handlers.

- [ ] **Step 2: Run test to verify it fails**
Run: `node --test .worktrees/volc-models-filter/tests/unit/proxy-resolver.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement `lib/config/proxy-resolver.mjs` and register proxy management routes in `server.js`**
Replace hardcoded proxy ports with `resolveOutboundProxyAgent` and implement connectivity probe endpoint.

- [ ] **Step 4: Run test to verify it passes**
Run: `node --test .worktrees/volc-models-filter/tests/unit/proxy-resolver.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**
Commit changes to git.

---

### Task 4: UI Navigation & Config Panel Tab Components

**Files:**
- Modify: `desktop/config-panel.html`
- Test: `tests/unit/config-panel-tabs.test.mjs`

**Interfaces:**
- Renders: **用量统计** (`#analytics`) and **网络代理** (`#proxy`) tabs.

- [ ] **Step 1: Write UI component tests in `tests/unit/config-panel-tabs.test.mjs`**
Test nav items, tab containers, chart rendering, filter controls, and proxy test actions in `config-panel.html`.

- [ ] **Step 2: Run test to verify it fails**
Run: `node --test .worktrees/volc-models-filter/tests/unit/config-panel-tabs.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement "用量统计" and "网络代理" TABs in `desktop/config-panel.html`**
Add navigation items, stats dashboard, SVG timeline chart, proxy configuration form, probe button, and endpoint status list.

- [ ] **Step 4: Run test to verify it passes**
Run: `node --test .worktrees/volc-models-filter/tests/unit/config-panel-tabs.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**
Commit changes to git.

---

### Task 5: End-to-End Testing & Server Launch on Port 8788

**Files:**
- All implementation files.

- [ ] **Step 1: Run complete test suite across all unit tests**
Run: `node --test .worktrees/volc-models-filter/tests/unit/*.test.mjs`
Expected: ALL PASS

- [ ] **Step 2: Launch server on port 8788 in background**
Kill any existing 8788 process and launch `GATEWAY_PORT=8788 node server.js`.

- [ ] **Step 3: Verify 8788 endpoints**
Probe `http://127.0.0.1:8788/health`, `/v1/analytics/token-usage`, and `/v1/config/proxy`.

- [ ] **Step 4: Final commit**
Commit final state.
