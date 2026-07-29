# Agent-Native CLI Design

> Status: design for external review  
> Branch: `codex/agent-cli-design`  
> Worktree: `.worktrees/agent-cli-design`  
> Date: 2026-07-29  
> CLI/package name: `shrimp` / `@wuhezhizhong/shrimp`

## 1. Goal

Build an **agent-first CLI** that can configure and operate this local multi-client AI gateway without requiring a human to click through the web config panel.

The CLI must cover essentially the same capability surface as `desktop/config-panel.html`, with a machine-stable protocol that large-language-model agents can reliably call, compose, dry-run, and recover from.

### Product positioning (locked)

- Primary: multi-client AI routing hub for Claude Code / Claude Desktop / Codex / DeepTutor / OpenAI-compatible clients
- Secondary: local one-stop console for install, configure, start, diagnose, and extend

### Naming

Locked names:

- CLI binary / command: `shrimp`
- npm package: `@wuhezhizhong/shrimp`
- user data dir: `~/.shrimp`
- GitHub repo target: `shrimp` (from `local-ai-gateway`)
- service identity: `shrimp`

Current values to replace during the clean rename (no external users yet):

- binary: `local-ai-gateway`
- package: `@wuhezhizhong/local-ai-gateway`
- data dir: `~/.local-ai-gateway`

Prefer a clean rename over long dual-compat. Temporary aliases are optional, not required. Domain logic should still read brand strings from constants.

## 2. Non-goals

This design does **not**:

1. Leave historical docs that still mention `local-ai-gateway` until the rename PR lands
2. Redesign the web UI look-and-feel
3. Replace the web config panel; CLI and panel share domain services
4. Add cloud account / multi-user remote management
5. Build a conversational REPL as the primary interface
6. Make interactive TTY setup the default agent path
7. Auto-install arbitrary untrusted shell packages without an explicit install command
8. Change upstream provider protocols or model adapters except where needed for config apply/validation
9. Merge `antigravity.secrets.json` into `gateway.secrets.json`

## 3. Problem statement

### What exists today

Current install / CLI behavior:

1. `npm install -g @wuhezhizhong/local-ai-gateway`
2. `local-ai-gateway` defaults to `start`
3. First run creates user data dir (`~/.local-ai-gateway` when not in source checkout)
4. Copies only:
   - `.env.example` -> `.env`
   - `gateway.config.example.json` -> `gateway.config.json` (empty endpoints)
5. Starts `server.js` in background

Current commands:

| Command | Meaning |
|---|---|
| `start` | Background-start gateway, write PID/logs, wait for health |
| `stop` | Stop managed gateway process after health/instance checks |
| `restart` | stop + start |
| `status` | PID / port / health / models |
| `init` | Non-interactive template copy |
| `setup` | Interactive setup; optional session-sync skill install |
| `sync` | Thin session-sync helpers (`install-skill`, `status`) |
| `logs` / `stdout` / `stderr` | Tail runtime logs |
| `path` | Print package/project root |
| `upstream google-oauth` | OAuth login/status for the Google/Antigravity upstream; writes `antigravity.secrets.json` |

Most real configuration still happens in the web panel:

- endpoint CRUD per client
- secrets / API keys
- Claude Code model slots
- Codex catalog / history migration
- DeepTutor setup
- session sync
- skills install / unify
- mini tools
- local CLI discovery / install history / scan sources

### Pain

Agents and humans both face high manual cost after install:

- empty config is not useful
- provider nodes, keys, model maps, and client base URLs are tedious
- web panel is human-oriented
- existing CLI is process-oriented, not configuration-oriented
- some features look special-cased (DeepTutor copy-from-Codex) even when the backend is more general

## 4. Decisions locked in discussion

| Topic | Decision |
|---|---|
| Primary CLI user | Large-model agents |
| Coverage target | Full config-panel capability surface |
| Architecture | Hybrid: local domain layer + runtime HTTP when needed |
| Output protocol | Lark-cli style: default JSON envelope, dry-run, schema |
| Secret input | Allow literal `--api-key`; always redact in outputs/logs |
| Client clone | Generalize beyond DeepTutor-from-Codex to any client copy |
| Implementation shape | Agent-native command surface + shared domain services |
| CLI name | `shrimp` |
| npm package | `@wuhezhizhong/shrimp` |
| Top-level Antigravity command | Renamed to `upstream google-oauth` to avoid product/mode ambiguity |

