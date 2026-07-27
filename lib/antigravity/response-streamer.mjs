// v1internal response -> Codex /v1/responses events.
// Drives the shared ResponsesWriter (lib/codex/responses-writer.mjs) so the
// output is byte-compatible with the gateway's other Codex adapters.
//
// Two entry points:
//   streamResponses(readable, writer)       - REST SSE stream (backward compat)
//   streamGrpcResponses(responses, writer)  - gRPC async generator
//
// Both share processResponseData() for the per-frame logic.
// v1internal frame (REST JSON or gRPC protobuf decoded):
//   { response: { candidates: [...], usageMetadata } }   (wrapped)
//   { candidates: [...], usageMetadata }                  (raw)
import { iterateSse } from "../codex/sse.mjs";
import { cacheSignature } from "./signature-cache.mjs";

function unwrapFrame(json) {
  if (json && typeof json === "object" && json.response) return json.response;
  return json;
}

function mapUsage(usageMetadata) {
  if (!usageMetadata || typeof usageMetadata !== "object") return undefined;
  const input_tokens = usageMetadata.promptTokenCount ?? 0;
  const output_tokens = usageMetadata.candidatesTokenCount ?? 0;
  const total_tokens = usageMetadata.totalTokenCount ?? (input_tokens + output_tokens);
  return { input_tokens, output_tokens, total_tokens };
}

function isTerminalFinish(reason) {
  return reason && reason !== "FINISH_REASON_UNSPECIFIED";
}

// Process a single decoded response data object, driving the writer.
// Mutates `state` ({ usage, funcIndex, terminal }).
function processResponseData(data, writer, state) {
  if (data.usageMetadata) state.usage = mapUsage(data.usageMetadata);

  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (!part || typeof part !== "object") continue;

        // Thought (thinking) part: route to reasoning summary.
        if (typeof part.text === "string" && part.thought) {
          if (part.text) writer.reasoningDelta(part.text);
          continue;
        }
        if (typeof part.text === "string" && part.text !== "") {
          writer.textDelta(part.text);
          continue;
        }
        if (part.functionCall) {
          const { name, args, id } = part.functionCall;
          const callId = String(id || `call_${state.funcIndex}`);
          // Capture the thoughtSignature the model returned alongside this
          // functionCall so request-builder can re-inject it in the next turn.
          // Required by the v1internal backend (see signature-cache.mjs).
          if (part.thoughtSignature) cacheSignature(state.sessionFp, callId, part.thoughtSignature);
          const argsText = args == null ? "{}" : (typeof args === "string" ? args : JSON.stringify(args));
          writer.functionArgumentsDelta({
            index: state.funcIndex,
            callId,
            name: name || "unknown",
            delta: argsText,
            kind: "function",
          });
          writer.finishFunction({
            index: state.funcIndex,
            callId,
            name: name || "unknown",
            argumentsText: argsText,
            kind: "function",
          });
          state.funcIndex += 1;
          continue;
        }
      }
    }

    if (isTerminalFinish(candidate?.finishReason) && !state.terminal) {
      state.terminal = true;
      writer.completed(state.usage || {});
    }
  }
}

// REST SSE path: drives `writer` from a v1internal SSE readable stream.
export async function streamResponses(readable, writer, sessionFp = "_default") {
  const state = { usage: undefined, funcIndex: 0, terminal: false, sessionFp };

  for await (const frame of iterateSse(readable)) {
    if (frame.data === "[DONE]") continue;
    let json;
    try { json = JSON.parse(frame.data); } catch { continue; }
    processResponseData(unwrapFrame(json), writer, state);
  }

  if (!state.terminal) {
    writer.completed(state.usage || {});
  }
}

// gRPC path: drives `writer` from an async generator of decoded response
// objects (each is { response: { candidates, usageMetadata, ... }, traceId }).
export async function streamGrpcResponses(responses, writer, sessionFp = "_default") {
  const state = { usage: undefined, funcIndex: 0, terminal: false, sessionFp };

  for await (const resp of responses) {
    processResponseData(unwrapFrame(resp), writer, state);
    if (state.terminal) break;
  }

  if (!state.terminal) {
    writer.completed(state.usage || {});
  }
}
