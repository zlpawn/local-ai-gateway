# Codex Gateway Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route official Codex subscription models and independently named OpenAI Responses, OpenAI Chat, and Grok models through one local Responses-compatible gateway without losing tools, images, reasoning, cancellation, errors, or usage.

**Architecture:** Codex always speaks OpenAI Responses to `/codex/v1`. Official and native Responses routes stay as close to pass-through as possible. Chat-only routes use focused request and stream adapters plus one Responses lifecycle writer; runtime model discovery and the generated Codex catalog share one catalog builder.

**Tech Stack:** Node.js 18+, ECMAScript modules, built-in `node:test`, built-in Fetch/Web Streams, Node HTTP/HTTPS, existing `https-proxy-agent`, Codex CLI 0.142.5 or newer.

## Global Constraints

- Use TDD for every behavior change: add one focused failing test, observe the expected failure, implement the minimum behavior, and rerun the focused and full suites.
- Do not add a runtime dependency.
- Official bundled `gpt-*` and `o*` IDs always route to the official Codex backend and cannot be shadowed by configuration.
- Third-party models use independent IDs declared under `clients.codex.endpoints`.
- Supported third-party types in this phase are exactly `openai-responses`, `openai-chat`, and `grok`.
- Anthropic Messages providers are not Codex backends in this phase.
- Development and automated tests must not overwrite the active `~/.codex/config.toml` or Claude Desktop third-party configuration.
- Credentials remain in `~/.codex/auth.json`, `~/.grok/auth.json`, or environment variables; committed JSON contains no live key.
- Logs must not contain prompts, tool arguments, tool results, image bytes, authorization headers, cookies, or session tokens.
- `max_concurrency` absent or `0` means unlimited Grok concurrency; a positive integer enables the explicit gateway limit.
- Keep the local `gateway.config.json` unstaged because it contains machine-specific configuration.

---

## File Structure

Create these focused modules:

- `lib/codex/model-catalog.mjs`: merge official and configured model metadata, validate collisions, and expose one catalog representation.
- `lib/codex/chat-request-adapter.mjs`: convert Responses requests to Chat Completions requests and retain per-tool kind metadata.
- `lib/codex/responses-writer.mjs`: emit one valid Responses SSE lifecycle with stable IDs and indices.
- `lib/codex/sse.mjs`: parse Web `ReadableStream` SSE input into async event records.
- `lib/codex/chat-response-adapter.mjs`: convert Chat SSE/JSON output into Responses SSE/JSON.
- `lib/codex/responses-collector.mjs`: collect a Responses SSE stream without dropping tools or reasoning.
- `lib/codex/request-abort.mjs`: bind client disconnects to one upstream `AbortSignal`.
- `lib/codex/config-validation.mjs`: validate Codex endpoint types, model collisions, and declared capabilities.

Create these tests and harnesses:

- `scripts/codex-model-catalog.test.mjs`
- `scripts/codex-chat-request-adapter.test.mjs`
- `scripts/codex-responses-writer.test.mjs`
- `scripts/codex-chat-response-adapter.test.mjs`
- `scripts/codex-gateway.integration.test.mjs`
- `scripts/codex-e2e.mjs`

Modify these existing files:

- `server.js`: delegate Codex catalog, translation, collection, and cancellation to the focused modules.
- `scripts/codex-catalog.mjs`: call the shared model catalog builder.
- `scripts/validate-config.mjs`: reject official-ID collisions and invalid Codex capabilities.
- `scripts/protocol-adapters.test.mjs`: retain existing Claude/Grok regression coverage and disable test-time Desktop synchronization.
- `desktop/config-panel.html`: expose Codex model capabilities and generate the single-provider Codex snippet.
- `desktop/lib/desktop-smoke.test.mjs`: verify the Codex configuration UI includes required fields and safe defaults.
- `package.json`: add exact Codex test commands.
- `README.md`: document the supported Codex provider matrix and isolated rollout.

---

### Task 1: Unify the Codex Model Catalog

**Files:**
- Create: `lib/codex/model-catalog.mjs`
- Create: `scripts/codex-model-catalog.test.mjs`
- Modify: `server.js:3538-3610`
- Modify: `scripts/codex-catalog.mjs:18-105`

**Interfaces:**
- Consumes: official model objects with a `slug` and configured `clients.codex.endpoints`.
- Produces: `buildCodexCatalog({ officialModels, endpoints }) -> { models, officialIds, customIds }`.
- Produces: `CodexCatalogError` with `code`, `modelId`, and a safe message.

- [ ] **Step 1: Write failing catalog tests**

Create `scripts/codex-model-catalog.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCodexCatalog,
  CodexCatalogError,
} from "../lib/codex/model-catalog.mjs";

const officialModels = [{
  slug: "gpt-5.5",
  display_name: "GPT-5.5",
  shell_type: "shell_command",
  input_modalities: ["text", "image"],
  supported_in_api: true,
}];

test("catalog merges Responses, Chat, and Grok models under independent IDs", () => {
  const result = buildCodexCatalog({
    officialModels,
    endpoints: [
      {
        name: "responses",
        type: "openai-responses",
        models: ["glm-5.2"],
        capabilities: {
          input_modalities: ["text", "image"],
          reasoning: true,
          tools: true,
        },
      },
      {
        name: "chat",
        type: "openai-chat",
        model_mapping: { "openrouter-qwen3-coder": "qwen/qwen3-coder" },
      },
      {
        name: "grok",
        type: "grok",
        models: ["grok-4.5"],
      },
      {
        name: "ignored",
        type: "anthropic",
        models: ["claude-sonnet"],
      },
    ],
  });

  assert.deepEqual(result.models.map((model) => model.slug), [
    "gpt-5.5",
    "glm-5.2",
    "openrouter-qwen3-coder",
    "grok-4.5",
  ]);
  assert.deepEqual(result.models[1].input_modalities, ["text", "image"]);
  assert.equal(result.officialIds.has("gpt-5.5"), true);
  assert.equal(result.customIds.has("grok-4.5"), true);
});

test("catalog rejects a configured model that shadows an official ID", () => {
  assert.throws(
    () => buildCodexCatalog({
      officialModels,
      endpoints: [{
        name: "chat",
        type: "openai-chat",
        models: ["gpt-5.5"],
      }],
    }),
    (error) => {
      assert.equal(error instanceof CodexCatalogError, true);
      assert.equal(error.code, "official_model_collision");
      assert.equal(error.modelId, "gpt-5.5");
      return true;
    },
  );
});
```

- [ ] **Step 2: Run the catalog tests and observe the missing-module failure**

Run:

```bash
node --test scripts/codex-model-catalog.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/codex/model-catalog.mjs`.

- [ ] **Step 3: Implement the shared catalog builder**

Create `lib/codex/model-catalog.mjs`:

```js
const SUPPORTED_PROVIDER_TYPES = new Set([
  "openai-responses",
  "openai-chat",
  "grok",
]);

export class CodexCatalogError extends Error {
  constructor(code, modelId, message) {
    super(message);
    this.name = "CodexCatalogError";
    this.code = code;
    this.modelId = modelId;
  }
}

export function buildCodexCatalog({ officialModels = [], endpoints = [] }) {
  const officialCopies = officialModels.map((model) => structuredClone(model));
  const officialIds = new Set(officialCopies.map((model) => model.slug));
  const customIds = new Set();
  const customModels = [];
  const reference = officialCopies[0] || fallbackReferenceModel();

  for (const endpoint of endpoints) {
    if (!SUPPORTED_PROVIDER_TYPES.has(endpoint?.type)) continue;
    const ids = [
      ...(Array.isArray(endpoint.models) ? endpoint.models : []),
      ...Object.keys(endpoint.model_mapping || {}),
    ];

    for (const rawId of ids) {
      const id = String(rawId || "").trim();
      if (!id || customIds.has(id)) continue;
      if (officialIds.has(id)) {
        throw new CodexCatalogError(
          "official_model_collision",
          id,
          `Configured Codex model '${id}' conflicts with an official Codex model ID.`,
        );
      }
      customIds.add(id);
      customModels.push(buildCustomModel(id, endpoint, reference));
    }
  }

  return {
    models: [...officialCopies, ...customModels],
    officialIds,
    customIds,
  };
}

function buildCustomModel(id, endpoint, reference) {
  const model = structuredClone(reference);
  delete model.model_messages;
  model.instructions_variables = {};
  model.slug = id;
  model.display_name = endpoint.display_names?.[id] || id;
  model.description = `${id} via ${endpoint.name || endpoint.type}.`;
  model.visibility = "list";
  model.supported_in_api = true;
  model.priority = 1000;
  model.owned_by = endpoint.name || "local-gateway";
  model.input_modalities = normalizeModalities(
    endpoint.capabilities?.input_modalities,
  );
  model.base_instructions =
    "You are Codex, a coding agent. Follow the active system and developer instructions.";
  return model;
}

function normalizeModalities(value) {
  const source = Array.isArray(value) ? value : ["text"];
  const result = source.filter((item) => item === "text" || item === "image");
  if (!result.includes("text")) result.unshift("text");
  return [...new Set(result)];
}

function fallbackReferenceModel() {
  return {
    slug: "gpt-5.5",
    display_name: "GPT-5.5",
    supported_in_api: true,
    shell_type: "shell_command",
    input_modalities: ["text"],
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast responses with lighter reasoning" },
      { effort: "medium", description: "Balanced reasoning" },
      { effort: "high", description: "More reasoning" },
    ],
  };
}
```

- [ ] **Step 4: Replace both catalog implementations with the shared builder**

In `server.js`, import the builder and derive `CODEX_CUSTOM_MODELS` and `OFFICIAL_CODEX_MODEL_IDS` from one result:

```js
import { buildCodexCatalog } from "./lib/codex/model-catalog.mjs";

const CODEX_CATALOG = buildCodexCatalog({
  officialModels: OFFICIAL_CODEX_CATALOG_MODELS,
  endpoints: GATEWAY_CONFIG.clients?.codex?.endpoints || [],
});
const OFFICIAL_CODEX_MODEL_IDS = CODEX_CATALOG.officialIds;
const CODEX_CUSTOM_MODELS = CODEX_CATALOG.models.filter(
  (model) => !OFFICIAL_CODEX_MODEL_IDS.has(model.slug),
);
```

Delete `buildCodexCustomModels` and `buildCodexCustomModel` from `server.js`.

In `scripts/codex-catalog.mjs`, import `buildCodexCatalog`, pass `config.clients?.codex?.endpoints`, and write the returned `models`. Delete its local `buildCustomModels` and `buildCustomModel`.

- [ ] **Step 5: Run focused and existing catalog verification**

Run:

```bash
node --test scripts/codex-model-catalog.test.mjs
npm run codex:catalog:verify
```

Expected: both commands exit 0; the generated catalog contains official models plus every configured Codex Responses, Chat, and Grok model, with no Anthropic-only model.

- [ ] **Step 6: Commit the catalog unit**

```bash
git add lib/codex/model-catalog.mjs scripts/codex-model-catalog.test.mjs server.js scripts/codex-catalog.mjs
git commit -m "feat: unify Codex model catalog generation"
```

---

### Task 2: Convert Codex Responses Requests to Chat Requests

**Files:**
- Create: `lib/codex/chat-request-adapter.mjs`
- Create: `scripts/codex-chat-request-adapter.test.mjs`
- Modify: `server.js:1940-2030`

**Interfaces:**
- Produces: `responsesRequestToChat(body, resolvedModel) -> { body, toolKinds }`.
- `toolKinds` is a `Map<string, "function" | "custom">` keyed by tool name.
- Later tasks consume the returned Chat body and `toolKinds`.

- [ ] **Step 1: Write failing request-conversion tests**

Create `scripts/codex-chat-request-adapter.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { responsesRequestToChat } from "../lib/codex/chat-request-adapter.mjs";

test("request adapter preserves image, function history, and custom tool metadata", () => {
  const result = responsesRequestToChat({
    model: "openrouter-qwen3-coder",
    instructions: "Work carefully.",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Inspect this image." },
          {
            type: "input_image",
            image_url: "data:image/png;base64,iVBORw0KGgo=",
          },
        ],
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "shell_command",
        arguments: "{\"command\":\"ls\"}",
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "README.md",
      },
    ],
    tools: [
      {
        type: "function",
        name: "shell_command",
        description: "Run a shell command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
      {
        type: "custom",
        name: "apply_patch",
        description: "Apply a patch",
      },
    ],
    tool_choice: "required",
    max_output_tokens: 100,
    stream: true,
  }, "qwen/qwen3-coder");

  assert.deepEqual(result.body.messages[0], {
    role: "system",
    content: "Work carefully.",
  });
  assert.deepEqual(result.body.messages[1].content, [
    { type: "text", text: "Inspect this image." },
    {
      type: "image_url",
      image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
    },
  ]);
  assert.equal(result.body.messages[2].tool_calls[0].id, "call_1");
  assert.deepEqual(result.body.messages[3], {
    role: "tool",
    tool_call_id: "call_1",
    content: "README.md",
  });
  assert.equal(result.body.tools[1].function.name, "apply_patch");
  assert.deepEqual(result.body.tools[1].function.parameters, {
    type: "object",
    properties: { input: { type: "string" } },
    required: ["input"],
    additionalProperties: false,
  });
  assert.equal(result.toolKinds.get("shell_command"), "function");
  assert.equal(result.toolKinds.get("apply_patch"), "custom");
  assert.equal(result.body.tool_choice, "required");
  assert.equal(result.body.max_tokens, 100);
});

test("request adapter rejects an unrepresentable hosted tool", () => {
  assert.throws(
    () => responsesRequestToChat({
      input: "Search",
      tools: [{ type: "web_search_preview" }],
    }, "chat-model"),
    /cannot be represented by Chat Completions/,
  );
});
```

- [ ] **Step 2: Run the request-adapter tests and observe the missing-module failure**

Run:

```bash
node --test scripts/codex-chat-request-adapter.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the request adapter**

Create `lib/codex/chat-request-adapter.mjs` with these exported and private functions:

```js
export function responsesRequestToChat(source, resolvedModel) {
  const messages = [];
  const toolKinds = new Map();

  if (source.instructions) {
    messages.push({ role: "system", content: String(source.instructions) });
  }

  const input = Array.isArray(source.input)
    ? source.input
    : typeof source.input === "string"
      ? [{ role: "user", content: [{ type: "input_text", text: source.input }] }]
      : [];

  for (const item of input) {
    const message = inputItemToChatMessage(item);
    if (message) messages.push(message);
  }

  const tools = (source.tools || []).map((tool) => {
    if (tool.type === "function") {
      toolKinds.set(tool.name, "function");
      return {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: tool.parameters || emptyObjectSchema(),
        },
      };
    }
    if (tool.type === "custom") {
      toolKinds.set(tool.name, "custom");
      return {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: {
            type: "object",
            properties: { input: { type: "string" } },
            required: ["input"],
            additionalProperties: false,
          },
        },
      };
    }
    throw new Error(
      `Responses tool type '${tool.type || "unknown"}' cannot be represented by Chat Completions.`,
    );
  });

  const body = {
    model: resolvedModel,
    messages: messages.length ? messages : [{ role: "user", content: "" }],
    stream: Boolean(source.stream),
  };
  if (tools.length) body.tools = tools;
  if (source.tool_choice != null) body.tool_choice = source.tool_choice;
  if (source.max_output_tokens != null) body.max_tokens = source.max_output_tokens;
  if (source.temperature != null) body.temperature = source.temperature;
  if (source.top_p != null) body.top_p = source.top_p;
  if (source.stop != null) body.stop = source.stop;

  return { body, toolKinds };
}