## 5. Current surface inventory

### 5.1 Config panel tabs to cover

**Proxy nodes**

- Claude Code (`code`)
- Claude Desktop (`desktop`)
- Codex (`codex`)
- DeepTutor (`deeptutor`)

Per client capabilities:

- list/add/update/delete endpoints
- endpoint fields: id, name, type/provider, purpose, base_url, models, model_mapping, defaults, enablement, dimensions, options, etc.
- secrets by endpoint id
- save/load config
- restore default template

Client-specific extras:

- Claude Code: model slots (opus/sonnet/haiku/fable) + auto-sync to `~/.claude/settings.json`
- Claude Desktop: auto-sync third-party inference config
- Codex: model catalog write, history unify/migrate, config snippet guidance / apply
- DeepTutor: dedicated URL surfaces (`/deeptutor/`, `/deeptutor/emb...`), copy nodes from another client

**System extensions**

- Session Sync: enable daemon, date range, summary mode/model, skill symlink targets
- Agent Skills: scan, filter, install, unify to `~/.agents/skills`, install history + pty install runner
- Mini Tools: text embedding utility over configured embedding endpoints
- Local CLI: discover installed CLIs, install history, scan source management

**Runtime / ops**

- start/stop/status/logs/doctor/validate
- Antigravity OAuth

### 5.2 Important storage files

| File | Role |
|---|---|
| `gateway.config.json` | Public routing config |
| `gateway.secrets.json` | Endpoint API keys (`api_keys`) only |
| `.env` | Process env defaults |
| `antigravity.secrets.json` | Antigravity OAuth client + tokens (isolated) |
| `cli-sources.json` | Local CLI scan sources |
| `cli-install-history.json` | CLI install records |
| skill install history file | Skill install records |
| runtime: `gateway.pid.json`, `gateway.log`, stdout/stderr | Process management |
| client-side: `~/.claude/settings.json`, `~/.codex/config.toml`, `~/.codex/gateway-model-catalog.json` | Client apply targets |

### 5.3 Existing reusable modules

- `lib/cli/init-config.mjs`
- `lib/cli/gateway-service.mjs`
- `lib/cli/discovery.mjs`
- `lib/cli/source-config.mjs`
- `lib/cli/install-history.mjs`
- `lib/config/gateway-config-store.mjs` including `copyClientEndpoints`
- `lib/config/claude-code-settings.mjs`
- `lib/session-sync/*`
- `lib/skills/*` / skill installer pieces
- `lib/antigravity/*`
- `scripts/doctor.mjs`, `scripts/validate-config.mjs`
- HTTP endpoints already used by panel (config get/save, copy-client, skills, cli discovery, etc.)

## 6. Architecture

### 6.1 Chosen approach

**Agent-native command surface + shared domain layer + hybrid I/O.**

```text
Agent / human
  -> shrimp argv parser + JSON envelope
      -> command handlers
          -> domain services (pure-ish business ops)
              -> local stores/files
              -> optional live gateway HTTP
              -> process manager
```

### 6.2 Why hybrid, not pure local or pure HTTP

Pure local:

- works offline
- cannot always observe live health/hot state
- duplicates some server-only behaviors if overused

Pure HTTP:

- matches panel runtime path
- fails when gateway is down
- awkward for package-local file bootstrap and some OS-level tasks

Hybrid:

- config CRUD and file writes use domain services/local stores
- live inspect/health/hot reload use HTTP when gateway is up
- process lifecycle remains local process manager
- agent can `init -> configure -> start -> doctor` without chicken-and-egg dead ends

### 6.3 Layer responsibilities

#### CLI transport layer

- parse argv
- resolve global flags (`--json/--format`, `--dry-run`, `--data-dir`, `--root`, `--port`)
- enforce non-interactive defaults for agents
- print success/error envelopes
- map domain errors to stable error types/codes
- never print raw secrets

#### Domain services

One service module per resource family, UI-agnostic:

- `GatewayLifecycleService`
- `ConfigService`
- `EndpointService`
- `SecretService`
- `ClientService` (including generic copy)
- `ClientApplyService` (Claude/Codex/Desktop apply + snippets)
- `SyncService`
- `SkillService`
- `CliToolService` (local CLI discovery/install/sources)
- `ToolService` (mini tools such as embeddings)
- `UpstreamAuthService` (Google/Antigravity OAuth)
- `DoctorService`
- `SchemaService`

