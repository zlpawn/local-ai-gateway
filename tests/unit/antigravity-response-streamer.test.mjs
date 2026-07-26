import { test } from "node:test";
import assert from "node:assert/strict";
import { ResponsesWriter } from "../../lib/codex/responses-writer.mjs";
import { streamResponses } from "../../lib/antigravity/response-streamer.mjs";

function makeReadable(chunks) {
  return new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

function sseData(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function runWriter() {
  const events = [];
  const writer = new ResponsesWriter({
    model: "gemini-3-pro",
    responseId: "resp_t",
    emit: (event, data) => events.push([event, data]),
  });
  return { writer, events };
}
const types = (events) => events.map(([t]) => t);

test("text streaming -> output_text.delta deltas + completed with usage", async () => {
  const { writer, events } = runWriter();
  const readable = makeReadable([
    sseData({ response: { candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] } }] } }),
    sseData({ response: { candidates: [{ content: { role: "model", parts: [{ text: "lo" }] } }] } }),
    sseData({ response: { candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } } }),
  ]);
  await streamResponses(readable, writer);
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

test("functionCall -> function_call_arguments.delta + done + output_item.done", async () => {
  const { writer, events } = runWriter();
  const readable = makeReadable([
    sseData({ response: { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "shell", args: { command: "ls" }, id: "call_1" } }] } }] } }),
    sseData({ response: { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] } }),
  ]);
  await streamResponses(readable, writer);
  assert.ok(types(events).includes("response.function_call_arguments.delta"));
  assert.ok(types(events).includes("response.function_call_arguments.done"));
  const itemDone = events.find(([t]) => t === "response.output_item.done")[1];
  assert.equal(itemDone.item.type, "function_call");
  assert.equal(itemDone.item.name, "shell");
  assert.equal(itemDone.item.call_id, "call_1");
  assert.deepEqual(JSON.parse(itemDone.item.arguments), { command: "ls" });
});

test("raw (unwrapped) frames parse without the response wrapper", async () => {
  const { writer, events } = runWriter();
  const readable = makeReadable([
    sseData({ candidates: [{ content: { role: "model", parts: [{ text: "x" }] } }] }),
    sseData({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] }),
  ]);
  await streamResponses(readable, writer);
  assert.ok(types(events).includes("response.completed"));
});

test("thought part routes to reasoning summary", async () => {
  const { writer, events } = runWriter();
  const readable = makeReadable([
    sseData({ response: { candidates: [{ content: { role: "model", parts: [{ text: "thinking...", thought: true }] } }] } }),
    sseData({ response: { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] } }),
  ]);
  await streamResponses(readable, writer);
  assert.ok(types(events).includes("response.reasoning_summary_text.delta"));
});

test("stream ending without finishReason still completes", async () => {
  const { writer, events } = runWriter();
  const readable = makeReadable([
    sseData({ response: { candidates: [{ content: { role: "model", parts: [{ text: "tail" }] } }] } }),
  ]);
  await streamResponses(readable, writer);
  assert.ok(types(events).includes("response.completed"));
});