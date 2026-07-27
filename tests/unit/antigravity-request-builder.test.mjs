import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGenerateContentRequest } from "../../lib/antigravity/request-builder.mjs";
import { deriveSessionId } from "../../lib/antigravity/session-id.mjs";
import { ANTIGRAVITY_IDENTITY } from "../../lib/antigravity/system-prompt.mjs";

const ACCOUNT = "user@example.com";
const PROJECT = "concrete-vortex-1jlsj";

function build(codexReq, model = "gemini-3-pro") {
  return buildGenerateContentRequest(codexReq, { project: PROJECT, accountId: ACCOUNT, model });
}

test("basic text request: outer body + systemInstruction identity + instructions", () => {
  const body = build({
    model: "gemini-3-pro",
    instructions: "Be concise.",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
  });
  assert.equal(body.project, PROJECT);
  assert.equal(body.model, "gemini-3-pro");
  assert.equal(body.userAgent, "antigravity");
  assert.equal(body.requestType, "agent");
  assert.deepEqual(body.enabledCreditTypes, ["GOOGLE_ONE_AI"]);
  assert.match(body.requestId, /^agent\/antigravity\/[^\/]+\/1$/);

  const si = body.request.systemInstruction;
  assert.equal(si.role, "user");
  assert.equal(si.parts[0].text, ANTIGRAVITY_IDENTITY);
  assert.equal(si.parts[1].text, "Be concise.");

  assert.equal(body.request.contents.length, 1);
  assert.equal(body.request.contents[0].role, "user");
  assert.equal(body.request.contents[0].parts[0].text, "hi");

  assert.equal(body.request.sessionId, deriveSessionId(ACCOUNT));
});

test("assistant role maps to model", () => {
  const body = build({
    input: [
      { type: "message", role: "user", content: "q" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "a" }] },
    ],
  });
  assert.equal(body.request.contents[0].role, "user");
  assert.equal(body.request.contents[1].role, "model");
});

test("tools -> functionDeclarations sorted by name + VALIDATED toolConfig", () => {
  const body = build({
    tools: [
      { type: "function", name: "zeta", description: "z", parameters: { type: "object", properties: {} } },
      { type: "function", name: "alpha", description: "a", parameters: { type: "object", properties: {} } },
    ],
    input: [{ type: "message", role: "user", content: "x" }],
  });
  const decls = body.request.tools[0].functionDeclarations;
  assert.equal(decls[0].name, "alpha");
  assert.equal(decls[1].name, "zeta");
  assert.equal(body.request.toolConfig.functionCallingConfig.mode, "VALIDATED");
});

test("custom tool -> input-string schema", () => {
  const body = build({
    tools: [{ type: "custom", name: "mytool", description: "d" }],
    input: [{ type: "message", role: "user", content: "x" }],
  });
  const decl = body.request.tools[0].functionDeclarations[0];
  assert.equal(decl.name, "mytool");
  assert.equal(decl.parameters.properties.input.type, "string");
  assert.deepEqual(decl.parameters.required, ["input"]);
});

test("function_call -> functionCall(model); output -> functionResponse(user) with prescan name", () => {
  const body = build({
    input: [
      { type: "message", role: "user", content: "list files" },
      { type: "function_call", name: "shell", arguments: "{\"command\":\"ls\"}", call_id: "call_1" },
      { type: "function_call_output", call_id: "call_1", output: "file.txt" },
    ],
  });
  const c = body.request.contents;
  assert.equal(c[1].role, "model");
  assert.equal(c[1].parts[0].functionCall.name, "shell");
  assert.deepEqual(c[1].parts[0].functionCall.args, { command: "ls" });
  assert.equal(c[1].parts[0].functionCall.id, "call_1");
  assert.equal(c[2].role, "user");
  assert.equal(c[2].parts[0].functionResponse.name, "shell");
  assert.equal(c[2].parts[0].functionResponse.id, "call_1");
  assert.equal(c[2].parts[0].functionResponse.response.result, "file.txt");
});

test("custom_tool_call -> functionCall with {input}; custom output -> functionResponse", () => {
  const body = build({
    input: [
      { type: "custom_tool_call", name: "apply_patch", input: "*** patch ***", call_id: "c2" },
      { type: "custom_tool_call_output", call_id: "c2", output: "ok" },
    ],
  });
  const c = body.request.contents;
  assert.equal(c[0].parts[0].functionCall.args.input, "*** patch ***");
  assert.equal(c[1].parts[0].functionResponse.name, "apply_patch");
  assert.equal(c[1].parts[0].functionResponse.response.result, "ok");
});

