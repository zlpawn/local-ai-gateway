# Extension Task Cookie Export Design

## Background & Problem

The gateway already supports three cookie paths:

1. **Local file read** — `POST /v1/cookies/export` via `lib/cookie-extractor`.
2. **Path A** — gateway page calls `chrome.runtime.sendMessage` then `POST /v1/cookies/import`.
3. **Path B** — extension popup pushes cookies to `POST /v1/cookies/import`.

Agents / skills cannot talk to a Chrome extension directly. They can only call local HTTP. Today there is no agent-callable path that uses the extension without a human clicking UI, and Path A dies if the gateway page tab is closed.

We need an additive path:

> skill → create task on gateway → extension pulls task → extension returns cookies → gateway writes `cookies-*.txt` → skill polls result

Constraints from product discussion:

- Prefer **extension pull**, not gateway-page proxy.
- Skill uses **create + bounded poll** (not long-blocking request).
- If no online cookie-capable extension exists at create time → **fail immediately**.
- Must **not change historical behavior** of Paths A/B, local export, register/heartbeat/list/download.
- Ship as **Approach A (minimal cookie task flow)** but leave a clean seam to grow into a general extension task bus with low rewrite cost.
- Code must follow **open/closed**: new task types / capabilities without editing core claim/complete machinery.

## Goals

- Agent/skill can request cookie export via HTTP without opening the gateway page.
- Extension claims and completes work while Chrome is open (no exclusive DB lock / v20 decrypt problems).
- Existing manual and local-file paths keep identical behavior and response shapes.
- Task model is type/capability driven so future jobs (screenshot, DOM assist, etc.) plug in without rewriting the queue.
- Isolated implementation on branch `codex/cookie-extension-task-export` only.

## Non-Goals

- Native Messaging between skill and extension.
- Making the extension listen on a local HTTP port.
- Migrating video-kb's existing server-side `lib/task-queue` into this system.
- Blocking one-shot HTTP that waits for the extension inside a single request.
- Chrome Web Store publishing.
- Automatic extension install.

## Relationship to Existing `lib/task-queue`

`lib/task-queue` is a **server-executed** job system:

- Node claims `pending` rows.
- A handler registry runs work inside the gateway process.
- Used by video-kb / other backend jobs.

Extension tasks are **client-executed**:

- Browser extension claims work.
- Gateway only validates, stores state, and materializes results (e.g. write cookies.txt).

Reusing the video-kb queue execution loop would couple unrelated lifecycles and risk historical regressions. This design adds a **separate extension-task module** that mirrors useful vocabulary (`type`, `payload`, `result`, `status`) but does not call `createTaskQueue` / server handlers.

Future optional convergence is allowed (shared persistence traits), but not required for v1.

## Architecture Overview

Five replaceable units:

1. **Extension task store** (`lib/extension-tasks/store.mjs`)  
   Persistence + claim/complete state transitions. Knows nothing about cookies.

2. **Task type registry** (`lib/extension-tasks/registry.mjs`)  
   Open/closed seam: each task type registers validate/create-guard/materialize/fail mapping. Cookie export is one plugin.

3. **HTTP routes** (`lib/extension-tasks/routes.mjs`)  
   Generic `/v1/extension-tasks/*` plus thin cookie facade `/v1/cookies/export-via-extension*`.

4. **Cookie type plugin** (`lib/extension-tasks/types/cookies-export.mjs`)  
   Domain validation, online-extension guard, Netscape file materialization via existing `toNetscapeFormat`.

5. **Extension worker** (`extensions/leo-cookie-txt-locally/background.js`)  
   After heartbeat, claim matching tasks, execute locally, complete/fail. Popup Path B untouched.

```text
skill
  POST /v1/cookies/export-via-extension { domain }
        │
        ▼
 extension-tasks routes
        │ create(type=cookies.export)
        ▼
 task store (queued)
        │
        │  POST claim { extension_id, capabilities:["cookies"] }
        ▼
 extension background
        │ chrome.cookies.getAll
        │
        ▼
 POST complete { cookies }
        │
        ▼
 cookies-export plugin materialize
        │ toNetscapeFormat + write file
        ▼
 task succeeded { file_path, count, domains }
        │
 skill GET task → file_path
```

## Data Model

### Task record

```json
{
  "id": "etsk_01H...",
  "type": "cookies.export",
  "capability": "cookies",
  "status": "queued",
  "payload": { "domain": "bilibili.com" },
  "result": null,
  "error": null,
  "claimed_by": null,
  "created_at": "2026-08-07T04:00:00.000Z",
  "updated_at": "2026-08-07T04:00:00.000Z",
  "started_at": null,
  "finished_at": null,
  "expires_at": "2026-08-07T04:01:30.000Z"
}
```

