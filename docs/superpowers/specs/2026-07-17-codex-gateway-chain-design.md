# Codex Desktop Gateway Chain Design

**Date:** 2026-07-17

**Branch:** `codex/codex-gateway-chain`

**Status:** Proposed for implementation

## 1. Purpose

Make Codex Desktop use `local-ai-gateway` as its single model provider while preserving both:

1. Official Codex subscription models.
2. Independently named third-party models served by OpenAI Responses, OpenAI Chat Completions, or Grok.

The completed chain must support real coding-agent work, not text-only chat. Tool calls, tool results, images, reasoning summaries, streaming, cancellation, errors, and usage must survive the gateway.

## 2. Confirmed Requirements

- Every Codex Desktop request goes through the local gateway.
- Official models keep their official IDs, including `gpt-*` and `o*`.
- Third-party models use independent IDs and cannot override an official model ID.
- The first implementation supports:
  - Official Codex subscription routing.
  - OpenAI Responses providers.
  - OpenAI Chat Completions providers.
  - Grok Responses and Grok Chat backends.
- Anthropic Messages providers are outside this phase.
- Text, images, reasoning summaries, tools, parallel tool calls, and multi-turn tool results are required.
- The end-to-end acceptance task is:
  - List a directory.
  - Read files.
  - Modify files.
  - Run tests.
  - Inspect a failure and continue fixing it.
- The current production Codex configuration must not be overwritten during development.

## 3. Current State and Gaps

The gateway already exposes `/codex/v1/responses`, `/codex/v1/models`, and official subscription forwarding. It can route configured `openai-responses`, `openai-chat`, and `grok` providers.

The remaining gaps are structural:

- Native Responses streams can pass through, but translated streams do not share a complete event implementation.
- The current Chat-to-Responses stream adapter forwards text but drops streamed `tool_calls`.
- Reasoning fields from Chat providers are not normalized for Codex.
- Tool argument fragments, parallel calls, completion status, and usage are not consistently emitted.
- The runtime Codex model list and the standalone catalog generator use different sources and provider filters.
- Custom model catalog entries currently advertise text only.
- Cancellation does not have one explicit client-to-upstream propagation path for every provider.
- Existing tests verify nearby protocol behavior but do not run a complete Codex agent loop.

Text-only success is therefore not sufficient evidence that a third-party model is usable in Codex.

## 4. Architecture

Codex Desktop uses one provider definition with the Responses wire protocol:

```text
Codex Desktop
  -> POST /codex/v1/responses
  -> Codex route resolver
     -> official gpt-* / o*       -> official Codex subscription backend
     -> openai-responses model    -> native Responses provider
     -> openai-chat model         -> Responses-to-Chat request adapter
     -> grok Responses model      -> Grok Responses backend
     -> grok Chat model           -> Responses-to-Chat request adapter
  -> standard Responses JSON or SSE
  -> Codex Desktop
```

The gateway uses OpenAI Responses as the Codex-facing protocol. It does not convert all providers into a new proprietary intermediate wire format.

### 4.1 Module Boundaries

The implementation should extract only the Codex-specific protocol responsibilities needed to remove duplicated stream logic:

- `lib/codex/model-catalog.mjs`
  - Builds the merged official and third-party model catalog.
  - Validates model ID ownership and capabilities.
- `lib/codex/responses-writer.mjs`
  - Emits valid Responses SSE lifecycle events.
  - Tracks response, output, content, and tool item indices.
- `lib/codex/chat-adapter.mjs`
  - Converts Responses input into Chat Completions input.
  - Converts Chat JSON and SSE output into Responses JSON and SSE.
  - Aggregates fragmented and parallel tool calls.
- `server.js`
  - Retains HTTP routing, provider selection, authentication, upstream transport, and top-level cancellation.

Native Responses providers remain direct wherever possible. The new writer is primarily for translated Chat/Grok Chat streams and for consistent failures after an SSE response has begun.

## 5. Model Routing

### 5.1 Official Models

Official IDs are loaded from the installed Codex bundled catalog. A request whose model ID is in that catalog is routed to the official Codex backend before third-party lookup.

