# Extension Task Cookie Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let agents/skills request cookie export through the browser extension via gateway HTTP tasks (create + bounded poll), without changing existing page/popup/local cookie paths.

**Architecture:** Add a new `lib/extension-tasks` module with a JSON task store, type registry (OCP), and generic `/v1/extension-tasks/*` routes. Register only `cookies.export` in v1. Extension background claims tasks every 2s, reads `chrome.cookies`, and completes/fails. Thin cookie facade `/v1/cookies/export-via-extension*` wraps create/get for skills. Historical Path A/B/local export stay untouched.

**Tech Stack:** Node.js ESM (`.mjs`), `node:test`, Chrome MV3 extension JS, existing `toNetscapeFormat`, no new npm deps.

## Global Constraints

- Branch/worktree only: `codex/cookie-extension-task-export` at `.worktrees/cookie-extension-task-export`.
- Do **not** modify main working tree dirty skill files unless intentionally ported in a later task.
- Do **not** change behavior of:
  - `POST /v1/cookies/export`
  - `POST /v1/cookies/import`
  - Path A `chrome.runtime.onMessageExternal` getCookies
  - popup Path B import
  - `/v1/extensions/register|heartbeat|list|download`
  - server-side `lib/task-queue` (video-kb jobs)
- Task TTL default: **90_000 ms**.
- Skill poll suggestion: **2000 ms × 30**.
- Create without online cookies extension → **`no_online_extension`** (HTTP 409).
- Claim batch default limit: **1**.
- Extension claim interval: **2000 ms**.
- Output file: `cookies-<sanitized-domain>.txt` mode `0o600`, same naming spirit as import.
- Prefer small focused files; type plugins over switch/case.
- TDD: failing test → implement → pass → commit per task.
- Frequent commits; one logical commit per task.

## File Map

| File | Responsibility |
|------|----------------|
| `lib/extension-tasks/store.mjs` | Persist tasks, state machine, dedupe, expire, claim/complete/fail |
| `lib/extension-tasks/registry.mjs` | Register/get task type definitions |
| `lib/extension-tasks/http.mjs` | Shared `sendJson` / `readJsonBody` helpers for this module |
| `lib/extension-tasks/write-netscape.mjs` | Pure helper: normalize cookies + write Netscape file |
| `lib/extension-tasks/types/cookies-export.mjs` | `cookies.export` plugin |
| `lib/extension-tasks/routes.mjs` | Generic + cookie facade HTTP routes |
| `lib/extension-tasks/create-system.mjs` | Factory wiring store+registry+cookie type for server |
| `server.js` | Construct system; mount `/v1/extension-tasks`; facade inside cookie router |
| `lib/extension-registry/routes.mjs` | Optional: refactor import to shared write helper **only if** tests prove identical output |
| `extensions/leo-cookie-txt-locally/background.js` | Claim loop + execute cookies.export |
| `extensions/leo-cookie-txt-locally/manifest.json` | Version `1.1.0` |
| `extensions/leo-cookie-txt-locally/README.md` | Document Path C |
| `lib/skills/leo-cookie-exporter/SKILL.md` | Document Path C + poll bounds |
| `lib/skills/leo-cookie-exporter/agents/openai.yaml` | Prefer Path C when gateway+extension available |
| `tests/unit/extension-task-store.test.mjs` | Store unit tests |
| `tests/unit/extension-task-registry.test.mjs` | Registry unit tests |
| `tests/unit/extension-task-cookies-export.test.mjs` | Cookie type + write helper tests |
| `tests/unit/extension-task-routes.test.mjs` | Route-level tests with mocked deps / temp dirs |

---

### Task 1: Extension task store

**Files:**
- Create: `lib/extension-tasks/store.mjs`
- Test: `tests/unit/extension-task-store.test.mjs`

**Interfaces:**
- Consumes: `node:fs`, `node:path`, `node:crypto` (`randomUUID`)
- Produces:
  - `createExtensionTaskStore({ dataDir, now = () => Date.now(), ttlMs = 90_000, maxTasks = 200 })`
  - returns `{ create, get, list, claim, complete, fail, expireDue }`
  - task shape:
    ```js
    {
      id: string,              // `etsk_` + uuid without dashes or randomUUID
      type: string,
      capability: string,
      status: 'queued'|'running'|'succeeded'|'failed',
      payload: object,
      result: object|null,
      error: { type: string, message: string }|null,
      claimed_by: string|null,
      dedupe_key: string|null,
      created_at: string,      // ISO
      updated_at: string,
      started_at: string|null,
      finished_at: string|null,
      expires_at: string
    }
    ```

