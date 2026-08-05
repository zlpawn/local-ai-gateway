# Browser Extension Cookie Bridge

## Background & Problem

The video-kb cookie export tool reads Chrome's Cookies SQLite file directly. On Windows, Chrome 137+ holds that file with an exclusive lock while running, and Chrome 127+ encrypts cookie values with app-bound encryption (v20 prefix) that third-party processes cannot decrypt. The local-file approach works on macOS and on Windows when the browser is closed, but fails in the common case of "Chrome open on Windows".

A browser extension runs inside Chrome and has legitimate access to the `chrome.cookies` API, which returns already-decrypted cookie values. This design adds a browser extension as an alternative cookie source, with the existing local-file reader kept as a fallback.

## Goals

- Let users export cookies (as Netscape cookies.txt) via a browser extension, without closing Chrome, on all platforms.
- Support two invocation paths: (A) gateway page triggers the extension via `chrome.runtime.sendMessage`, (B) extension popup pushes cookies to the gateway directly.
- Extension auto-registers its ID with the gateway on install; gateway persists it so the page knows which extension to talk to.
- Add a "浏览器插件" (Browser Extensions) management panel inside the existing Mini Tools section, designed to host multiple extensions over time.
- Preserve the existing local-file cookie extractor as a fallback; surface a clear "use the extension" hint when the local path fails because the browser is open on Windows.
- Work only on the `codex/lancedb-video-kb` branch; do not touch main. Test against the 8788 port.

## Non-Goals

- Publishing the extension to the Chrome Web Store (localhost `externally_connectable` is rejected by store review; distribute as unpacked extension + ZIP download from the gateway).
- Supporting browsers other than Chromium-based (Chrome/Edge/Brave) for the extension path. Firefox is covered by the existing local-file fallback (plaintext cookies).
- Auto-installing the extension. Chrome requires manual user confirmation in `chrome://extensions` for any install method. We minimize friction with a download button and step-by-step instructions, but cannot bypass this.

## Architecture Overview

Four independently replaceable units, each with a single responsibility:

1. **Extension package** (`extensions/cookie-helper/`) - a Manifest V3 Chromium extension. Owns: reading cookies via `chrome.cookies`, communicating with the gateway, rendering its popup UI. Knows nothing about the gateway's internal config or video-kb module.

2. **Extension registry store** (`lib/extension-registry/store.mjs`) - persistence layer for registered extensions. Owns: reading/writing `extensions.json` next to the gateway config, in-memory cache, heartbeat/online-status logic. Knows nothing about HTTP or the extension package contents.

3. **Extension REST routes** (`lib/extension-registry/routes.mjs`) - thin HTTP adapter over the store. Owns: request parsing, JSON validation, calling the store, sending JSON responses. Mirrors the existing `routeCookieRequest` pattern. Knows nothing about how cookies are used downstream.

4. **Frontend panel + video-kb integration** (`desktop/src/`) - renders the management UI and wires the "export via extension" button into the existing cookie panel. Owns: DOM rendering, user messaging, calling `chrome.runtime.sendMessage` and the gateway API.

The cookie-import endpoint reuses the existing `toNetscapeFormat` from `lib/cookie-extractor/index.mjs` so the output format is identical regardless of source. This is the single shared seam between the extension path and the local-file path.

## Data Flow

### Extension registration (on extension install / browser startup)

```
Extension background starts
  -> reads gateway URL from chrome.storage (default http://127.0.0.1:8788)
  -> POST /v1/extensions/register
       { id, name, version, capabilities: ["cookies"], permissions: ["cookies","activeTab"] }
  -> gateway store upserts into extensions.json, sets last_seen = now
  -> extension stores its own registration state, starts heartbeat interval
```

### Heartbeat (every 60s)

```
Extension -> POST /v1/extensions/heartbeat { id }
  -> store updates last_seen; gateway marks online if seen within 90s
```

### Path A: gateway page triggers extension