Domain services accept plain objects and return plain result objects. They do not print.

#### Store / adapter layer

- config/secrets file IO via existing gateway-config-store patterns
- env file helpers
- process pid/log management via gateway-service
- HTTP client adapter for live gateway
- OS path adapters for Claude/Codex/skills homes

### 6.4 Hot reload policy

After local config mutation:

1. Write files through the same validation path used by panel/server
2. If gateway is running and exposes a reload/save-compatible API, call it
3. Else include `next: ["restart required" or specific apply steps]` in result
4. Never silently claim live effect without verification

### 6.5 Compatibility with current CLI

Keep existing verbs working:

- `start|stop|restart|status|logs|stdout|stderr|path|init|setup|sync|upstream`

Upgrade them onto the new envelope/protocol gradually:

- Phase 1: new framework wraps old lifecycle commands with JSON envelope
- Phase 2+: add resource commands
- Old human text mode remains available via `--format pretty`

Default invocation with no args remains debatable; recommendation:

- keep `start` as no-arg default for backward compatibility
- document agent entry as explicit commands (`doctor`, `schema`, `endpoint list`, etc.)

## 7. CLI protocol

### 7.1 Global flags

```text
--format <json|pretty|table|ndjson>   default: json
--dry-run                             preview mutating commands
--data-dir <path>                     override user data dir
--root <path>                         package/project root
--runtime-dir <path>                  pid/log dir
--port <n>                            lifecycle override
--config-file <path>
--secrets-file <path>
--timeout-ms <n>
--no-color
-y / --yes                            confirm destructive ops when required
```

Notes:

- default format is **json**, matching lark-cli agent orientation
- pretty/table are human convenience only
- dry-run supported on all mutating commands

### 7.2 Success envelope

stdout, exit 0:

```json
{
  "ok": true,
  "command": "endpoint.add",
  "data": {},
  "meta": {
    "dry_run": false,
    "duration_ms": 12,
    "data_dir": "C:/Users/x/.local-ai-gateway"
  },
  "next": [
    {
      "command": "client apply --client code",
      "reason": "Claude Code settings not yet synced"
    }
  ]
}
```

### 7.3 Error envelope

stderr, non-zero exit:

```json
{
  "ok": false,
  "command": "endpoint.add",
  "error": {
    "type": "validation",
    "code": "missing_fields",
    "message": "base_url is required",
    "fields": ["base_url"],
    "hint": "Provide --base-url with the full upstream request URL",
    "retryable": false
  },
  "meta": {
    "dry_run": false
  }
}
```

### 7.4 Error taxonomy

| type | meaning | typical exit |
|---|---|---|
| `usage` | bad argv / unknown command | 2 |
| `validation` | schema/business validation failed | 2 |
| `not_found` | resource missing | 3 |
| `conflict` | already exists / unsafe overwrite without flag | 4 |
| `auth` | local gateway auth or missing secret material | 5 |
| `runtime` | process/port/health failure | 6 |
| `external` | upstream provider/network failure | 7 |
| `internal` | unexpected bug | 1 |

Agents must branch on `ok` and `error.code`, not free-text matching.

### 7.5 Secret redaction rules

- allow input: `--api-key sk-...`
- allow input: `--api-key-env VAR` and `env:VAR` form
- outputs never include raw key material
- list/get secrets returns state only: `missing | stored | env:VAR_NAME`
- logs redact bearer tokens and `api_key` fields
- dry-run still redacts

### 7.6 Schema introspection

```text
shrimp schema
shrimp schema endpoint.add
shrimp schema client.copy
```

Returns JSON describing:

- command path
- required/optional params
- defaults
- side effects
- whether dry-run is meaningful
- related next commands

This is intentionally first-class so agents can recover without scraping `--help` prose.

### 7.7 Non-interactive contract

For agent mode (default):

- never block on stdin prompts
- missing required values => `missing_fields` error
- destructive overwrite requires `--yes` or explicit mode flag
- OAuth-like flows that need browser use non-blocking patterns where possible (`login --no-wait` style later); v1 may still open browser but must return structured status

`setup` remains the only intentionally interactive human command.

## 8. Command tree

Binary shown as `shrimp`.

### 8.1 Lifecycle / ops

