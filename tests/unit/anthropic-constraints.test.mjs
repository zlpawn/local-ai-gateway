import assert from "node:assert/strict";
import test from "node:test";
import {
  noAssistantPrefill,
  textBeforeToolUse,
  applyAnthropicConstraints,
  constraintsForRoute,
} from "../../lib/codex/anthropic-constraints.mjs";

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
    { role: "user", content: [{ type: "text", text: "do work" }] },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "tool", input: {} },
        { type: "text", text: "after tool" },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    { role: "assistant", content: [{ type: "text", text: "trailing prefill" }] },
  ];

  const result = applyAnthropicConstraints(messages, {
    provider: { base_url: "https://ark.cn-beijing.volces.com/api/plan" },
  });

  assert.equal(result.length, 3);
  assert.equal(result[0].role, "user");
  assert.equal(result[1].role, "assistant");
  assert.deepEqual(
    result[1].content.map((p) => p.type),
    ["text", "tool_use"],
  );
  assert.equal(result[2].role, "user");
});