- [ ] **Step 1: Write failing store tests**

Create `tests/unit/extension-task-store.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createExtensionTaskStore } from "../../lib/extension-tasks/store.mjs";

function tmpStore(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-tasks-"));
  let now = opts.nowMs ?? Date.now();
  const store = createExtensionTaskStore({
    dataDir,
    ttlMs: opts.ttlMs ?? 90_000,
    maxTasks: opts.maxTasks ?? 200,
    now: () => now,
  });
  return {
    store,
    dataDir,
    setNow(ms) { now = ms; },
    cleanup() { fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

test("create returns queued task with expires_at", () => {
  const t = tmpStore({ nowMs: 1_000_000 });
  const task = t.store.create({ type: "cookies.export", capability: "cookies", payload: { domain: "bilibili.com" } });
  assert.equal(task.status, "queued");
  assert.ok(task.id.startsWith("etsk_"));
  assert.equal(task.payload.domain, "bilibili.com");
  assert.equal(task.expires_at, new Date(1_000_000 + 90_000).toISOString());
  t.cleanup();
});

test("dedupe returns existing active task", () => {
  const t = tmpStore();
  const a = t.store.create({ type: "cookies.export", capability: "cookies", payload: { domain: "x.com" }, dedupeKey: "cookies.export:x.com" });
  const b = t.store.create({ type: "cookies.export", capability: "cookies", payload: { domain: "x.com" }, dedupeKey: "cookies.export:x.com" });
  assert.equal(a.id, b.id);
  assert.equal(t.store.list().length, 1);
  t.cleanup();
});

test("claim moves queued to running and filters by capability", () => {
  const t = tmpStore();
  t.store.create({ type: "cookies.export", capability: "cookies", payload: { domain: "a.com" } });
  t.store.create({ type: "other", capability: "tabs", payload: {} });
  const claimed = t.store.claim({ extensionId: "ext1", capabilities: ["cookies"], limit: 1 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].status, "running");
  assert.equal(claimed[0].claimed_by, "ext1");
  assert.equal(t.store.claim({ extensionId: "ext1", capabilities: ["cookies"], limit: 1 }).length, 0);
  t.cleanup();
});

test("complete and fail enforce owner and status", () => {
  const t = tmpStore();
  const task = t.store.create({ type: "cookies.export", capability: "cookies", payload: { domain: "a.com" } });
  t.store.claim({ extensionId: "ext1", capabilities: ["cookies"], limit: 1 });
  assert.throws(() => t.store.complete(task.id, { extensionId: "other", result: { ok: true } }));
  const done = t.store.complete(task.id, { extensionId: "ext1", result: { file_path: "/tmp/c.txt", count: 1, domains: [".a.com"] } });
  assert.equal(done.status, "succeeded");
  assert.equal(done.result.count, 1);

  const task2 = t.store.create({ type: "cookies.export", capability: "cookies", payload: { domain: "b.com" }, dedupeKey: "b" });
  t.store.claim({ extensionId: "ext1", capabilities: ["cookies"], limit: 1 });
  const failed = t.store.fail(task2.id, { extensionId: "ext1", error: { type: "no_cookies", message: "none" } });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.type, "no_cookies");
  t.cleanup();
});

test("expireDue marks timed out queued/running as failed", () => {
  const t = tmpStore({ nowMs: 0, ttlMs: 1000 });
  const task = t.store.create({ type: "cookies.export", capability: "cookies", payload: { domain: "a.com" } });
  t.setNow(2000);
  t.store.expireDue();
  const got = t.store.get(task.id);
  assert.equal(got.status, "failed");
  assert.equal(got.error.type, "timeout");
  t.cleanup();
});

test("persists across store instances", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-tasks-"));
  const s1 = createExtensionTaskStore({ dataDir });
  const task = s1.create({ type: "cookies.export", capability: "cookies", payload: { domain: "z.com" } });
  const s2 = createExtensionTaskStore({ dataDir });
  assert.equal(s2.get(task.id)?.payload.domain, "z.com");
  fs.rmSync(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests — expect FAIL (module missing)**

```bash
node --test tests/unit/extension-task-store.test.mjs
```

Expected: fail resolving `../../lib/extension-tasks/store.mjs`.

- [ ] **Step 3: Implement store**

Create `lib/extension-tasks/store.mjs` with:

- load/flush JSON array at `path.join(dataDir, "extension-tasks.json")` (atomic tmp+rename)
- `create({ type, capability, payload, dedupeKey })`:
  - call `expireDue()` first
  - if `dedupeKey` matches existing `queued|running`, return that task
  - else insert queued task, `expires_at = now+ttlMs`
- `get(id)`: expireDue, return task or null
- `list({ status, type, limit } = {})`
- `claim({ extensionId, capabilities, limit = 1 })`:
  - expireDue
  - pick oldest queued where capability in capabilities
  - set running, claimed_by, started_at, updated_at
- `complete(id, { extensionId, result })`:
  - must be running + claimed_by match → succeeded
  - else throw Error with code-ish message (`conflict`)
- `fail(id, { extensionId, error })`:
  - if extensionId provided, require owner match when running
  - set failed + error + finished_at
- `expireDue()`:
  - queued/running with `now > expires_at` → failed `{ type:"timeout", message:"Task expired before completion." }`
- prune to `maxTasks` newest by created_at on flush

ID format: `etsk_` + `randomUUID().replaceAll("-", "")`.

- [ ] **Step 4: Run tests — expect PASS**

```bash
node --test tests/unit/extension-task-store.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add lib/extension-tasks/store.mjs tests/unit/extension-task-store.test.mjs
git commit -m "feat(extension-tasks): add persistent task store with claim lifecycle"
```

---

### Task 2: Type registry + cookies.export plugin + netscape writer

**Files:**
- Create: `lib/extension-tasks/registry.mjs`
- Create: `lib/extension-tasks/write-netscape.mjs`
- Create: `lib/extension-tasks/types/cookies-export.mjs`
- Test: `tests/unit/extension-task-registry.test.mjs`
- Test: `tests/unit/extension-task-cookies-export.test.mjs`

**Interfaces:**
- Consumes: `toNetscapeFormat` from `../cookie-extractor/index.mjs`
- Produces:
  - `createExtensionTaskTypeRegistry() -> { register(type, def), get(type), list() }`
  - `writeNetscapeCookieFile({ configDir, domain, cookies }) -> { file_path, count, domains }`
  - `createCookiesExportType() -> definition` with:
    - `type: "cookies.export"`
    - `capability: "cookies"`
    - `validateCreate(body)`
    - `dedupeKey(payload)`
    - `assertCreatable(payload, { extensionStore })`
    - `materializeResult(task, body, { configDir })`

- [ ] **Step 1: Write failing registry + cookie type tests**

`tests/unit/extension-task-registry.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createExtensionTaskTypeRegistry } from "../../lib/extension-tasks/registry.mjs";