```text
shrimp start
shrimp stop [--force]
shrimp restart
shrimp status
shrimp logs [--lines N]
shrimp stdout [--lines N]
shrimp stderr [--lines N]
shrimp path
shrimp doctor
shrimp validate
shrimp init
shrimp setup            # human interactive only
```

### 8.2 Config root

```text
shrimp config get
shrimp config set --server-host 127.0.0.1 --server-port 8787
shrimp config validate
shrimp config diff --from fileA --to fileB
shrimp config export --out path
shrimp config import --in path [--yes]
shrimp config restore-template [--yes]
```

### 8.3 Clients

```text
shrimp client list
shrimp client get --client code
shrimp client add --client myapp [--copy-from codex]
shrimp client remove --client myapp [--yes]
shrimp client copy --from codex --to deeptutor [--mode replace|merge|fill-empty]
```

#### Generic client copy (replaces DeepTutor special-case UX)

Backend already has `copyClientEndpoints({from,to})` and `POST /v1/config/copy-client`.

Design upgrades:

1. CLI exposes generic copy for any existing clients
2. Panel should later change button from hard-coded Codex->DeepTutor into source/target selectors
3. Auto-seed behavior on load (`seedDeepTutorFromCodex`) remains compatibility behavior in v1, but is documented as legacy convenience, not the primary model
4. Copy modes:
   - `replace` (current behavior): target endpoints fully replaced
   - `merge`: append cloned endpoints; keep target-only endpoints
   - `fill-empty`: copy only if target has zero endpoints
5. Always mint new endpoint IDs and remap secrets keys
6. Result includes counts: `copied`, `skipped`, `secrets_copied`

### 8.4 Endpoints

```text
shrimp endpoint list [--client code] [--purpose embedding|web_search|vision_fallback|chat]
shrimp endpoint get --id ep_xxx
shrimp endpoint add --client code --name ark --type openai-chat --base-url URL --model glm-5.2 [flags]
shrimp endpoint update --id ep_xxx [--name ...] [--base-url ...] [...]
shrimp endpoint remove --id ep_xxx [--yes]
shrimp endpoint set-default --id ep_xxx
shrimp endpoint enable --id ep_xxx
shrimp endpoint disable --id ep_xxx
```

Important flags for add/update:

```text
--client
--name
--type anthropic|openai-chat|openai-responses|...
--purpose chat|embedding|web_search|vision_fallback
--base-url
--models a,b,c
--model-mapping json
--upstream-model
--embedding-model
--dimensions
--is-default
--expose-models
--enabled
--options json
--api-key
--api-key-env
```

`base_url` semantics stay as today: for third-party providers it is the exact upstream request URL; gateway does not append protocol suffixes.

### 8.5 Secrets

```text
shrimp secret list [--client code]
shrimp secret get --endpoint-id ep_xxx
shrimp secret set --endpoint-id ep_xxx --api-key sk-...
shrimp secret set --endpoint-id ep_xxx --api-key-env ARK_API_KEY
shrimp secret unset --endpoint-id ep_xxx [--yes]
```

`gateway.secrets.json` remains `{ "api_keys": { "<endpoint_id>": "..." } }`.

Antigravity secrets stay separate.

### 8.6 Client apply / integration

```text
shrimp client apply --client code
shrimp client apply --client desktop
shrimp client apply --client codex [--write-config/--snippet-only]
shrimp client snippet --client codex
shrimp client slots get --client code
shrimp client slots set --client code --opus M --sonnet M --haiku M --fable M
shrimp codex catalog write
shrimp codex catalog verify
shrimp codex history unify --dry-run
shrimp codex history unify --apply [--yes]
```

Notes:

- Claude Code apply uses existing settings sync logic
- Codex apply must be careful with `~/.codex/config.toml`; default may be snippet generation + catalog write; full auto-edit can be opt-in
- DeepTutor apply returns the two base URLs agents should configure in that app

### 8.7 Session sync

```text
shrimp sync status
shrimp sync enable
shrimp sync disable
shrimp sync set --start-date YYYY-MM-DD --end-date YYYY-MM-DD --summary-mode rule|llm --summary-model MODEL
shrimp sync install-skill
```

### 8.8 Skills

```text
shrimp skill list [--scope all|installed|managed|local|missing|unified-missing]
shrimp skill get --name foo
shrimp skill install --command "npx ..." [--name optional]
shrimp skill unify [--name foo|--all]
shrimp skill refresh
shrimp skill history list
shrimp skill history rerun --id r_xxx
```