function inputItemToChatMessage(item) {
  if (!item || typeof item !== "object") return null;
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    const rawArguments = item.type === "custom_tool_call"
      ? JSON.stringify({ input: item.input || "" })
      : typeof item.arguments === "string"
        ? item.arguments
        : JSON.stringify(item.arguments || {});
    return {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: item.call_id || item.id,
        type: "function",
        function: { name: item.name, arguments: rawArguments },
      }],
    };
  }
  if (
    item.type === "function_call_output" ||
    item.type === "custom_tool_call_output"
  ) {
    return {
      role: "tool",
      tool_call_id: item.call_id || item.id,
      content: stringifyOutput(item.output),
    };
  }
  return {
    role: item.role === "assistant" ? "assistant" : "user",
    content: contentToChat(item.content),
  };
}

function contentToChat(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (
      part.type === "input_text" ||
      part.type === "output_text" ||
      part.type === "text"
    ) {
      return { type: "text", text: String(part.text || "") };
    }
    if (part.type === "input_image" && part.image_url) {
      return {
        type: "image_url",
        image_url: { url: String(part.image_url) },
      };
    }
    throw new Error(
      `Responses content type '${part.type || "unknown"}' cannot be represented by Chat Completions.`,
    );
  });
}

function stringifyOutput(output) {
  return typeof output === "string" ? output : JSON.stringify(output ?? "");
}

function emptyObjectSchema() {
  return { type: "object", properties: {} };
}
```

- [ ] **Step 4: Replace the server's local request conversion**

Import `responsesRequestToChat` in `server.js`. In the `openai-chat` and Grok Chat branches, use:

```js
const chatRequest = responsesRequestToChat(body, resolvedModel);
const upstream = await fetchConfiguredOpenAI(
  route.provider,
  "/v1/chat/completions",
  chatRequest.body,
  clientReq,
);
```

Keep `chatRequest.toolKinds` available for Task 4's response adapter. Delete `openAIResponsesToChatCompletions` only after every call site uses the module.

- [ ] **Step 5: Run request conversion and existing adapter tests**

Run:

```bash
node --test scripts/codex-chat-request-adapter.test.mjs scripts/protocol-adapters.test.mjs
```

Expected: all tests pass.

- [ ] **Step 6: Commit request conversion**

```bash
git add lib/codex/chat-request-adapter.mjs scripts/codex-chat-request-adapter.test.mjs server.js
git commit -m "feat: preserve Codex inputs for Chat providers"
```

---

### Task 3: Add the Responses SSE Parser and Lifecycle Writer

**Files:**
- Create: `lib/codex/sse.mjs`
- Create: `lib/codex/responses-writer.mjs`
- Create: `scripts/codex-responses-writer.test.mjs`

**Interfaces:**
- Produces: `iterateSse(readable) -> AsyncGenerator<{ event, data }>`
- Produces: `ResponsesWriter({ model, emit, responseId })`.
- `emit(event, payload)` receives already parsed event data; the server transport serializes it as SSE.

- [ ] **Step 1: Write failing lifecycle tests**

Create `scripts/codex-responses-writer.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { ResponsesWriter } from "../lib/codex/responses-writer.mjs";

test("writer emits stable text, reasoning, parallel function calls, and one terminal event", () => {
  const events = [];
  const writer = new ResponsesWriter({
    model: "chat-model",
    responseId: "resp_test",
    emit: (event, data) => events.push([event, data]),
  });

  writer.created();
  writer.reasoningDelta("Checking files.");
  writer.textDelta("I will inspect.");
  writer.functionArgumentsDelta({
    index: 0,
    callId: "call_a",
    name: "shell_command",
    delta: "{\"command\":\"ls\"}",
    kind: "function",
  });
  writer.functionArgumentsDelta({
    index: 1,
    callId: "call_b",
    name: "read_file",
    delta: "{\"path\":\"README.md\"}",
    kind: "function",
  });
  writer.finishFunction({
    index: 0,
    callId: "call_a",
    name: "shell_command",
    argumentsText: "{\"command\":\"ls\"}",
    kind: "function",
  });
  writer.finishFunction({
    index: 1,
    callId: "call_b",
    name: "read_file",
    argumentsText: "{\"path\":\"README.md\"}",
    kind: "function",
  });
  writer.completed({
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
  });
  writer.completed({});

  assert.equal(events[0][0], "response.created");
  assert.equal(
    events.filter(([event]) => event === "response.reasoning_summary_text.delta").length,
    1,
  );
  assert.equal(
    events.filter(([event]) => event === "response.output_item.added").length,
    3,
  );
  assert.equal(
    events.filter(([event]) => event === "response.output_item.done").length,
    3,
  );
  assert.equal(
    events.filter(([event]) => event === "response.completed").length,
    1,
  );
  const functionDone = events
    .filter(([event, data]) => (
      event === "response.output_item.done" &&
      data.item.type === "function_call"
    ))
    .map(([, data]) => data.item.call_id);
  assert.deepEqual(functionDone, ["call_a", "call_b"]);
});

test("writer emits response.failed instead of response.completed after failure", () => {
  const events = [];
  const writer = new ResponsesWriter({
    model: "chat-model",
    responseId: "resp_fail",
    emit: (event, data) => events.push([event, data]),
  });
  writer.created();
  writer.failed({ code: "upstream_stream_closed", message: "Upstream closed early." });
  writer.completed({});
  assert.deepEqual(
    events.filter(([event]) => event.startsWith("response.")).map(([event]) => event).slice(-1),
    ["response.failed"],
  );
});
```

- [ ] **Step 2: Run the writer tests and observe the missing-module failure**

Run:

```bash
node --test scripts/codex-responses-writer.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the SSE iterator**

Create `lib/codex/sse.mjs`:

```js
export async function* iterateSse(readable) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseFrame(frame);
        if (parsed) yield parsed;
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const parsed = parseFrame(buffer);
      if (parsed) yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(frame) {
  let event = "message";
  const data = [];
  for (const rawLine of frame.replaceAll("\r\n", "\n").split("\n")) {
    if (rawLine.startsWith("event:")) event = rawLine.slice(6).trim();
    if (rawLine.startsWith("data:")) data.push(rawLine.slice(5).trimStart());
  }
  if (!data.length) return null;
  return { event, data: data.join("\n") };
}
```

- [ ] **Step 4: Implement the Responses lifecycle writer**

Create `lib/codex/responses-writer.mjs` with a class that owns stable indices and refuses a second terminal event:

