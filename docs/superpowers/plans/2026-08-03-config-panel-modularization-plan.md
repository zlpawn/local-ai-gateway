# Config Panel Modularization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 526KB `desktop/config-panel.html` monolith into TypeScript + esbuild modular frontend with per-tab modules and shared core.

**Architecture:** TypeScript modules organized by tab, with a shared `core/` layer for state, API, types, DOM utils, and rendering. esbuild bundles into a single IIFE JS + CSS. server.js serves `index.html` and static `dist/` assets.

**Tech Stack:** TypeScript, esbuild, vanilla DOM (no framework), node:test for testing.

## Global Constraints

- Test gateway runs on port **8788** (set `GATEWAY_PORT=8788` env) to avoid conflicting with main branch's 8787.
- `desktop/dist/` is gitignored (already covered by existing `dist/` rule).
- `desktop/config-panel.html` is kept until Phase 4 cleanup — both files coexist during migration.
- TypeScript starts with `strict: false`; fields not yet typed use `[key: string]: unknown`.
- All existing tests in `tests/unit/config-panel.test.mjs` must pass after each phase (they read `config-panel.html` which remains until Phase 4).
- Each migration step compiles with `npm run build:panel` and is browser-tested on port 8788.

---

## Task 1: Install esbuild and Create Build Configuration

**Files:**
- Create: `desktop/esbuild.config.mjs`
- Create: `tsconfig.json`
- Modify: `package.json` (add devDependencies + scripts)

**Interfaces:**
- Produces: `npm run build:panel` (one-shot build), `npm run dev:panel` (watch mode)
- Produces: `desktop/dist/panel.bundle.js`, `desktop/dist/panel.css`

- [ ] **Step 1: Install esbuild**

```bash
npm install --save-dev esbuild
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": false,
    "noImplicitAny": false,
    "allowJs": true,
    "checkJs": false,
    "outDir": "desktop/dist",
    "rootDir": "desktop/src",
    "sourceMap": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "skipLibCheck": true
  },
  "include": ["desktop/src/**/*"],
  "exclude": ["node_modules", "desktop/dist"]
}
```

- [ ] **Step 3: Create desktop/esbuild.config.mjs**

```javascript
import esbuild from "esbuild";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const outdir = path.resolve("desktop", "dist");
if (!existsSync(outdir)) mkdirSync(outdir, { recursive: true });

const isWatch = process.argv.includes("--watch");

const commonOptions = {
  bundle: true,
  outdir,
  sourcemap: true,
  target: ["chrome100"],
  logLevel: "info",
};

if (isWatch) {
  const ctx = await esbuild.context({
    ...commonOptions,
    entryPoints: ["desktop/src/main.ts", "desktop/src/styles/main.css"],
    format: "esm",
  });
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  // JS bundle
  await esbuild.build({
    ...commonOptions,
    entryPoints: ["desktop/src/main.ts"],
    outfile: path.join(outdir, "panel.bundle.js"),
    format: "iife",
  });
  // CSS bundle
  await esbuild.build({
    ...commonOptions,
    entryPoints: ["desktop/src/styles/main.css"],
    outfile: path.join(outdir, "panel.css"),
    loader: { ".css": "css" },
  });
}
```

- [ ] **Step 4: Add npm scripts to package.json**

Add to `"scripts"`:
```json
"build:panel": "node desktop/esbuild.config.mjs",
"dev:panel": "node desktop/esbuild.config.mjs --watch"
```

- [ ] **Step 5: Verify build configuration works**

Create a minimal `desktop/src/main.ts`:
```typescript
console.log("panel loaded");
```

Create a minimal `desktop/src/styles/main.css`:
```css
/* placeholder */
```

Run: `npm run build:panel`
Expected: `desktop/dist/panel.bundle.js` and `desktop/dist/panel.css` are created and non-empty.

- [ ] **Step 6: Commit**

```bash
git add desktop/esbuild.config.mjs tsconfig.json package.json package-lock.json desktop/src/main.ts desktop/src/styles/main.css
git commit -m "build: add esbuild + TypeScript configuration for panel modularization"
```

---

