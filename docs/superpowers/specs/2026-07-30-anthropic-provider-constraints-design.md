# Anthropic Provider Constraints Layer

## Problem

`sanitizeAnthropicMessages` in `server.js` mixes three categories of logic:

1. Anthropic protocol format normalization (all providers need this): empty
   text padding, string-to-block conversion, adjacent same-role merging.
2. Bedrock-specific constraint: assistant text blocks must precede tool_use
   blocks.
3. Cross-provider constraint: conversation must end with a user message
   (Bedrock and GLM both require this, for different reasons).

These share one function on one call path. Adding a constraint for any
provider risks every other provider's path. This is the technical debt the
refactor addresses.

## Goal

Provider-specific Anthropic constraints become independent, atomic, and
non-interfering. Adding a constraint for one provider never touches code on
another provider's path.

## Architecture

```
sanitizeAnthropicMessages(messages)
  -> format normalization only, no provider logic
  -> applied to all anthropic routes unconditionally

applyAnthropicConstraints(messages, route)
  -> constraintsForRoute(route) returns an ordered list
  -> each constraint .apply(messages) in sequence
  -> constraints are independent: order-independent, no cross-references
```

### New module: lib/codex/anthropic-constraints.mjs

Exports:

- Individual constraint objects, each with `{ name, description, apply }`
- `constraintsForRoute(route)` - profile resolver, returns constraint list
- `applyAnthropicConstraints(messages, route)` - applies the list in order

### Constraint unit shape

Every constraint is a standalone exported object:

```js
export const noAssistantPrefill = {
  name: "no_assistant_prefill",
  description: "Strip trailing assistant messages so the conversation ends with a user turn.",
  apply(messages) {
    // mutates the array in place, returns it
  },
};
```

Constraints:
- Are pure functions of messages (no side effects, no external state).
- Do not import or reference each other.
- Can be applied in any order without changing the result.
- `apply(messages)` mutates the array in place and returns it. The input
  array is always a fresh copy produced by `sanitizeAnthropicMessages`, so
  mutation is safe.

### Initial constraints

Two constraints move out of `sanitizeAnthropicMessages`:

| Constraint | What it does | Origin |
|---|---|---|
| `noAssistantPrefill` | Pop trailing assistant messages, ensure final message is user | Bedrock prefill fix + GLM fix |
| `textBeforeToolUse` | Move trailing text blocks ahead of tool_use within each assistant message | Bedrock ordering fix |

### Profile resolver

Profile is selected by a declarative domain-to-profile table. The resolver
is a pure lookup function that never changes; adding a provider means adding
one row to the table, not modifying resolver logic. This satisfies the
open-closed principle: open for extension (new table rows, new constraint
exports), closed for modification (resolver body stays fixed).

Domain is stable across config changes, unlike provider id (random UUID) or
name (user defined). Official Anthropic routes (`route.kind === "official"`)
have no `base_url` and default to strict.

```js
const PROFILES = {
  strict: [noAssistantPrefill, textBeforeToolUse],
};

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

All current providers map to strict:

| Domain | Provider | Profile |
|---|---|---|
| `ark.cn-beijing.volces.com` | Volcengine (Bedrock-compatible) | strict |
| (no base_url, `route.kind === "official"`) | Official Anthropic | strict |

Adding a new provider with the same constraints as Volcengine requires zero
code change (falls through to `strict` default). Adding a provider with new
constraints requires: one new constraint export (new file/test), one entry
in `PROFILES`, one row in `DOMAIN_PROFILES`. The resolver, existing
constraints, and existing tests are never modified.

### What stays in sanitizeAnthropicMessages

Only format normalization remains:

- Empty/invalid input guard
- String content to block conversion
- Empty text padding (empty -> space)
- Adjacent same-role message merging

The function keeps its current signature `(messages)` so callers that don't
need provider constraints still work.

## Wiring

### Conversion functions gain a route parameter

```js
openAIChatToAnthropic(body, resolvedModel, route)
openAIResponsesToAnthropic(body, resolvedModel, route)
```

Inside each, the sequence becomes:

```js
const sanitized = sanitizeAnthropicMessages(messages);
const constrained = applyAnthropicConstraints(sanitized, route);
```

Both functions already receive `resolvedModel`; the route object is available
at every call site (`route.provider.type`, `route.kind`). Retry paths pass
the same route through.

### Call sites affected

`openAIChatToAnthropic` is called at: 2074, 2164, 2190, 2394.
`openAIResponsesToAnthropic` is called at: 2738, 2973, 2998, 3051.

All eight call sites have `route` in scope. Each gains `route` as a third
argument.

### Direct passthrough boundary

`forwardAnthropicMessagesResolved` (Anthropic Messages in, Anthropic Messages
out, no format conversion) is NOT touched in this refactor. It has its own
sanitization path. Covering it is a follow-up.

## Files

| File | Change |
|---|---|
| `lib/codex/anthropic-constraints.mjs` | New: constraint objects, profile resolver, apply function |
| `server.js` | Import new module; add `route` param to two conversion functions; remove constraint logic from `sanitizeAnthropicMessages` |
| `tests/unit/anthropic-constraints.test.mjs` | New: each constraint tested independently + profile resolver |
| `tests/integration/codex-gateway.test.mjs` | Existing tests verify no regression |

## Testing

### Unit tests (new file)

Each constraint gets its own test:

- `noAssistantPrefill`: input ending with assistant -> ends with user
- `noAssistantPrefill`: input already ending with user -> unchanged
- `textBeforeToolUse`: assistant with text after tool_use -> text moved before
- `textBeforeToolUse`: assistant with text before tool_use -> unchanged
- `constraintsForRoute`: returns strict profile for any route
- `applyAnthropicConstraints`: applies all constraints in order

### Integration regression

Existing 23 integration tests must pass unchanged. The two tests added in the
previous commit (`moves assistant text before tool_use for Bedrock history`
and `coalesces parallel tool history`) specifically validate the wiring.

## Out of scope

- Refactoring the N*N conversion matrix into a canonical intermediate
  representation (larger structural change, separate effort).
- OpenAI Chat / Responses sanitization (different protocol, different module).
- Direct Anthropic Messages passthrough sanitization (follow-up).
- Tool argument normalization (`normalizeCustomInput` stays in
  `responses-writer.mjs`).
