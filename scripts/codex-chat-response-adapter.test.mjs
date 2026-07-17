import assert from "node:assert/strict";
import test from "node:test";
import { ReadableStream } from "node:stream/web";
import {
  chatCompletionToResponse,
  streamChatAsResponses,
} from "../lib/codex/chat-response-adapter.mjs";
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

test("Chat SSE assembles fragmented tool names before selecting the tool kind", async () => {
  const encoder = new TextEncoder();
  const frames = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_patch", function: { name: "apply_" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "patch", arguments: "{\"input\":\"patch\"}" } }] } }] },
  ];
  const readable = new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const events = [];
  const writer = new ResponsesWriter({
    model: "chat-model",
    responseId: "resp_fragmented",
    emit: (event, data) => events.push([event, data]),
  });

  await streamChatAsResponses({
    readable,
    writer,
    toolKinds: new Map([["apply_patch", "custom"]]),
  });

  const toolItems = events
    .filter(([event]) => event === "response.output_item.done")
    .map(([, data]) => data.item)
    .filter((item) => item.type.endsWith("_call"));
  assert.deepEqual(toolItems, [{
    id: "fc_call_patch",
    type: "custom_tool_call",
    call_id: "call_patch",
    name: "apply_patch",
    input: "patch",
  }]);
});

test("Chat SSE fails the Responses lifecycle when the DONE marker is missing", async () => {
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`,
      ));
      controller.close();
    },
  });
  const events = [];
  const writer = new ResponsesWriter({
    model: "chat-model",
    emit: (event, data) => events.push([event, data]),
  });

  await streamChatAsResponses({ readable, writer });

  assert.equal(events.at(-1)[0], "response.failed");
  assert.equal(
    events.at(-1)[1].response.error.code,
    "upstream_stream_closed",
  );
});

test("Chat completion becomes reasoning, text, custom tool, and normalized usage", () => {
  const response = chatCompletionToResponse({
    model: "requested-model",
    toolKinds: new Map([["apply_patch", "custom"]]),
    completion: {
      id: "chatcmpl_nonstream",
      created: 123,
      choices: [{
        message: {
          reasoning_content: "I should patch.",
          content: "Applying.",
          tool_calls: [{
            id: "call_patch",
            function: {
              name: "apply_patch",
              arguments: "{\"input\":\"*** Begin Patch\\n*** End Patch\"}",
            },
          }],
        },
      }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 7,
        total_tokens: 19,
      },
    },
  });

  assert.deepEqual(response.output.map((item) => item.type), [
    "reasoning",
    "message",
    "custom_tool_call",
  ]);
  assert.equal(response.output[2].input, "*** Begin Patch\n*** End Patch");
  assert.deepEqual(response.usage, {
    input_tokens: 12,
    output_tokens: 7,
    total_tokens: 19,
  });
});
