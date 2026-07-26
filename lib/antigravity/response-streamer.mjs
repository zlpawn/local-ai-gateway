// v1internal streamGenerateContent SSE -> Codex /v1/responses events.
// Drives the shared ResponsesWriter (lib/codex/responses-writer.mjs) so the
// output is byte-compatible with the gateway's other Codex adapters.
//
// v1internal SSE frame: `data: <json>` where <json> is either
//   { response: { candidates: [...], usageMetadata } }   (wrapped)
//   { candidates: [...], usageMetadata }                  (raw)
// Mirrors AG gemini/collector.rs unwrap of the `response` field.
import { iterateSse } from "../codex/sse.mjs";

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

// Drives `writer` (ResponsesWriter) from a v1internal SSE readable stream.
// Resolves when the stream closes. The writer always receives a terminal
// event (response.completed) - either on the first terminal finishReason or
// when the stream ends without one.
export async function streamResponses(readable, writer) {
  let usage = undefined;
  let funcIndex = 0;
  let terminal = false;

  for await (const frame of iterateSse(readable)) {
    if (frame.data === "[DONE]") continue;
    let json;
    try { json = JSON.parse(frame.data); } catch { continue; }
    const data = unwrapFrame(json);

    if (data.usageMetadata) usage = mapUsage(data.usageMetadata);

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
            const callId = String(id || `call_${funcIndex}`);
            const argsText = args == null ? "{}" : (typeof args === "string" ? args : JSON.stringify(args));
            writer.functionArgumentsDelta({
              index: funcIndex,
              callId,
              name: name || "unknown",
              delta: argsText,
              kind: "function",
            });
            writer.finishFunction({
              index: funcIndex,
              callId,
              name: name || "unknown",
              argumentsText: argsText,
              kind: "function",
            });
            funcIndex += 1;
            continue;
          }
        }
      }

      if (isTerminalFinish(candidate?.finishReason) && !terminal) {
        terminal = true;
        writer.completed(usage || {});
      }
    }
  }

  if (!terminal) {
    // Stream closed without an explicit finishReason; close gracefully.
    writer.completed(usage || {});
  }
}