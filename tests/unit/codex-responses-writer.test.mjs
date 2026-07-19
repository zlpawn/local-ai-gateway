import assert from "node:assert/strict";
import test from "node:test";
import { ResponsesWriter } from "../../lib/codex/responses-writer.mjs";
import { iterateSse } from "../../lib/codex/sse.mjs";

test("writer emits stable text, reasoning, parallel function calls, and one terminal event", () => {
  const events = [];
  const writer = new ResponsesWriter({
    model: "chat-model",
    responseId: "resp_test",
    emit: (event, data) => events.push([event, data]),
  });

  writer.created();
  writer.reasoningDelta("Checking ");
  writer.reasoningDelta("files.");
  writer.textDelta("I will ");
  writer.textDelta("inspect.");
  writer.functionArgumentsDelta({
    index: 0,
    callId: "call_a",
    name: "shell_command",
    delta: "{\"command\":",
    kind: "function",
  });
  writer.functionArgumentsDelta({
    index: 1,
    callId: "call_b",
    name: "read_file",
    delta: "{\"path\":\"README.md\"}",
    kind: "function",
  });
  writer.functionArgumentsDelta({
    index: 0,
    callId: "call_a",
    name: "shell_command",
    delta: "\"ls\"}",
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
    2,
  );
  assert.equal(
    events.filter(([event]) => event === "response.output_item.added").length,
    4,
  );
  assert.equal(
    events.filter(([event]) => event === "response.output_item.done").length,
    4,
  );
  assert.equal(
    events.filter(([event]) => event === "response.completed").length,
    1,
  );

  const added = events
    .filter(([event]) => event === "response.output_item.added")
    .map(([, data]) => [data.output_index, data.item.id]);
  assert.deepEqual(added, [
    [0, "rs_resp_test"],
    [1, "msg_resp_test"],
    [2, "fc_call_a"],
    [3, "fc_call_b"],
  ]);

  const done = events.filter(([event]) => event === "response.output_item.done");
  assert.equal(done.find(([, data]) => data.item.type === "reasoning")[1].item.summary[0].text, "Checking files.");
  assert.equal(done.find(([, data]) => data.item.type === "message")[1].item.content[0].text, "I will inspect.");
  assert.deepEqual(
    done
      .filter(([, data]) => data.item.type === "function_call")
      .map(([, data]) => [data.output_index, data.item.call_id, data.item.arguments]),
    [
      [2, "call_a", "{\"command\":\"ls\"}"],
      [3, "call_b", "{\"path\":\"README.md\"}"],
    ],
  );
});

test("writer unwraps custom tool input and does not finish an item twice", () => {
  const events = [];
  const writer = new ResponsesWriter({
    model: "chat-model",
    responseId: "resp_custom",
    emit: (event, data) => events.push([event, data]),
  });

  const call = {
    index: 7,
    callId: "call_custom",
    name: "computer",
    argumentsText: "{\"input\":\"click(10, 20)\"}",
    kind: "custom",
  };
  writer.finishFunction(call);
  writer.finishFunction(call);
  writer.completed({});

  const inputDone = events.filter(([event]) => event === "response.custom_tool_call_input.done");
  const itemDone = events.filter(([event, data]) => (
    event === "response.output_item.done" && data.item.type === "custom_tool_call"
  ));
  assert.equal(inputDone.length, 1);
  assert.equal(inputDone[0][1].input, "click(10, 20)");
  assert.equal(itemDone.length, 1);
  assert.equal(itemDone[0][1].item.input, "click(10, 20)");
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
  writer.textDelta("too late");
  assert.deepEqual(
    events.filter(([event]) => event.startsWith("response.")).map(([event]) => event).slice(-1),
    ["response.failed"],
  );
});

test("SSE iterator parses chunked LF and CRLF frames, multiline data, and a final frame", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    "event: first\r",
    "\ndata: one\r\ndata: two\r\n\r",
    "\nevent: second\n",
    "data: value\n\n",
    "data: final",
  ].map((chunk) => encoder.encode(chunk));
  const readable = new ReadableStream({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });

  const frames = [];
  for await (const frame of iterateSse(readable)) frames.push(frame);

  assert.deepEqual(frames, [
    { event: "first", data: "one\ntwo" },
    { event: "second", data: "value" },
    { event: "message", data: "final" },
  ]);
});