```js
export class ResponsesWriter {
  constructor({ model, emit, responseId = `resp_${Date.now()}` }) {
    this.model = model;
    this.emit = emit;
    this.responseId = responseId;
    this.terminal = false;
    this.createdSent = false;
    this.nextOutputIndex = 0;
    this.textItem = null;
    this.reasoningItem = null;
    this.toolItems = new Map();
  }

  created() {
    if (this.createdSent) return;
    this.createdSent = true;
    this.emit("response.created", {
      type: "response.created",
      response: this.response("in_progress"),
    });
  }

  textDelta(delta) {
    this.created();
    if (!this.textItem) {
      this.textItem = this.addItem({
        id: `msg_${this.responseId}`,
        type: "message",
        role: "assistant",
        content: [],
      });
      this.textItem.text = "";
    }
    this.textItem.text += String(delta);
    this.emit("response.output_text.delta", {
      type: "response.output_text.delta",
      output_index: this.textItem.outputIndex,
      content_index: 0,
      delta: String(delta),
    });
  }

  reasoningDelta(delta) {
    this.created();
    if (!this.reasoningItem) {
      this.reasoningItem = this.addItem({
        id: `rs_${this.responseId}`,
        type: "reasoning",
        summary: [],
      });
      this.reasoningItem.text = "";
    }
    this.reasoningItem.text += String(delta);
    this.emit("response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      output_index: this.reasoningItem.outputIndex,
      summary_index: 0,
      delta: String(delta),
    });
  }

  functionArgumentsDelta({ index, callId, name, delta, kind }) {
    this.created();
    const key = `${kind}:${index}`;
    if (!this.toolItems.has(key)) {
      const type = kind === "custom" ? "custom_tool_call" : "function_call";
      this.toolItems.set(key, this.addItem({
        id: `fc_${callId}`,
        type,
        call_id: callId,
        name,
        ...(kind === "custom" ? { input: "" } : { arguments: "" }),
      }));
    }
    const item = this.toolItems.get(key);
    const event = kind === "custom"
      ? "response.custom_tool_call_input.delta"
      : "response.function_call_arguments.delta";
    this.emit(event, {
      type: event,
      output_index: item.outputIndex,
      item_id: item.item.id,
      delta: String(delta),
    });
  }

  finishFunction({ index, callId, name, argumentsText, kind }) {
    const key = `${kind}:${index}`;
    if (!this.toolItems.has(key)) {
      this.functionArgumentsDelta({
        index,
        callId,
        name,
        delta: "",
        kind,
      });
    }
    const record = this.toolItems.get(key);
    const finalItem = {
      ...record.item,
      ...(kind === "custom"
        ? { input: unwrapCustomInput(argumentsText) }
        : { arguments: argumentsText }),
    };
    const doneEvent = kind === "custom"
      ? "response.custom_tool_call_input.done"
      : "response.function_call_arguments.done";
    this.emit(doneEvent, {
      type: doneEvent,
      output_index: record.outputIndex,
      item_id: record.item.id,
      ...(kind === "custom"
        ? { input: finalItem.input }
        : { arguments: finalItem.arguments }),
    });
    this.emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: record.outputIndex,
      item: finalItem,
    });
    record.done = true;
  }

  completed(usage) {
    if (this.terminal) return;
    this.finishOpenItems();
    this.terminal = true;
    this.emit("response.completed", {
      type: "response.completed",
      response: { ...this.response("completed"), usage },
    });
  }

  failed({ code, message }) {
    if (this.terminal) return;
    this.terminal = true;
    this.emit("response.failed", {
      type: "response.failed",
      response: {
        ...this.response("failed"),
        error: { code, message },
      },
    });
  }

  addItem(item) {
    const record = {
      item,
      outputIndex: this.nextOutputIndex,
      done: false,
    };
    this.nextOutputIndex += 1;
    this.emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: record.outputIndex,
      item,
    });
    return record;
  }

  finishOpenItems() {
    for (const record of [this.reasoningItem, this.textItem]) {
      if (!record || record.done) continue;
      const finalItem = record === this.textItem
        ? {
            ...record.item,
            content: [{
              type: "output_text",
              text: record.text,
              annotations: [],
            }],
          }
        : {
            ...record.item,
            summary: [{
              type: "summary_text",
              text: record.text,
            }],
          };
      this.emit("response.output_item.done", {
        type: "response.output_item.done",
        output_index: record.outputIndex,
        item: finalItem,
      });
      record.done = true;
    }
  }

  response(status) {
    return {
      id: this.responseId,
      object: "response",
      model: this.model,
      status,
    };
  }
}

function unwrapCustomInput(argumentsText) {
  const parsed = JSON.parse(argumentsText);
  if (typeof parsed.input !== "string") {
    throw new Error("Wrapped custom tool arguments must contain a string input.");
  }
  return parsed.input;
}
```

- [ ] **Step 5: Run writer tests**

Run:

```bash
node --test scripts/codex-responses-writer.test.mjs
```

Expected: all tests pass.

- [ ] **Step 6: Commit the streaming primitives**

```bash
git add lib/codex/sse.mjs lib/codex/responses-writer.mjs scripts/codex-responses-writer.test.mjs
git commit -m "feat: add Codex Responses lifecycle writer"
```

---

### Task 4: Translate Chat SSE Text, Reasoning, and Parallel Tools

**Files:**
- Create: `lib/codex/chat-response-adapter.mjs`
- Create: `scripts/codex-chat-response-adapter.test.mjs`
- Modify: `server.js:2906-2978`

**Interfaces:**
- Consumes: `iterateSse`, `ResponsesWriter`, and `toolKinds`.
- Produces: `streamChatAsResponses({ readable, writer, toolKinds }) -> Promise<void>`.
- Produces: `chatCompletionToResponse({ completion, model, toolKinds }) -> object`.

- [ ] **Step 1: Write a failing fragmented parallel-tool stream test**

Create `scripts/codex-chat-response-adapter.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { ReadableStream } from "node:stream/web";
import { streamChatAsResponses } from "../lib/codex/chat-response-adapter.mjs";
import { ResponsesWriter } from "../lib/codex/responses-writer.mjs";

test("Chat SSE becomes reasoning, text, and parallel Responses tool events", async () => {
  const chunks = [
    { choices: [{ delta: { reasoning_content: "Inspecting." } }] },
    { choices: [{ delta: { content: "Running tools." } }] },
    {
      choices: [{
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_a",
              type: "function",
              function: { name: "shell_command", arguments: "{\"command\":" },
            },
            {
              index: 1,
              id: "call_b",
              type: "function",
              function: { name: "apply_patch", arguments: "{\"input\":" },
            },
          ],
        },
      }],
    },
    {
      choices: [{
        delta: {
          tool_calls: [
            { index: 0, function: { arguments: "\"ls\"}" } },
            { index: 1, function: { arguments: "\"*** Begin Patch\\n*** End Patch\"}" } },
          ],
        },
      }],
    },
    {
      choices: [{
        delta: {},
        finish_reason: "tool_calls",
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    },
  ];
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const events = [];
  const writer = new ResponsesWriter({
    model: "chat-model",
    responseId: "resp_chat",
    emit: (event, data) => events.push([event, data]),
  });

  await streamChatAsResponses({
    readable,
    writer,
    toolKinds: new Map([
      ["shell_command", "function"],
      ["apply_patch", "custom"],
    ]),
  });

  const doneItems = events
    .filter(([event]) => event === "response.output_item.done")
    .map(([, data]) => data.item);
  assert.equal(doneItems.some((item) => item.type === "message"), true);
  assert.equal(
    doneItems.some((item) => (
      item.type === "function_call" &&
      item.call_id === "call_a" &&
      item.arguments === "{\"command\":\"ls\"}"
    )),
    true,
  );
  assert.equal(
    doneItems.some((item) => (
      item.type === "custom_tool_call" &&
      item.call_id === "call_b" &&
      item.input === "*** Begin Patch\n*** End Patch"
    )),
    true,
  );
  assert.equal(
    events.some(([event]) => event === "response.reasoning_summary_text.delta"),
    true,
  );
  assert.equal(events.at(-1)[0], "response.completed");
});
```

- [ ] **Step 2: Run the stream-adapter test and observe the missing-module failure**

Run:

```bash
node --test scripts/codex-chat-response-adapter.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement streamed Chat conversion**

Create `lib/codex/chat-response-adapter.mjs`:

```js
import { iterateSse } from "./sse.mjs";

export async function streamChatAsResponses({
  readable,
  writer,
  toolKinds = new Map(),
}) {
  const calls = new Map();
  let sawDone = false;
  let finalUsage = {};

  for await (const frame of iterateSse(readable)) {
    if (frame.data === "[DONE]") {
      sawDone = true;
      break;
    }
    const payload = JSON.parse(frame.data);
    const choice = payload.choices?.[0] || {};
    const delta = choice.delta || {};
    const reasoning = firstString(
      delta.reasoning_content,
      delta.reasoning,
      delta.analysis,
    );
    if (reasoning) writer.reasoningDelta(reasoning);
    if (typeof delta.content === "string" && delta.content) {
      writer.textDelta(delta.content);
    }
    for (const toolDelta of delta.tool_calls || []) {
      const state = getCallState(calls, toolDelta);
      const argumentDelta = toolDelta.function?.arguments || "";
      state.argumentsText += argumentDelta;
      writer.functionArgumentsDelta({
        index: state.index,
        callId: state.callId,
        name: state.name,
        delta: argumentDelta,
        kind: toolKinds.get(state.name) || "function",
      });
    }
    if (payload.usage) finalUsage = normalizeUsage(payload.usage);
    if (choice.finish_reason === "tool_calls") {
      finishCalls(calls, writer, toolKinds);
    }
  }

  if (!sawDone) {
    writer.failed({
      code: "upstream_stream_closed",
      message: "Chat upstream closed without a [DONE] marker.",
    });
    return;
  }
  finishCalls(calls, writer, toolKinds);
  writer.completed(finalUsage);
}

