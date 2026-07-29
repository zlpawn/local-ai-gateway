# Agent-Native CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement an agent-first CLI that can configure and operate the local AI gateway across the full config-panel surface using a stable JSON protocol.

**Architecture:** Shared domain services under `lib/domain/*`, thin command handlers under `lib/cli/commands/*`, and a lark-cli-style JSON envelope transport. Local file stores handle offline config; live HTTP is used for health/hot state; process management stays in the existing gateway lifecycle layer.

**Tech Stack:** Node.js >= 18, native `node:test`, existing ESM modules in `lib/`, current `bin/cli.js` entrypoint, no new runtime dependencies unless absolutely necessary.

## Global Constraints

- Public CLI command name is `shrimp` (compat alias `local-ai-gateway` allowed during transition).
- Top-level OAuth command is `upstream google-oauth` (not `antigravity`).
- Target data dir constant is `~/.shrimp` with compatibility for `~/.local-ai-gateway` during migration.
- Default CLI output format is JSON (`--format json`).
- Success stdout envelope: `{ ok: true, command, data, meta, next? }`.
- Error stderr envelope: `{ ok: false, command, error, meta? }` with stable `error.type` / `error.code`.
- Mutating commands support `--dry-run`.
- Literal `--api-key` is allowed; outputs/logs must redact secrets.
- `gateway.secrets.json` stays `{ api_keys: ... }` only.
- `antigravity.secrets.json` remains isolated.
- Generic client copy replaces DeepTutor-only UX as the primary model.
- CLI binary name is `shrimp`; use constants for bin/service/data-dir strings. Package/data-dir migration may trail the binary rename. OAuth command surface is `upstream google-oauth`.
- Prefer extending existing modules over broad rewrites.
- TDD: write failing tests before implementation in each task.
- Frequent atomic commits after each green task.

**Spec:** `docs/superpowers/specs/2026-07-29-agent-native-cli-design.md`

---

## File structure (target)

### Create

- `lib/cli/protocol.mjs` — envelopes, exit codes, redaction, printers
- `lib/cli/registry.mjs` — command registration + schema export
- `lib/cli/parse-args.mjs` — shared argv helpers
- `lib/cli/commands/lifecycle.mjs`
- `lib/cli/commands/config.mjs`
- `lib/cli/commands/endpoint.mjs`
- `lib/cli/commands/secret.mjs`
- `lib/cli/commands/client.mjs`
- `lib/cli/commands/apply.mjs`
- `lib/cli/commands/sync.mjs`
- `lib/cli/commands/skill.mjs`
- `lib/cli/commands/cli-tool.mjs`
- `lib/cli/commands/tool.mjs`
- `lib/cli/commands/upstream.mjs`
- `lib/cli/commands/doctor.mjs`
- `lib/cli/commands/schema.mjs`
- `lib/domain/live-gateway.mjs`
- `lib/domain/config-service.mjs`
- `lib/domain/endpoint-service.mjs`
- `lib/domain/secret-service.mjs`
- `lib/domain/client-service.mjs`
- `lib/domain/apply-service.mjs`
- `lib/domain/doctor-service.mjs`
- `lib/domain/sync-service.mjs`
- `lib/domain/skill-service.mjs`
- `lib/domain/cli-tool-service.mjs`
- `lib/domain/tool-service.mjs`
- `tests/unit/cli-protocol.test.mjs`
- `tests/unit/cli-registry.test.mjs`
- `tests/unit/endpoint-service.test.mjs`
- `tests/unit/client-copy-service.test.mjs`
- `tests/unit/secret-service.test.mjs`
- `tests/unit/doctor-service.test.mjs`
- `tests/integration/agent-cli.integration.test.mjs`

### Modify

- `bin/cli.js` — dispatch via registry
- `lib/cli/gateway-service.mjs` — structured results for lifecycle
- `lib/cli/init-config.mjs` — structured bootstrap results as needed
- `lib/config/gateway-config-store.mjs` — copy modes if needed
- `package.json` — scripts for new tests if useful
- `README.md` — agent quick start
- `desktop/config-panel.html` — generic copy UI (Phase 4 task)

---

### Task 1: CLI protocol primitives

**Files:**
- Create: `lib/cli/protocol.mjs`
- Test: `tests/unit/cli-protocol.test.mjs`

