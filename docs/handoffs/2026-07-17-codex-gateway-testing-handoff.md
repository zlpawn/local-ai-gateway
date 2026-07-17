# Codex Gateway Testing Handoff

Date: 2026-07-17

Branch: `codex/codex-gateway-chain`

Worktree: `/Users/pa/project/AI/local-ai-gateway/.worktrees/codex-gateway-chain`

## Source of truth

- Design: `docs/superpowers/specs/2026-07-17-codex-gateway-chain-design.md`
- Implementation plan: `docs/superpowers/plans/2026-07-17-codex-gateway-chain.md`
- SDD progress ledger: `.superpowers/sdd/progress.md` (local-only, excluded from Git)
- Per-task reports: `.superpowers/sdd/task-*-report.md` (local-only, excluded from Git)

Do not duplicate or rewrite the design and plan. Continue from Task 7 in the implementation plan.

## Completed and reviewed

Tasks 1–6 are implemented and independently reviewed:

1. Shared Codex model catalog.
2. Responses request adaptation for OpenAI Chat.
3. SSE parser and Responses lifecycle writer.
4. Chat SSE/JSON conversion to Responses, including parallel tools.
5. Full non-streaming Grok Responses collection.
6. Client cancellation propagation and translated-stream `response.failed`.

The last fully reviewed implementation commit is `6cd1b9d`.

Task 6 verification at that commit:

- Focused integration/adapter: 18/18.
- Protocol/adapter: 16/16.
- Full Node suite: 44/44.
- `npm run check`: passed.
- `git diff --check`: passed.
- No temporary gateway processes/listeners remained.

## Current partial Task 7 state

Task 7 was paused before completion. The worktree contains a stageable partial implementation:

- Codex endpoint capability validation.
- Safe official-model discovery fallback.
- Desktop UI controls for image, reasoning, and tools.
- Tests ensuring unknown fields and API-key values are not copied or printed.

Still required before Task 7 can be considered complete:

- Add the exact Codex provider capability matrix to `README.md`.
- Add `test:codex:unit`, `test:codex:integration`, and `test:codex:e2e` scripts to `package.json`.
- Run the full Task 7 command block.
- Independently review Task 7 and fix every Critical/Important finding.

## Remaining automated test work

### Task 7 — capabilities, UI, documentation

Required commands:

```bash
node --test scripts/codex-model-catalog.test.mjs desktop/lib/desktop-smoke.test.mjs
npm run validate:config
npm run desktop:test
npm run codex:catalog:verify
npm run check
git diff --check
```

Assertions:

- Only `text` and `image` input modalities are accepted.
- `reasoning` and `tools` must be booleans.
- Third-party IDs cannot shadow official subscription model IDs.
- Failure to execute `codex debug models --bundled` produces a safe warning.
- No API-key value appears in stdout/stderr or generated UI state.
- UI updates preserve unknown endpoint/client fields.

### Task 8 — provider compatibility matrix

Use only temporary configs, local mock upstreams, and dynamic ports. Cover:

- Native OpenAI Responses: text, image, reasoning, function/custom tools, usage.
- OpenAI Chat adaptation: image input, reasoning aliases, fragmented and parallel tool calls.
- Grok Responses and Grok Chat adaptation.
- Streaming and non-streaming responses.
- HTTP 401, 429, and 500 normalization.
- Premature SSE close ends with `response.failed`, never `response.completed`.
- Model mapping preserves independent public IDs and sends the upstream ID.

Required commands:

```bash
npm run check
npm run desktop:test
npm run test:cli
npm run test:codex:unit
npm run test:codex:integration
node --test scripts/protocol-adapters.test.mjs
```

### Task 9 — isolated Codex agent E2E

Build the deterministic fixture and harness described in the plan. It must:

- Use temporary `CODEX_HOME`, config, catalog, fixture, logs, and ports.
- Route Codex through `/codex/v1`.
- Complete four tool rounds.
- Fix the deliberately broken `add()` implementation.
- Rerun tests successfully.
- Print JSON with `ok`, `toolRounds`, `testsPassed`, and `filesChanged`.
- Leave the real `~/.codex/config.toml` and `~/.codex/auth.json` untouched.

Required final command:

```bash
npm run test:codex:e2e
```

Optional real-provider smoke mode must be read-only:

```bash
CODEX_REAL_SMOKE_MODEL=grok-4.5 npm run test:codex:e2e
```

## Mandatory test isolation

Every test that spawns `server.js` must:

- Set `GATEWAY_NO_OPEN=1`.
- Set `CLAUDE_3P_SYNC_DISABLED=1`.
- Use a dynamically reserved temporary port.
- Use a temporary config and auth file.
- Never use or modify the real `gateway.config.json`.
- Never bind or stop port 8787.
- Kill child processes and remove temporary directories in teardown.

Before and after integration/E2E runs, confirm no worktree server remains:

```bash
ps -axo pid,ppid,etime,command \
  | rg '\\.worktrees/codex-gateway-chain/server\\.js|node --test' \
  | rg -v 'rg ' || true
```

The main launchd service intentionally remains on `127.0.0.1:8787` with
`GATEWAY_NO_OPEN=1`.

## Known non-blocking follow-ups

- Native Responses passthrough transport failures do not yet synthesize `response.failed`.
- Translated-stream `AbortError` is currently classified as `upstream_protocol_error`.
- Queued Grok cancellation lacks a direct `max_concurrency` integration test.
- Gateway spawn setup is duplicated across protocol tests and could be extracted into a fixture.
- `unwrapCustomInput(null)` could return a clearer validation error, with negative tests.

Treat these as final-review candidates. Do not expand scope until Tasks 7–9 pass.

## Final verification and security review

Run from a clean worktree:

```bash
npm run check
npm run desktop:test
npm run test:cli
npm run test:codex:unit
npm run test:codex:integration
npm run test:codex:e2e
node --test scripts/protocol-adapters.test.mjs
npm run validate:config
npm run codex:catalog:verify
git diff --check
```

Then verify:

```bash
git diff --stat main...HEAD
git diff --name-only main...HEAD | rg 'gateway\\.config\\.json' && exit 1 || true
git diff main...HEAD \
  | rg 'sk-[A-Za-z0-9]{12,}|ark-[A-Za-z0-9-]{12,}|Bearer [A-Za-z0-9._-]{12,}' \
  || true
```

Expected: no tracked real config and no credential matches.

Only after all tests and final review pass:

```bash
curl -fsS http://127.0.0.1:8787/codex/health
curl -fsS http://127.0.0.1:8787/codex/v1/models
```

Do not push or merge until the user explicitly requests it.