Official authentication order remains:

1. A non-placeholder bearer token supplied by Codex.
2. The current Codex login in `~/.codex/auth.json`.
3. `OPENAI_API_KEY` for the public OpenAI Responses endpoint.

The auth file is read per request so token refreshes do not require a gateway restart. The gateway does not copy official credentials into `gateway.config.json`.

### 5.2 Third-Party Models

Third-party models are declared under `clients.codex.endpoints`. Each exposed ID is independent, for example:

- `glm-5.2`
- `deepseek-v4`
- `openrouter-qwen3-coder`
- `grok-4.5`
- `grok-build`

Configuration validation fails when a third-party ID or alias collides with an official Codex ID. Silent override is not permitted.

Routing uses exact model IDs or explicit `model_mapping`. A default endpoint must not capture an official ID or an unknown Codex model implicitly.

## 6. Unified Codex Model Catalog

One catalog builder supplies both:

- `GET /codex/v1/models`
- The JSON file referenced by Codex `model_catalog_json`

The builder merges:

1. Official bundled Codex model metadata.
2. Models from `clients.codex.endpoints` whose type is `openai-responses`, `openai-chat`, or `grok`.

The standalone `scripts/codex-catalog.mjs` command calls the same builder instead of maintaining separate provider filtering.

Each custom model entry includes:

- Stable independent `slug`.
- Display name.
- Responses API support.
- Supported reasoning levels.
- Shell/tool metadata compatible with Codex.
- Declared input modalities.
- A description identifying the configured provider.

Image support is capability-driven. A custom model advertises `["text", "image"]` only when its configuration declares image support; otherwise the catalog advertises text only and the gateway returns a clear error for image input.

## 7. Request Conversion

### 7.1 Native Responses and Official Subscription

For official and `openai-responses` routes:

- Preserve the request structure and tool types.
- Replace only the model ID with the configured upstream ID.
- Preserve instructions, input items, images, tools, tool choice, reasoning options, and limits.
- Preserve upstream Responses SSE events unless an error or transport termination requires a normalized failure.

### 7.2 Responses to Chat Completions

For `openai-chat` and Grok Chat routes:

- `instructions` becomes the leading system message.
- User and assistant text blocks become Chat message content.
- `input_image` becomes an OpenAI-compatible `image_url` content part.
- `function_call` input items become assistant `tool_calls`.
- `function_call_output` becomes a `role: "tool"` message with the same `call_id`.
- Function tool definitions become Chat `tools[].function`.
- Tool choice is translated without weakening an explicit required or named-tool choice.
- Output token limits and sampling options are mapped only when the upstream protocol supports them.

### 7.3 Custom Codex Tools

Codex may expose tools as standard function tools or Responses custom tools.

- Standard function tools map directly.
- A custom tool sent to a Chat-only provider is wrapped as a function with a single string input field.
- The adapter records the original tool kind by tool name for the lifetime of the request.
- A wrapped Chat tool call is converted back to the Responses output item and delta event type expected for the original custom tool.
- If a tool cannot be represented without changing its meaning, the gateway returns a compatibility error before contacting the upstream provider.

Unsupported tools are never silently removed.

## 8. Responses Streaming Contract

Translated streams use a single lifecycle writer.

### 8.1 Text

The writer emits a valid sequence containing:

- `response.created`
- `response.output_item.added`
- Content-part start events when required by the Codex client version.
- `response.output_text.delta`
- Text/content completion events.
- `response.output_item.done`
- `response.completed`

Indices and item IDs remain stable throughout the stream.

### 8.2 Function Calls

Chat `delta.tool_calls` fragments are grouped by choice index and tool-call index. For each call, the writer emits:

- `response.output_item.added`
- `response.function_call_arguments.delta`
- `response.function_call_arguments.done`
- `response.output_item.done`

The final item contains the complete function name, `call_id`, and JSON argument string. Multiple calls may be open concurrently and complete in any valid order.

For custom tools, the corresponding custom-tool input delta and done events are emitted instead.

Malformed argument fragments are preserved during streaming. JSON validity is checked only when the call is finalized, producing an explicit failure if the final argument string is invalid.

