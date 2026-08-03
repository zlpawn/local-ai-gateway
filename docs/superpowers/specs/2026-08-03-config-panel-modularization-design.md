# Design Spec: Config Panel Modularization

**Date:** 2026-08-03
**Status:** Draft
**Scope:** Split `desktop/config-panel.html` (526 KB, 10,146 lines) into a TypeScript + esbuild modular frontend

---

## 1. Problem Statement

The gateway web UI lives entirely in `desktop/config-panel.html` - a single file containing 3,087 lines of CSS, 840 lines of HTML body (14 tab panels), and 6,196 lines of vanilla JavaScript in one script block. Served as-is via `fs.readFileSync` (server.js line 864). No build pipeline, no bundler, no module system. The JS uses 126 `window.xxx` global function assignments and 25 top-level `let` state variables in a single scope.

**Pain points:** Any change requires scrolling a 10K-line file; adding a feature in one tab risks breaking unrelated code; no type safety; no state isolation; poor navigability for humans and AI.

**Goals:** High cohesion, low coupling; open-closed principle; high extensibility; maintainable, type-safe code.

---

## 2. Technology Choice

**TypeScript + esbuild.**

TypeScript provides compile-time type checking across module boundaries. esbuild bundles into a single IIFE in milliseconds with minimal config. No framework rewrite - the goal is modularization, not re-platforming.

| Option | Why not |
|--------|---------|
| Pure JS + native ESM (zero build) | No type checking; boundaries enforced by convention only |
| React + TypeScript | Full rewrite of all rendering logic; high risk, out of scope |
| Vite | Heavier than needed; esbuild alone suffices |

---

## 3. Directory Structure

```
desktop/
  index.html                    # HTML shell only - structure, no inline CSS/JS
  esbuild.config.mjs            # Build configuration
  src/
    main.ts                     # Entry: init, register window exports, first render
    core/
      types.ts                  # Shared type definitions
      state.ts                  # Global shared state (cross-tab variables only)
      api.ts                    # All fetch calls, typed
      dom.ts                    # DOM utilities (escapeHtml, qs, qsa)
      ui.ts                     # Shared UI components (toast, modal, select)
      render.ts                 # Central render dispatcher
      navigation.ts             # switchTab + tab lifecycle hooks (onEnter/onLeave)
    tabs/
      clients/
        clients.ts              # Built-in clients (code/desktop/codex/deeptutor) - shared render + CRUD
        endpoint-detail.ts      # Endpoint detail editor view
        model-discovery.ts      # Model discovery and suggestion UI
        custom-clients.ts       # Custom agent-node groups
      analytics/
        analytics.ts            # Token usage dashboard + future cost analytics
      proxy/
        proxy.ts                # Network proxy configuration
      sync/
        sync.ts                 # Cross-app session sync
      skills/
        skills.ts               # Skills library, install/promote/unify
        install-history.ts      # Skills install history sub-tab
      tools/
        tools.ts                # Tools cards router + shared infrastructure
        image-gen.ts            # Image generation mini-tool
        video-gen.ts            # Video generation mini-tool
        tts.ts                  # TTS mini-tool
        embedding.ts            # Text embedding mini-tool
        classification-metrics.ts
        codex-subscribe.ts
        antigravity-subscribe.ts
      cli/
        cli.ts                  # CLI library main view
        library.ts              # CLI discovery, search, filter
        sources.ts              # CLI sources management sub-tab
        install-history.ts      # CLI install history sub-tab
  dist/                         # Build output (gitignored)
  styles/
    main.css                    # @import entry
    base.css                    # Theme variables, reset, light/dark themes
    layout.css                  # Sidebar, content area, responsive
    components.css              # Cards, forms, buttons, toast, modal, selects
    clients.css                 # Endpoint list/grid and detail editor
    analytics.css               # Analytics dashboard
    tools.css                   # Mini-tools
    skills.css                  # Skills library + install history
    cli.css                     # CLI library + sources + history
```

**Design decisions:**

- `clients/` is one directory, not four. The built-in clients share identical render logic, CRUD functions, and endpoint editor. Their difference is config data, not code.
- `tools/` is split finest. Seven independent mini-tools each have a complete render+interaction+API loop with no inter-dependencies. Adding a tool means adding a file.
- HTML stays single-file. 840 lines of structural markup; splitting requires a template engine for minimal gain.
- CSS split follows existing style block section comments 1:1.

---

## 4. State Management

### 4.1 Two-Layer State

**Layer 1 - Global shared state (`core/state.ts`):** Only variables accessed across multiple tabs:

```typescript
export const state = {
  config: AppConfig,
  codexModelCatalogPath: string,
  selectedEndpoint: Selection | null,
  activeClient: string,
  toolsView: ToolsView,
};
```