export function chatCompletionToResponse({
  completion,
  model,
  toolKinds = new Map(),
}) {
  const message = completion.choices?.[0]?.message || {};
  const output = [];
  if (message.reasoning_content) {
    output.push({
      id: `rs_${completion.id}`,
      type: "reasoning",
      summary: [{ type: "summary_text", text: message.reasoning_content }],
    });
  }
  if (message.content) {
    output.push({
      id: `msg_${completion.id}`,
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: message.content, annotations: [] }],
    });
  }
  for (const toolCall of message.tool_calls || []) {
    const name = toolCall.function?.name || "tool";
    const kind = toolKinds.get(name) || "function";
    output.push(kind === "custom"
      ? {
          id: `fc_${toolCall.id}`,
          type: "custom_tool_call",
          call_id: toolCall.id,
          name,
          input: JSON.parse(toolCall.function.arguments).input,
        }
      : {
          id: `fc_${toolCall.id}`,
          type: "function_call",
          call_id: toolCall.id,
          name,
          arguments: toolCall.function.arguments,
        });
  }
  return {
    id: completion.id || `resp_${Date.now()}`,
    object: "response",
    created_at: completion.created || Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output,
    output_text: message.content || "",
    usage: normalizeUsage(completion.usage || {}),
  };
}

function getCallState(calls, delta) {
  const index = Number(delta.index) || 0;
  if (!calls.has(index)) {
    calls.set(index, {
      index,
      callId: delta.id || `call_${index}`,
      name: delta.function?.name || "tool",
      argumentsText: "",
      done: false,
    });
  }
  const state = calls.get(index);
  if (delta.id) state.callId = delta.id;
  if (delta.function?.name) state.name = delta.function.name;
  return state;
}

function finishCalls(calls, writer, toolKinds) {
  for (const state of calls.values()) {
    if (state.done) continue;
    writer.finishFunction({
      index: state.index,
      callId: state.callId,
      name: state.name,
      argumentsText: state.argumentsText,
      kind: toolKinds.get(state.name) || "function",
    });
    state.done = true;
  }
}

function normalizeUsage(usage) {
  return {
    input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
    output_tokens: usage.completion_tokens || usage.output_tokens || 0,
    total_tokens: usage.total_tokens || 0,
  };
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value) || "";
}
```

- [ ] **Step 4: Route Chat streams and JSON through the adapter**

Replace `streamOpenAIChatAsOpenAIResponse` in `server.js` with:

```js
async function sendChatUpstreamAsResponses({
  upstream,
  clientRes,
  requestedModel,
  toolKinds,
}) {
  if (!upstream.ok) {
    await sendUpstreamError(upstream, clientRes);
    return;
  }
  clientRes.writeHead(200, responsesSseHeaders());
  const writer = new ResponsesWriter({
    model: requestedModel,
    emit(event, payload) {
      clientRes.write(`event: ${event}\n`);
      clientRes.write(`data: ${JSON.stringify(payload)}\n\n`);
    },
  });
  await streamChatAsResponses({
    readable: upstream.body,
    writer,
    toolKinds,
  });
  clientRes.end();
}
```

For non-streaming Chat responses, parse `await upstream.json()` and send `chatCompletionToResponse({ completion, model: requestedModel, toolKinds })`.

- [ ] **Step 5: Run focused and protocol regression tests**

Run:

```bash
node --test scripts/codex-chat-response-adapter.test.mjs scripts/protocol-adapters.test.mjs
```

Expected: all tests pass and existing Claude Desktop Grok tool behavior remains green.

- [ ] **Step 6: Commit Chat response conversion**

```bash
git add lib/codex/chat-response-adapter.mjs scripts/codex-chat-response-adapter.test.mjs server.js
git commit -m "feat: bridge Chat tools into Codex Responses"
```

---

### Task 5: Preserve Full Non-Streaming Grok Responses Output

**Files:**
- Create: `lib/codex/responses-collector.mjs`
- Modify: `scripts/codex-chat-response-adapter.test.mjs`
- Modify: `server.js:1208-1248`

**Interfaces:**
- Produces: `collectResponsesStream(readable, requestedModel) -> Promise<ResponseObject>`.
- Preserves message, reasoning, function call, custom tool call, usage, and terminal status.

- [ ] **Step 1: Add a failing full-output collector test**

Append to `scripts/codex-chat-response-adapter.test.mjs`:

```js
import { collectResponsesStream } from "../lib/codex/responses-collector.mjs";

test("Responses collector keeps reasoning and function calls", async () => {
  const encoder = new TextEncoder();
  const frames = [
    ["response.created", {
      type: "response.created",
      response: { id: "resp_collect", model: "grok-4.5", status: "in_progress" },
    }],
    ["response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "rs_1",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Inspect first." }],
      },
    }],
    ["response.output_item.done", {
      type: "response.output_item.done",
      output_index: 1,
      item: {
        id: "fc_1",
        type: "function_call",
        call_id: "call_1",
        name: "shell_command",
        arguments: "{\"command\":\"ls\"}",
      },
    }],
    ["response.completed", {
      type: "response.completed",
      response: {
        id: "resp_collect",
        model: "grok-4.5",
        status: "completed",
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      },
    }],
  ];
  const readable = new ReadableStream({
    start(controller) {
      for (const [event, data] of frames) {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      }
      controller.close();
    },
  });

  const response = await collectResponsesStream(readable, "grok-4.5");
  assert.equal(response.status, "completed");
  assert.deepEqual(response.output.map((item) => item.type), [
    "reasoning",
    "function_call",
  ]);
  assert.equal(response.usage.total_tokens, 5);
});
```

- [ ] **Step 2: Run the collector test and observe the missing-module failure**

Run:

```bash
node --test --test-name-pattern="Responses collector" scripts/codex-chat-response-adapter.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the full Responses collector**

Create `lib/codex/responses-collector.mjs`:

```js
import { iterateSse } from "./sse.mjs";

export async function collectResponsesStream(readable, requestedModel) {
  let response = {
    id: `resp_${Date.now()}`,
    object: "response",
    model: requestedModel,
    status: "in_progress",
    output: [],
    output_text: "",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
  };
  const outputByIndex = new Map();
  let terminal = false;

  for await (const frame of iterateSse(readable)) {
    const payload = JSON.parse(frame.data);
    if (payload.type === "response.created") {
      response = { ...response, ...payload.response, output: response.output };
    }
    if (payload.type === "response.output_item.done") {
      outputByIndex.set(payload.output_index, payload.item);
    }
    if (payload.type === "response.completed") {
      response = { ...response, ...payload.response };
      terminal = true;
    }
    if (payload.type === "response.incomplete") {
      response = { ...response, ...payload.response, status: "incomplete" };
      terminal = true;
    }
    if (payload.type === "response.failed") {
      response = { ...response, ...payload.response, status: "failed" };
      terminal = true;
    }
  }

  if (!terminal) {
    throw new Error("Responses upstream closed without a terminal event.");
  }
  response.output = [...outputByIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, item]) => item);
  response.output_text = response.output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text || "")
    .join("");
  return response;
}
```

- [ ] **Step 4: Replace the text-only Grok Responses collector**

In the non-streaming Grok Responses branch in `server.js`, replace `collectResponsesSseAsChatCompletion` plus `openAIChatCompletionToResponse` with:

```js
const response = await collectResponsesStream(upstream.body, requestedModel);
clientRes.writeHead(200, {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
});
clientRes.end(JSON.stringify(response));
```

Delete `collectResponsesSseAsChatCompletion` when no caller remains.

- [ ] **Step 5: Run collector and full adapter tests**

Run:

```bash
node --test scripts/codex-chat-response-adapter.test.mjs scripts/protocol-adapters.test.mjs
```

Expected: all tests pass.

- [ ] **Step 6: Commit full Responses collection**

```bash
git add lib/codex/responses-collector.mjs scripts/codex-chat-response-adapter.test.mjs server.js
git commit -m "fix: preserve Grok tools in non-streaming Responses"
```

---