### 8.3 Reasoning

Native Responses reasoning events pass through.

For compatible Chat providers, known summary fields such as `reasoning_content` are converted into Codex-readable reasoning summary events. The gateway:

- Emits only content explicitly supplied by the upstream provider.
- Does not invent reasoning.
- Does not expose or decrypt hidden chain-of-thought fields.
- Preserves encrypted reasoning content only on native Responses routes that already support it.

### 8.4 Usage and Completion

Token usage is normalized from the final upstream usage object when available. Missing usage remains absent or zero according to the Responses contract; it is not estimated inside the stream adapter.

The writer emits exactly one terminal state:

- `response.completed`
- `response.incomplete`
- `response.failed`

A stream that closes without a valid terminal upstream event is not reported as successfully completed.

## 9. Non-Streaming Contract

Non-streaming Chat responses are converted into a complete Responses JSON object containing:

- Assistant text output items.
- Function or custom tool call output items.
- Reasoning summaries when supplied.
- Completion status.
- Usage.

Non-streaming Grok Responses streams are collected without discarding tool items or reasoning. The existing text-only collector is replaced by a full Responses collector.

## 10. Cancellation, Timeouts, and Errors

Each incoming request owns one `AbortController`.

- Client disconnect or cancellation aborts the active upstream request.
- Node HTTP requests used by Grok are destroyed on abort.
- Waiting work is removed from a provider queue when cancellation occurs.
- A completed or cancelled request releases provider resources exactly once.

The gateway does not automatically retry after an upstream response or tool call has started. This prevents duplicate shell commands and file modifications.

Before SSE headers are sent, upstream failures return an OpenAI-compatible JSON error with the original meaningful HTTP status when safe.

After SSE headers are sent, failures produce a standard `response.failed` event and close the stream. Error handling distinguishes:

- Authentication failure.
- Rate limiting.
- Provider rejection.
- Upstream timeout.
- Proxy/TLS failure.
- Client cancellation.
- Malformed upstream JSON or SSE.
- Premature stream termination.

## 11. Grok Behavior

Grok model metadata decides whether a model uses the Responses or Chat backend.

- Grok Responses uses the native Responses path.
- Grok Chat uses the Chat adapter.
- Local Grok session authentication and proxy behavior remain unchanged.
- Gateway concurrency is unlimited by default.
- A positive `max_concurrency` value remains available as an explicit safety control.

The Codex implementation must not reintroduce an implicit single-request Grok queue.

## 12. Configuration

Example third-party Codex endpoints:

```json
{
  "clients": {
    "codex": {
      "endpoints": [
        {
          "name": "openrouter-chat",
          "type": "openai-chat",
          "base_url": "https://openrouter.ai/api/v1/chat/completions",
          "api_key": "env:OPENROUTER_API_KEY",
          "models": ["openrouter-qwen3-coder"],
          "model_mapping": {
            "openrouter-qwen3-coder": "qwen/qwen3-coder"
          },
          "capabilities": {
            "input_modalities": ["text", "image"],
            "reasoning": true,
            "tools": true
          }
        },
        {
          "name": "grok-subscription",
          "type": "grok",
          "base_url": "https://cli-chat-proxy.grok.com/v1",
          "auth_path": "~/.grok/auth.json",
          "proxy": "http://127.0.0.1:7897",
          "max_concurrency": 0,
          "models": ["grok-4.5", "grok-build"],
          "capabilities": {
            "input_modalities": ["text", "image"],
            "reasoning": true,
            "tools": true
          }
        }
      ]
    }
  }
}
```

Codex uses one local provider:

```toml
model_provider = "local-gateway"
model_catalog_json = "/absolute/path/to/gateway-model-catalog.json"

[model_providers.local-gateway]
name = "Local AI Gateway"
base_url = "http://127.0.0.1:8787/codex/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "dummy"
request_max_retries = 1
stream_max_retries = 1
stream_idle_timeout_ms = 600000
```

The gateway configuration UI may generate this snippet, but it does not overwrite `~/.codex/config.toml` automatically.

## 13. Security and Logging

