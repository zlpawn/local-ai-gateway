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