### Task 6: Propagate Cancellation and Normalize Stream Failures

**Files:**
- Create: `lib/codex/request-abort.mjs`
- Create: `scripts/codex-gateway.integration.test.mjs`
- Modify: `server.js:532-700`
- Modify: `server.js:1138-1208`

**Interfaces:**
- Produces: `bindRequestAbort(req, res) -> { signal, dispose }`.
- Configured Fetch and Grok Node HTTP transports consume `signal`.
- Streaming adapters convert post-header failures into `response.failed`.

- [ ] **Step 1: Write a failing cancellation integration test**

Create `scripts/codex-gateway.integration.test.mjs` with the existing test helpers from `scripts/protocol-adapters.test.mjs`, then add:

```js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`Gateway exited before health check: ${child.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Gateway health check timed out.");
}

test("Codex cancellation aborts the active Chat upstream request", async (t) => {
  let upstreamClosed = false;
  const upstream = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: {\"choices\":[{\"delta\":{\"content\":\"start\"}}]}\n\n");
    });
    response.on("close", () => {
      upstreamClosed = true;
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  const reservation = http.createServer();
  const gatewayPort = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const tempDir = await mkdtemp(path.join(tmpdir(), "codex-cancel-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const configPath = path.join(tempDir, "gateway.config.json");
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: gatewayPort },
    clients: {
      codex: {
        endpoints: [{
          name: "chat",
          type: "openai-chat",
          base_url: `http://127.0.0.1:${upstreamPort}/chat/completions`,
          api_key: "env:TEST_CHAT_KEY",
          models: ["chat-model"],
        }],
      },
    },
  }));
  const gateway = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GATEWAY_CONFIG_FILE: configPath,
      GATEWAY_PORT: String(gatewayPort),
      TEST_CHAT_KEY: "test",
      CLAUDE_3P_SYNC_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (gateway.exitCode == null) gateway.kill();
  });
  await waitForHealth(gatewayPort, gateway);

  const controller = new AbortController();
  const request = fetch(`http://127.0.0.1:${gatewayPort}/codex/v1/responses`, {
    method: "POST",
    signal: controller.signal,
    headers: {
      authorization: "Bearer dummy",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "chat-model",
      input: "Start and wait.",
      stream: true,
    }),
  }).then((response) => response.text());
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(request, /abort/i);

  const deadline = Date.now() + 2_000;
  while (!upstreamClosed && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(upstreamClosed, true);
});
```

- [ ] **Step 2: Run the cancellation test and observe that the upstream stays open**

Run:

```bash
node --test --test-name-pattern="Codex cancellation" scripts/codex-gateway.integration.test.mjs
```

Expected: FAIL at `assert.equal(upstreamClosed, true)`.

- [ ] **Step 3: Implement request abort binding**

Create `lib/codex/request-abort.mjs`:

```js
export function bindRequestAbort(req, res) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted && !res.writableEnded) controller.abort();
  };
  req.once("aborted", abort);
  res.once("close", abort);
  return {
    signal: controller.signal,
    dispose() {
      req.off("aborted", abort);
      res.off("close", abort);
    },
  };
}
```

- [ ] **Step 4: Pass the signal through every Codex upstream transport**

At the start of `forwardOpenAIResponses`, bind cancellation:

```js
const requestAbort = bindRequestAbort(clientReq, clientRes);
try {
  await forwardResolvedCodexResponse({
    body,
    clientReq,
    clientRes,
    context,
    signal: requestAbort.signal,
  });
} finally {
  requestAbort.dispose();
}
```

Add `signal` to configured Fetch options:

```js
const upstream = await fetch(provider.base_url, {
  method: "POST",
  headers,
  body: JSON.stringify(upstreamBody),
  signal,
});
```

Add the signal to `fetchGrok`. Before `reqRef.end()`, bind:

```js
const abortGrok = () => reqRef?.destroy(new Error("client aborted"));
signal?.addEventListener("abort", abortGrok, { once: true });
res.once("close", () => {
  signal?.removeEventListener("abort", abortGrok);
});
```

Do not retry a request after an upstream response has started.

- [ ] **Step 5: Convert post-header adapter failures to `response.failed`**

Wrap translated streaming in `server.js`:

```js
try {
  await streamChatAsResponses({
    readable: upstream.body,
    writer,
    toolKinds,
  });
} catch (error) {
  writer.failed({
    code: error.code || "upstream_protocol_error",
    message: error.message || "Upstream protocol error.",
  });
} finally {
  clientRes.end();
}
```

Keep pre-header errors as JSON with the upstream HTTP status.

- [ ] **Step 6: Run cancellation, adapter, and syntax tests**

Run:

```bash
node --test scripts/codex-gateway.integration.test.mjs scripts/codex-chat-response-adapter.test.mjs
npm run check
```

Expected: all tests pass and syntax checks exit 0.

- [ ] **Step 7: Commit cancellation behavior**

```bash
git add lib/codex/request-abort.mjs scripts/codex-gateway.integration.test.mjs server.js
git commit -m "fix: propagate Codex request cancellation"
```

---

### Task 7: Validate Codex Capabilities and Update Configuration UI

**Files:**
- Create: `lib/codex/config-validation.mjs`
- Modify: `scripts/validate-config.mjs:94-153`
- Modify: `desktop/config-panel.html:1117-1200`
- Modify: `desktop/lib/desktop-smoke.test.mjs`
- Modify: `README.md:290-324`
- Modify: `package.json:35-44`

**Interfaces:**
- Codex endpoint `capabilities.input_modalities` is a subset of `["text", "image"]`.
- `capabilities.reasoning` and `capabilities.tools` are booleans.
- The UI stores these fields without exposing or copying secrets.

- [ ] **Step 1: Write failing validation and UI smoke tests**

Add a config-validation fixture test to `scripts/codex-model-catalog.test.mjs`:

```js
import { validateCodexEndpoints } from "../lib/codex/config-validation.mjs";

test("config validation rejects official collision and invalid modalities", () => {
  const result = validateCodexEndpoints({
    endpoints: [{
      name: "chat",
      type: "openai-chat",
      base_url: "https://example.invalid/chat/completions",
      api_key: "env:CHAT_KEY",
      models: ["gpt-5.5"],
      capabilities: {
        input_modalities: ["text", "audio"],
        reasoning: true,
        tools: true,
      },
    }],
    officialIds: new Set(["gpt-5.5"]),
  });
  assert.equal(
    result.errors.some((error) => error.includes("official Codex model ID")),
    true,
  );
  assert.equal(
    result.errors.some((error) => error.includes("unsupported input modality")),
    true,
  );
});
```

Add to `desktop/lib/desktop-smoke.test.mjs`:

```js
test("config panel exposes Codex tools, reasoning, and image capabilities", async () => {
  const html = await readFile(
    path.join(ROOT, "desktop", "config-panel.html"),
    "utf8",
  );
  assert.match(html, /Codex 能力/);
  assert.match(html, /capabilities-input-image/);
  assert.match(html, /capabilities-reasoning/);
  assert.match(html, /capabilities-tools/);
  assert.match(html, /wire_api = "responses"/);
});
```

- [ ] **Step 2: Run validation and UI tests and observe missing behavior**

Run:

```bash
node --test scripts/codex-model-catalog.test.mjs desktop/lib/desktop-smoke.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/codex/config-validation.mjs`; after that module exists, the UI smoke assertion still fails until Step 4.

- [ ] **Step 3: Add exact Codex capability validation**

Create `lib/codex/config-validation.mjs`:

```js
const CODEX_PROVIDER_TYPES = new Set([
  "openai-responses",
  "openai-chat",
  "grok",
]);