## Task 2: Create index.html and Wire server.js Static Handler

**Files:**
- Create: `desktop/index.html` (derived from config-panel.html)
- Modify: `server.js` (config route + static file handler)

**Interfaces:**
- Produces: `/config` serves `index.html`; `/desktop/dist/*` serves static assets.

- [ ] **Step 1: Create desktop/index.html from config-panel.html**

Copy `config-panel.html` to `index.html`. Then make these replacements:
1. Replace the entire `<style>...</style>` block (lines 7-3093) with: `<link rel="stylesheet" href="/desktop/dist/panel.css">`
2. Replace the main `<script>` block (lines 3951-10144, the large one) with: `<script src="/desktop/dist/panel.bundle.js"></script>`
3. Keep the xterm `<script>` tags (lines 3107-3108) as-is.
4. Keep the small init `<script>` block (lines 3094-3105) as-is if it exists.

- [ ] **Step 2: Add static file handler to server.js**

Insert before the `/config` route handler (around line 863), a new handler for `/desktop/dist/`:

```javascript
// --- Static assets for modularized config panel ---
if (reqPath.startsWith("/desktop/dist/") && req.method === "GET") {
  const distRoot = path.join(PROJECT_ROOT, "desktop", "dist");
  const filePath = path.resolve(path.join(PROJECT_ROOT, reqPath));
  if (!filePath.startsWith(distRoot + path.sep)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const ext = path.extname(filePath);
  const mimeTypes = {
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".map": "application/json",
  };
  res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
  res.end(fs.readFileSync(filePath));
  return;
}
```

- [ ] **Step 3: Change config route to read index.html**

In server.js line 864, change:
```javascript
// Before
const htmlPath = path.join(PROJECT_ROOT, "desktop", "config-panel.html");
// After
const htmlPath = path.join(PROJECT_ROOT, "desktop", "index.html");
```

- [ ] **Step 4: Verify page loads**

Run: `$env:GATEWAY_PORT=8788; node server.js`
Open: `http://127.0.0.1:8788/config`
Expected: Page loads with CSS applied. "panel loaded" appears in browser DevTools console. The page will be non-functional (JS is just console.log) but should render the HTML structure with styling.

- [ ] **Step 5: Commit**

```bash
git add desktop/index.html server.js
git commit -m "feat: serve modularized index.html with static dist handler"
```

---

## Task 3: Extract CSS into Separate Files

**Files:**
- Create: `desktop/src/styles/base.css`
- Create: `desktop/src/styles/layout.css`
- Create: `desktop/src/styles/components.css`
- Create: `desktop/src/styles/clients.css`
- Create: `desktop/src/styles/analytics.css`
- Create: `desktop/src/styles/tools.css`
- Create: `desktop/src/styles/skills.css`
- Create: `desktop/src/styles/cli.css`
- Modify: `desktop/src/styles/main.css` (replace placeholder with @import chain)
- Modify: `desktop/index.html` (remove inline `<style>` if any remnants)

**Interfaces:**
- Produces: `desktop/dist/panel.css` containing all styles bundled from 8 source files.

- [ ] **Step 1: Extract CSS blocks by section comments**

From the original `config-panel.html` `<style>` block (lines 7-3093), split by the existing section comments:

- `base.css`: Lines 9-122 (`/* Pure Dark Theme */` through `/* Input specific */`)
- `layout.css`: Lines 123-458 (`/* App Layout (Dashboard) */` through `/* End of App Layout styling */`)
- `components.css`: Lines 460-1186 (`/* Sections */` through `/* Tag & Mapping UI */`) + lines 1187-1891 (`/* Usage Guide */` through `/* Skills library */` start) — all shared component styles (toast, modal, form grid, empty state, usage guide, selects)
- `clients.css`: Endpoint grid, summary cards, detail view, cards, form grid, add-node menus, custom client blocks
- `analytics.css`: Analytics-specific styles (summary cards, breakdown tables, chart)
- `tools.css`: Mini-tools styles (image gen, video gen, TTS, embedding, classification metrics)
- `skills.css`: Skills library, skill detail, install history
- `cli.css`: CLI library, CLI sources, CLI install history

