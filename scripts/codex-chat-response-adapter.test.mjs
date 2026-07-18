import assert from "node:assert/strict";
import test from "node:test";
import { ReadableStream } from "node:stream/web";
import {
  chatCompletionToResponse,
  streamChatAsResponses,
} from "../lib/codex/chat-response-adapter.mjs";
import { collectResponsesStream } from "../lib/codex/responses-collector.mjs";
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
    events
      .filter(([event]) => event === "response.custom_tool_call_input.delta")
      .map(([, data]) => data.delta)
      .join(""),
    "*** Begin Patch\n*** End Patch",
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

test("Chat SSE buffers arguments until late tool name and id metadata arrives", async () => {
  const encoder = new TextEncoder();
  const frames = [
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"command\":" } }] } }] },
    { choices: [{ delta: { tool_calls: [{
      index: 0,
      id: "call_late",
      function: { name: "shell_command", arguments: "\"pwd\"}" },
    }] } }] },
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
    responseId: "resp_late_metadata",
    emit: (event, data) => events.push([event, data]),
  });

  await streamChatAsResponses({
    readable,
    writer,
    toolKinds: new Map([["shell_command", "function"]]),
  });

  const addedItem = events.find(
    ([event, data]) => (
      event === "response.output_item.added" &&
      data.item.type === "function_call"
    ),
  )[1].item;
  const doneItem = events.find(
    ([event, data]) => (
      event === "response.output_item.done" &&
      data.item.type === "function_call"
    ),
  )[1].item;
  assert.deepEqual(addedItem, {
    id: "fc_call_late",
    type: "function_call",
    call_id: "call_late",
    name: "shell_command",
    arguments: "",
  });
  assert.equal(doneItem.id, "fc_call_late");
  assert.equal(doneItem.call_id, "call_late");
  assert.equal(doneItem.name, "shell_command");
  assert.equal(doneItem.arguments, "{\"command\":\"pwd\"}");
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

test("Chat SSE emits created then completed for a valid empty output stream", async () => {
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        choices: [{
          delta: { role: "assistant" },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 0,
          total_tokens: 3,
        },
      })}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const events = [];
  const writer = new ResponsesWriter({
    model: "chat-model",
    responseId: "resp_empty",
    emit: (event, data) => events.push([event, data]),
  });

  await streamChatAsResponses({ readable, writer });

  assert.deepEqual(events.map(([event]) => event), [
    "response.created",
    "response.completed",
  ]);
  assert.deepEqual(events[1][1].response.output, undefined);
  assert.deepEqual(events[1][1].response.usage, {
    input_tokens: 3,
    output_tokens: 0,
    total_tokens: 3,
  });
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

test("Chat completion accepts reasoning and analysis aliases", () => {
  for (const [field, text] of [
    ["reasoning", "Reasoning alias."],
    ["analysis", "Analysis alias."],
  ]) {
    const response = chatCompletionToResponse({
      model: "requested-model",
      completion: {
        id: `chatcmpl_${field}`,
        choices: [{
          message: {
            [field]: text,
            content: "",
          },
        }],
      },
    });

    assert.deepEqual(response.output, [{
      id: `rs_chatcmpl_${field}`,
      type: "reasoning",
      summary: [{ type: "summary_text", text }],
    }]);
  }
});

test("Chat completion falls back when custom tool arguments are malformed", () => {
  const response = chatCompletionToResponse({
    model: "requested-model",
    toolKinds: new Map([["apply_patch", "custom"]]),
    completion: {
      id: "chatcmpl_bad_custom",
      choices: [{
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call_bad",
            function: {
              name: "apply_patch",
              arguments: "{not-json",
            },
          }],
        },
      }],
    },
  });

  assert.deepEqual(response.output, [{
    id: "fc_call_bad",
    type: "function_call",
    call_id: "call_bad",
    name: "apply_patch",
    arguments: "{not-json",
  }]);
});