test("generation config mapping (temperature/maxOutputTokens/topP/thinking)", () => {
  const body = build({
    temperature: 0.2,
    max_output_tokens: 4096,
    top_p: 0.9,
    thinking: { budget_tokens: 1024 },
    input: [{ type: "message", role: "user", content: "x" }],
  });
  const gc = body.request.generationConfig;
  assert.equal(gc.temperature, 0.2);
  assert.equal(gc.maxOutputTokens, 4096);
  assert.equal(gc.topP, 0.9);
  assert.equal(gc.thinkingConfig.thinkingBudget, 1024);
});

test("inner request field order: systemInstruction, tools, toolConfig, generationConfig, sessionId, contents", () => {
  const body = build({
    tools: [{ type: "function", name: "a", parameters: {} }],
    temperature: 0.5,
    input: [{ type: "message", role: "user", content: "x" }],
  });
  assert.deepEqual(
    Object.keys(body.request),
    ["systemInstruction", "tools", "toolConfig", "generationConfig", "sessionId", "contents"],
  );
});

test("no tools => no tools/toolConfig; string input coerced to one user message", () => {
  const body = build({ input: "hello there" });
  assert.equal(body.request.tools, undefined);
  assert.equal(body.request.toolConfig, undefined);
  assert.equal(body.request.contents.length, 1);
  assert.equal(body.request.contents[0].parts[0].text, "hello there");
});

test("image input -> inlineData from data URL", () => {
  const body = build({
    input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "see this" },
        { type: "input_image", image_url: "data:image/png;base64,QUJD" },
      ],
    }],
  });
  const parts = body.request.contents[0].parts;
  assert.equal(parts[0].text, "see this");
  assert.equal(parts[1].inlineData.mimeType, "image/png");
  assert.equal(parts[1].inlineData.data, "QUJD");
});
// ── thoughtSignature injection (multi-turn tool calls) ──
import {
  cacheSignature,
  computeSessionFingerprint,
  _clearSignatureCache,
} from "../../lib/antigravity/signature-cache.mjs";

const LONG_SIG = "x".repeat(120); // above MIN_LENGTH (50)

// Cache a signature under the SAME session fingerprint request-builder will
// derive from the input, then verify it is re-injected onto the functionCall part.
function cacheForInput(input, callId) {
  cacheSignature(computeSessionFingerprint(input), callId, LONG_SIG);
}

test("function_call part re-injects cached thoughtSignature by call_id", () => {
  _clearSignatureCache();
  const input = [
    { type: "message", role: "user", content: "run it" },
    { type: "function_call", name: "shell", arguments: "{\"command\":\"echo hi\"}", call_id: "call_sig_1" },
    { type: "function_call_output", call_id: "call_sig_1", output: "hi" },
  ];
  cacheForInput(input, "call_sig_1");
  const body = build({ input });
  const modelTurn = body.request.contents[1];
  assert.equal(modelTurn.parts[0].thoughtSignature, LONG_SIG);
});

test("custom_tool_call part also re-injects cached thoughtSignature", () => {
  _clearSignatureCache();
  const input = [
    { type: "custom_tool_call", name: "apply_patch", input: "p", call_id: "call_sig_2" },
    { type: "custom_tool_call_output", call_id: "call_sig_2", output: "ok" },
  ];
  cacheForInput(input, "call_sig_2");
  const body = build({ input });
  assert.equal(body.request.contents[0].parts[0].thoughtSignature, LONG_SIG);
});

test("no cached signature => functionCall part has no thoughtSignature", () => {
  _clearSignatureCache();
  const body = build({
    input: [
      { type: "function_call", name: "shell", arguments: "{}", call_id: "call_none" },
      { type: "function_call_output", call_id: "call_none", output: "x" },
    ],
  });
  assert.equal(body.request.contents[0].parts[0].thoughtSignature, undefined);
});

test("signature cached under a different session is NOT injected", () => {
  _clearSignatureCache();
  const input = [
    { type: "message", role: "user", content: "run it" },
    { type: "function_call", name: "shell", arguments: "{}", call_id: "call_iso" },
    { type: "function_call_output", call_id: "call_iso", output: "x" },
  ];
  // Cache under a DIFFERENT first-message fingerprint than the input has.
  cacheSignature(computeSessionFingerprint([{ type: "message", role: "user", content: "DIFFERENT" }]), "call_iso", LONG_SIG);
  const body = build({ input });
  assert.equal(body.request.contents[1].parts[0].thoughtSignature, undefined);
});