### Status machine

```text
queued --claim--> running --complete--> succeeded
  |                  |
  |                  +--fail/timeout--> failed
  +--timeout-------> failed
```

`cancelled` is reserved in the store API but not exposed in v1 HTTP.

### Persistence

- File: `extension-tasks.json` next to `extensions.json` / gateway config (same `dataDir`).
- Atomic write: temp file + rename.
- In-memory cache loaded lazily.
- Keep only recent tasks (e.g. last 200 or last 24h) on flush to avoid unbounded growth.
- Lazy timeout: on `get` / `claim` / `create`, mark expired `queued|running` as `failed` with `error.type = "timeout"`.

Why JSON file not SQLite for v1:

- Matches extension-registry simplicity.
- Low volume (interactive exports).
- Avoids schema coupling with `gateway.db` task_queue used by video-kb.

If volume grows later, swap store implementation behind the same interface.

### Store API (closed for modification, open for callers)

```js
createExtensionTaskStore({ dataDir, now = () => Date.now(), ttlMs = 90_000 })
  -> {
    create({ type, capability, payload, dedupeKey })
    get(id)
    list({ status, type, limit }?)
    claim({ extensionId, capabilities, limit = 1 })
    complete(id, { extensionId, result })
    fail(id, { extensionId?, error })
    expireDue()
  }
```

`dedupeKey` (optional string) enables idempotent create: if a `queued|running` task with same key exists, return it instead of inserting.

## Task Type Registry (Open/Closed Seam)

```js
createExtensionTaskTypeRegistry()
  -> {
    register(type, definition)
    get(type)
    list()
  }
```

Definition shape:

```js
{
  type: "cookies.export",
  capability: "cookies",
  // returns { ok:true, payload } or { ok:false, status, error }
  validateCreate(body, ctx),
  // optional: compute dedupe key
  dedupeKey?(payload),
  // optional: pre-create guard (e.g. require online extension)
  assertCreatable?(payload, ctx),
  // turn extension completion body into stored result (+ side effects like writing files)
  materializeResult(task, completeBody, ctx),
  // optional normalize extension failure
  mapFailError?(body)
}
```

`ctx` provides:

- `extensionStore` (list/online checks)
- `configDir`
- helpers (`toNetscapeFormat` imported by cookie plugin only)

**Core routes never switch on cookie-specific fields.**  
They only:

1. resolve type definition
2. call validate/assert/materialize
3. drive store transitions

Adding `screenshot.capture` later = new file under `types/` + `register(...)` at bootstrap. No edits to claim/complete/get.

## HTTP API

### Generic bus (primary extensible surface)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/extension-tasks` | Create task |
| GET | `/v1/extension-tasks/:id` | Get task |
| POST | `/v1/extension-tasks/claim` | Extension claims work |
| POST | `/v1/extension-tasks/:id/complete` | Extension success |
| POST | `/v1/extension-tasks/:id/fail` | Extension failure |

#### Create

```http
POST /v1/extension-tasks
Content-Type: application/json

{
  "type": "cookies.export",
  "payload": { "domain": "bilibili.com" }
}
```

`capability` may be omitted; default from type definition.

Responses:

- `200 { task }` created or deduped existing active task
- `400` invalid payload / unknown type
- `409` or `503` with `{ error: { type: "no_online_extension", message } }` when create guard fails

#### Claim

```http
POST /v1/extension-tasks/claim
{
  "extension_id": "<chrome.runtime.id>",
  "capabilities": ["cookies"],
  "limit": 1
}
```

Rules:

- Extension should already be registered; if unknown → `404 extension_not_registered`.
- Refresh `last_seen` via existing extension store heartbeat/register path **without changing heartbeat request/response contract**. Preferred: claim handler calls `extensionStore.heartbeat(id)` when present.
- Only tasks with `status=queued`, not expired, and `capability` ∈ request capabilities.
- Atomic transition to `running`, set `claimed_by`, `started_at`.
- Return `{ tasks: Task[] }` (empty array if none).

#### Complete

```http
POST /v1/extension-tasks/:id/complete
{
  "extension_id": "...",
  "cookies": [ { domain, name, value, path, secure, httpOnly, expirationDate } ]
}
```

For generic types, body may instead be `{ extension_id, result }` — cookie plugin accepts `cookies` and materializes `result`.

Rules:

- Task must be `running` and `claimed_by` must match `extension_id` (else `409`).
- Type plugin `materializeResult` runs side effects + returns result object.
- Store → `succeeded`.

#### Fail

```http
POST /v1/extension-tasks/:id/fail
{
  "extension_id": "...",
  "error": { "type": "no_cookies", "message": "..." }
}
```

### Cookie facade (skill ergonomics)

Thin wrappers over generic create/get. No separate persistence.