**Interfaces:**
- Produces:
  - `EXIT = { OK:0, USAGE:2, VALIDATION:2, NOT_FOUND:3, CONFLICT:4, AUTH:5, RUNTIME:6, EXTERNAL:7, INTERNAL:1 }`
  - `successEnvelope({ command, data, meta, next }) -> object`
  - `errorEnvelope({ command, error, meta }) -> object`
  - `printSuccess(io, envelope, format)`
  - `printError(io, envelope, format)`
  - `redactSecrets(value) -> value`
  - `formatSecretState(value) -> "missing"|"stored"|`env:NAME``

- [ ] **Step 1: Write failing protocol tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  successEnvelope,
  errorEnvelope,
  redactSecrets,
  formatSecretState,
  EXIT,
} from "../../lib/cli/protocol.mjs";

test("success envelope shape", () => {
  const env = successEnvelope({
    command: "status",
    data: { running: true },
    meta: { dry_run: false },
    next: [],
  });
  assert.equal(env.ok, true);
  assert.equal(env.command, "status");
  assert.deepEqual(env.data, { running: true });
});

test("error envelope shape", () => {
  const env = errorEnvelope({
    command: "endpoint.add",
    error: {
      type: "validation",
      code: "missing_fields",
      message: "base_url is required",
      fields: ["base_url"],
      hint: "Provide --base-url",
      retryable: false,
    },
  });
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "missing_fields");
});

test("redacts api keys and bearer tokens", () => {
  const redacted = redactSecrets({
    api_key: "sk-live-123",
    nested: { authorization: "Bearer abc", token: "xyz" },
    safe: "ok",
  });
  assert.equal(redacted.api_key, "***");
  assert.equal(redacted.nested.authorization, "***");
  assert.equal(redacted.nested.token, "***");
  assert.equal(redacted.safe, "ok");
});

