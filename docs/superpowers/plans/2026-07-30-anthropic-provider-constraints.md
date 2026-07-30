# Anthropic Provider Constraints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract provider-specific Anthropic message constraints from `sanitizeAnthropicMessages` into independent, atomic constraint units selected by a declarative domain-to-profile table, satisfying the open-closed principle.

**Architecture:** A new `lib/codex/anthropic-constraints.mjs` module exports standalone constraint objects (`noAssistantPrefill`, `textBeforeToolUse`), a `PROFILES` map, a `DOMAIN_PROFILES` lookup table, and `constraintsForRoute(route)` + `applyAnthropicConstraints(messages, route)`. `sanitizeAnthropicMessages` in `server.js` loses its constraint logic and keeps only format normalization. The two conversion functions `openAIChatToAnthropic` and `openAIResponsesToAnthropic` gain a `route` parameter and call sanitize then constrain internally.

**Tech Stack:** Node.js 24, ES modules, `node:test` + `node:assert/strict`, no external dependencies.

## Global Constraints

- The worktree is at `.worktrees/refactor/provider-constraints` on branch `refactor/provider-constraints`, based on `main` at commit `0bdc71f`.
- All files are ES modules (`.mjs`), use `export`/`import`, no CommonJS.
- Tests use `node:test` and `node:assert/strict` only, no external test runner.
- Constraint `apply(messages)` mutates the array in place and returns it; the input is always a fresh copy from `sanitizeAnthropicMessages`.
- Constraints are independent: no cross-imports, order-independent results.
- `constraintsForRoute` is a pure lookup over `DOMAIN_PROFILES`; the function body never changes when adding providers.
- The design spec is at `docs/superpowers/specs/2026-07-30-anthropic-provider-constraints-design.md`.
- Direct Anthropic passthrough (`forwardAnthropicMessagesResolved`) is out of scope.

---

### Task 1: Create the constraints module with noAssistantPrefill

**Files:**
- Create: `lib/codex/anthropic-constraints.mjs`
- Test: `tests/unit/anthropic-constraints.test.mjs`

**Interfaces:**
- Produces: `noAssistantPrefill` (exported object with `name`, `description`, `apply`), `hostFromUrl(url)` (internal helper), `constraintsForRoute(route)` (returns array), `applyAnthropicConstraints(messages, route)` (returns messages array)

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/anthropic-constraints.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { noAssistantPrefill, applyAnthropicConstraints, constraintsForRoute } from "../../lib/codex/anthropic-constraints.mjs";

test("noAssistantPrefill strips trailing assistant messages", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "prefill" }] },
    { role: "assistant", content: [{ type: "text", text: "more" }] },
  ];

  const result = noAssistantPrefill.apply(messages);

  assert.equal(result.length, 1);
  assert.equal(result[0].role, "user");
});

test("noAssistantPrefill leaves user-ending conversation unchanged", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
    { role: "user", content: [{ type: "text", text: "again" }] },
  ];

  const result = noAssistantPrefill.apply(messages);

  assert.equal(result.length, 3);
  assert.equal(result.at(-1).role, "user");
});

test("noAssistantPrefill appends user placeholder when all messages stripped", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "orphan" }] },
  ];

  const result = noAssistantPrefill.apply(messages);

  assert.equal(result.length, 1);
  assert.equal(result[0].role, "user");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/anthropic-constraints.test.mjs`
Expected: FAIL with module not found

- [ ] **Step 3: Write minimal implementation**

```js
// lib/codex/anthropic-constraints.mjs

export const noAssistantPrefill = {
  name: "no_assistant_prefill",
  description: "Strip trailing assistant messages so the conversation ends with a user turn.",
  apply(messages) {
    while (messages.length > 0 && messages[messages.length - 1]?.role === "assistant") {
      messages.pop();
    }
    const lastRole = messages[messages.length - 1]?.role;
    if (!lastRole || lastRole !== "user") {
      messages.push({ role: "user", content: [{ type: "text", text: " " }] });
    }
    return messages;
  },
};

export function hostFromUrl(url) {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function constraintsForRoute(route) {
  return PROFILES.strict;
}

export function applyAnthropicConstraints(messages, route) {
  const constraints = constraintsForRoute(route);
  for (const constraint of constraints) {
    constraint.apply(messages);
  }
  return messages;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/anthropic-constraints.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/codex/anthropic-constraints.mjs tests/unit/anthropic-constraints.test.mjs
git commit -m "feat: add anthropic-constraints module with noAssistantPrefill"
```

---

### Task 2: Add textBeforeToolUse constraint

**Files:**
- Modify: `lib/codex/anthropic-constraints.mjs`
- Test: `tests/unit/anthropic-constraints.test.mjs`

**Interfaces:**
- Consumes: module structure from Task 1
- Produces: `textBeforeToolUse` (exported object), `PROFILES` map containing both constraints under `strict`

- [ ] **Step 1: Write the failing test**

```js
// Append to tests/unit/anthropic-constraints.test.mjs
import { textBeforeToolUse } from "../../lib/codex/anthropic-constraints.mjs";

test("textBeforeToolUse moves trailing text before tool_use", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "tool", input: {} },
        { type: "text", text: "after" },
      ],
    },
  ];

  const result = textBeforeToolUse.apply(messages);

  assert.deepEqual(
    result[0].content.map((p) => p.type),
    ["text", "tool_use"],
  );
});