**Layer 2 - Module-local state:** Variables used within one tab stay in that module, unexported:

```typescript
// tabs/skills/skills.ts - not exported, invisible outside
let skillsLibraryState = { loaded: false, loading: false, ... };
// tabs/cli/library.ts
let cliLibraryState = { loaded: false, loading: false, ... };
// tabs/tools/image-gen.ts
let imageGenState = { client: '', endpointId: '', ... };
```

This is the primary mechanism for low coupling: a module internal state is invisible to other modules.

### 4.2 State Mutation

State in `core/state.ts` is mutated directly, but mutation points are limited:

- `loadConfig()` in `api.ts` - replaces entire `config` after fetching.
- `switchTab()` in `navigation.ts` - sets `activeClient`.
- `openEndpoint()` / `closeEndpointDetail()` in `clients.ts` - sets/clears `selectedEndpoint`.

No other module writes to `state` directly. Reads are unrestricted.

---

## 5. Module Communication

### 5.1 Render Dispatcher

The current `render()` (line 7028, 53 lines) becomes a lightweight dispatcher in `core/render.ts`:

```typescript
export function render(): void {
  const { host, port } = state.config.server ?? { host: '127.0.0.1', port: 8787 };
  document.querySelectorAll('.cfg-host').forEach(el =>
    el.textContent = host === '0.0.0.0' ? '127.0.0.1' : host);
  document.querySelectorAll('.cfg-port').forEach(el => el.textContent = String(port));

  renderClaudeCodeModelSlots();
  if (state.selectedEndpoint) { /* bounds check, clear if invalid */ }
  ['code', 'desktop', 'codex', 'deeptutor'].forEach(renderClients);
  renderCustomClientNav();
  if (isCustomClient(state.activeClient)) renderCustomClientSections();
  if (state.activeClient === 'proxy') renderProxyEndpointsList();
}
```

Each tab may also have local render functions for sub-views (e.g., `renderAnalyticsChart`), called only within that tab module.

### 5.2 Tab Lifecycle Hooks

`switchTab` chain of `if (tabId === '...')` is replaced by a hook registry:

```typescript
type TabHooks = { onEnter?: () => void; onLeave?: () => void };
const tabHooks: Record<string, TabHooks> = {};

export function registerTab(tabId: string, hooks: TabHooks): void {
  tabHooks[tabId] = hooks;
}

export function switchTab(tabId: string): void {
  // onLeave previous tab
  // update nav active states
  // show/hide sections
  render();
  // onEnter new tab
}
```

Each tab registers hooks at module load:

```typescript
registerTab('analytics', { onEnter: () => loadAnalyticsData() });
```

This is the open-closed mechanism: adding a tab requires a `registerTab()` call, not modifying `switchTab`.

### 5.3 Window Exports for Inline Handlers

HTML uses inline `onclick="switchTab('analytics')"` attributes. Only functions referenced by inline handlers are exported to `window` in `main.ts`:

```typescript
const windowExports = { switchTab, addEndpoint, openEndpoint, /* ... */ };
Object.assign(window, windowExports);
```

Functions not referenced by inline handlers remain module-scoped. Future: inline `onclick` can be gradually replaced with `addEventListener`, but that is out of scope.

---

## 6. API Module

All 52 `fetch` calls consolidate into `core/api.ts` with typed returns:

```typescript
export async function getConfig(): Promise<AppConfig> {
  const res = await fetch('/v1/config');
  return res.json();
}
export async function saveConfig(config: AppConfig): Promise<void> { /* ... */ }
export async function getAnalyticsData(params: AnalyticsQuery): Promise<AnalyticsResponse> { /* ... */ }
```

Benefits: each endpoint URL/method/type defined once; changing a path edits one file; TypeScript ensures correct usage at call sites.

---

## 7. Build Pipeline

### 7.1 esbuild Configuration

`desktop/esbuild.config.mjs` bundles `src/main.ts` into `dist/panel.bundle.js` (IIFE, sourcemap, target chrome100) and `src/styles/main.css` into `dist/panel.css`. Supports `--watch` for dev.

### 7.2 npm Scripts

```json
"build:panel": "node desktop/esbuild.config.mjs",
"dev:panel": "node desktop/esbuild.config.mjs --watch"
```

### 7.3 CSS Bundling

`src/styles/main.css` chains all CSS via `@import`; esbuild resolves and bundles into one file.

### 7.4 HTML

`index.html` replaces `config-panel.html`: style and script blocks replaced by external link and script tags.

---

## 8. Server Changes

### 8.1 Config Route

```javascript
// Before: path.join(PROJECT_ROOT, "desktop", "config-panel.html")
// After:  path.join(PROJECT_ROOT, "desktop", "index.html")
```