| Method | Path | Maps to |
|--------|------|---------|
| POST | `/v1/cookies/export-via-extension` | create `cookies.export` |
| GET | `/v1/cookies/export-via-extension/:task_id` | get task |

Request:

```json
{ "domain": "bilibili.com" }
```

Response create:

```json
{ "task_id": "etsk_...", "status": "queued", "poll_after_ms": 2000, "max_polls_suggested": 30 }
```

Response get (success):

```json
{
  "task_id": "etsk_...",
  "status": "succeeded",
  "result": {
    "file_path": "/path/cookies-bilibili.com.txt",
    "count": 42,
    "domains": [".bilibili.com", "www.bilibili.com"]
  }
}
```

### Historical endpoints unchanged

- `GET /v1/cookies/browsers`
- `GET /v1/cookies/domains`
- `GET /v1/cookies/files`
- `POST /v1/cookies/export`
- `POST /v1/cookies/import`
- `POST /v1/extensions/register|heartbeat`
- `GET /v1/extensions/list|download`
- `DELETE /v1/extensions/:id`

`/v1/cookies/import` remains the manual import path. Task complete uses type materialization (may share a private helper with import for writing Netscape files) but must not require clients to call import separately.

## Cookie Type Plugin Behavior

File: `lib/extension-tasks/types/cookies-export.mjs`

- `type`: `cookies.export`
- `capability`: `cookies`
- `validateCreate`: domain required non-empty string; normalize strip leading dots/`www.` only for dedupe key if desired, but store original user domain in payload.
- `dedupeKey`: `cookies.export:<normalized-domain>`
- `assertCreatable`: `extensionStore.list()` has at least one `online && capabilities.includes("cookies")`
- `materializeResult`:
  - accept Chrome cookie objects or already-normalized objects
  - map `httpOnly`/`expirationDate` → internal `httponly`/`expires`
  - filter invalid rows
  - if zero cookies → throw/mapped fail `no_cookies`
  - write `cookies-<domain>.txt` with mode `0600` using same naming rules as import
  - return `{ file_path, count, domains }`

Shared write helper:

- Extract pure function `writeNetscapeCookieFile({ configDir, domain, cookies })` used by:
  - existing `routeCookieImport` (refactor only if behavior-identical)
  - cookie task materializer

Refactor rule: **behavior-preserving extraction only**. No response shape changes for import.

## Extension Changes

File: `extensions/leo-cookie-txt-locally/background.js`

Additive only:

1. Keep register, heartbeat, `onMessageExternal` Path A exactly.
2. After successful heartbeat (and on alarm), call claim:

```js
POST /v1/extension-tasks/claim
{ extension_id, capabilities: ["cookies"], limit: 1 }
```

3. For each task with `type === "cookies.export"`:
   - `chrome.cookies.getAll({ domain: payload.domain })`
   - if empty → fail `no_cookies`
   - else complete with cookie array

4. Unknown future types: ignore or fail with `unsupported_task_type` (prefer fail if claimed; better: claim filter only returns types extension understands — v1 cookie extension only claims capability cookies, and only executes known types; unknown type → fail `unsupported_task_type` so task does not stick in running).

5. Popup.js / Path B: **no required changes**.

6. Version bump to `1.1.0` in manifest so users know to reload unpacked extension.

7. README: document agent/skill auto-export path + reload note.

Polling cadence:

- Reuse existing heartbeat/alarm (~25–30s) **and** a faster lightweight claim timer while gateway reachable (e.g. every 2s) **or** claim immediately after heartbeat plus every 2s via `setInterval`/alarm.
- Recommended v1: claim every **2s** when registered, independent of heartbeat, with silent failure if gateway down.
- Guard against concurrent claim loops with an in-memory `claimInFlight` flag.

## Skill / Agent Contract

Update `leo-cookie-exporter` skill docs (in this branch) to document Path C:

```bash
# 1) create
curl -s -X POST http://127.0.0.1:8788/v1/cookies/export-via-extension \
  -H 'Content-Type: application/json' \
  -d '{"domain":"bilibili.com"}'

# 2) poll bounded
# interval 2s, max 30 attempts (~60s)
curl -s http://127.0.0.1:8788/v1/cookies/export-via-extension/TASK_ID
```

Skill policy:

1. Prefer Path C when gateway is up.
2. If create returns `no_online_extension`, tell user to open Chrome + load extension; optionally fall back to local script.
3. Never infinite poll: **2s interval, max 30**.
4. On `succeeded`, use `result.file_path` with yt-dlp.
5. On `failed/timeout`, surface `error.message`.

Optional tiny helper script later (`scripts/export_via_extension.sh` or python) — not required for v1 if skill documents curl clearly.

## Server Wiring

In `server.js` (additive):

