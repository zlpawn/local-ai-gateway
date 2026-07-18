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

test("request adapter coalesces parallel function_call history into one assistant message", () => {
  const result = responsesRequestToChat({
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "Inspect and read." }],
      },
      {
        type: "function_call",
        call_id: "call_0",
        name: "shell_command",
        arguments: "{\"command\":\"ls\"}",
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "read_file",
        arguments: "{\"path\":\"README.md\"}",
      },
      {
        type: "custom_tool_call",
        call_id: "call_2",
        name: "apply_patch",
        input: "*** Begin Patch\n*** End Patch",
      },
      {
        type: "function_call_output",
        call_id: "call_0",
        output: "README.md",
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "# Title",
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_2",
        output: "ok",
      },
      {
        role: "user",
        content: [{ type: "input_text", text: "Continue." }],
      },
    ],
    tools: [
      {
        type: "function",
        name: "shell_command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
        },
      },
      {
        type: "function",
        name: "read_file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
      {
        type: "custom",
        name: "apply_patch",
      },
    ],
  }, "chat-model");

  const assistantMessages = result.body.messages.filter(
    (message) => message.role === "assistant",
  );
  assert.equal(assistantMessages.length, 1);
  assert.deepEqual(
    assistantMessages[0].tool_calls.map((call) => call.id),
    ["call_0", "call_1", "call_2"],
  );
  assert.equal(
    assistantMessages[0].tool_calls[2].function.arguments,
    "{\"input\":\"*** Begin Patch\\n*** End Patch\"}",
  );
  assert.deepEqual(
    result.body.messages.filter((message) => message.role === "tool").map(
      (message) => message.tool_call_id,
    ),
    ["call_0", "call_1", "call_2"],
  );
  assert.equal(result.body.messages.at(-1).role, "user");
});

test("request adapter attaches tool calls to a preceding assistant text message", () => {
  const result = responsesRequestToChat({
    input: [
      {
        role: "assistant",
        content: [{ type: "output_text", text: "I will inspect files." }],
      },
      {
        type: "function_call",
        call_id: "call_a",
        name: "shell_command",
        arguments: "{\"command\":\"ls\"}",
      },
      {
        type: "function_call",
        call_id: "call_b",
        name: "read_file",
        arguments: "{\"path\":\"a.txt\"}",
      },
    ],
  }, "chat-model");

  assert.equal(result.body.messages.length, 1);
  assert.equal(result.body.messages[0].role, "assistant");
  assert.deepEqual(result.body.messages[0].content, [
    { type: "text", text: "I will inspect files." },
  ]);
  assert.deepEqual(
    result.body.messages[0].tool_calls.map((call) => call.id),
    ["call_a", "call_b"],
  );
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

test("request adapter rejects an unsupported top-level input item", () => {
  assert.throws(
    () => responsesRequestToChat({
      input: [{ type: "computer_call" }],
    }, "chat-model"),
    /cannot be represented by Chat Completions/,
  );
});

test("request adapter rejects an unsupported message content shape", () => {
  assert.throws(
    () => responsesRequestToChat({
      input: [{
        role: "user",
        content: { type: "input_text", text: "Hello" },
      }],
    }, "chat-model"),
    /cannot be represented by Chat Completions/,
  );
});