export function validateCodexEndpoints({
  endpoints = [],
  officialIds = new Set(),
}) {
  const errors = [];
  const warnings = [];
  for (const [index, endpoint] of endpoints.entries()) {
    const label = `client 'codex' endpoint ${index + 1}`;
    if (!CODEX_PROVIDER_TYPES.has(endpoint.type)) {
      errors.push(`${label} has unsupported Codex type '${endpoint.type}'.`);
    }
    for (const id of [
      ...(endpoint.models || []),
      ...Object.keys(endpoint.model_mapping || {}),
    ]) {
      if (officialIds.has(id)) {
        errors.push(`${label} shadows official Codex model ID '${id}'.`);
      }
    }
    for (const modality of endpoint.capabilities?.input_modalities || ["text"]) {
      if (!["text", "image"].includes(modality)) {
        errors.push(`${label} has unsupported input modality '${modality}'.`);
      }
    }
    for (const key of ["reasoning", "tools"]) {
      const value = endpoint.capabilities?.[key];
      if (value != null && typeof value !== "boolean") {
        errors.push(`${label} capabilities.${key} must be boolean.`);
      }
    }
  }
  return { errors, warnings };
}
```

Import the validator in `scripts/validate-config.mjs`, load installed official IDs, and append every result to the existing `errors` and `warnings` arrays:

```js
import { execFileSync } from "node:child_process";
import { validateCodexEndpoints } from "../lib/codex/config-validation.mjs";

const codexValidation = validateCodexEndpoints({
  endpoints: config.clients?.codex?.endpoints || [],
  officialIds: loadOfficialCodexIds(),
});
errors.push(...codexValidation.errors);
warnings.push(...codexValidation.warnings);

function loadOfficialCodexIds() {
  try {
    const output = execFileSync("codex", ["debug", "models", "--bundled"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    });
    const parsed = JSON.parse(output);
    return new Set((parsed.models || []).map((model) => model.slug));
  } catch {
    warnings.push(
      "Could not load bundled Codex model IDs; runtime catalog validation will still reject collisions.",
    );
    return new Set();
  }
}
```

- [ ] **Step 4: Add Codex capability controls to the endpoint detail form**

In `desktop/config-panel.html`, render this block only when `client === "codex"`:

```html
<div class="form-group full">
  <label>Codex 能力</label>
  <div class="checkbox-row">
    <label>
      <input
        id="capabilities-input-image-${client}-${index}"
        type="checkbox"
        ${ep.capabilities?.input_modalities?.includes('image') ? 'checked' : ''}
        onchange="updateCodexCapability('${client}', ${index}, 'image', this.checked)">
      图片输入
    </label>
    <label>
      <input
        id="capabilities-reasoning-${client}-${index}"
        type="checkbox"
        ${ep.capabilities?.reasoning ? 'checked' : ''}
        onchange="updateCodexCapability('${client}', ${index}, 'reasoning', this.checked)">
      Reasoning 摘要
    </label>
    <label>
      <input
        id="capabilities-tools-${client}-${index}"
        type="checkbox"
        ${ep.capabilities?.tools !== false ? 'checked' : ''}
        onchange="updateCodexCapability('${client}', ${index}, 'tools', this.checked)">
      工具调用
    </label>
  </div>