test("register and get type definition", () => {
  const reg = createExtensionTaskTypeRegistry();
  const def = { type: "demo", capability: "demo", validateCreate: () => ({ ok: true, payload: {} }) };
  reg.register("demo", def);
  assert.equal(reg.get("demo"), def);
  assert.deepEqual(reg.list(), ["demo"]);
});

test("register rejects missing run contract fields", () => {
  const reg = createExtensionTaskTypeRegistry();
  assert.throws(() => reg.register("", {}));
  assert.throws(() => reg.register("x", { type: "x" })); // missing capability/validateCreate
});
```

`tests/unit/extension-task-cookies-export.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeNetscapeCookieFile } from "../../lib/extension-tasks/write-netscape.mjs";
import { createCookiesExportType } from "../../lib/extension-tasks/types/cookies-export.mjs";

test("writeNetscapeCookieFile writes mode-safe netscape file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-"));
  const result = writeNetscapeCookieFile({
    configDir: dir,
    domain: "bilibili.com",
    cookies: [
      { domain: ".bilibili.com", path: "/", name: "SESSDATA", value: "abc", secure: true, httponly: true, expires: 1700000000 },
    ],
  });
  assert.ok(result.file_path.endsWith("cookies-bilibili.com.txt"));
  const text = fs.readFileSync(result.file_path, "utf8");
  assert.ok(text.includes("SESSDATA\tabc"));
  assert.equal(result.count, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("cookies.export validateCreate requires domain", () => {
  const def = createCookiesExportType();
  assert.equal(def.validateCreate({}).ok, false);
  assert.equal(def.validateCreate({ domain: "  " }).ok, false);
  const ok = def.validateCreate({ domain: "Bilibili.com" });
  assert.equal(ok.ok, true);
  assert.equal(ok.payload.domain, "Bilibili.com");
});

test("cookies.export assertCreatable needs online cookies extension", () => {
  const def = createCookiesExportType();
  const offline = { list: () => [{ id: "1", online: false, capabilities: ["cookies"] }] };
  const online = { list: () => [{ id: "1", online: true, capabilities: ["cookies"] }] };
  assert.equal(def.assertCreatable({ domain: "a.com" }, { extensionStore: offline }).ok, false);
  assert.equal(def.assertCreatable({ domain: "a.com" }, { extensionStore: online }).ok, true);
});

test("materializeResult accepts chrome cookie shape", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-"));
  const def = createCookiesExportType();
  const task = { payload: { domain: "example.com" } };
  const result = def.materializeResult(task, {
    cookies: [
      { domain: ".example.com", path: "/", name: "sid", value: "1", secure: true, httpOnly: true, expirationDate: 1700000000 },
    ],
  }, { configDir: dir });
  assert.equal(result.count, 1);
  assert.ok(fs.existsSync(result.file_path));
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
node --test tests/unit/extension-task-registry.test.mjs tests/unit/extension-task-cookies-export.test.mjs
```

- [ ] **Step 3: Implement registry, writer, cookies-export type**

`registry.mjs`:
- Map of type → definition
- `register(type, def)` requires non-empty type string, `def.capability` string, `typeof def.validateCreate === "function"`
- Optional methods allowed: `dedupeKey`, `assertCreatable`, `materializeResult`, `mapFailError`

`write-netscape.mjs`:
- Normalize each cookie:
  - domain/name required
  - path default `/`
  - secure/httponly booleans
  - expires from `expires` or `expirationDate` or 0
  - map `httpOnly` → `httponly`
- Use `toNetscapeFormat`
- Sanitize domain for filename: `domain.replace(/[^a-zA-Z0-9.-]/g, "_")`
- Path: `cookies-${sanitized}.txt` or `cookies.txt` if empty
- `fs.writeFileSync(..., { mode: 0o600 })`

`types/cookies-export.mjs`:
- `validateCreate(body)` → `{ ok:true, payload:{ domain } }` or `{ ok:false, status:400, error:{ type:"invalid_request_error", message } }`
- `dedupeKey(payload)` → `` `cookies.export:${payload.domain.trim().toLowerCase().replace(/^www\./,"")}` ``
- `assertCreatable(_, { extensionStore })` → check online+capability cookies; fail `{ ok:false, status:409, error:{ type:"no_online_extension", message:"No online browser extension with cookies capability. Open Chrome and load Leo cookie.txt Locally." } }`
- `materializeResult(task, body, { configDir })`:
  - require `Array.isArray(body.cookies)`
  - if empty after normalize, throw object/error `{ type:"no_cookies", message:"No cookies returned for domain." }`
  - return `writeNetscapeCookieFile(...)`

- [ ] **Step 4: Run tests — expect PASS**

```bash
node --test tests/unit/extension-task-registry.test.mjs tests/unit/extension-task-cookies-export.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add lib/extension-tasks/registry.mjs lib/extension-tasks/write-netscape.mjs lib/extension-tasks/types/cookies-export.mjs tests/unit/extension-task-registry.test.mjs tests/unit/extension-task-cookies-export.test.mjs
git commit -m "feat(extension-tasks): add type registry and cookies.export plugin"
```

---

### Task 3: HTTP routes + system factory + route tests

**Files:**
- Create: `lib/extension-tasks/http.mjs`
- Create: `lib/extension-tasks/routes.mjs`
- Create: `lib/extension-tasks/create-system.mjs`
- Test: `tests/unit/extension-task-routes.test.mjs`

**Interfaces:**
- Consumes: store, registry, extensionStore, configDir
- Produces:
  - `createExtensionTaskSystem({ dataDir, configDir, extensionStore }) -> { store, registry, routeExtensionTaskRequest, routeCookieExportViaExtension }`
  - `routeExtensionTaskRequest(req, res, context, reqPath, deps)`
  - `routeCookieExportViaExtension(req, res, context, reqPath, deps)`

- [ ] **Step 1: Write route tests using minimal mock req/res**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createExtensionTaskSystem } from "../../lib/extension-tasks/create-system.mjs";
import { createExtensionStore } from "../../lib/extension-registry/store.mjs";

function mockReqRes({ method = "GET", body = null } = {}) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  let i = 0;
  const req = {
    method,
    on(event, cb) {
      if (event === "data") {
        if (chunks[i]) cb(chunks[i++]);
      }
      if (event === "end") queue.nextTick(cb);
      if (event === "error") {/* no-op */}
      return req;
    },
  };
  let status = 0;
  let payload = null;
  const res = {
    writeHead(code) { status = code; },
    end(buf) { payload = JSON.parse(String(buf || "{}")); },
  };
  return {
    req,
    res,
    get result() { return { status, payload }; },
  };
}

async function withSystem(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-sys-"));
  const extensionStore = createExtensionStore({ dataDir });
  const system = createExtensionTaskSystem({ dataDir, configDir: dataDir, extensionStore });
  try {
    await fn({ system, extensionStore, dataDir });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test("create fails without online extension", async () => {
  await withSystem(async ({ system }) => {
    const http = mockReqRes({ method: "POST", body: { domain: "bilibili.com" } });
    await system.routeCookieExportViaExtension(http.req, http.res, {}, "/v1/cookies/export-via-extension");
    assert.equal(http.result.status, 409);
    assert.equal(http.result.payload.error.type, "no_online_extension");
  });
});

test("create + claim + complete happy path", async () => {
  await withSystem(async ({ system, extensionStore, dataDir }) => {
    extensionStore.register({ id: "ext1", name: "Leo", version: "1.1.0", capabilities: ["cookies"], permissions: [] });
    const createHttp = mockReqRes({ method: "POST", body: { domain: "example.com" } });
    await system.routeCookieExportViaExtension(createHttp.req, createHttp.res, {}, "/v1/cookies/export-via-extension");
    assert.equal(createHttp.result.status, 200);
    const taskId = createHttp.result.payload.task_id;
    assert.ok(taskId);

    const claimHttp = mockReqRes({ method: "POST", body: { extension_id: "ext1", capabilities: ["cookies"], limit: 1 } });
    await system.routeExtensionTaskRequest(claimHttp.req, claimHttp.res, {}, "/v1/extension-tasks/claim", system.deps);
    assert.equal(claimHttp.result.status, 200);
    assert.equal(claimHttp.result.payload.tasks.length, 1);

    const completeHttp = mockReqRes({
      method: "POST",
      body: {
        extension_id: "ext1",
        cookies: [{ domain: ".example.com", path: "/", name: "sid", value: "1", secure: true, httpOnly: false, expirationDate: 1700000000 }],
      },
    });
    await system.routeExtensionTaskRequest(completeHttp.req, completeHttp.res, {}, `/v1/extension-tasks/${taskId}/complete`, system.deps);
    assert.equal(completeHttp.result.status, 200);
    assert.equal(completeHttp.result.payload.task.status, "succeeded");
    assert.ok(fs.existsSync(completeHttp.result.payload.task.result.file_path));

    const getHttp = mockReqRes({ method: "GET" });
    await system.routeCookieExportViaExtension(getHttp.req, getHttp.res, {}, `/v1/cookies/export-via-extension/${taskId}`);
    assert.equal(getHttp.result.status, 200);
    assert.equal(getHttp.result.payload.status, "succeeded");
    assert.ok(String(getHttp.result.payload.result.file_path).includes(path.basename(dataDir)) || fs.existsSync(getHttp.result.payload.result.file_path));
  });
});
```

Note: expose `system.deps = { store, registry, extensionStore, configDir }` from factory for tests, or pass deps explicitly as shown.

- [ ] **Step 2: Run tests — expect FAIL**

```bash
node --test tests/unit/extension-task-routes.test.mjs
```

- [ ] **Step 3: Implement http helpers, routes, create-system**

`http.mjs`:
```js
export function sendJson(res, status, data) { /* same as extension-registry routes */ }
export function readJsonBody(req) { /* same promise reader */ }
```

`routes.mjs` handlers:

1. `POST /v1/extension-tasks`
   - read body, require `type`
   - `def = registry.get(type)` else 400 `unknown_task_type`
   - `validated = def.validateCreate(body.payload ?? body)`
   - if not ok → status/error
   - if `def.assertCreatable` → run with `{ extensionStore }`; if not ok return
   - `dedupeKey = def.dedupeKey?.(validated.payload) ?? null`
   - `task = store.create({ type: def.type, capability: body.capability || def.capability, payload: validated.payload, dedupeKey })`
   - 200 `{ task }`

2. `GET /v1/extension-tasks/:id` → 200 `{ task }` or 404

3. `POST /v1/extension-tasks/claim`
   - require extension_id
   - if `!extensionStore.get(id)` → 404 `extension_not_registered`
   - `extensionStore.heartbeat(id)` if available
   - capabilities from body or registered extension
   - `tasks = store.claim(...)`
   - 200 `{ tasks }`

4. `POST /v1/extension-tasks/:id/complete`
   - load task; get def; `materializeResult`
   - on materialize throw no_cookies → `store.fail` + 200 with failed task **or** 200 always with updated task; prefer: fail task and return `{ task }` with status failed and HTTP 200 for async worker simplicity, **except** owner conflict → 409
   - success: `store.complete` with result

5. `POST /v1/extension-tasks/:id/fail`
   - `store.fail`

Cookie facade:

- `POST /v1/cookies/export-via-extension` → force type cookies.export create path; response:
  ```json
  {
    "task_id": "...",
    "status": "queued",
    "poll_after_ms": 2000,
    "max_polls_suggested": 30,
    "task": { ...optional full task... }
  }
  ```
- `GET /v1/cookies/export-via-extension/:taskId` →
  ```json
  { "task_id", "status", "result", "error", "task" }
  ```

`create-system.mjs`:
```js
export function createExtensionTaskSystem({ dataDir, configDir, extensionStore, ttlMs }) {
  const store = createExtensionTaskStore({ dataDir, ttlMs });
  const registry = createExtensionTaskTypeRegistry();
  registry.register("cookies.export", createCookiesExportType());
  const deps = { store, registry, extensionStore, configDir };
  return {
    store,
    registry,
    deps,
    routeExtensionTaskRequest: (req, res, context, reqPath) => routeExtensionTaskRequest(req, res, context, reqPath, deps),
    routeCookieExportViaExtension: (req, res, context, reqPath) => routeCookieExportViaExtension(req, res, context, reqPath, deps),
  };
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
node --test tests/unit/extension-task-routes.test.mjs tests/unit/extension-task-store.test.mjs tests/unit/extension-task-registry.test.mjs tests/unit/extension-task-cookies-export.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add lib/extension-tasks/http.mjs lib/extension-tasks/routes.mjs lib/extension-tasks/create-system.mjs tests/unit/extension-task-routes.test.mjs
git commit -m "feat(extension-tasks): add HTTP routes and system factory"
```

---

### Task 4: Wire server.js (additive only)

**Files:**
- Modify: `server.js` (imports ~78-79, globals ~177, dispatch ~951-962, `routeCookieRequest` ~3038-3122)

**Interfaces:**
- Consumes: `createExtensionTaskSystem`
- Produces: live routes on gateway process

- [ ] **Step 1: Add import + global system next to extension store**

Near:
```js
import { createExtensionStore } from "./lib/extension-registry/store.mjs";
import { routeExtensionRequest, routeCookieImport } from "./lib/extension-registry/routes.mjs";
```

Add:
```js
import { createExtensionTaskSystem } from "./lib/extension-tasks/create-system.mjs";
```

Near `const globalExtensionStore = createExtensionStore(...)` add:
```js
const globalExtensionTaskSystem = createExtensionTaskSystem({
  dataDir: path.dirname(GATEWAY_CONFIG_FILE),
  configDir: path.dirname(GATEWAY_CONFIG_FILE),
  extensionStore: globalExtensionStore,
});
```

- [ ] **Step 2: Mount `/v1/extension-tasks` dispatch (before or after extensions block; additive)**

```js
if (reqPath.startsWith("/v1/extension-tasks")) {
  if (!checkLocalAuth(req, res)) return;
  await globalExtensionTaskSystem.routeExtensionTaskRequest(req, res, context, reqPath);
  return;
}
```

- [ ] **Step 3: Add cookie facade branches inside `routeCookieRequest` BEFORE final 404, AFTER existing import branch**

```js
// POST /v1/cookies/export-via-extension
if (reqPath === "/v1/cookies/export-via-extension" && req.method === "POST") {
  await globalExtensionTaskSystem.routeCookieExportViaExtension(req, res, context, reqPath);
  return;
}
// GET /v1/cookies/export-via-extension/:taskId
if (reqPath.startsWith("/v1/cookies/export-via-extension/") && req.method === "GET") {
  await globalExtensionTaskSystem.routeCookieExportViaExtension(req, res, context, reqPath);
  return;
}
```

Do **not** alter existing export/import/browsers/domains/files logic.

- [ ] **Step 4: Syntax check + unit tests + existing cookie/extension tests**

```bash
node --check server.js
node --test tests/unit/extension-task-*.test.mjs tests/unit/extension-store.test.mjs tests/unit/cookie-extractor.test.mjs
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(server): mount extension-task routes and cookie export facade"
```

---

### Task 5: Extension claim loop (Path A/B untouched)

**Files:**
- Modify: `extensions/leo-cookie-txt-locally/background.js`
- Modify: `extensions/leo-cookie-txt-locally/manifest.json` (version `1.1.0`)
- Modify: `extensions/leo-cookie-txt-locally/README.md`

**Interfaces:**
- Consumes: `POST /v1/extension-tasks/claim|.../complete|.../fail`
- Produces: automatic cookie export worker

- [ ] **Step 1: Bump manifest version**

```json
"version": "1.1.0"
```

- [ ] **Step 2: Add claim loop to background.js without removing existing listeners**

Keep: register, heartbeat, onMessageExternal, alarms heartbeat, storage listener.

Add constants:
```js
const CLAIM_INTERVAL_MS = 2000;
let claimInFlight = false;
let claimTimer = null;
```

Add functions:
```js
async function claimAndRun() {
  if (claimInFlight) return;
  claimInFlight = true;
  try {
    const url = await getGatewayUrl();
    const resp = await fetch(`${url}/v1/extension-tasks/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        extension_id: chrome.runtime.id,
        capabilities: ["cookies"],
        limit: 1,
      }),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const tasks = data.tasks || [];
    for (const task of tasks) {
      await executeTask(url, task);
    }
  } catch {
    /* silent */
  } finally {
    claimInFlight = false;
  }
}