- API keys use `env:NAME` or `api_key_env`; committed examples contain no secrets.
- Official Codex tokens remain in the existing Codex auth store.
- Logs include request ID, client, model, resolved model, provider, upstream status, terminal event, and elapsed time.
- Logs exclude prompts, tool arguments, tool results, image data, authorization headers, cookies, and session tokens.
- Public configuration endpoints return masked credentials.
- Test processes disable Claude Desktop third-party config synchronization.

## 14. Test Strategy

### 14.1 Unit Tests

Test pure conversion behavior for:

- Text and system instructions.
- URL and base64 image parts.
- Function tool definitions.
- Custom tool wrapping.
- Tool choice.
- Function calls and tool outputs across turns.
- Fragmented arguments.
- Parallel tool calls.
- Reasoning summaries.
- Usage and terminal status.
- Invalid tool arguments and unsupported tools.

### 14.2 Mock Provider Integration Tests

Run the gateway against local scripted providers for:

- Native Responses SSE.
- Native Responses JSON.
- Chat Completions SSE.
- Chat Completions JSON.
- Grok Responses.
- Grok Chat.
- Authentication errors.
- Rate limits.
- TLS/transport-style failures.
- Premature SSE closure.
- Client cancellation.

The tests assert both the upstream request body and the exact Codex-facing output event sequence.

### 14.3 Codex Agent End-to-End Test

Use a temporary `CODEX_HOME`, temporary model catalog, temporary gateway config, and fixture Git repository. Do not modify the user's active Codex configuration.

A scripted provider drives a deterministic multi-turn task:

1. Ask Codex to inspect the fixture.
2. Return a directory-listing tool call.
3. Return a file-reading tool call.
4. Return an edit tool call.
5. Return a test command.
6. Simulate a failing result.
7. Return a corrective edit and rerun.
8. Finish with a text response.

The test passes only if Codex executes the expected tools, sends every tool result back through the gateway, changes the fixture correctly, and receives one valid terminal response per turn.

### 14.4 Opt-In Real Provider Smoke Tests

After deterministic tests pass:

- Run one official subscription request through the gateway.
- Run one configured Responses provider request.
- Run one configured Chat provider request.
- Run one Grok request.
- Run one image request on a model declaring image support.

These tests are opt-in because they use real credentials, quota, and network services.

## 15. Rollout and Rollback

1. Keep the current Codex Desktop configuration unchanged during development.
2. Validate the generated model catalog with `codex debug models`.
3. Run unit, integration, and temporary-`CODEX_HOME` tests.
4. Back up `~/.codex/config.toml`.
5. Add the single local gateway provider and catalog path.
6. Verify an official subscription model first.
7. Verify one third-party model from each supported protocol.
8. Verify the complete coding-agent acceptance task.
9. Enable normal Codex Desktop use only after the checks pass.

Rollback restores the backed-up `config.toml` and restarts Codex Desktop. The existing Codex auth file and official login are not modified, so rollback does not require signing in again.

## 16. Acceptance Criteria

The implementation is complete when all of the following are true:

- Codex Desktop has one configured local gateway provider.
- Official bundled models work through the gateway using the existing subscription.
- Third-party Responses, Chat, and Grok models appear under independent IDs.
- Third-party IDs cannot shadow official IDs.
- Text and image inputs reach capable upstream models intact.
- Reasoning summaries display when an upstream provider supplies them.
- Single and parallel tool calls execute successfully.
- Tool results survive multiple turns.
- The deterministic coding-agent end-to-end task passes.
- Cancellation stops upstream work.
- 401, 429, timeout, malformed SSE, and premature close are not reported as success.
- No test or log exposes credentials, prompts, tool payloads, or image data.
- Existing Claude Desktop, Claude Code, and non-Codex OpenAI routes continue to pass their regression tests.

## 17. Non-Goals

- Anthropic Messages providers as Codex backends.
- Image or video generation output.
- Automatic migration of existing Codex task history.
- Automatic editing of the user's active Codex configuration.
- Provider-side billing, quota management, or account pooling.
- Replacing Codex's local tool sandbox or approval system.