</div>
```

Add the update function:

```js
window.updateCodexCapability = function(client, index, capability, enabled) {
  const endpoint = config.clients[client].endpoints[index];
  endpoint.capabilities ||= {
    input_modalities: ['text'],
    reasoning: false,
    tools: true,
  };
  if (capability === 'image') {
    endpoint.capabilities.input_modalities = enabled
      ? ['text', 'image']
      : ['text'];
  } else {
    endpoint.capabilities[capability] = enabled;
  }
};
```

- [ ] **Step 5: Add commands and documentation**

Add package scripts:

```json
{
  "test:codex:unit": "node --test scripts/codex-model-catalog.test.mjs scripts/codex-chat-request-adapter.test.mjs scripts/codex-responses-writer.test.mjs scripts/codex-chat-response-adapter.test.mjs",
  "test:codex:integration": "node --test scripts/codex-gateway.integration.test.mjs",
  "test:codex:e2e": "node scripts/codex-e2e.mjs"
}
```

Update `README.md` with the exact provider matrix:

```markdown
| Codex upstream | Text | Image | Reasoning | Tools |
| --- | --- | --- | --- | --- |
| Official subscription | Native | Native | Native | Native |
| OpenAI Responses | Native | Capability-based | Native | Native |
| OpenAI Chat | Adapted | Capability-based | Adapted summary | Adapted |
| Grok Responses | Native | Capability-based | Native | Native |
| Grok Chat | Adapted | Capability-based | Adapted summary | Adapted |
```

- [ ] **Step 6: Run config, UI, and catalog verification**

Run:

```bash
npm run validate:config
npm run desktop:test
npm run codex:catalog:verify
```

Expected: all commands exit 0. Warnings may mention local inline keys, but no key value may appear.

- [ ] **Step 7: Commit configuration support**

```bash
git add scripts/validate-config.mjs scripts/codex-model-catalog.test.mjs desktop/config-panel.html desktop/lib/desktop-smoke.test.mjs README.md package.json
git commit -m "feat: configure Codex provider capabilities"
```

---

### Task 8: Cover the Native, Chat, and Grok Provider Matrix

**Files:**
- Modify: `scripts/codex-gateway.integration.test.mjs`
- Modify: `scripts/protocol-adapters.test.mjs`

**Interfaces:**
- Exercises public HTTP endpoints only.
- Uses temporary config, auth, port, and local mock providers.
- Never contacts a real provider.

- [ ] **Step 1: Add failing integration scenarios**

Add table-driven tests to `scripts/codex-gateway.integration.test.mjs`:

```js
const scenarios = [
  {
    name: "native Responses preserves function events",
    providerType: "openai-responses",
    upstreamPath: "/responses",
    upstreamEvents: [
      ["response.created", {
        type: "response.created",
        response: { id: "resp_native", status: "in_progress" },
      }],
      ["response.output_item.done", {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "fc_native",
          type: "function_call",
          call_id: "call_native",
          name: "shell_command",
          arguments: "{\"command\":\"ls\"}",
        },
      }],
      ["response.completed", {
        type: "response.completed",
        response: {
          id: "resp_native",
          status: "completed",
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        },
      }],
    ],
    expectedPatterns: [
      /"type":"function_call"/,
      /"call_id":"call_native"/,
      /event: response.completed/,
    ],
  },
  {
    name: "Chat preserves image input and parallel tool output",
    providerType: "openai-chat",
    upstreamPath: "/chat/completions",
    chatChunks: [
      {
        choices: [{
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_0",
                function: {
                  name: "shell_command",
                  arguments: "{\"command\":\"ls\"}",
                },
              },
              {
                index: 1,
                id: "call_1",
                function: {
                  name: "read_file",
                  arguments: "{\"path\":\"README.md\"}",
                },
              },
            ],
          },
        }],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ],
    expectedPatterns: [
      /"call_id":"call_0"/,
      /"call_id":"call_1"/,
      /event: response.completed/,
    ],
  },
  {
    name: "Grok Responses uses the native Responses backend",
    providerType: "grok",
    upstreamPath: "/responses",
    grokAuth: true,
    upstreamEvents: [
      ["response.output_text.delta", {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: "Grok OK",
      }],
      ["response.completed", {
        type: "response.completed",
        response: { id: "resp_grok", status: "completed" },
      }],
    ],
    expectedPatterns: [
      /Grok OK/,
      /event: response.completed/,
    ],
  },
];
```

For each scenario, start a local upstream and gateway, send a Responses request containing text, an image data URL, two function tools, and `stream: true`, then assert:

```js
for (const pattern of scenario.expectedPatterns) {
  assert.match(responseText, pattern);
}
assert.equal(capturedRequest.model, "upstream-model");
if (scenario.providerType === "openai-chat") {
  assert.equal(
    capturedRequest.messages[0].content.some(
      (part) => part.type === "image_url",
    ),
    true,
  );
}
```

- [ ] **Step 2: Run the provider matrix and observe failures in unimplemented paths**

Run:

```bash
npm run test:codex:integration
```

Expected before all prior tasks are applied: at least the Chat tool assertions fail. After Tasks 1-7, all scenarios must pass.

- [ ] **Step 3: Disable Claude Desktop synchronization in every spawned test gateway**

In every test process environment in `scripts/protocol-adapters.test.mjs` and `scripts/codex-gateway.integration.test.mjs`, include:

```js
CLAUDE_3P_SYNC_DISABLED: "1",
```

Assert the temporary test directory contains all test output and no test references the real Claude config library path.

- [ ] **Step 4: Add failure matrix assertions**

Add integration cases for:

```js
const failureCases = [
  { status: 401, expectedCode: "authentication_error" },
  { status: 429, expectedCode: "rate_limit_error" },
  { status: 500, expectedCode: "upstream_error" },
];
```

For a premature SSE close, assert the terminal event is:

```js
assert.match(streamText, /event: response.failed/);
assert.doesNotMatch(streamText, /event: response.completed/);
```

- [ ] **Step 5: Run the full automated suite**

Run:

```bash
npm run check
npm run desktop:test
npm run test:cli
npm run test:codex:unit
npm run test:codex:integration
node --test scripts/protocol-adapters.test.mjs
```

Expected: all commands exit 0 with zero failed tests.

- [ ] **Step 6: Commit the provider matrix**

```bash
git add scripts/codex-gateway.integration.test.mjs scripts/protocol-adapters.test.mjs
git commit -m "test: cover Codex provider compatibility matrix"
```

---

### Task 9: Add an Isolated Codex Agent End-to-End Harness

**Files:**
- Create: `scripts/codex-e2e.mjs`
- Create: `scripts/fixtures/codex-e2e/package.json`
- Create: `scripts/fixtures/codex-e2e/src/math.js`
- Create: `scripts/fixtures/codex-e2e/test/math.test.js`
- Modify: `README.md`

**Interfaces:**
- Runs only when the `codex` executable is available.
- Uses temporary `CODEX_HOME`, gateway config, model catalog, logs, and fixture copy.
- Produces a JSON summary with `ok`, `toolRounds`, `testsPassed`, and `filesChanged`.

- [ ] **Step 1: Create a deliberately failing fixture**

Create `scripts/fixtures/codex-e2e/package.json`:

```json
{
  "name": "codex-gateway-e2e-fixture",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
```

Create `scripts/fixtures/codex-e2e/src/math.js`:

```js
export function add(left, right) {
  return left - right;
}
```

Create `scripts/fixtures/codex-e2e/test/math.test.js`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { add } from "../src/math.js";

test("add returns the sum", () => {
  assert.equal(add(2, 3), 5);
});
```

- [ ] **Step 2: Write the E2E harness with deterministic provider rounds**

Create `scripts/codex-e2e.mjs`. It must:

1. Copy the fixture to a temporary directory.
2. Start a scripted local Responses provider.
3. Start the gateway with a temporary `clients.codex` Responses endpoint.
4. Generate a temporary model catalog containing `fixture-coder`.
5. Run Codex with `CODEX_HOME` pointing to the temporary directory.
6. Assert the fixture test passes and the subtraction operator was replaced.

Use this exact command construction:

```js
const codexArgs = [
  "exec",
  "--skip-git-repo-check",
  "--sandbox",
  "workspace-write",
  "-c",
  'model_provider="local-gateway"',
  "-c",
  `model_catalog_json=${JSON.stringify(catalogPath)}`,
  "-c",
  'model="fixture-coder"',
  "-c",
  'model_providers.local-gateway.name="Local AI Gateway E2E"',
  "-c",
  `model_providers.local-gateway.base_url=${JSON.stringify(
    `http://127.0.0.1:${gatewayPort}/codex/v1`,
  )}`,
  "-c",
  'model_providers.local-gateway.wire_api="responses"',
  "-c",
  "model_providers.local-gateway.requires_openai_auth=true",
  "-c",
  'model_providers.local-gateway.experimental_bearer_token="dummy"',
  "Inspect the project, run the tests, fix the add function, rerun the tests, and report the result.",
];
```

The scripted provider reads each request's `tools` and returns tool calls in this order:

```js
const rounds = [
  {
    toolNamePattern: /shell|command/i,
    arguments: { command: "ls -la && find . -maxdepth 3 -type f | sort" },
  },
  {
    toolNamePattern: /shell|command/i,
    arguments: { command: "sed -n '1,120p' src/math.js && npm test" },
  },
  {
    toolNamePattern: /shell|command/i,
    arguments: {
      command: "node -e \"const fs=require('fs');const p='src/math.js';fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('left - right','left + right'))\"",
    },
  },
  {
    toolNamePattern: /shell|command/i,
    arguments: { command: "npm test" },
  },
];
```

For each round, choose the first tool whose name matches the pattern and emit:

```js
function functionCallEvents({ responseId, callId, name, argumentsObject }) {
  const item = {
    id: `fc_${callId}`,
    type: "function_call",
    call_id: callId,
    name,
    arguments: JSON.stringify(argumentsObject),
  };
  return [
    ["response.created", {
      type: "response.created",
      response: { id: responseId, status: "in_progress" },
    }],
    ["response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "" },
    }],
    ["response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: item.id,
      delta: item.arguments,
    }],
    ["response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item,
    }],
    ["response.completed", {
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    }],
  ];
}
```

After the fourth tool result appears in a request, emit a final assistant message and `response.completed`.

- [ ] **Step 3: Run E2E before completing server integration and observe the protocol failure**

Run:

```bash
npm run test:codex:e2e
```

Expected before Tasks 1-8: FAIL because the custom catalog or tool-result loop is incomplete. After Tasks 1-8: exit 0 and print:

```json
{
  "ok": true,
  "toolRounds": 4,
  "testsPassed": true,
  "filesChanged": ["src/math.js"]
}
```

- [ ] **Step 4: Add an opt-in real-provider smoke mode**

Support:

```bash
CODEX_REAL_SMOKE_MODEL=grok-4.5 npm run test:codex:e2e
```

When `CODEX_REAL_SMOKE_MODEL` is set, do not start the scripted provider. Use the existing local gateway and run a read-only prompt:

```text
List the current directory with the shell tool, then reply with the first entry.
```

The smoke mode must not edit files and must print the selected model and terminal status without printing the prompt or tool arguments.

- [ ] **Step 5: Document isolated rollout and rollback**

Add to `README.md`:

```markdown
### Codex isolated verification

Run `npm run test:codex:e2e` before editing `~/.codex/config.toml`.
The harness uses a temporary Codex home, temporary fixture, local mock provider,
and a temporary gateway port.

After it passes, back up `~/.codex/config.toml`, add the generated local-gateway
provider snippet, and verify one official subscription model before selecting a
third-party model. Roll back by restoring the backup and restarting Codex
Desktop; `~/.codex/auth.json` is not modified.
```

- [ ] **Step 6: Run all verification from a clean service-independent state**

Run:

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

Expected:

- Every command exits 0.
- The deterministic E2E summary has `"ok": true` and `"toolRounds": 4`.
- Config validation may report only safe warnings naming key locations; it must not print key values.
- `git diff --check` prints nothing.

- [ ] **Step 7: Commit the E2E harness and rollout documentation**

```bash
git add scripts/codex-e2e.mjs scripts/fixtures/codex-e2e package.json README.md
git commit -m "test: verify Codex agent loop through gateway"
```

---

## Final Review and Branch Handoff

- [ ] Review `git log --oneline main..HEAD` and confirm each implementation task has one focused commit.
- [ ] Review `git diff --stat main...HEAD` and confirm `gateway.config.json` is absent.
- [ ] Perform the security review by searching tracked changes for credential patterns:

```bash
git diff main...HEAD | rg 'sk-[A-Za-z0-9]{12,}|ark-[A-Za-z0-9-]{12,}|Bearer [A-Za-z0-9._-]{12,}'
```

Expected: no output.

- [ ] Run the complete verification block from Task 9 one final time.
- [ ] Start the existing launchd gateway only after tests pass, then verify:

```bash
curl -fsS http://127.0.0.1:8787/codex/health
curl -fsS http://127.0.0.1:8787/codex/v1/models
```

Expected: health reports `ok: true`; the model list contains official and configured independent third-party IDs.
- [ ] Push `codex/codex-gateway-chain` only after the user requests publication or approves the branch handoff.
