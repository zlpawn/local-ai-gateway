import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeResponsesInput, sanitizeGrokResponsesInput } from "../../lib/codex/grok-input-sanitizer.mjs";

test("sanitizeResponsesInput converts custom_tool_call and output to standard function_call", () => {
  const raw = {
    model: "glm-5.2",
    input: [
      { role: "user", content: "hello" },
      { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "apply_patch", input: "*** Patch" },
      { type: "custom_tool_call_output", id: "ctco_1", call_id: "call_1", output: "Success" },
      { type: "compaction", text: "compacted previous thread" },
      { type: "item_reference", id: "ref_1" },
    ],
    tools: [
      { type: "function", name: "exec", description: "exec command" },
      { type: "custom", name: "apply_patch", description: "apply patch" },
      { type: "namespace", name: "codex_app" },
    ],
    instructions_variables: { foo: "bar" },
  };

  const clean = sanitizeResponsesInput(raw);

  assert.equal(clean.model, "glm-5.2");
  assert.equal(clean.instructions_variables, undefined);

  // Check tools sanitization (filters out namespace tools)
  assert.equal(clean.tools.length, 2);
  assert.equal(clean.tools[0].type, "function");
  assert.equal(clean.tools[0].name, "exec");
  assert.equal(clean.tools[1].type, "function");
  assert.equal(clean.tools[1].name, "apply_patch");

  // Check input items sanitization
  assert.equal(clean.input.length, 3);
  assert.equal(clean.input[0].role, "user");
  assert.equal(clean.input[1].type, "function_call");
  assert.equal(clean.input[1].name, "apply_patch");
  assert.equal(clean.input[1].arguments, '{"input":"*** Patch"}');
  assert.equal(clean.input[2].type, "function_call_output");
  assert.equal(clean.input[2].output, "Success");
});

test("sanitizeGrokResponsesInput maps assistant content parts to output_text and user content parts to input_text", () => {
  const raw = {
    model: "grok-4.5",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "message", role: "assistant", content: [{ type: "input_text", text: "hi there" }] },
    ],
  };

  const clean = sanitizeGrokResponsesInput(raw);

  assert.equal(clean.input.length, 2);
  assert.equal(clean.input[0].role, "user");
  assert.equal(clean.input[0].content[0].type, "input_text");
  assert.equal(clean.input[1].role, "assistant");
  assert.equal(clean.input[1].content[0].type, "output_text");
  assert.equal(clean.input[1].content[0].text, "hi there");
});

test("sanitizeGrokResponsesInput maps image content parts to input_image with string url", () => {
  const raw = {
    model: "grok-4.5",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "what is this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,123" } },
        ],
      },
    ],
  };

  const clean = sanitizeGrokResponsesInput(raw);

  assert.equal(clean.input.length, 1);
  assert.equal(clean.input[0].content[1].type, "input_image");
  assert.equal(clean.input[0].content[1].image_url, "data:image/png;base64,123");
});

test("sanitizeGrokResponsesInput is exported as an alias of sanitizeResponsesInput", () => {
  assert.equal(sanitizeGrokResponsesInput, sanitizeResponsesInput);
});