```
Video-kb cookie panel: user clicks "用浏览器插件导出"
  -> page GET /v1/extensions/list -> finds an online extension with capability "cookies"
  -> page calls chrome.runtime.sendMessage(extensionId, { action: "getCookies", domain })
  -> extension background: chrome.cookies.getAll({ domain }) -> returns cookie array
  -> page receives cookie array
  -> page POST /v1/cookies/import { domain, cookies: [...] }
  -> gateway: toNetscapeFormat(cookies) -> writes cookies.txt -> returns { file_path, count, domains }
  -> page shows success, refreshes the cookie-file dropdown
```

### Path B: extension popup pushes cookies

```
User clicks extension icon -> popup opens
  -> popup reads current tab URL -> derives domain
  -> (optional) user edits domain in the popup input
  -> user clicks "导出到网关"
  -> popup calls chrome.cookies.getAll({ domain })
  -> popup POST /v1/cookies/import { domain, cookies: [...] }
  -> gateway writes cookies.txt -> returns result
  -> popup shows success message
```

### Fallback: local-file path (unchanged)

When no extension is registered or online, the video-kb cookie panel shows the existing browser-selector + domain-input UI. On Windows when Chrome is open and the local read throws EBUSY, the error message (already implemented) tells the user to use the browser extension instead of closing Chrome.

## Component Specifications

### 1. Extension package (`extensions/cookie-helper/`)

**Files:**
- `manifest.json` - Manifest V3
- `background.js` - service worker: registration, heartbeat, message listener for Path A
- `popup.html` - popup UI
- `popup.js` - popup logic for Path B
- `popup.css` - popup styles
- `README.md` - install instructions

**manifest.json:**
- `manifest_version: 3`
- `name: "Leo cookie.txt Locally"`
- `permissions: ["cookies", "activeTab", "storage"]`
- `host_permissions: ["<all_urls>"]` (per user decision - local self-use tool, needs to read cookies from any site the user exports)
- `externally_connectable: { matches: ["http://127.0.0.1:*/*", "http://localhost:*/*"] }`
- `background: { service_worker: "background.js" }`
- `action: { default_popup: "popup.html" }`
- A fixed `key` field is NOT included in the manifest. For unpacked extensions, Chrome derives the ID from the extension directory path hash, which is stable per machine. The extension reports its actual runtime `chrome.runtime.id` to the gateway during registration, so the gateway always has the correct ID without any manual configuration.

**background.js responsibilities:**
- On startup: read gateway URL from `chrome.storage.local`, default `http://127.0.0.1:8788`. POST `/v1/extensions/register` with `{ id: chrome.runtime.id, name, version, capabilities: ["cookies"], permissions }`.
- Start a heartbeat interval (60s) calling `/v1/extensions/heartbeat`.
- Listen for `chrome.runtime.onMessageExternal`: on `{ action: "getCookies", domain }`, call `chrome.cookies.getAll({ domain })`, resolve with the cookie array. On unknown action, reject.
- If registration or heartbeat fails (gateway down), retry with backoff (every 30s). Silently - no user-facing error.

**popup.js responsibilities:**
- On open: read current active tab URL, extract registrable domain, prefill the domain input.
- Gateway URL input: prefill from `chrome.storage.local`, default `http://127.0.0.1:8788`. On change, save to storage and trigger re-registration in the background.
- "导出到网关" button: call `chrome.cookies.getAll({ domain })`, then `POST /v1/cookies/import` to the gateway URL. Show success/failure inline.
- Fallback: if no active tab or domain cannot be derived, the domain input is empty and the user types one manually.

**Domain extraction:** Use the URL hostname. `chrome.cookies.getAll({ domain })` matches the domain and subdomains, so passing `bilibili.com` gets all `*.bilibili.com` cookies. The popup strips `www.` prefix for convenience but keeps the registrable domain.

### 2. Extension registry store (`lib/extension-registry/store.mjs`)

**API:**