PTY-based interactive install remains supported for human/panel; agent path should prefer non-interactive install commands and capture exit code/logs structurally.

### 8.9 Local CLI tools

```text
shrimp cli-tool list [--query rg] [--probe]
shrimp cli-tool install --command "npm i -g ..." [--name optional]
shrimp cli-tool history list
shrimp cli-tool history rerun --id r_xxx
shrimp cli-tool source list
shrimp cli-tool source add --name chocolatey --label "..." --dirs "A;B"
shrimp cli-tool source save --file sources.json
shrimp cli-tool source reset
```

Naming note: top-level `cli-tool` avoids clashing with the product CLI itself.

### 8.10 Mini tools

```text
shrimp tool embedding --client codex --endpoint-id ep_x --model M --text "..."
shrimp tool embedding-similarity --client codex --endpoint-id ep_x --model M --text-a A --text-b B
```

These call the gateway embeddings path (local service or live HTTP). If gateway is required and down, return structured runtime error with `next: ["start"]`.

### 8.11 Upstream auth (Google / Antigravity provider)

Top-level command is **not** named `antigravity`, because that reads like a product mode or third client and confuses agents/humans.

Use an explicit upstream-auth command:

```text
shrimp upstream list
shrimp upstream google-oauth login
shrimp upstream google-oauth status
```

Compatibility:

- old docs/code may still say Antigravity because that is the upstream protocol/provider codename
- storage file remains `antigravity.secrets.json` unless later migrated
- optional hidden alias `shrimp antigravity ...` may exist temporarily, but schema/help should promote `upstream google-oauth`

Writes/reads `antigravity.secrets.json` only.

### 8.12 Convenience workflows (optional sugar)

Not required for v1 completeness, but recommended soon after core CRUD:

```text
shrimp plan bootstrap --client code --provider openrouter
shrimp apply recommended --client code
```

These compose lower-level commands and return a step plan. Sugar must not be the only way to do something.

## 9. Domain designs

### 9.1 Endpoint + secret write path

```text
endpoint.add
  validate args
  load config+secrets
  create endpoint id
  mutate config
  optional secret set
  validate full state
  dry-run? return diff
  save state
  maybe reload live gateway
  return endpoint summary + secret state + next actions
```

Validation must reuse `validateGatewayConfig` / existing store rules so CLI cannot persist states the server rejects.

### 9.2 Client copy path

```text
client.copy --from A --to B --mode replace|merge|fill-empty
  ensure both clients exist (or create target if policy allows)
  clone endpoints with new IDs
  remap secrets
  validate
  save
  return counts
```

Default mode: `replace` for compatibility with current DeepTutor button.  
Agent docs should prefer explicit `--mode`.

### 9.3 Apply path

Apply is separate from save:

1. save config/secrets
2. apply client integration files
3. doctor/verify

This avoids surprising side effects on every endpoint edit.  
However, existing gateway auto-sync on panel save for Claude Code/Desktop should remain unless intentionally changed; CLI should expose explicit apply and also report whether auto-sync already happened when using live save APIs.

### 9.4 Doctor path

`doctor` becomes structured JSON, not only text:

```json
{
  "ok": true,
  "data": {
    "node": {"version": "v22...", "ok": true},
    "config": {"path": "...", "valid": true, "issues": []},
    "endpoints": [{"client":"code","id":"ep_","key_state":"env:ARK_API_KEY","enabled":true}],
    "runtime": {"listening": true, "health_ok": true, "models": []},
    "clients": {
      "code": {"apply_state": "synced|drift|missing", "urls": ["http://127.0.0.1:8787/code"]},
      "codex": {"catalog": "present|missing", "urls": ["http://127.0.0.1:8787/codex"]}
    },
    "recommendations": [{"command":"secret set ...","reason":"..."}]
  }
}
```

### 9.5 Schema path

Generate from a command registry, not hand-maintained markdown only:

```js
{
  name: "endpoint.add",
  mutating: true,
  dryRun: true,
  params: [ { name: "client", required: true, type: "string", enum: [...] }, ... ]
}
```

Help text and schema both render from the same registry.

## 10. File / module plan

### New modules (recommended)

