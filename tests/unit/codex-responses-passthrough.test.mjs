import assert from "node:assert/strict";
import test from "node:test";
import { ReadableStream } from "node:stream/web";
import { pipeResponsesSsePassthrough } from "../../lib/codex/responses-passthrough.mjs";

function collectWritable() {
  const chunks = [];
  let ended = false;
  return {
    chunks,
    write(chunk) {
      chunks.push(Buffer.from(chunk).toString("utf8"));
    },
    end() {
      ended = true;
    },
    get text() {
      return chunks.join("");
    },
    get ended() {
      return ended;
    },
  };
}

test("passthrough preserves terminal completed streams without synthesis", async () => {
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_ok","status":"in_progress"}}\n\n',
      ));
      controller.enqueue(encoder.encode(
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_ok","status":"completed"}}\n\n',
      ));
      controller.close();
    },
  });
  const out = collectWritable();
  const result = await pipeResponsesSsePassthrough({
    readable,
    write: out.write,
    end: out.end,
    model: "glm-5.2",
  });

  assert.equal(result.sawTerminal, true);
  assert.equal(result.responseId, "resp_ok");
  assert.equal(out.ended, true);
  assert.match(out.text, /event: response\.completed/);
  assert.doesNotMatch(out.text, /event: response\.failed/);
  assert.equal(
    out.text.includes(
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_ok","status":"in_progress"}}\n\n',
    ),
    true,
  );
});

test("passthrough synthesizes response.failed when upstream closes early", async () => {
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_cut","status":"in_progress"}}\n\n',
      ));
      controller.enqueue(encoder.encode(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
      ));
      controller.close();
    },
  });
  const out = collectWritable();
  const result = await pipeResponsesSsePassthrough({
    readable,
    write: out.write,
    end: out.end,
    model: "glm-5.2",
  });

  assert.equal(result.sawTerminal, false);
  assert.equal(result.responseId, "resp_cut");
  assert.equal(out.ended, true);
  assert.match(out.text, /event: response\.failed/);
  assert.match(out.text, /"code":"upstream_stream_closed"/);
  assert.match(out.text, /"id":"resp_cut"/);
  assert.doesNotMatch(out.text, /event: response\.completed/);
});

test("passthrough treats incomplete as a terminal event", async () => {
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        'data: {"type":"response.incomplete","response":{"id":"resp_incomplete","status":"incomplete"}}\n\n',
      ));
      controller.close();
    },
  });
  const out = collectWritable();
  const result = await pipeResponsesSsePassthrough({
    readable,
    write: out.write,
    end: out.end,
  });

  assert.equal(result.sawTerminal, true);
  assert.equal(result.responseId, "resp_incomplete");
  assert.doesNotMatch(out.text, /event: response\.failed/);
});