test("formatSecretState distinguishes missing/stored/env", () => {
  assert.equal(formatSecretState(undefined), "missing");
  assert.equal(formatSecretState("sk-abc"), "stored");
  assert.equal(formatSecretState("env:ARK_API_KEY"), "env:ARK_API_KEY");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/cli-protocol.test.mjs`  
Expected: FAIL module not found

- [ ] **Step 3: Implement `lib/cli/protocol.mjs`**

Implement envelope builders, deep redaction for keys matching `/api[_-]?key/i`, `authorization`, `token`, `access_token`, `refresh_token`, `client_secret`, and printers that:

- json: `JSON.stringify(envelope, null, 2)`
- pretty: compact human summary but still no secrets
- write success to `io.log` / stdout path, errors to `io.error` / stderr path

- [ ] **Step 4: Run tests**

Run: `node --test tests/unit/cli-protocol.test.mjs`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/cli/protocol.mjs tests/unit/cli-protocol.test.mjs
git commit -m "feat(cli): add agent JSON protocol helpers"
```

---

### Task 2: Command registry + schema

**Files:**
- Create: `lib/cli/registry.mjs`
- Create: `lib/cli/parse-args.mjs`
- Create: `lib/cli/commands/schema.mjs`
- Test: `tests/unit/cli-registry.test.mjs`

**Interfaces:**
- Produces:
  - `createRegistry() -> { register, get, list, toSchema, dispatch }`
  - `parseGlobalFlags(argv) -> { flags, rest }`
  - command descriptor:
    `{ name, description, mutating=false, dryRun=false, params=[], handler }`

- [ ] **Step 1: Write failing registry tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createRegistry } from "../../lib/cli/registry.mjs";

test("registry dispatches a command and returns handler result", async () => {
  const reg = createRegistry();
  reg.register({
    name: "ping",
    description: "ping",
    handler: async () => ({ data: { pong: true } }),
  });
  const result = await reg.dispatch(["ping"], { format: "json" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { pong: true });
});

test("unknown command becomes usage error", async () => {
  const reg = createRegistry();
  const result = await reg.dispatch(["nope"], {});
  assert.equal(result.ok, false);
  assert.equal(result.error.type, "usage");
});

test("schema export includes registered params", () => {
  const reg = createRegistry();
  reg.register({
    name: "endpoint.add",
    description: "add endpoint",
    mutating: true,
    dryRun: true,
    params: [{ name: "client", required: true, type: "string" }],
    handler: async () => ({ data: {} }),
  });
  const schema = reg.toSchema("endpoint.add");
  assert.equal(schema.name, "endpoint.add");
  assert.equal(schema.params[0].name, "client");
});
```

- [ ] **Step 2: Run test to verify fail**

Run: `node --test tests/unit/cli-registry.test.mjs`  
Expected: FAIL

- [ ] **Step 3: Implement registry + parse helpers**

Requirements:

- support nested command paths (`endpoint add` => `endpoint.add` or keep space form consistently; pick **space form in argv**, dotted form in envelope `command`)
- global flags parsed before command lookup
- `--dry-run` rejected or ignored cleanly on non-mutating commands
- `schema` command lists all or one command

- [ ] **Step 4: Run tests**

Run: `node --test tests/unit/cli-registry.test.mjs`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/cli/registry.mjs lib/cli/parse-args.mjs lib/cli/commands/schema.mjs tests/unit/cli-registry.test.mjs
git commit -m "feat(cli): add command registry and schema export"
```

---

### Task 3: Wire bin entry + wrap lifecycle commands

**Files:**
- Modify: `bin/cli.js`
- Create: `lib/cli/commands/lifecycle.mjs`
- Modify: `lib/cli/gateway-service.mjs` as needed to return structured data
- Modify: `tests/unit/gateway-service.test.mjs` if assertions depend on text-only output
- Modify: `tests/integration/gateway-cli.integration.test.mjs` only if necessary for JSON default

**Interfaces:**
- Consumes: registry, protocol, existing `runGatewayCommand` / lifecycle helpers
- Produces: lifecycle commands through registry with JSON envelopes

- [ ] **Step 1: Write/adjust failing tests for structured lifecycle status**

Add unit coverage that `status` handler returns `{ running, metadata?, health? }` object rather than only printing text. If current integration tests assert human text, keep a `--format pretty` path or preserve dual print for lifecycle during transition.

Recommended compatibility approach:

- handlers return structured `data`
- printer renders JSON by default
- pretty format approximates old text

- [ ] **Step 2: Run relevant tests to observe failures**

Run:

```bash
node --test tests/unit/gateway-service.test.mjs
node --test tests/integration/gateway-cli.integration.test.mjs
```

- [ ] **Step 3: Implement lifecycle command module and bin dispatch**

`bin/cli.js` responsibilities:

1. resolve package root + data dir (existing)
2. initialize config (existing)
3. load env (existing)
4. parse global flags
5. dispatch registry
6. print envelope / set exit code

Register: `start stop restart status logs stdout stderr path init setup`

Also introduce naming constants and ensure package bin can expose `shrimp` (alias `local-ai-gateway` ok for transition).

- [ ] **Step 4: Run lifecycle tests**

Run:

```bash
node --test tests/unit/gateway-service.test.mjs tests/unit/cli-protocol.test.mjs tests/unit/cli-registry.test.mjs
node --test tests/integration/gateway-cli.integration.test.mjs
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bin/cli.js lib/cli/commands/lifecycle.mjs lib/cli/gateway-service.mjs tests
git commit -m "feat(cli): route lifecycle commands through agent registry"
```

---

### Task 4: Config service + validate/get

**Files:**
- Create: `lib/domain/config-service.mjs`
- Create: `lib/cli/commands/config.mjs`
- Test: extend or create `tests/unit/config-service-cli.test.mjs`

**Interfaces:**
- Produces:
  - `getConfig({ configPath, secretsPath })`
  - `validateConfig({ configPath, secretsPath })`
  - `restoreTemplate({ packageRoot, dataDir, yes, dryRun })`

- [ ] **Step 1: Write failing tests using temp dirs**

Cover:

- get returns public config and secret states without raw keys
- validate surfaces store validation issues as structured errors
- restore-template refuses overwrite without `--yes`

- [ ] **Step 2: Run fail**

Run: `node --test tests/unit/config-service-cli.test.mjs`

- [ ] **Step 3: Implement service using `loadGatewayState` / `saveGatewayState` / examples**

Do not invent a second config schema. Reuse `lib/config/gateway-config-store.mjs`.

- [ ] **Step 4: Pass tests + register commands**

Commands:

- `config get`
- `config validate`
- `config restore-template`

- [ ] **Step 5: Commit**

```bash
git add lib/domain/config-service.mjs lib/cli/commands/config.mjs tests/unit/config-service-cli.test.mjs
git commit -m "feat(cli): add config get/validate/restore commands"
```

---

### Task 5: Endpoint service CRUD

**Files:**
- Create: `lib/domain/endpoint-service.mjs`
- Create: `lib/cli/commands/endpoint.mjs`
- Test: `tests/unit/endpoint-service.test.mjs`

**Interfaces:**
- Produces:
  - `listEndpoints({ client, purpose })`
  - `getEndpoint({ id })`
  - `addEndpoint(input)`
  - `updateEndpoint(input)`
  - `removeEndpoint({ id, yes })`
  - `setDefaultEndpoint({ id })`
  - `enableEndpoint({ id, enabled })`

- [ ] **Step 1: Write failing CRUD tests in temp data dir**

Minimum cases:

1. add endpoint to `code` with type/base_url/models
2. reject missing base_url with `missing_fields`
3. update name/model mapping
4. set default
5. remove requires `--yes` if policy set, or removes cleanly
6. dry-run add does not write file

Use real filesystem temp dirs and existing validation rules.

- [ ] **Step 2: Run fail**

Run: `node --test tests/unit/endpoint-service.test.mjs`

- [ ] **Step 3: Implement endpoint service**

Implementation notes:

- generate ids via `createEndpointId`
- preserve purpose-specific fields (embedding/web_search/vision_fallback)
- keep public model uniqueness rules intact
- return summary objects suitable for agents

- [ ] **Step 4: Register commands and pass tests**

- [ ] **Step 5: Commit**

```bash
git add lib/domain/endpoint-service.mjs lib/cli/commands/endpoint.mjs tests/unit/endpoint-service.test.mjs
git commit -m "feat(cli): add endpoint CRUD for agent configuration"
```

---

### Task 6: Secret service with redaction

**Files:**
- Create: `lib/domain/secret-service.mjs`
- Create: `lib/cli/commands/secret.mjs`
- Test: `tests/unit/secret-service.test.mjs`

**Interfaces:**
- Produces:
  - `listSecrets({ client? }) -> [{ endpoint_id, state }]`
  - `getSecret({ endpointId }) -> { endpoint_id, state }`
  - `setSecret({ endpointId, apiKey?, apiKeyEnv?, dryRun })`
  - `unsetSecret({ endpointId, yes, dryRun })`

- [ ] **Step 1: Write failing tests**

Cases:

1. set literal key writes to secrets file but list/get returns `stored`
2. set env ref writes `env:NAME` and get returns `env:NAME`
3. envelopes/redaction never include raw key
4. unset removes key

- [ ] **Step 2: Run fail**

- [ ] **Step 3: Implement secret service on `gateway.secrets.json` only**

Reject attempts to store antigravity OAuth fields here.

- [ ] **Step 4: Pass tests + register commands**

- [ ] **Step 5: Commit**

```bash
git add lib/domain/secret-service.mjs lib/cli/commands/secret.mjs tests/unit/secret-service.test.mjs
git commit -m "feat(cli): add secret set/list with output redaction"
```

---

### Task 7: Generic client copy modes

**Files:**
- Modify: `lib/config/gateway-config-store.mjs` (if extending copy helper)
- Create: `lib/domain/client-service.mjs`
- Create: `lib/cli/commands/client.mjs` (list/get/copy/add/remove parts)
- Test: `tests/unit/client-copy-service.test.mjs`
- Extend: `tests/unit/gateway-config-store.test.mjs` if store behavior changes

**Interfaces:**
- Produces:
  - `listClients()`
  - `getClient({ client })`
  - `copyClient({ from, to, mode: "replace"|"merge"|"fill-empty", dryRun })`
  - optionally `addClient({ client, copyFrom?, mode? })`

- [ ] **Step 1: Write failing copy-mode tests**

Cases:

1. replace codex -> deeptutor copies all endpoints and secrets with new ids
2. merge keeps target-only endpoints and appends clones
3. fill-empty no-ops when target already has endpoints
4. from == to validation error
5. missing source client not_found

Example assertion sketch:

```js
const result = copyClient({ from: "codex", to: "deeptutor", mode: "replace" });
assert.equal(result.copied, sourceCount);
assert.notEqual(result.config.clients.deeptutor.endpoints[0].id, sourceId);
assert.equal(
  result.secrets.api_keys[result.config.clients.deeptutor.endpoints[0].id],
  sourceSecretValue,
);
```

- [ ] **Step 2: Run fail**

- [ ] **Step 3: Implement modes**

Prefer implementing mode logic in `client-service` using current `copyClientEndpoints` for replace, and explicit merge/fill-empty logic around it.

Preserve current replace semantics exactly for compatibility.

- [ ] **Step 4: Register `client list|get|copy|add|remove` and pass tests**

- [ ] **Step 5: Commit**

```bash
git add lib/domain/client-service.mjs lib/cli/commands/client.mjs lib/config/gateway-config-store.mjs tests/unit/client-copy-service.test.mjs tests/unit/gateway-config-store.test.mjs
git commit -m "feat(cli): generalize client endpoint copy modes"
```

---

### Task 8: Doctor JSON

**Files:**
- Create: `lib/domain/doctor-service.mjs`
- Create: `lib/cli/commands/doctor.mjs`
- Create: `lib/domain/live-gateway.mjs`
- Test: `tests/unit/doctor-service.test.mjs`
- Optionally refactor logic out of `scripts/doctor.mjs` to call the service

**Interfaces:**
- Produces:
  - `runDoctor({ dataDir, configPath, secretsPath, port, host }) -> doctorReport`
  - `fetchHealth({ host, port })`

- [ ] **Step 1: Write failing tests with fixture config**

Cover:

- invalid config => valid=false + issues
- missing secret => endpoint key_state missing + recommendation
- runtime listening false when port closed
- recommendations include concrete next commands

- [ ] **Step 2: Run fail**

- [ ] **Step 3: Implement doctor service**

Port useful checks from `scripts/doctor.mjs`, but return structured data. Keep script as thin wrapper if easy.

- [ ] **Step 4: Pass tests**

- [ ] **Step 5: Commit**

```bash
git add lib/domain/doctor-service.mjs lib/domain/live-gateway.mjs lib/cli/commands/doctor.mjs scripts/doctor.mjs tests/unit/doctor-service.test.mjs
git commit -m "feat(cli): add structured doctor command"
```

---

### Task 9: Client apply + slots + codex helpers

**Files:**
- Create: `lib/domain/apply-service.mjs`
- Create: `lib/cli/commands/apply.mjs`
- Modify/reuse: `lib/config/claude-code-settings.mjs`, codex catalog/history modules
- Tests: new unit tests under `tests/unit/apply-service.test.mjs` + reuse existing codex/claude tests

**Interfaces:**
- Produces:
  - `getModelSlots({ client:"code" })`
  - `setModelSlots({ client:"code", slots, dryRun })`
  - `applyClient({ client, mode, dryRun })`
  - `snippetForClient({ client })`
  - `writeCodexCatalog()`
  - `unifyCodexHistory({ apply, dryRun })`

- [ ] **Step 1: Write failing tests with temp home dirs**

Use temporary `HOME`/`USERPROFILE` style paths where existing helpers allow injection. If helpers read OS home directly, extend them to accept explicit paths rather than monkeypatching globals when practical.

Cases:

1. set Claude Code slots updates config and apply writes settings structure
2. codex snippet contains `/codex/v1` and catalog path
3. history unify dry-run does not modify files

- [ ] **Step 2: Run fail**

- [ ] **Step 3: Implement apply service**

Policy for Codex config.toml in v1:

- default `client apply --client codex` writes catalog + returns snippet
- actual `config.toml` mutation only with explicit `--write-config --yes`

Document this in command schema help.

- [ ] **Step 4: Pass tests + register commands**

Commands:

- `client slots get|set`
- `client apply`
- `client snippet`
- `codex catalog write|verify`
- `codex history unify`

- [ ] **Step 5: Commit**

```bash
git add lib/domain/apply-service.mjs lib/cli/commands/apply.mjs tests/unit/apply-service.test.mjs
git commit -m "feat(cli): add client apply, slots, and codex helpers"
```

---

### Task 10: Session sync command coverage

**Files:**
- Create: `lib/domain/sync-service.mjs`
- Create: `lib/cli/commands/sync.mjs`
- Modify existing sync handling currently in gateway-service
- Test: extend `tests/unit/session-sync.test.mjs` or add `tests/unit/sync-service-cli.test.mjs`

**Interfaces:**
- Produces:
  - `getSyncStatus()`
  - `setSyncConfig({ enabled, startDate, endDate, summaryMode, summaryModel, dryRun })`
  - `installSyncSkill()`

- [ ] **Step 1: Write failing tests for enable/disable/set and status shape**

- [ ] **Step 2: Run fail**

- [ ] **Step 3: Implement by reusing SessionWatcherDaemon + config.sessionSync fields + SkillInstaller**

- [ ] **Step 4: Pass tests**

- [ ] **Step 5: Commit**

```bash
git add lib/domain/sync-service.mjs lib/cli/commands/sync.mjs tests/unit/sync-service-cli.test.mjs
git commit -m "feat(cli): expose full session sync settings"
```

---

### Task 11: Skills + local CLI tool commands

**Files:**
- Create: `lib/domain/skill-service.mjs`
- Create: `lib/domain/cli-tool-service.mjs`
- Create: `lib/cli/commands/skill.mjs`
- Create: `lib/cli/commands/cli-tool.mjs`
- Reuse: discovery/source-config/install-history/skill installer
- Tests: extend `tests/unit/skills-library.test.mjs`, `tests/unit/cli-discovery.test.mjs`, add service tests

**Interfaces:**
- Skills:
  - `listSkills({ scope, query })`
  - `getSkill({ name })`
  - `installSkill({ command, name, dryRun })`
  - `unifySkills({ name?, all?, dryRun })`
  - `listSkillHistory()` / `rerunSkillInstall({ id })`
- CLI tools:
  - `listCliTools({ query, probe })`
  - `installCliTool({ command, name, dryRun })`
  - history + source CRUD wrappers over existing modules

- [ ] **Step 1: Write failing tests for list filters and source save/reset**

Avoid running real networked installs in unit tests. For install commands, mock spawn/PTY or test only history bookkeeping + command construction unless an existing harness already covers install execution.

- [ ] **Step 2: Run fail**

- [ ] **Step 3: Implement services as wrappers around existing panel backend logic**

Prefer extracting shared functions used by server routes if currently inlined in `server.js`. If extraction is too large, call existing modules directly and leave server extraction as a follow-up, but do not duplicate business rules.

- [ ] **Step 4: Pass tests**

- [ ] **Step 5: Commit**

```bash
git add lib/domain/skill-service.mjs lib/domain/cli-tool-service.mjs lib/cli/commands/skill.mjs lib/cli/commands/cli-tool.mjs tests
git commit -m "feat(cli): add skills and local CLI tool management commands"
```

---

### Task 12: Mini tools + antigravity command modules

**Files:**
- Create: `lib/domain/tool-service.mjs`
- Create: `lib/cli/commands/tool.mjs`
- Create: `lib/domain/upstream-auth-service.mjs` (thin)
- Create: `lib/cli/commands/upstream.mjs`
- Tests: `tests/unit/tool-service.test.mjs`; reuse antigravity unit tests

**Interfaces:**
- `embedText({ client, endpointId, model, text, dimensions? })`
- `embedSimilarity({ client, endpointId, model, textA, textB, dimensions? })`
- `upstream google-oauth login|status` structured wrappers (provider codename may remain Antigravity internally)

- [ ] **Step 1: Write failing embedding similarity unit test with mocked fetch/live gateway**

Compute cosine in service for parity with panel.

- [ ] **Step 2: Run fail**

- [ ] **Step 3: Implement tool service via live gateway HTTP adapter; if gateway down, runtime error with next start recommendation**

Wrap existing Google/Antigravity OAuth handlers under `upstream google-oauth` and ensure secrets path remains `antigravity.secrets.json`.

- [ ] **Step 4: Pass tests**

- [ ] **Step 5: Commit**

```bash
git add lib/domain/tool-service.mjs lib/cli/commands/tool.mjs lib/domain/upstream-auth-service.mjs lib/cli/commands/upstream.mjs tests
git commit -m "feat(cli): add mini tools and upstream google-oauth commands"
```

---

### Task 13: End-to-end agent flow integration test

**Files:**
- Create: `tests/integration/agent-cli.integration.test.mjs`
- Modify: `package.json` scripts (`test:cli` include new integration test)

**Interfaces:**
- Consumes: built CLI entry `bin/cli.js`

- [ ] **Step 1: Write failing integration test**

Flow in temp data/runtime dirs:

1. `init`
2. `endpoint add` + `secret set` (or combined add with key)
3. `doctor` shows endpoint and key state
4. `start --test` (or isolated port/runtime)
5. `status` running true
6. `stop`

Assert JSON envelopes parse and `ok=true` on each step.

Because default format is JSON, parse stdout as JSON.

- [ ] **Step 2: Run fail if command surface incomplete**

Run: `node --test tests/integration/agent-cli.integration.test.mjs`

- [ ] **Step 3: Fix gaps needed for the flow**

- [ ] **Step 4: Pass integration + existing CLI tests**

Run:

```bash
npm run test:cli
node --test tests/integration/agent-cli.integration.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add tests/integration/agent-cli.integration.test.mjs package.json
git commit -m "test(cli): add agent bootstrap integration flow"
```

---

### Task 14: Docs + panel copy UX follow-through

Also finalize user-facing naming:

- `package.json` `bin` field exposes `shrimp` (keep `local-ai-gateway` alias if needed)
- README examples use `shrimp ...`
- data dir constant defaults to `~/.shrimp` with migration note from `~/.local-ai-gateway`
- help/schema show `upstream google-oauth`, not top-level `antigravity`

**Files:**
- Modify: `README.md`
- Modify: `desktop/config-panel.html` (generic copy controls)
- Optional: `docs/providers.md` cross-links

- [ ] **Step 1: Write README Agent Quick Start section**

Include:

- install
- agent protocol summary
- bootstrap command sequence
- secret redaction warning
- client copy examples
- note that product name may change later

- [ ] **Step 2: Update config panel DeepTutor button area**

Replace hard-coded Codex->DeepTutor-only control with:

- source client select
- target client select
- mode select (default replace)
- copy button calling existing `/v1/config/copy-client` with chosen from/to

Keep DeepTutor default selection as convenience.

Add/extend `tests/unit/config-panel.test.mjs` for the new selectors if practical.

- [ ] **Step 3: Run panel/unit tests touched**

Run:

```bash
node --test tests/unit/config-panel.test.mjs
npm run check
```

- [ ] **Step 4: Commit**

```bash
git add README.md desktop/config-panel.html tests/unit/config-panel.test.mjs
git commit -m "docs(cli): agent quickstart and generic client copy UI"
```

---

### Task 15: Final verification sweep

**Files:**
- none expected except fixes

- [ ] **Step 1: Run focused suites**

```bash
node --test tests/unit/cli-protocol.test.mjs tests/unit/cli-registry.test.mjs tests/unit/endpoint-service.test.mjs tests/unit/secret-service.test.mjs tests/unit/client-copy-service.test.mjs tests/unit/doctor-service.test.mjs
npm run test:cli
npm run check
```

- [ ] **Step 2: Manual smoke (if environment allows)**

```bash
node bin/cli.js schema --format json
node bin/cli.js doctor --format json
node bin/cli.js upstream google-oauth status --format json
node bin/cli.js client copy --help  # or schema client.copy
```

- [ ] **Step 3: Fix any regressions**

- [ ] **Step 4: Commit fixes if needed**

```bash
git add -A
git commit -m "fix(cli): address verification sweep issues"
```

- [ ] **Step 5: Summarize remaining open questions from design §16 for humans**

---

## Self-review against spec

| Spec area | Task coverage |
|---|---|
| Protocol default JSON / envelope / dry-run / schema | Tasks 1-2 |
| Lifecycle wrap | Task 3 |
| Config get/validate/restore | Task 4 |
| Endpoint CRUD full panel core | Task 5 |
| Secrets + redaction | Task 6 |
| Generic client copy modes | Task 7 |
| Doctor structured | Task 8 |
| Claude/Codex/DeepTutor apply integrations | Task 9 |
| Session sync full settings | Task 10 |
| Skills + local CLI tools | Task 11 |
| Mini tools + antigravity | Task 12 |
| Agent e2e flow | Task 13 |
| Docs + panel generalization | Task 14 |
| Verification | Task 15 |
| CLI name `shrimp` + `upstream google-oauth` command | Naming constants + upstream command module (Tasks 3/12/14) |
| Optional bootstrap sugar commands | Not in v1 tasks (YAGNI); can compose from lower-level commands |

Placeholder scan: no TBD implementation steps remain; open product questions are listed in the design for reviewers, not as incomplete engineering steps.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-29-agent-native-cli.md`.

Recommended execution after review approval:

1. **Subagent-Driven** — one task per subagent with review between tasks
2. **Inline Execution** — same session using executing-plans

Do not start implementation until external design/plan review feedback is incorporated if required.