```text
lib/cli/protocol.mjs          # envelope, redaction, exit codes
lib/cli/registry.mjs          # command registry + schema
lib/cli/parse-args.mjs        # argv parsing shared helpers
lib/cli/commands/*.mjs        # thin command handlers
lib/domain/config-service.mjs
lib/domain/endpoint-service.mjs
lib/domain/secret-service.mjs
lib/domain/client-service.mjs
lib/domain/apply-service.mjs
lib/domain/sync-service.mjs
lib/domain/skill-service.mjs
lib/domain/cli-tool-service.mjs
lib/domain/tool-service.mjs
lib/domain/doctor-service.mjs
lib/domain/upstream-auth-service.mjs
lib/domain/live-gateway.mjs   # HTTP adapter
```

### Modified modules

```text
bin/cli.js                    # route through registry
lib/cli/gateway-service.mjs   # envelope-aware lifecycle integration
lib/cli/init-config.mjs       # keep bootstrap; maybe expose richer result objects
lib/config/gateway-config-store.mjs
  - keep copyClientEndpoints
  - add merge/fill-empty helpers if not inlined in domain service
desktop/config-panel.html     # later: generic copy UI (can be same milestone or follow-up)
README.md                     # agent quick start + command map
```

### Tests

```text
tests/unit/cli-protocol.test.mjs
tests/unit/cli-registry.test.mjs
tests/unit/endpoint-service.test.mjs
tests/unit/client-copy-service.test.mjs
tests/unit/secret-redaction.test.mjs
tests/unit/doctor-service.test.mjs
tests/integration/agent-cli.integration.test.mjs
```

Keep existing lifecycle tests green.

## 11. Agent UX principles

1. **Discover**: `schema`, `doctor`, `client list`, `endpoint list`
2. **Mutate safely**: `--dry-run` then real command
3. **Compose**: every response may include `next`
4. **Never hang**: no prompts in default mode
5. **Never leak secrets**
6. **Idempotent where practical**: re-running same secret set / same endpoint update should succeed
7. **Explain side effects**: catalog writes, settings rewrites, process restarts

### Example agent bootstrap flow

```text
shrimp init
shrimp doctor
shrimp endpoint add --client code --name openrouter --type openai-chat --base-url https://... --models ... --api-key sk-...
shrimp client slots set --client code --sonnet my-model
shrimp client apply --client code
shrimp start
shrimp doctor
```

Each step returns JSON the agent can branch on.

## 12. Security & safety

1. Local-only assumptions remain (gateway binds 127.0.0.1 by default)
2. Literal API keys allowed in argv by decision, with redaction everywhere else
3. Warn in docs that shell history / agent transcripts may retain argv secrets
4. Destructive commands require `--yes` when they overwrite user client configs or replace all endpoints
5. Codex history unify keeps backup behavior
6. Install commands record history and exit codes
7. Do not auto-run remote installers from `doctor` recommendations without explicit user/agent command

## 13. Migration & compatibility

### 13.1 CLI / config compatibility

1. Existing human scripts using text output may need `--format pretty`
2. No-arg `start` preserved
3. Existing npm scripts (`gateway:start`, `doctor`, etc.) keep working; can later delegate to new CLI
4. `copy-client` API remains; CLI becomes preferred agent entry
5. DeepTutor auto-seed retained in v1 for compatibility, documented as legacy
6. Brand strings (`shrimp`, `@wuhezhizhong/shrimp`, `~/.shrimp`, service id) live in constants so rename PRs stay mechanical

### 13.2 GitHub repo rename runbook (multi-machine)

Because there are no external users yet, treat GitHub rename as a clean cutover. **Do not re-clone source on every machine.** Existing working copies remain valid; only remotes/docs/package identity need updating.

#### A. One-time on GitHub (owner)

1. Rename repository `local-ai-gateway` -> `shrimp`
2. Confirm old URL redirects to the new URL
3. Update repo description/topics if desired
4. If GitHub Pages, Actions secrets, or branch protection reference the old name, re-check them after rename

#### B. On every computer that already cloned the repo

Run inside that machine's existing checkout:

```bash
# 1) optional: stop local gateway if this checkout is currently serving
# shrimp stop   # or: node bin/cli.js stop

# 2) inspect current remote
git remote -v

# 3) point origin at the renamed repo
# HTTPS:
git remote set-url origin https://github.com/zlpawn/shrimp.git
# SSH:
# git remote set-url origin git@github.com:zlpawn/shrimp.git

# 4) verify fetch/push still works
git fetch origin
git status -sb

# 5) optional: rename local folder for sanity
#   Windows PowerShell:
#     cd ..
#     Rename-Item local-ai-gateway shrimp
#     cd shrimp
#   macOS/Linux:
#     cd .. && mv local-ai-gateway shrimp && cd shrimp
```