**Note:** Some CSS rules may apply to multiple sections. When in doubt, put shared rules in `components.css` and section-specific rules in the section file. The goal is a pure extraction — no CSS rules are changed, only relocated.

- [ ] **Step 2: Update main.css with @import chain**

Replace `desktop/src/styles/main.css` content with:

```css
@import "./base.css";
@import "./layout.css";
@import "./components.css";
@import "./clients.css";
@import "./analytics.css";
@import "./tools.css";
@import "./skills.css";
@import "./cli.css";
```

- [ ] **Step 3: Build and verify CSS**

Run: `npm run build:panel`
Expected: `desktop/dist/panel.css` is created and non-empty.

- [ ] **Step 4: Visual regression check**

Run: `$env:GATEWAY_PORT=8788; node server.js`
Open: `http://127.0.0.1:8788/config`
Expected: Page styles look identical to the old config-panel.html. Compare side-by-side in two browser tabs (one loading old file directly, one loading new). Check: sidebar layout, theme colors, card styles, form inputs, responsive behavior.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/styles/
git commit -m "feat: extract CSS into per-section files with @import chain"
```

---

## Task 4: Create core/ Module Skeleton (types, state, dom, api, render, navigation)

**Files:**
- Create: `desktop/src/core/types.ts`
- Create: `desktop/src/core/state.ts`
- Create: `desktop/src/core/dom.ts`
- Create: `desktop/src/core/ui.ts`
- Create: `desktop/src/core/api.ts`
- Create: `desktop/src/core/render.ts`
- Create: `desktop/src/core/navigation.ts`

**Interfaces:**
- `types.ts` exports: `AppConfig`, `ClientConfig`, `Endpoint`, `ToolsView`, `Selection`, `AnalyticsResponse`, `CustomPrice`
- `state.ts` exports: `state` object with `config`, `codexModelCatalogPath`, `selectedEndpoint`, `activeClient`, `toolsView`
- `dom.ts` exports: `escapeHtml`, `qs`, `qsa`
- `ui.ts` exports: `showToast`
- `api.ts` exports: `getConfig`, `saveConfig`, `getAnalyticsData`, `loadSyncStatus`, `configureSync`, and all other fetch wrappers
- `render.ts` exports: `render` (dispatcher)
- `navigation.ts` exports: `switchTab`, `registerTab`

- [ ] **Step 1: Create core/types.ts**

```typescript
export interface AppConfig {
  server: { host: string; port: number };
  clients: Record<string, ClientConfig>;
  codex_model_catalog?: { path?: string; path_posix?: string };
  custom_prices?: CustomPrice[];
  [key: string]: unknown;
}

export interface ClientConfig {
  endpoints: Endpoint[];
  model_slots?: Record<string, string>;
  [key: string]: unknown;
}

export interface Endpoint {
  id?: string;
  name: string;
  type: string;
  base_url: string;
  api_key: string;
  models: string[];
  model_mapping?: Record<string, string>;
  is_default?: boolean;
  enabled?: boolean;
  purpose?: string;
  proxy?: string;
  [key: string]: unknown;
}

export type ToolsView = "cards" | "embedding" | "classification-metrics"
  | "antigravity-subscribe" | "codex-subscribe"
  | "image-gen" | "video-gen" | "tts";

export interface Selection {
  client: string;
  index: number;
}

export interface AnalyticsResponse {
  summary: Record<string, unknown>;
  timeline: unknown[];
  purpose_breakdown: unknown[];
  client_breakdown: unknown[];
  endpoint_breakdown: unknown[];
  model_breakdown: unknown[];
  detail_breakdown: unknown[];
  [key: string]: unknown;
}

export interface CustomPrice {
  model: string;
  currency: string;
  prompt: number;
  completion: number;
  cache_creation?: number;
  cache_read?: number;
}
```

- [ ] **Step 2: Create core/state.ts**

```typescript
import type { AppConfig, Selection, ToolsView } from "./types";

