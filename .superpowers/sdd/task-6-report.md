# Task 6 Report: Propagate Cancellation and Normalize Stream Failures

## Status

Complete. Codex requests now own one cancellation signal that reaches configured
OpenAI Fetch transports, the Ark fallback, official Codex Fetch, Grok Node HTTP,
and Grok concurrency queues. Translated Chat stream exceptions now emit a
single `response.failed` terminal event and close. Pre-header upstream failures
retain their upstream HTTP status and JSON body. Codex Fetch requests do not
perform a 401/403 credential retry after an upstream response has begun, while
non-Codex Responses requests preserve legacy retry permission and configured
provider-key precedence.

## Implementation

- Added `lib/codex/request-abort.mjs` with
  `bindRequestAbort(req, res) -> { signal, dispose }`.
- Wrapped the complete Codex Responses route lifetime in the request abort
  binding and a request-wide timeout signal.
- Passed that signal to:
  - official Codex Fetch;
  - configured OpenAI Chat and Responses Fetch;
  - the Ark Responses fallback Fetch;
  - Grok Responses and Chat Node HTTP.
- Made queued Grok work removable on abort and retained the existing exactly-once
  resource release guard.
- Closed the race between Grok queue acquisition and Node request listener
  registration by checking `signal.aborted` after installing error/cleanup
  handlers.
- Made configured OpenAI's 401/403 fallback an explicit client policy: disabled
  for Codex after the first response and retained for non-Codex clients.
- Wrapped translated Chat streaming so parser/protocol exceptions become
  `response.failed` with `upstream_protocol_error`, followed by stream close.
- Added integration coverage for configured Chat cancellation, Grok Node HTTP
  cancellation, malformed post-header translated SSE, no retry after stream
  start, and pre-header 429 status/JSON preservation.

## TDD Evidence

### RED: cancellation

Command:

```text
node --test --test-name-pattern="Codex cancellation" scripts/codex-gateway.integration.test.mjs
```

Result: exit 1, 0 pass / 2 fail. Exact failures:

```text
AssertionError [ERR_ASSERTION]: client cancellation should close the configured Chat upstream
false !== true

AssertionError [ERR_ASSERTION]: client cancellation should close the Grok Node HTTP upstream
false !== true
```

### RED: post-header translated failure

Command:

```text
node --test --test-name-pattern="translated Chat stream failures" scripts/codex-gateway.integration.test.mjs
```

Result: exit 1, 0 pass / 1 fail. Exact failure:

```text
AssertionError [ERR_ASSERTION]: The input did not match the regular expression /event: response\.failed/.
```

The received stream contained `response.created`,
`response.output_item.added`, and `response.output_text.delta`, then closed
without a terminal failure event.

### GREEN: focused integration and adapter tests

Command:

```text
node --test scripts/codex-gateway.integration.test.mjs scripts/codex-chat-response-adapter.test.mjs
```

Result: exit 0, 16 pass / 0 fail.

Command:

```text
node --test scripts/protocol-adapters.test.mjs scripts/codex-chat-response-adapter.test.mjs
```

Result: exit 0, 16 pass / 0 fail.

The focused integration cases passed:

```text
Codex cancellation aborts the active Chat upstream request
Codex cancellation destroys the active Grok Node HTTP request
translated Chat stream failures emit response.failed and close without retry
translated Chat pre-header errors preserve upstream status and JSON
```

## Complete Verification

Command:

```text
node --test
```

Result: exit 0, 42 pass / 0 fail.

Command:

```text
npm run check
```

Result: exit 0.

```text
> node --check server.js && node scripts/check-bash-script.mjs
```

Command:

```text
git diff --check
```

Result: exit 0, no output.

## Files

- `lib/codex/request-abort.mjs` — new request cancellation binding.
- `scripts/codex-gateway.integration.test.mjs` — new focused gateway integration
  coverage and reusable safe process harness.
- `server.js` — request-wide signal ownership, transport propagation, Grok queue
  cancellation, retry guard, and translated stream failure normalization.
- `.superpowers/sdd/task-6-report.md` — this report.

## Commit

Exact final subject:

```text
fix: propagate Codex request cancellation
```

