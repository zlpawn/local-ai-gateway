import test from "node:test";
import assert from "node:assert/strict";

import { createResponseUsageCapture } from "../../lib/analytics/response-usage-capture.mjs";

test("captures OpenAI-compatible JSON usage", () => {
  const capture = createResponseUsageCapture();
  capture.push(JSON.stringify({
    usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
  }));

  assert.deepEqual(capture.finish(), {
    prompt_tokens: 12,
    completion_tokens: 5,
    total_tokens: 17,
  });
});

test("captures Responses and chat-completions SSE usage", () => {
  const capture = createResponseUsageCapture();
  capture.push('data: {"type":"response.completed","response":{"usage":{"input_tokens":20,"output_tokens":8,"total_tokens":28}}}\n\n');
  capture.push('data: {"choices":[],"usage":{"prompt_tokens":22,"completion_tokens":9,"total_tokens":31}}\n\n');
  capture.push("data: [DONE]\n\n");

  assert.deepEqual(capture.finish(), {
    prompt_tokens: 22,
    completion_tokens: 9,
    total_tokens: 31,
  });
});

test("combines Anthropic message_start and message_delta usage", () => {
  const capture = createResponseUsageCapture();
  capture.push('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":30,"output_tokens":1}}}\n\n');
  capture.push('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":11}}\n\n');

  assert.deepEqual(capture.finish(), {
    prompt_tokens: 30,
    completion_tokens: 11,
    total_tokens: 41,
  });
});

test("returns null when the response has no usage", () => {
  const capture = createResponseUsageCapture();
  capture.push('{"ok":true}');
  assert.equal(capture.finish(), null);
});