export const state = {
  config: {
    server: { host: "127.0.0.1", port: 8787 },
    clients: {
      code: { endpoints: [], model_slots: {} },
      desktop: { endpoints: [] },
      codex: { endpoints: [] },
      deeptutor: { endpoints: [] },
    },
  } as AppConfig,
  codexModelCatalogPath: "~/.codex/gateway-model-catalog.json",
  selectedEndpoint: null as Selection | null,
  activeClient: "code",
  toolsView: "cards" as ToolsView,
};
```

- [ ] **Step 3: Create core/dom.ts**

Extract `escapeHtml` (line 6496) and add query helpers:

```typescript
export function escapeHtml(value: unknown): string {
  const s = String(value ?? "");
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function qs<T extends HTMLElement = HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

export function qsa<T extends HTMLElement = HTMLElement>(selector: string): T[] {
  return Array.from(document.querySelectorAll<T>(selector));
}
```

- [ ] **Step 4: Create core/ui.ts**

Extract `showToast` (line 10036):

```typescript
export function showToast(message: string, type: "success" | "error" | "info" = "success"): void {
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  const container = document.getElementById("toast-container") || document.body;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}
```

- [ ] **Step 5: Create core/api.ts**

Consolidate fetch calls. Start with the essential ones (getConfig, saveConfig, analytics, sync). Others are added during tab migration:

```typescript
import type { AppConfig, AnalyticsResponse } from "./types";

export async function getConfig(): Promise<AppConfig | null> {
  try {
    const res = await fetch("/v1/config");
    if (res.ok) return await res.json();
  } catch {
    console.warn("Failed to fetch config.");
  }
  return null;
}

export async function saveConfig(config: AppConfig): Promise<boolean> {
  try {
    const res = await fetch("/v1/config/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function getAnalyticsData(params: Record<string, string>): Promise<AnalyticsResponse | null> {
  try {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`/v1/analytics/token-usage?${qs}`);
    if (res.ok) return await res.json();
  } catch {
    console.warn("Failed to fetch analytics.");
  }
  return null;
}

export async function loadSyncStatus(): Promise<unknown> {
  try {
    const res = await fetch("/v1/sync/status");
    if (res.ok) return await res.json();
  } catch {
    /* ignore */
  }
  return null;
}
```

- [ ] **Step 6: Create core/render.ts (stub for now)**

```typescript
export function render(): void {
  // Will be filled during tab migration.
  // Each tab module registers its render function.
  // For now, this is a no-op stub.
}
```

- [ ] **Step 7: Create core/navigation.ts**

```typescript
import { state } from "./state";
import { render } from "./render";

type TabHooks = { onEnter?: () => void; onLeave?: () => void };

const tabHooks: Record<string, TabHooks> = {};

export function registerTab(tabId: string, hooks: TabHooks): void {
  tabHooks[tabId] = hooks;
}

export function switchTab(tabId: string): void {
  const prevClient = state.activeClient;
  state.activeClient = tabId;

  if (prevClient !== tabId && tabHooks[prevClient]?.onLeave) {
    tabHooks[prevClient].onLeave!();
  }

  if (state.selectedEndpoint && state.selectedEndpoint.client !== tabId) {
    state.selectedEndpoint = null;
  }

  document.querySelectorAll(".nav-item").forEach((el) => el.classList.remove("active"));
  const navItem = document.querySelector(`.nav-item[href="#${tabId}"]`);
  if (navItem) navItem.classList.add("active");

  document.querySelectorAll(".tab-section").forEach((el) => {
    (el as HTMLElement).style.display = "none";
    el.classList.remove("active");
  });

  const sectionId = tabId; // custom clients handled during migration
  const activeSection = document.getElementById(`section-${sectionId}`);
  if (activeSection) {
    (activeSection as HTMLElement).style.display = "block";
    activeSection.classList.add("active");
  }

  render();

  if (tabHooks[tabId]?.onEnter) {
    tabHooks[tabId].onEnter!();
  }
}
```

- [ ] **Step 8: Update main.ts to import core modules and register window exports**

```typescript
import { state } from "./core/state";
import { getConfig } from "./core/api";
import { render } from "./core/render";
import { switchTab } from "./core/navigation";

// Register window exports needed by inline HTML handlers
window.switchTab = switchTab;

async function init(): Promise<void> {
  const data = await getConfig();
  if (data && data.clients) {
    state.config = { ...state.config, ...data };
  }
  render();
}

document.addEventListener("DOMContentLoaded", () => {
  init();
});

console.log("panel loaded with core modules");
```

- [ ] **Step 9: Build and verify**

Run: `npm run build:panel`
Expected: Builds without errors.

Run: `$env:GATEWAY_PORT=8788; node server.js`
Expected: Page loads, console shows "panel loaded with core modules". Page is non-functional but HTML structure renders with CSS.

- [ ] **Step 10: Commit**

```bash
git add desktop/src/core/ desktop/src/main.ts
git commit -m "feat: create core module skeleton (types, state, dom, ui, api, render, navigation)"
```

---

## Task 5: Migrate clients/ Tab (Built-in Clients + Endpoint Detail + Model Discovery + Custom Clients)

**Files:**
- Create: `desktop/src/tabs/clients/clients.ts`
- Create: `desktop/src/tabs/clients/endpoint-detail.ts`
- Create: `desktop/src/tabs/clients/model-discovery.ts`
- Create: `desktop/src/tabs/clients/custom-clients.ts`

**Interfaces:**
- Consumes: `state`, `AppConfig`, `Endpoint`, `escapeHtml`, `qs`, `qsa`, `showToast`, `getConfig`, `saveConfig`
- Produces: `renderClients`, `renderClaudeCodeModelSlots`, `addEndpoint`, `openEndpoint`, `closeEndpointDetail`, `removeEndpoint`, `updateEndpoint`, `saveNode`, `setAsDefault`, `toggleEndpointEnabled`, `toggleEndpointExposure`, `isCustomClient`, `isCapabilityEndpointPurpose`, `renderCustomClientNav`, `renderCustomClientSections`, and all other client-related functions

- [ ] **Step 1: Extract all client-related functions from the old script block**

This is the largest migration step (~1,700 lines). Extract these functions from `config-panel.html` lines 3951-10144:

Functions to extract (from the `window.xxx` list and internal functions):
- `isCapabilityEndpointPurpose`, `isCustomClient` (utility predicates)
- `mergeFetchedClients` (config merge helper)
- `createEndpointGroupsHTML`, `createEndpointDetailHTML` (HTML generators)
- `setSectionChrome`, `renderClaudeCodeModelSlots`, `getClaudeCodeDefaultEndpoint`, `getEndpointPublicModels`
- `renderClients` (per-client render loop, extracted from `render()`)
- `renderCustomClientNav`, `renderCustomClientSections`
- `renderAddNodeMenus`, `closeAddNodeMenus`, `toggleAddNodeMenu`
- `addEndpoint`, `removeEndpoint`, `updateEndpoint`, `saveNode`, `openEndpoint`, `closeEndpointDetail`
- `setAsDefault`, `setAsDefaultEmbedding`, `setAsDefaultWebSearch`
- `toggleEndpointEnabled`, `toggleEndpointExposure`
- `addVisionFallbackEndpoint`, `addEmbeddingEndpoint`, `addWebSearchEndpoint`, `addMediaEndpoint`, `addNodeByPurpose`
- `handleTagInput`, `removeTag`, `handleMappingInput`, `removeMapping`, `fillMappingField`
- `openModelSuggest`, `refreshEndpointModels`, `addDiscoveredUpstreamModel`
- `renderDiscoverySuggestions`, `renderMappingTargetSuggestions`, `renderMappingSourceSuggestions`
- `updateModelImageCapability`, `updateModelContextWindow`
- `toggleCtxVisionMenu`, `closeAllCtxVisionMenus`, `toggleCtxWindowMenu`, `closeAllCtxWindowMenus`
- `updateClaudeCodeModelSlot`, `addClaudeUserModel`, `removeClaudeUserModel`, `saveClaudeModelCatalog`, `renderClaudeModelCatalogDetail`
- `openClientCreateModal`, `closeClientCreateModal`, `submitCreateClient`, `removeCustomClient`, `setCustomClientProtocol`
- `onClientCreateModeChange`, `syncClientCreateProtocol` (internal helpers)
- `togglePasswordVisibility`, `toggleTheme`, `updateThemeIcon`
- `renderUiSelectHtml`, `toggleUiSelect`, `closeUiSelects`, `chooseUiSelectOption`
- `copyCodeSnippet`

Put client-rendering functions in `clients.ts`, endpoint detail HTML generation in `endpoint-detail.ts`, model discovery in `model-discovery.ts`, and custom client functions in `custom-clients.ts`.

Move tab-local state variables (`clientCreateOpen`, `codexAuthState`, `antigravityAuthState`) to their respective modules. `codexAuthState` and `antigravityAuthState` belong in `tools/codex-subscribe.ts` and `tools/antigravity-subscribe.ts` respectively (they are used by the subscribe mini-tools). For now, keep them in `clients.ts` and move them during the tools migration step.

- [ ] **Step 2: Add type annotations**

Add types to function parameters and return values based on usage. Use `Endpoint`, `ClientConfig`, `AppConfig` from `core/types.ts`. For untyped objects, use `Record<string, unknown>` or `[key: string]: unknown`.

- [ ] **Step 3: Replace global state references**

Replace bare `config` with `state.config`, `selectedEndpoint` with `state.selectedEndpoint`, `activeClient` with `state.activeClient`.

- [ ] **Step 4: Replace fetch calls with api.ts imports**

Replace `fetch("/v1/config")` calls with `getConfig()`, `fetch("/v1/config/save", ...)` with `saveConfig()`, etc.

- [ ] **Step 5: Update render.ts to call client render functions**

```typescript
import { renderClients, renderClaudeCodeModelSlots } from "../tabs/clients/clients";
import { renderCustomClientNav, renderCustomClientSections, isCustomClient } from "../tabs/clients/custom-clients";
import { state } from "./state";

export function render(): void {
  const { host, port } = state.config.server ?? { host: "127.0.0.1", port: 8787 };
  document.querySelectorAll(".cfg-host").forEach((el) =>
    (el as HTMLElement).textContent = host === "0.0.0.0" ? "127.0.0.1" : host);
  document.querySelectorAll(".cfg-port").forEach((el) =>
    (el as HTMLElement).textContent = String(port));
  document.querySelectorAll(".cfg-catalog-path").forEach((el) =>
    (el as HTMLElement).textContent = state.codexModelCatalogPath || "~/.codex/gateway-model-catalog.json");

  renderClaudeCodeModelSlots();

  if (state.selectedEndpoint) {
    const eps = (state.config.clients[state.selectedEndpoint.client]?.endpoints ?? []) as Endpoint[];
    if (state.selectedEndpoint.index < 0 || state.selectedEndpoint.index >= eps.length) {
      state.selectedEndpoint = null;
    }
  }

  (["code", "desktop", "codex", "deeptutor"] as const).forEach((client) => renderClients(client));

  renderCustomClientNav();
  if (isCustomClient(state.activeClient) ||
    (state.selectedEndpoint && isCustomClient(state.selectedEndpoint.client))) {
    renderCustomClientSections();
  }
}
```

- [ ] **Step 6: Register window exports in main.ts**

Add all functions referenced by inline `onclick` in the HTML to the `window` exports.

- [ ] **Step 7: Build and test**

Run: `npm run build:panel`
Run: `$env:GATEWAY_PORT=8788; node server.js`
Test in browser: switch between code/desktop/codex/deeptutor tabs, add/edit/save/delete endpoints, set default, toggle enable/exposure, add/remove tags and mappings, model discovery, create/remove custom clients, theme toggle.

- [ ] **Step 8: Commit**

```bash
git add desktop/src/tabs/clients/ desktop/src/core/render.ts desktop/src/main.ts
git commit -m "feat: migrate clients tab to TypeScript modules"
```

---

## Task 6: Migrate analytics/ Tab

**Files:**
- Create: `desktop/src/tabs/analytics/analytics.ts`

**Interfaces:**
- Consumes: `getAnalyticsData`, `escapeHtml`, `state`
- Produces: `loadAnalyticsData`, `renderAnalyticsChart`, `renderAnalyticsBreakdownTable`, `renderAnalyticsBreakdown`, etc.

- [ ] **Step 1: Extract analytics functions**

From the old script block, extract: `loadAnalyticsData`, `renderAnalyticsChart`, `renderAnalyticsBreakdownTable`, `renderAnalyticsBreakdown`, `renderAnalyticsClientBreakdown`, `renderAnalyticsEndpointBreakdown`, `renderAnalyticsModelBreakdown`, `renderAnalyticsDetailBreakdown`.

- [ ] **Step 2: Register tab hooks**

```typescript
import { registerTab } from "../../core/navigation";
registerTab("analytics", { onEnter: () => loadAnalyticsData() });
```

- [ ] **Step 3: Build and test**

Run: `npm run build:panel`, test on port 8788. Switch to analytics tab, verify data loads, charts render, breakdown tables populate.

- [ ] **Step 4: Commit**

```bash
git add desktop/src/tabs/analytics/
git commit -m "feat: migrate analytics tab to TypeScript module"
```

---

## Task 7: Migrate proxy/ Tab

**Files:**
- Create: `desktop/src/tabs/proxy/proxy.ts`

- [ ] **Step 1: Extract proxy functions**

Extract: `loadProxyConfig`, `saveProxyConfig`, `testProxyConnection`, `renderProxyEndpointsList`, `setEndpointProxyMode`.

- [ ] **Step 2: Register tab hooks and update render.ts**

```typescript
registerTab("proxy", { onEnter: () => loadProxyConfig() });
```

Update `render.ts` to import and call `renderProxyEndpointsList` when `activeClient === "proxy"`.

- [ ] **Step 3: Build, test, commit**

```bash
git add desktop/src/tabs/proxy/ desktop/src/core/render.ts
git commit -m "feat: migrate proxy tab to TypeScript module"
```

---

## Task 8: Migrate sync/ Tab

**Files:**
- Create: `desktop/src/tabs/sync/sync.ts`

- [ ] **Step 1: Extract sync functions**

Extract: `loadSyncStatus`, `configureSync`, `setDatePreset`, `setSummaryMode`, and any sync-related helpers. Move `lastLoadedSyncTargets` to module-local state.

- [ ] **Step 2: Build, test, commit**

```bash
git add desktop/src/tabs/sync/
git commit -m "feat: migrate sync tab to TypeScript module"
```

---

## Task 9: Migrate skills/ Tab

**Files:**
- Create: `desktop/src/tabs/skills/skills.ts`
- Create: `desktop/src/tabs/skills/install-history.ts`

- [ ] **Step 1: Extract skills functions**

Extract all skills functions + `renderSkillsCategories`, `renderSkillsList`, `renderSkillDetail`, `renderSkillsLibrary`, `renderInstallHistoryList`, `refreshInstallHistory`. Move `skillsLibraryState`, `skillsSearchTimer`, `skillConfirmResolver`, `skillPromoteResolver`, `skillPromoteOriginalName` to module-local state.

- [ ] **Step 2: Register tab hooks**

```typescript
registerTab("skills", { onEnter: () => refreshSkillsLibrary(false) });
registerTab("install-history", { onEnter: () => refreshInstallHistory() });
```

- [ ] **Step 3: Build, test, commit**

```bash
git add desktop/src/tabs/skills/
git commit -m "feat: migrate skills tab to TypeScript modules"
```

---

## Task 10: Migrate tools/ Tab (8 files)

**Files:**
- Create: `desktop/src/tabs/tools/tools.ts`
- Create: `desktop/src/tabs/tools/image-gen.ts`
- Create: `desktop/src/tabs/tools/video-gen.ts`
- Create: `desktop/src/tabs/tools/tts.ts`
- Create: `desktop/src/tabs/tools/embedding.ts`
- Create: `desktop/src/tabs/tools/classification-metrics.ts`
- Create: `desktop/src/tabs/tools/codex-subscribe.ts`
- Create: `desktop/src/tabs/tools/antigravity-subscribe.ts`

- [ ] **Step 1: Extract tools router**

Extract `renderToolsCards`, `renderToolsDetail`, `openTool`, `backToToolsCards`, `renderToolGroups`. Move `toolsView` to use `state.toolsView`.

- [ ] **Step 2: Extract each mini-tool into its own file**

Each mini-tool file contains its own render function, event handlers, API calls, and module-local state. Move `codexAuthState` to `codex-subscribe.ts`, `antigravityAuthState` to `antigravity-subscribe.ts`.

- [ ] **Step 3: Build, test, commit**

```bash
git add desktop/src/tabs/tools/
git commit -m "feat: migrate tools tab to TypeScript modules (8 mini-tools)"
```

---

## Task 11: Migrate cli/ Tab (4 files)

**Files:**
- Create: `desktop/src/tabs/cli/cli.ts`
- Create: `desktop/src/tabs/cli/library.ts`
- Create: `desktop/src/tabs/cli/sources.ts`
- Create: `desktop/src/tabs/cli/install-history.ts`

- [ ] **Step 1: Extract CLI functions**

Move `cliLibraryState`, `cliSearchTimer`, `cliIgnoredState`, `cliFavoriteState`, `cliSourcesState`, `cliXterm`, `cliXtermFit`, `currentCliInstallWs` to module-local state in respective files.

- [ ] **Step 2: Build, test, commit**

```bash
git add desktop/src/tabs/cli/
git commit -m "feat: migrate CLI tab to TypeScript modules"
```

---

## Task 12: Finalize main.ts and Complete Window Exports

**Files:**
- Modify: `desktop/src/main.ts`

- [ ] **Step 1: Wire all remaining window exports**

Audit `index.html` for all inline `onclick="..."` references. Ensure every function referenced is exported to `window` in `main.ts`.

- [ ] **Step 2: Wire DOMContentLoaded init code**

Migrate the `DOMContentLoaded` handler (lines 10084-10103): `renderAddNodeMenus()`, radio button listeners, client create input listener, `init()` call, theme icon update.

- [ ] **Step 3: Wire document click handler**

Migrate the document-level click handler (lines 10105-10111) that closes menus on outside clicks.

- [ ] **Step 4: Build, test all tabs, commit**

```bash
git add desktop/src/main.ts
git commit -m "feat: finalize main.ts with all window exports and init code"
```

---

## Task 13: Update Existing Tests and Cleanup

**Files:**
- Modify: `tests/unit/config-panel.test.mjs`
- Delete: `desktop/config-panel.html`
- Modify: `desktop/index.html` (remove any remaining inline references)

- [ ] **Step 1: Update config-panel.test.mjs**

The existing tests read `desktop/config-panel.html`. After migration, update them to read `desktop/index.html` and adjust assertions:
- Tests checking for CSS patterns: update to read `desktop/dist/panel.css` or keep reading the source CSS files.
- Tests checking for JS patterns (inline script content): these need to be adjusted to read the source `.ts` files or the built bundle.
- Tests using `vm.runInNewContext` to execute inline JS: update to load from built bundle or skip (the logic is now in modules).

- [ ] **Step 2: Delete config-panel.html**

```bash
git rm desktop/config-panel.html
```

- [ ] **Step 3: Run all tests**

```bash
npm run check
npm run test:cli
npm run test:codex:unit
npm run test:adapters
npm run test:config-panel
```

- [ ] **Step 4: Final smoke test on port 8788**

```bash
$env:GATEWAY_PORT=8788; node server.js
```

Test every tab and interaction per the smoke test checklist.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/config-panel.test.mjs desktop/
git commit -m "refactor: delete config-panel.html, update tests for modularized panel"
```

---

## Execution Notes

- Tasks 1-4 are sequential (each depends on the previous).
- Task 5 (clients) is the largest and most critical — take extra time testing.
- Tasks 6-11 can be done in any order after Task 5, but the suggested order follows dependency weight (analytics/proxy/sync are small; skills/tools/cli are larger).
- Task 12 wires everything together.
- Task 13 is cleanup — only run when all previous tasks pass.
- **Testing port:** All browser testing uses `GATEWAY_PORT=8788` to avoid conflicting with the main branch gateway on 8787.