test("Responses collector keeps complete output, usage, and terminal status", async () => {
  const encoder = new TextEncoder();
  const frames = [
    ["response.created", {
      type: "response.created",
      response: {
        id: "resp_collect",
        model: "grok-upstream",
        status: "in_progress",
      },
    }],
    ["response.output_item.done", {
      type: "response.output_item.done",
      output_index: 2,
      item: {
        id: "fc_1",
        type: "function_call",
        call_id: "call_1",
        name: "shell_command",
        arguments: "{\"command\":\"ls\"}",
      },
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
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "I will inspect." }],
      },
    }],
    ["response.output_item.done", {
      type: "response.output_item.done",
      output_index: 3,
      item: {
        id: "ctc_1",
        type: "custom_tool_call",
        call_id: "call_2",
        name: "apply_patch",
        input: "*** Begin Patch\n*** End Patch",
      },
    }],
    ["response.completed", {
      type: "response.completed",
      response: {
        id: "resp_collect",
        model: "grok-upstream",
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

  const response = await collectResponsesStream(readable, "grok-requested");

  assert.equal(response.id, "resp_collect");
  assert.equal(response.model, "grok-upstream");
  assert.equal(response.status, "completed");
  assert.deepEqual(response.output.map((item) => item.type), [
    "reasoning",
    "message",
    "function_call",
    "custom_tool_call",
  ]);
  assert.equal(response.output_text, "I will inspect.");
  assert.deepEqual(response.usage, {
    input_tokens: 3,
    output_tokens: 2,
    total_tokens: 5,
  });
});

test("Responses collector preserves an incomplete terminal response", async () => {
  const readable = responsesStream([
    ["response.incomplete", {
      type: "response.incomplete",
      response: {
        id: "resp_incomplete",
        model: "grok-upstream",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
      },
    }],
  ]);

  const response = await collectResponsesStream(readable, "grok-requested");

  assert.equal(response.status, "incomplete");
  assert.deepEqual(response.incomplete_details, {
    reason: "max_output_tokens",
  });
  assert.deepEqual(response.usage, {
    input_tokens: 8,
    output_tokens: 4,
    total_tokens: 12,
  });
});

test("Responses collector preserves a failed terminal response", async () => {
  const readable = responsesStream([
    ["response.failed", {
      type: "response.failed",
      response: {
        id: "resp_failed",
        model: "grok-upstream",
        status: "failed",
        error: {
          code: "upstream_error",
          message: "Grok failed.",
        },
        usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 },
      },
    }],
  ]);

  const response = await collectResponsesStream(readable, "grok-requested");

  assert.equal(response.status, "failed");
  assert.deepEqual(response.error, {
    code: "upstream_error",
    message: "Grok failed.",
  });
  assert.deepEqual(response.usage, {
    input_tokens: 5,
    output_tokens: 0,
    total_tokens: 5,
  });
});

test("Responses collector rejects a premature close without a terminal event", async () => {
  const readable = responsesStream([
    ["response.created", {
      type: "response.created",
      response: {
        id: "resp_partial",
        model: "grok-upstream",
        status: "in_progress",
      },
    }],
  ]);

  await assert.rejects(
    collectResponsesStream(readable, "grok-requested"),
    /closed without a terminal event/,
  );
});

test("Responses collector tolerates DONE after a completed terminal response", async () => {
  const readable = responsesStream([
    ["response.completed", {
      type: "response.completed",
      response: {
        id: "resp_done",
        model: "grok-upstream",
        status: "completed",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    }],
    [null, "[DONE]"],
  ]);

  const response = await collectResponsesStream(readable, "grok-requested");

  assert.equal(response.status, "completed");
  assert.equal(response.id, "resp_done");
  assert.equal(response.usage.total_tokens, 2);
});

function responsesStream(frames) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const [event, data] of frames) {
        const eventLine = event ? `event: ${event}\n` : "";
        const payload = typeof data === "string" ? data : JSON.stringify(data);
        controller.enqueue(encoder.encode(`${eventLine}data: ${payload}\n\n`));
      }
      controller.close();
    },
  });
}
