import { test } from "node:test";
import assert from "node:assert/strict";
import { ResponsesWriter } from "../../lib/codex/responses-writer.mjs";
import { streamGrpcResponses } from "../../lib/antigravity/response-streamer.mjs";

function runWriter() {
  const events = [];
  const writer = new ResponsesWriter({
    model: "gemini-pro-agent",
    responseId: "resp_t",
    emit: (event, data) => events.push([event, data]),
  });
  return { writer, events };
}
const types = (events) => events.map(([t]) => t);

// Helper: create an async generator from an array of response objects.
async function* fromArray(arr) {
  for (const item of arr) yield item;
}

test("gRPC: text streaming -> output_text.delta + completed with usage", async () => {
  const { writer, events } = runWriter();
  await streamGrpcResponses(fromArray([
    { response: { candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] } }] } },
    { response: { candidates: [{ content: { role: "model", parts: [{ text: "lo" }] } }] } },
    { response: { candidates: [{ content: { parts: [] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } } },
  ]), writer);
  assert.ok(types(events).includes("response.output_text.delta"));
  const text = events
    .filter(([t]) => t === "response.output_text.delta")
    .map(([, d]) => d.delta)
    .join("");
  assert.equal(text, "Hello");
  assert.ok(types(events).includes("response.completed"));
  const completed = events.find(([t]) => t === "response.completed")[1];
  assert.deepEqual(completed.response.usage, { input_tokens: 5, output_tokens: 2, total_tokens: 7 });
});

test("gRPC: functionCall -> function_call_arguments events", async () => {
  const { writer, events } = runWriter();
  await streamGrpcResponses(fromArray([
    { response: { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "shell", args: { command: "ls" }, id: "call_1" } }] } }] } },
    { response: { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] } },
  ]), writer);
  assert.ok(types(events).includes("response.function_call_arguments.delta"));
  assert.ok(types(events).includes("response.function_call_arguments.done"));
  const itemDone = events.find(([t]) => t === "response.output_item.done")[1];
  assert.equal(itemDone.item.type, "function_call");
  assert.equal(itemDone.item.name, "shell");
  assert.deepEqual(JSON.parse(itemDone.item.arguments), { command: "ls" });
});

test("gRPC: thought part routes to reasoning summary", async () => {
  const { writer, events } = runWriter();
  await streamGrpcResponses(fromArray([
    { response: { candidates: [{ content: { role: "model", parts: [{ text: "thinking...", thought: true }] } }] } },
    { response: { candidates: [{ content: { parts: [{ text: "answer" }] } }] } },
    { response: { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] } },
  ]), writer);
  assert.ok(types(events).includes("response.reasoning_summary_text.delta"));
  assert.ok(types(events).includes("response.output_text.delta"));
});

test("gRPC: stream ending without finishReason still completes", async () => {
  const { writer, events } = runWriter();
  await streamGrpcResponses(fromArray([
    { response: { candidates: [{ content: { role: "model", parts: [{ text: "tail" }] } }] } },
  ]), writer);
  assert.ok(types(events).includes("response.completed"));
});

test("gRPC: stops after terminal finishReason", async () => {
  const { writer, events } = runWriter();
  const responses = [
    { response: { candidates: [{ content: { parts: [{ text: "first" }] }, finishReason: "STOP" }] } },
    { response: { candidates: [{ content: { parts: [{ text: "should not appear" }] } }] } },
  ];
  await streamGrpcResponses(fromArray(responses), writer);
  const text = events
    .filter(([t]) => t === "response.output_text.delta")
    .map(([, d]) => d.delta)
    .join("");
  assert.equal(text, "first");
  assert.ok(!text.includes("should not appear"));
});

test("gRPC: raw (unwrapped) frames parse without the response wrapper", async () => {
  const { writer, events } = runWriter();
  await streamGrpcResponses(fromArray([
    { candidates: [{ content: { role: "model", parts: [{ text: "x" }] } }] },
    { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] },
  ]), writer);
  assert.ok(types(events).includes("response.completed"));
});

// ── thoughtSignature capture into the signature cache ──
import {
  getSignature,
  _clearSignatureCache,
} from "../../lib/antigravity/signature-cache.mjs";

test("gRPC: functionCall with thoughtSignature is cached under the session scope", async () => {
  _clearSignatureCache();
  const { writer } = runWriter();
  const sig = "s".repeat(120);
  await streamGrpcResponses(fromArray([
    { response: { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "shell", args: { command: "ls" }, id: "call_xyz" }, thoughtSignature: sig }] } }] } },
    { response: { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] } },
  ]), writer, "sess-stream-1");
  assert.equal(getSignature("sess-stream-1", "call_xyz"), sig);
  // invisible under a different session
  assert.equal(getSignature("sess-other", "call_xyz"), null);
});

test("gRPC: functionCall without thoughtSignature does not pollute cache", async () => {
  _clearSignatureCache();
  const { writer } = runWriter();
  await streamGrpcResponses(fromArray([
    { response: { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "shell", args: { command: "ls" }, id: "call_no_sig" } }] } }] } },
    { response: { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] } },
  ]), writer, "sess-stream-2");
  assert.equal(getSignature("sess-stream-2", "call_no_sig"), null);
});

test("gRPC: thoughtSignature on reasoning thought part is cached for functionCall", async () => {
  _clearSignatureCache();
  const { writer } = runWriter();
  const sig = "t".repeat(120);
  await streamGrpcResponses(fromArray([
    { response: { candidates: [{ content: { role: "model", parts: [{ text: "Thinking...", thought: true, thoughtSignature: sig }] } }] } },
    { response: { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "shell", args: { command: "pwd" }, id: "call_thought_sig" } }] } }] } },
    { response: { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] } },
  ]), writer, "sess-stream-3");
  assert.equal(getSignature("sess-stream-3", "call_thought_sig"), sig);
});