### 8.2 Static File Handler

New handler for `/desktop/dist/` with path traversal guard (`path.resolve` + `startsWith` check against `desktop/dist`). Serves `.js`, `.css`, `.map` with correct MIME types. Added before existing routes.

### 8.3 xterm

Existing xterm handler (lines 1832-1841) unchanged.

---

## 9. Migration Strategy

Four phases. **Every phase ends with a working, testable state.**

### Phase 1: Skeleton (no logic moved)

Install esbuild, create directory structure, write esbuild config, create `index.html` (copy of config-panel.html with external links), add static handler to server.js, change config route. Create minimal `main.ts` with `console.log`. **Verify:** page loads, CSS renders, console log appears.

### Phase 2: CSS Extraction

Extract 3,087-line style block into `styles/*.css` following existing section comments. Create `main.css` with `@import` chain. **Verify:** visual appearance identical (side-by-side comparison).

### Phase 3: JavaScript Migration (main work)

Migrated in dependency order, each step compiles and is browser-tested:

| Step | Module | Approx lines | Depends on |
|------|--------|-------------|------------|
| 3.1 | `core/types.ts` | - | nothing |
| 3.2 | `core/dom.ts` | ~100 | types |
| 3.3 | `core/api.ts` | ~300 | types |
| 3.4 | `core/state.ts` | ~30 | types |
| 3.5 | `tabs/clients/*` (3 files) | ~1,500 | state, api, dom |
| 3.6 | `tabs/clients/custom-clients.ts` | ~200 | state, clients |
| 3.7 | `tabs/analytics/analytics.ts` | ~200 | api, dom |
| 3.8 | `tabs/proxy/proxy.ts` | ~100 | api, dom |
| 3.9 | `tabs/sync/sync.ts` | ~150 | api, dom |
| 3.10 | `tabs/skills/*` (2 files) | ~400 | api, dom, ui |
| 3.11 | `tabs/tools/*` (8 files) | ~1,500 | api, dom, ui |
| 3.12 | `tabs/cli/*` (4 files) | ~600 | api, dom, ui |
| 3.13 | `core/render.ts` | ~50 | all tabs |
| 3.14 | `core/navigation.ts` | ~60 | state, render |
| 3.15 | `main.ts` | ~80 | all modules |

**Per-step workflow:** extract functions -> add type annotations -> replace `fetch` with `api.ts` imports -> replace global `let` with `state.xxx` or module-local -> compile -> browser test -> commit.

### Phase 4: Cleanup

Delete `config-panel.html`, add `desktop/dist/` to `.gitignore`, add esbuild to devDependencies, run all tests, final smoke test.

---

## 10. Testing

### 10.1 Existing Tests

`tests/unit/config-panel.test.mjs` is updated to read `index.html`, verify external link/script tags, and verify no inline style/script blocks remain.

### 10.2 Build Verification

`npm run build:panel` added to `release:check`; verifies `dist/panel.bundle.js` and `dist/panel.css` exist and are non-empty.

### 10.3 Manual Smoke Test

After each migration step: clients CRUD, custom clients, analytics, proxy, sync, skills, all 7 tools, CLI library/sources/history, theme toggle, nav groups.

---

## 11. TypeScript Types

Shared types in `core/types.ts` derived from existing config structure and API responses. Start permissive with `[key: string]: unknown` for untyped fields; tighten incrementally during migration.

Key types: `AppConfig`, `ClientConfig`, `Endpoint`, `ToolsView`, `Selection`, `AnalyticsResponse`, `CustomPrice`.

---

## 12. Open-Closed Extension Scenarios

**New tab:** create `tabs/new-tab/` + CSS + HTML section + nav item + `registerTab()` + `main.ts` import. No existing module modified.

**New mini-tool:** create `tabs/tools/new-tool.ts` + register in tools router + add CSS. No existing tool code modified.

**Cost analytics (upcoming):** modify only `tabs/analytics/` + `analytics.css` + `core/types.ts` + backend `lib/analytics/`. No other tab touched.

---

## 13. Out of Scope

React/Vue/Svelte migration; replacing inline onclick with addEventListener (future); backend refactoring beyond static handler; test framework changes; CI/CD pipeline; deleting old file before migration complete.

---

## 14. Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Breaking functionality during JS migration | Per-module migration with browser testing after each step; old file kept until all JS moved |
| CSS visual regression | Pure extraction, no rule changes; side-by-side visual comparison |
| esbuild incompatibility | Pin version in devDependencies |
| TS strictness blocking migration | Start with `strict: false`; use `[key: string]: unknown` for untyped fields |
| Path traversal via static handler | `path.resolve` + `startsWith` guard |
| Large diff | Each step (3.1-3.15) is a separate commit |