test("textBeforeToolUse leaves correct ordering unchanged", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "before" },
        { type: "tool_use", id: "t1", name: "tool", input: {} },
      ],
    },
  ];

  const result = textBeforeToolUse.apply(messages);

  assert.deepEqual(
    result[0].content.map((p) => p.type),
    ["text", "tool_use"],
  );
});

test("textBeforeToolUse skips messages without tool_use", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
  ];

  const result = textBeforeToolUse.apply(messages);

  assert.equal(result[0].content[0].type, "text");
  assert.equal(result[0].content[0].text, "hello");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/anthropic-constraints.test.mjs`
Expected: FAIL with `textBeforeToolUse` not exported

- [ ] **Step 3: Write minimal implementation**

Add to `lib/codex/anthropic-constraints.mjs`, before `constraintsForRoute`:

```js
export const textBeforeToolUse = {
  name: "text_before_tool_use",
  description: "Move assistant text blocks ahead of tool_use blocks within each message.",
  apply(messages) {
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      const firstToolUse = message.content.findIndex((part) => part?.type === "tool_use");
      if (firstToolUse < 0) continue;

      const beforeToolUse = message.content.slice(0, firstToolUse);
      const fromToolUse = message.content.slice(firstToolUse);
      const trailingText = fromToolUse.filter((part) => part?.type === "text");
      if (trailingText.length === 0) continue;

      message.content = [
        ...beforeToolUse,
        ...trailingText,
        ...fromToolUse.filter((part) => part?.type !== "text"),
      ];
    }
    return messages;
  },
};
```

Add the `PROFILES` map before `constraintsForRoute`:

```js
const PROFILES = {
  strict: [noAssistantPrefill, textBeforeToolUse],
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/anthropic-constraints.test.mjs`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/codex/anthropic-constraints.mjs tests/unit/anthropic-constraints.test.mjs
git commit -m "feat: add textBeforeToolUse constraint and strict profile"
```

---

### Task 3: Add profile resolver with domain lookup

**Files:**
- Modify: `lib/codex/anthropic-constraints.mjs`
- Test: `tests/unit/anthropic-constraints.test.mjs`

**Interfaces:**
- Consumes: `PROFILES` map, `hostFromUrl` from Tasks 1-2
- Produces: `DOMAIN_PROFILES` table, updated `constraintsForRoute` with domain-aware lookup, `profileNameForRoute` (internal)

- [ ] **Step 1: Write the failing test**

```js
// Append to tests/unit/anthropic-constraints.test.mjs

test("constraintsForRoute returns strict profile for volcengine domain", () => {
  const route = {
    provider: { base_url: "https://ark.cn-beijing.volces.com/api/plan" },
  };

  const constraints = constraintsForRoute(route);

  assert.equal(constraints.length, 2);
  assert.equal(constraints[0].name, "no_assistant_prefill");
  assert.equal(constraints[1].name, "text_before_tool_use");
});

test("constraintsForRoute returns strict for official route without base_url", () => {
  const route = { kind: "official" };

  const constraints = constraintsForRoute(route);

  assert.equal(constraints.length, 2);
});

test("constraintsForRoute returns strict for unknown domain fallback", () => {
  const route = {
    provider: { base_url: "https://unknown.example.com/api" },
  };

  const constraints = constraintsForRoute(route);

  assert.equal(constraints.length, 2);
});

test("constraintsForRoute returns strict for null route", () => {
  const constraints = constraintsForRoute(null);

  assert.equal(constraints.length, 2);
});

test("applyAnthropicConstraints chains both constraints in order", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "tool", input: {} },
        { type: "text", text: "after tool" },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "trailing prefill" }] },
  ];

  const result = applyAnthropicConstraints(messages, {
    provider: { base_url: "https://ark.cn-beijing.volces.com/api/plan" },
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].role, "assistant");
  assert.deepEqual(
    result[0].content.map((p) => p.type),
    ["text", "tool_use"],
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/anthropic-constraints.test.mjs`
Expected: FAIL on the domain-specific tests (constraintsForRoute currently returns PROFILES.strict unconditionally, which happens to pass; but `applyAnthropicConstraints` chaining test will fail because the assistant message with trailing text+tool_use needs both constraints applied)

Note: the domain tests may pass already since the default is strict. The chaining test validates the full pipeline. If all pass, proceed; the domain tests guard against future regressions when non-strict profiles are added.

- [ ] **Step 3: Write minimal implementation**

Replace `constraintsForRoute` in `lib/codex/anthropic-constraints.mjs`:

```js
const DOMAIN_PROFILES = {
  "ark.cn-beijing.volces.com": "strict",
};

export function constraintsForRoute(route) {
  const profile = profileNameForRoute(route);
  return PROFILES[profile] || PROFILES.strict;
}

function profileNameForRoute(route) {
  if (route?.kind === "official") return "strict";
  const host = hostFromUrl(route?.provider?.base_url);
  return DOMAIN_PROFILES[host] || "strict";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/anthropic-constraints.test.mjs`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/codex/anthropic-constraints.mjs tests/unit/anthropic-constraints.test.mjs
git commit -m "feat: add domain-to-profile resolver for anthropic constraints"
```

---

### Task 4: Strip constraint logic from sanitizeAnthropicMessages

**Files:**
- Modify: `server.js` (function `sanitizeAnthropicMessages` at line ~4937)
- Test: existing integration tests in `tests/integration/codex-gateway.test.mjs`

**Interfaces:**
- Consumes: nothing new
- Produces: `sanitizeAnthropicMessages` that does only format normalization (no prefill stripping, no text-before-tool-use reordering)

- [ ] **Step 1: Write the failing test**

This is a regression guard. The existing integration test "Codex Anthropic moves assistant text before tool_use for Bedrock history" validates that the constraint is still applied end-to-end. After stripping from sanitize, that test will fail until Task 5 wires the new module in. We run it now to capture the baseline.

Run: `node --test tests/integration/codex-gateway.test.mjs`
Expected: PASS (23 tests) - baseline before change

- [ ] **Step 2: Strip constraint logic from sanitizeAnthropicMessages**

In `server.js`, replace the `sanitizeAnthropicMessages` function (line ~4937) with format-normalization only:

```js
function sanitizeAnthropicMessages(messages) {
  if (!Array.isArray(messages)) return [{ role: "user", content: [{ type: "text", text: " " }] }];

  const merged = [];
  for (const rawMsg of messages) {
    if (!rawMsg || typeof rawMsg !== "object") continue;
    const role = rawMsg.role === "assistant" ? "assistant" : "user";
    let content = Array.isArray(rawMsg.content)
      ? rawMsg.content.filter(Boolean)
      : typeof rawMsg.content === "string"
        ? [{ type: "text", text: rawMsg.content }]
        : [];

    content = content.map((part) => {
      if (typeof part === "string") return { type: "text", text: part || " " };
      if (part && typeof part === "object" && part.type === "text") {
        return { ...part, text: part.text || " " };
      }
      return part;
    }).filter(Boolean);

    if (content.length === 0) {
      content = [{ type: "text", text: " " }];
    }

    const previous = merged[merged.length - 1];
    if (previous?.role === role) {
      previous.content.push(...content);
    } else {
      merged.push({ role, content });
    }
  }

  return merged;
}
```

This removes: the `textBeforeToolUse` loop, the trailing-assistant-pop `while` loop, and the `lastRole` user-guard. Those now live in the constraints module.

- [ ] **Step 3: Run tests to verify the regression**

Run: `node --test tests/integration/codex-gateway.test.mjs`
Expected: FAIL on "Codex Anthropic moves assistant text before tool_use for Bedrock history" - the constraint is no longer applied. This confirms the logic was removed.

- [ ] **Step 4: Commit (broken state, will be fixed in Task 5)**

```bash
git add server.js
git commit -m "refactor: strip provider constraints from sanitizeAnthropicMessages

Format normalization only; constraints move to anthropic-constraints.mjs.
Integration test for Bedrock text ordering will fail until wiring in next task."
```

---

### Task 5: Wire constraints module into conversion functions

**Files:**
- Modify: `server.js` (import at top, `openAIChatToAnthropic` at ~4999, `openAIResponsesToAnthropic` at ~5042, 8 call sites)
- Test: `tests/integration/codex-gateway.test.mjs`

**Interfaces:**
- Consumes: `applyAnthropicConstraints` from Task 3, `route` object available at each call site
- Produces: `openAIChatToAnthropic(body, resolvedModel, route)` and `openAIResponsesToAnthropic(body, resolvedModel, route)` with constraint application

- [ ] **Step 1: Add the import**

In `server.js`, near the other `lib/codex` imports (around line 30), add:

```js
import { applyAnthropicConstraints } from "./lib/codex/anthropic-constraints.mjs";
```

- [ ] **Step 2: Update openAIChatToAnthropic signature and body**

Change the function signature at ~4999 from:

```js
function openAIChatToAnthropic(body, resolvedModel) {
```

to:

```js
function openAIChatToAnthropic(body, resolvedModel, route) {
```

Change the sanitize call at ~5014 from:

```js
  const sanitizedMessages = sanitizeAnthropicMessages(messages);
```

to:

```js
  const sanitizedMessages = applyAnthropicConstraints(
    sanitizeAnthropicMessages(messages),
    route,
  );
```

- [ ] **Step 3: Update openAIResponsesToAnthropic signature and body**

Change the function signature at ~5042 from:

```js
function openAIResponsesToAnthropic(body, resolvedModel) {
```

to:

```js
function openAIResponsesToAnthropic(body, resolvedModel, route) {
```

Change the sanitize call at ~5070 from:

```js
  const sanitizedMessages = sanitizeAnthropicMessages(messages);
```

to:

```js
  const sanitizedMessages = applyAnthropicConstraints(
    sanitizeAnthropicMessages(messages),
    route,
  );
```

Also update the internal delegation to `openAIChatToAnthropic` at ~5060 from:

```js
    return openAIChatToAnthropic(
      {
        ...body,
        model: resolvedModel,
        max_tokens: body.max_output_tokens || body.max_tokens,
      },
      resolvedModel,
    );
```

to:

```js
    return openAIChatToAnthropic(
      {
        ...body,
        model: resolvedModel,
        max_tokens: body.max_output_tokens || body.max_tokens,
      },
      resolvedModel,
      route,
    );
```

- [ ] **Step 4: Update all 8 call sites to pass route**

In `server.js`, update each call to add `route` as the third argument:

Line ~2074:
```js
      ? openAIChatToAnthropic(body, resolvedModel, route)
```

Line ~2164:
```js
        body: withoutStreamFlag(openAIChatToAnthropic(body, resolvedModel, route)),
```

Line ~2190:
```js
              withoutStreamFlag(openAIChatToAnthropic(retryBody, resolvedModel, route)),
```

Line ~2394:
```js
          ? openAIChatToAnthropic(retryBody, resolvedModel, route)
```

Line ~2738:
```js
    ? openAIResponsesToAnthropic(body, resolvedModel, route)
```

Line ~2973:
```js
        body: withoutStreamFlag(openAIResponsesToAnthropic(body, resolvedModel, route)),
```

Line ~2998:
```js
              withoutStreamFlag(openAIResponsesToAnthropic(retryBody, resolvedModel, route)),
```

Line ~3051:
```js
        openAIResponsesToAnthropic(retryBody, resolvedModel, route),
```

- [ ] **Step 5: Run all tests**

Run:
```bash
npm run check
node --test tests/unit/anthropic-constraints.test.mjs
node --test tests/unit/codex-responses-writer.test.mjs
node --test tests/unit/grok-input-sanitizer.test.mjs
node --test tests/integration/codex-gateway.test.mjs
```

Expected: all pass, including "Codex Anthropic moves assistant text before tool_use for Bedrock history"

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: wire anthropic-constraints into conversion functions

openAIChatToAnthropic and openAIResponsesToAnthropic now accept route and
apply provider constraints after format sanitization. All 8 call sites
updated to pass route through."
```

---

### Task 6: Full regression and verification

**Files:**
- Test: all unit and integration tests

- [ ] **Step 1: Run the complete test suite**

Run:
```bash
npm run check
npm run test:codex:unit
npm run test:codex:integration
```

Expected: all pass, 0 failures

- [ ] **Step 2: Verify no constraint logic remains in sanitizeAnthropicMessages**

Run: `grep -n "trailingText\|firstToolUse\|lastRole.*assistant\|while.*assistant" server.js`

Expected: no matches in the `sanitizeAnthropicMessages` function. The only `assistant` references should be the role assignment (`rawMsg.role === "assistant"`).

- [ ] **Step 3: Verify open-closed principle holds**

Confirm the following files have zero edits needed to add a hypothetical new provider:

- `lib/codex/anthropic-constraints.mjs` constraints: `noAssistantPrefill` and `textBeforeToolUse` would not be modified
- `server.js` `sanitizeAnthropicMessages`: would not be modified
- `server.js` call sites: would not be modified

Only `DOMAIN_PROFILES` and potentially `PROFILES` would gain a new entry.

- [ ] **Step 4: Final commit if any cleanup needed**

If the verification found no issues, no commit is needed. If cleanup was performed:

```bash
git add -A
git commit -m "chore: final cleanup after constraints refactor"
```

- [ ] **Step 5: Report completion**

Report:
- Unit tests: N passed, 0 failed
- Integration tests: 23 passed, 0 failed
- `npm run check`: passed
- `sanitizeAnthropicMessages` contains only format normalization
- Adding a new provider requires only data table changes, no logic edits