Notes for agents executing this later:

- Re-cloning is **not** required unless the local git metadata is broken or the user only has a zip export
- Old GitHub URLs usually redirect, but agents should still update `origin` rather than relying on redirects forever
- Local uncommitted work survives rename; do not delete the working tree
- If a machine has multiple worktrees, update/fetch in the main checkout and each linked worktree as needed; `git remote set-url` is per-clone repository metadata

#### C. After code rename lands on the branch

On each machine, after pulling the rename commit(s):

```bash
git pull

# clean local identity (author is the only tester today)
# preferred: recreate config under ~/.shrimp
# or manually move old test data:
#   mv ~/.local-ai-gateway ~/.shrimp

# reinstall local bin link if using npm link / global install from source
npm link
# or:
# npm install -g .

shrimp status
shrimp doctor
```

#### D. Package / install identity checklist

When implementing the rename PR, update all of:

- `package.json` `name` = `@wuhezhizhong/shrimp`
- `package.json` `bin.shrimp`
- `package.json` `repository` / `homepage` / `bugs`
- data dir default `~/.shrimp`
- health/service identity strings
- README install examples: `npm i -g @wuhezhizhong/shrimp`
- tests asserting old names

No multi-user migration matrix is required in v1.

## 14. Phased delivery

### Phase 0 — Framework

- protocol envelope
- registry/schema
- wrap lifecycle commands
- redaction helpers
- tests for protocol

### Phase 1 — Config core

- config get/validate
- endpoint CRUD
- secret set/list
- client list/get/copy (generic modes)
- doctor JSON

### Phase 2 — Client integrations

- Claude Code slots + apply
- Claude Desktop apply status
- Codex catalog/history/snippet/apply policy
- DeepTutor URL helpers + copy UX generalization

### Phase 3 — Extensions

- session sync full settings
- skills list/install/unify/history
- cli-tool discovery/sources/history
- mini embedding tool commands

### Phase 4 — Polish

- panel generic copy UI
- agent quickstart docs / optional skill pack
- richer `next` recommendations
- pretty/table format niceties

Each phase must leave the CLI usable and tested.

## 15. Acceptance criteria

Design is successfully implemented when:

1. An agent can bootstrap a useful local gateway config without opening `/config`
2. Every config-panel resource family has list/get and, where relevant, mutate commands
3. Default output is machine JSON with stable `ok/data/error`
4. Secrets never appear in command output
5. `client copy` works for arbitrary from/to, not only codex->deeptutor
6. `doctor` returns actionable structured recommendations
7. Existing start/stop/status behavior remains reliable
8. Unit/integration tests cover protocol, endpoint/secret CRUD, client copy modes, and one end-to-end agent-style flow

## 16. Open questions for reviewers

These are intentionally unresolved or soft:

1. **Codex config.toml auto-write default**: snippet-only vs opt-in write vs full managed apply
2. **Dynamic custom clients**: allow arbitrary client names beyond code/desktop/codex/deeptutor, or keep fixed set in v1?
3. **No-arg default**: keep `start`, or eventually move to `status/doctor`?
4. **Live reload completeness**: which mutations can hot-apply without restart today, and which need explicit restart?
5. Whether GitHub rename and npm publish of `@wuhezhizhong/shrimp` happen in the same PR as the agent CLI framework, or as a thin preceding rename PR
6. Whether to ship an agent skill package in-repo in the same milestone as Phase 1

## 17. Reviewer guide

Please review for:

1. Scope realism vs “full panel coverage”
2. Protocol stability for agents
3. Secret handling decision risks
4. Domain boundary quality (CLI vs service vs store)
5. Compatibility hazards with current users
6. Missing commands relative to config panel
7. Whether Phase splits are implementable by another agent without redesign

Related current code entry points:

- `bin/cli.js`
- `lib/cli/gateway-service.mjs`
- `lib/cli/init-config.mjs`
- `lib/config/gateway-config-store.mjs`
- `desktop/config-panel.html`
- `server.js` (`/v1/config`, `/v1/config/copy-client`, skills/cli routes)
- `lib/antigravity/token-store.mjs`