- Construct `extensionTaskStore` + `extensionTaskTypeRegistry`.
- Register `cookies.export` plugin at boot.
- Route prefix `/v1/extension-tasks` → `routeExtensionTaskRequest`.
- Inside cookie router, add export-via-extension facade branches **before** 404.
- Pass `{ extensionStore, configDir }` into task routes.

Do not modify existing branch conditions except inserting new path matches.

## Error Catalog

| error.type | When | HTTP |
|------------|------|------|
| `invalid_request_error` | bad JSON / missing fields | 400 |
| `unknown_task_type` | type not registered | 400 |
| `no_online_extension` | create guard fails | 409 |
| `extension_not_registered` | claim from unknown id | 404 |
| `not_found` | unknown task id | 404 |
| `conflict` | complete/fail wrong owner/status | 409 |
| `timeout` | expired queued/running | status on task; create N/A |
| `no_cookies` | extension found zero cookies | task failed |
| `unsupported_task_type` | extension claimed unknown type | task failed |
| `extension_error` | generic extension failure | task failed |

## Compatibility Matrix

| Path | Before | After |
|------|--------|-------|
| Local export | works | unchanged |
| Import from popup/page | works | unchanged |
| Page sendMessage Path A | works | unchanged |
| register/heartbeat online semantics | works | unchanged (claim may refresh last_seen) |
| Agent auto extension export | missing | **new** |

## File Layout

```text
lib/extension-tasks/
  store.mjs                 # persistence + state machine
  registry.mjs              # type registry
  routes.mjs                # generic HTTP + helpers
  materialize-cookies.mjs   # shared netscape write helper (or under types/)
  types/
    cookies-export.mjs      # cookies.export plugin
extensions/leo-cookie-txt-locally/
  background.js             # claim loop additive
  manifest.json             # version 1.1.0
  README.md                 # docs
lib/skills/leo-cookie-exporter/
  SKILL.md                  # Path C docs
  agents/openai.yaml        # optional prompt tweak
tests/unit/
  extension-task-store.test.mjs
  extension-task-routes.test.mjs
  cookies-export-type.test.mjs
docs/superpowers/specs/
  2026-08-07-extension-task-cookie-export-design.md
```

Optional later (not v1): move facade into skills script; desktop UI badge for pending extension tasks.

## Testing Strategy

Unit:

- store create/dedupe/claim/complete/fail/expire
- claim respects capability filter and owner checks
- cookie plugin validate + materialize file contents (reuse netscape expectations)
- routes: no_online_extension, happy path with mocked store/registry
- regression: existing `extension-store` and `cookie-extractor` tests still pass

Manual:

1. Load unpacked extension 1.1.0, confirm register online.
2. `POST export-via-extension` for a logged-in domain.
3. Observe task queued → running → succeeded without opening gateway cookie panel.
4. Close extension/browser → create returns `no_online_extension`.
5. Popup Path B still imports.
6. Local export still works on macOS.

## Implementation Principles (OCP / maintainability)

1. **New module over editing old cores** — don't overload `lib/task-queue` execution.
2. **Type plugins over switch/case** — routes stay generic.
3. **Capability-based claim** — extensions declare what they can run.
4. **Facade over duplication** — skill-facing cookie URLs are thin.
5. **Shared pure helpers** for netscape writing; HTTP adapters stay thin.
6. **Additive routing** in `server.js`; no reordering of unrelated handlers beyond necessary inserts.
7. **Fail fast at create** when no worker online; don't build a zombie queue people forget about.
8. **Bounded waits** everywhere (TTL 90s, skill polls 2s × 30).

## Future Upgrade Path to General Bus

When a second type arrives:

1. Add `types/<new-type>.mjs` + register.
2. Extension with new capability claims it (or a new extension).
3. No store/route rewrite expected.
4. If needed, promote JSON store → SQLite implementing same store interface.
5. Optional: unify naming under `/v1/extension-tasks` only and keep cookie facade forever as compatibility sugar.

## Defaults Summary

| Knob | Default |
|------|---------|
| Task TTL | 90s |
| Skill poll interval | 2000 ms |
| Skill max polls | 30 |
| Claim batch limit | 1 |
| Extension claim interval | 2000 ms |
| Create without online worker | fail `no_online_extension` |
| Dedupe active same domain export | yes |
| Output file | `cookies-<domain>.txt` mode 0600 |

## Branch & Risk Notes

- Branch: `codex/cookie-extension-task-export` worktree only.
- Do not merge assumptions from dirty main working tree skill edits unless intentionally ported.
- Largest risk: extension service worker sleep delaying claim — mitigate with 2s alarm/interval + claim on startup/register.
- Second risk: users not reloading unpacked extension after upgrade — document version bump + panel download zip refresh.