async function executeTask(gatewayUrl, task) {
  if (task.type !== "cookies.export") {
    await fetch(`${gatewayUrl}/v1/extension-tasks/${task.id}/fail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        extension_id: chrome.runtime.id,
        error: { type: "unsupported_task_type", message: `Unsupported task type: ${task.type}` },
      }),
    });
    return;
  }
  const domain = (task.payload && task.payload.domain) || "";
  const cookies = await chrome.cookies.getAll({ domain });
  if (!cookies || cookies.length === 0) {
    await fetch(`${gatewayUrl}/v1/extension-tasks/${task.id}/fail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        extension_id: chrome.runtime.id,
        error: { type: "no_cookies", message: `No cookies for domain ${domain}` },
      }),
    });
    return;
  }
  await fetch(`${gatewayUrl}/v1/extension-tasks/${task.id}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      extension_id: chrome.runtime.id,
      cookies,
    }),
  });
}

function scheduleClaimLoop() {
  if (claimTimer) clearInterval(claimTimer);
  claimTimer = setInterval(claimAndRun, CLAIM_INTERVAL_MS);
  claimAndRun();
}
```

Call `scheduleClaimLoop()` after successful `register()` (alongside heartbeat schedule).

Also on alarm heartbeat callback, fire `claimAndRun()` once as backup when SW wakes.

Do **not** modify popup.js.

- [ ] **Step 3: Update README with Path C**

Add section:

```markdown
### Via agent / skill (Path C)
1. Ensure the extension is loaded and gateway is running.
2. Create a task:
   `POST /v1/cookies/export-via-extension` with `{"domain":"bilibili.com"}`
3. Poll `GET /v1/cookies/export-via-extension/:task_id` every 2s, max 30 times.
4. On success, use returned `result.file_path`.

Reload the unpacked extension after upgrading to 1.1.0.
```

- [ ] **Step 4: Sanity parse JS**

```bash
node --check extensions/leo-cookie-txt-locally/background.js
```

(If node --check fails on chrome globals, skip and rely on manual load; background is browser JS — `node --check` usually still parses syntax.)

- [ ] **Step 5: Commit**

```bash
git add extensions/leo-cookie-txt-locally/background.js extensions/leo-cookie-txt-locally/manifest.json extensions/leo-cookie-txt-locally/README.md
git commit -m "feat(extension): claim and complete cookie export tasks"
```

---

### Task 6: Skill docs for Path C + optional import helper share

**Files:**
- Modify: `lib/skills/leo-cookie-exporter/SKILL.md`
- Modify: `lib/skills/leo-cookie-exporter/agents/openai.yaml`
- Modify (optional behavior-preserving): `lib/extension-registry/routes.mjs` to use `writeNetscapeCookieFile` **only if** import output remains identical under unit test

- [ ] **Step 1: Update SKILL.md with Path C as preferred when gateway+extension online**

Document order:
1. Path C agent API (export-via-extension + bounded poll)
2. Path A/B manual extension UI
3. Local script fallback

Include exact curl examples and poll limits (2s × 30). Mention `no_online_extension`.

- [ ] **Step 2: Update agents/openai.yaml short_description/default_prompt** to prefer Path C then fallback

- [ ] **Step 3: Optional refactor import route**

If doing it:
- Change `routeCookieImport` to call `writeNetscapeCookieFile`
- Re-run any import-related tests / manual response shape check: still `{ file_path, count, domains }`

If risky in review, **skip** this step; duplicate write logic is acceptable for v1 as long as netscape helper is used by task path.

- [ ] **Step 4: Run full relevant unit suite**

```bash
node --test tests/unit/extension-task-*.test.mjs tests/unit/extension-store.test.mjs tests/unit/cookie-extractor.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add lib/skills/leo-cookie-exporter/SKILL.md lib/skills/leo-cookie-exporter/agents/openai.yaml lib/extension-registry/routes.mjs
git commit -m "docs(skill): document extension-task cookie export path for agents"
```

---

### Task 7: Manual verification checklist + final regression

**Files:** none required (notes only)

- [ ] **Step 1: Start gateway in worktree**

```bash
# use a free port if 8788 busy, e.g. 8790
PORT=8790 node server.js
```

- [ ] **Step 2: Register simulation without browser (unit already covers); with browser:**
  1. Load unpacked `extensions/leo-cookie-txt-locally` (v1.1.0)
  2. Set gateway URL in popup if not default
  3. Confirm `/v1/extensions/list` shows online

- [ ] **Step 3: Agent path**

```bash
curl -s -X POST http://127.0.0.1:8790/v1/cookies/export-via-extension \
  -H 'Content-Type: application/json' \
  -d '{"domain":"bilibili.com"}'
# poll
curl -s http://127.0.0.1:8790/v1/cookies/export-via-extension/TASK_ID
```

Expected: queued → succeeded with file_path; or no_online_extension if extension offline.

- [ ] **Step 4: Regression**
  - popup export still works
  - page Path A still works if used
  - `POST /v1/cookies/export` still works on macOS local path

- [ ] **Step 5: Final commit only if verification notes/docs tweaks needed; otherwise done**

```bash
git status -sb
node --test tests/unit/extension-task-*.test.mjs tests/unit/extension-store.test.mjs tests/unit/cookie-extractor.test.mjs
```

---

## Spec Coverage Self-Review

| Spec requirement | Task |
|------------------|------|
| Extension pull model | Task 5 |
| Create + bounded poll skill UX | Task 3 facade + Task 6 docs |
| Fail create if no online extension | Task 2 assertCreatable + Task 3 routes |
| No historical path regressions | Task 4 additive wiring + Task 5 keep Path A/B + Task 7 |
| Generic bus + cookie facade | Task 3 |
| Type registry OCP | Task 2 |
| Separate from lib/task-queue | Task 1-3 new module |
| TTL 90s / claim 2s / poll 2s×30 | store default + facade fields + skill docs + extension interval |
| Dedupe active domain tasks | Task 1 + cookies dedupeKey |
| Netscape write reuse | Task 2 writer (+ optional Task 6 import) |
| Tests | Tasks 1-4 |
| Skill docs | Task 6 |
| Manifest bump / README | Task 5 |

## Placeholder Scan

- No TBD/TODO left in steps.
- Concrete file paths, commands, and code sketches included.
- Error types match design: `no_online_extension`, `timeout`, `no_cookies`, `unsupported_task_type`, `unknown_task_type`, `extension_not_registered`.

## Type/Name Consistency

- Task id prefix: `etsk_`
- Type name: `cookies.export`
- Capability: `cookies`
- Facade paths: `/v1/cookies/export-via-extension` and `/v1/cookies/export-via-extension/:id`
- Generic paths: `/v1/extension-tasks`, `/claim`, `/:id`, `/:id/complete`, `/:id/fail`
- Factory: `createExtensionTaskSystem`
- Store: `createExtensionTaskStore`
- Registry: `createExtensionTaskTypeRegistry`

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-07-extension-task-cookie-export-plan.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks
2. **Inline Execution** — execute tasks in this session with executing-plans checkpoints

Which approach?