The final commit is the commit containing this report. Its immutable hash is
reported by `git log -1 --oneline` and in the task handoff rather than embedded
here: embedding the hash and amending this report would necessarily create a
different hash.

## Reviewer Regression Corrections: Retry Policy and Credential Precedence

The first Task 6 implementation incorrectly inferred retry permission from the
presence of an abort signal. Because every Responses request now owns a signal,
that disabled the existing configured-key fallback for non-Codex
`/v1/responses` requests. Retry permission is now explicit: false for Codex
Responses and true for legacy/non-Codex callers.

An initial reviewer fix then incorrectly preferred the request bearer whenever
retry was permitted. That changed the established `providerApiKey` rule, which
always prefers a configured provider key. The final fix restores
`providerApiKey(provider, clientReq)` as the initial credential selection for
every caller and keeps retry permission as a separate boolean.

### Final Fix RED

Command:

```text
node --test --test-name-pattern="non-Codex Responses|Codex Responses does not retry" scripts/codex-gateway.integration.test.mjs
```

Result: exit 1, 1 pass / 1 fail. Exact non-Codex failure:

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
actual:   [ "Bearer client-key", "Bearer configured-key" ]
expected: [ "Bearer configured-key" ]
```

The companion Codex test passed in RED with one 401 response and exactly one
upstream authorization attempt.

### Final Fix GREEN

The same command after restoring legacy credential precedence returned exit 0:

```text
non-Codex Responses preserves configured-key credential precedence
Codex Responses does not retry after an upstream authentication response
tests 2, pass 2, fail 0
```

Focused integration/protocol/adapter verification:

```text
node --test scripts/codex-gateway.integration.test.mjs scripts/protocol-adapters.test.mjs scripts/codex-chat-response-adapter.test.mjs
tests 22, pass 22, fail 0
```

The fix deliberately does not rewrite native Responses passthrough, change the
brief-mandated translated adapter failure code, or add queued-Grok coverage.

## Safety and Cleanup Audit

- Browser opening was disabled for every new gateway spawn with the explicit
  environment entry `GATEWAY_NO_OPEN: "1"`.
- Repository-wide inspection confirmed all five `spawn(process.execPath,
  ["server.js"])` test sites explicitly include `GATEWAY_NO_OPEN: "1"`.
- Every new gateway port is obtained by listening on `127.0.0.1` port `0`,
  closing the reservation, and passing that dynamic port through both temporary
  config and `GATEWAY_PORT`.
- No test used or contacted port 8787. A separately existing PID was observed
  listening on 127.0.0.1:8787; it had no task-worktree cwd and was left
  untouched.
- New child cleanup registers the exit promise before `kill()` and awaits the
  `exit` event.
- Mock/reservation servers are closed through awaited callbacks, with open test
  connections closed during teardown.
- Temporary gateway config/auth/agent-id directories are removed recursively.
- Post-test inspection found no Node process with cwd
  `.worktrees/codex-gateway-chain` and no `codex-gateway-integration-*`
  temporary directory.
- No real configuration, credential, secret, browser, background service, or
  active Codex configuration was read for mutation or modified.

## Self-Review

- Cancellation is bound only for the Responses route and disposed in `finally`,
  so existing non-Responses routes retain their behavior.
- The request-wide timeout and disconnect share the same downstream transport
  signal for the whole response body lifetime, avoiding the earlier
  headers-only cancellation gap.
- Pre-header translated errors still execute before SSE headers and use the
  original upstream status/body.
- Post-header exceptions cannot fall through to the top-level JSON error path;
  `ResponsesWriter` enforces one terminal event and `finally` closes the stream.
- Codex's configured Fetch path explicitly disables credential fallback once
  any upstream response exists. All callers retain legacy configured-key-first
  selection through `providerApiKey`; retry permission does not alter initial
  credential precedence.
- Grok queue removal and response/request cleanup are guarded against double
  resource release.
- No unrelated files or real runtime configuration were changed.

## Concerns

No known functional concerns. Official Codex and Ark cancellation are covered
by the same Fetch signal path as the local configured Fetch integration test;
they were not contacted because deterministic tests must not use real
credentials or external services.