```js
createExtensionStore({ dataDir })
  -> {
    register({ id, name, version, capabilities, permissions }) -> { id, name, ... , online: true, last_seen: ISO }
    heartbeat(id) -> updates last_seen
    list() -> Extension[]
    get(id) -> Extension | null
    remove(id) -> void
    isOnline(id) -> boolean  // online if last_seen within 90s
  }
```

**Extension record shape:**
```json
{
  "id": "abcdef...",
  "name": "Leo cookie.txt Locally",
  "version": "1.0.0",
  "capabilities": ["cookies"],
  "permissions": ["cookies", "activeTab", "storage"],
  "registered_at": "2026-08-05T...",
  "last_seen": "2026-08-05T..."
}
```

**Persistence:** `extensions.json` in `dataDir` (same dir as `gateway.config.json`). Atomic write via temp-file + rename. In-memory cache loaded lazily on first access; writes flush to disk synchronously.

**Online status:** `isOnline(id)` returns true if `now - last_seen < 90s`. The heartbeat interval is 60s, so a 90s threshold tolerates one missed heartbeat. The `list()` result includes an `online` boolean computed at call time.

**Extensibility (open/closed):** The store is keyed by `id` and tags each record with `capabilities`. Adding future extensions (e.g. a screenshot helper) requires no store changes - they just register with different `capabilities`. The REST layer and frontend filter by capability, not by extension identity.

### 3. Extension REST routes (`lib/extension-registry/routes.mjs`)

**Endpoints:**

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/v1/extensions/register` | `{ id, name, version, capabilities, permissions }` | `{ extension: {...} }` |
| POST | `/v1/extensions/heartbeat` | `{ id }` | `{ ok: true }` |
| GET | `/v1/extensions/list` | - | `{ extensions: [...] }` |
| GET | `/v1/extensions/download` | - | ZIP file (Content-Type: application/zip) |
| DELETE | `/v1/extensions/:id` | - | `{ ok: true }` |

Plus the cookie import endpoint (added to the existing cookie route handler):

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/v1/cookies/import` | `{ domain, cookies: [{domain,path,name,value,secure,httponly,expires}] }` | `{ file_path, count, domains }` |

**Routing integration:** Add `if (reqPath.startsWith("/v1/extensions"))` following the same pattern as `/v1/cookies/*`. The import endpoint is added inside the existing `routeCookieRequest`. The import endpoint reuses `toNetscapeFormat` from `lib/cookie-extractor/index.mjs`.

**ZIP download:** Reads `extensions/cookie-helper/` directory, zips it in-memory, streams as download. Filename: `cookie-helper.zip`. This lets users download the extension without cloning the repo. The directory is excluded from the ZIP's internal paths so it loads cleanly as an unpacked extension.

**Cookie import validation:** Reject if `cookies` is not an array or is empty. Each cookie must have at least `domain`, `name`, `value`. Missing fields get defaults (`path: "/"`, `secure: false`, `httponly: false`, `expires: 0`). The output path defaults to `cookies.txt` next to the gateway config, same as the existing export endpoint.

### 4. Frontend

**4a. "浏览器插件" management panel (new tool in Mini Tools)**

Added to `toolGroupConfigs` as a new group `{ title: '浏览器插件', tools: ['browser-extensions'] }` and a `toolDefs()` entry. The detail view `renderBrowserExtensionsDetail()` shows:

- A list of registered extensions: name, ID (truncated), version, capabilities badges, online/offline status dot. Empty state: "尚未检测到已安装的浏览器插件" with a link to the download button.
- "下载扩展包" button: triggers `GET /v1/extensions/download`, downloads `cookie-helper.zip`. 旁边是三步安装指引 (open chrome://extensions, enable developer mode, load unpacked).
- "刷新" button: re-fetches `/v1/extensions/list`.
- Each extension row has a "删除" button calling `DELETE /v1/extensions/:id` (for cleaning up stale registrations).

This panel is the future home for additional browser extensions - the list is generic and capability-driven.

**4b. Video-kb cookie panel integration**

The existing `cookiePanelHTML()` gains a new section above the local-file UI:

- If an online cookie-capable extension is registered: show a "用浏览器插件导出" button + a domain input (prefilled with current tab domain is not possible from the gateway page, so user types or it defaults to empty). Clicking it runs Path A.
- Always show the local-file UI below, labeled as fallback. The existing browser selector and export button remain unchanged.
- When the local-file export fails with the EBUSY message, the error banner now appends: "建议使用浏览器插件导出（见上方）".

**Path A communication:** The gateway page calls `chrome.runtime.sendMessage(extensionId, msg, callback)`. This only works if the page is loaded in a Chromium browser that has the extension installed and the extension declared this origin in `externally_connectable.matches`. If the page is opened in a non-Chromium browser or the extension is not installed, `chrome.runtime` is undefined or the call fails - the UI catches this and shows "请使用 Chrome/Edge 打开本页面，并安装 Leo cookie.txt Locally 扩展".

## File Layout

```
extensions/
  cookie-helper/
    manifest.json
    background.js
    popup.html
    popup.js
    popup.css
    README.md
lib/
  extension-registry/
    store.mjs        # createExtensionStore({ dataDir })
    routes.mjs       # routeExtensionRequest(req, res, context, reqPath)
  cookie-extractor/
    index.mjs        # unchanged (toNetscapeFormat reused by import endpoint)
server.js            # add /v1/extensions routing + /v1/cookies/import in routeCookieRequest
desktop/src/
  app.ts             # add toolGroup entry + toolDef + openTool branch + renderBrowserExtensionsDetail
  modules/
    video-kb.ts      # extend cookiePanelHTML + videoKbExportViaExtension()
  styles/
    panel.css        # styles for extension panel + new cookie-panel section
```

## Error Handling

- **Extension not installed / gateway page in non-Chromium browser:** Path A UI shows a friendly hint with a link to the "浏览器插件" panel. No crash.
- **Gateway down when extension tries to register:** Background retries every 30s silently. Popup shows "无法连接到网关，请检查网关地址" if a push fails.
- **Stale registration (extension uninstalled but record remains):** The heartbeat stops, `isOnline` returns false after 90s. The panel shows it as offline. User can delete it via the "删除" button.
- **Cookie import with invalid payload:** 400 with `{ error: { type: "invalid_request_error", message } }`.
- **ZIP download when extension directory missing:** 404 with a clear message.

## Testing Strategy

- **Store unit tests:** register, heartbeat updates last_seen, list returns online status correctly, remove works, duplicate register upserts.
- **Routes:** manual curl tests against 8788 for register, heartbeat, list, import, download.
- **Extension:** load unpacked in Chrome, verify registration appears in the gateway panel, verify popup push exports a cookies.txt, verify page-triggered export from the video-kb panel.
- **End-to-end:** export bilibili.com cookies via the extension while Chrome is open, confirm the resulting cookies.txt is valid (SESSDATA, bili_jct present and readable), then use it in a yt-dlp dry run.

## Open/Closed Principle Notes

- **Store is open for new extension types:** `capabilities` array means new extensions register without store changes. The frontend filters by capability, not by hardcoded IDs.
- **Routes are open for new extension endpoints:** The route dispatcher matches `/v1/extensions/*`; new sub-routes are added inside `routeExtensionRequest` without touching the server's main dispatch.
- **Cookie panel is open for new sources:** Path A (extension) and the local-file path are separate code paths in the panel. A future source (e.g. a remote cookie API) would add a third path without modifying the existing two.
- **`toNetscapeFormat` is the closed seam:** Both the local-file reader and the extension import path funnel through it, so the output format is guaranteed identical. Changes to output format happen in one place.

## Branch & Port Constraints

- All work on `codex/lancedb-video-kb` branch only. The elevated server process is already running on port 8788 in this worktree.
- The main branch's server on 8787 is untouched.
- After implementation, rebuild the frontend (`npm run build:panel`) and restart the 8788 server to test.