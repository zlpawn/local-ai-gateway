import { iterateSse } from "./sse.mjs";

export async function streamChatAsResponses({
  readable,
  writer,
  toolKinds = new Map(),
}) {
  const calls = new Map();
  let sawDone = false;
  let finalUsage = {};

  for await (const frame of iterateSse(readable)) {
    if (frame.data === "[DONE]") {
      sawDone = true;
      break;
    }
    const payload = JSON.parse(frame.data);
    const choice = payload.choices?.[0] || {};
    const delta = choice.delta || {};
    const reasoning = firstString(
      delta.reasoning_content,
      delta.reasoning,
      delta.analysis,
    );
    if (reasoning) writer.reasoningDelta(reasoning);
    if (typeof delta.content === "string" && delta.content) {
      writer.textDelta(delta.content);
    }
    for (const toolDelta of delta.tool_calls || []) {
      const state = getCallState(calls, toolDelta);
      const argumentDelta = toolDelta.function?.arguments || "";
      state.argumentsText += argumentDelta;
      if (argumentDelta) state.pendingArgumentDeltas.push(argumentDelta);
      if (!hasPossibleNameContinuation(state.name, toolKinds)) {
        emitPendingArguments(state, writer, toolKinds);
      }
    }
    if (payload.usage) finalUsage = normalizeUsage(payload.usage);
    if (choice.finish_reason === "tool_calls") {
      finishCalls(calls, writer, toolKinds);
    }
  }

  if (!sawDone) {
    writer.failed({
      code: "upstream_stream_closed",
      message: "Chat upstream closed without a [DONE] marker.",
    });
    return;
  }
  finishCalls(calls, writer, toolKinds);
  writer.completed(finalUsage);
}

export function chatCompletionToResponse({
  completion,
  model,
  toolKinds = new Map(),
}) {
  const message = completion.choices?.[0]?.message || {};
  const output = [];
  if (message.reasoning_content) {
    output.push({
      id: `rs_${completion.id}`,
      type: "reasoning",
      summary: [{ type: "summary_text", text: message.reasoning_content }],
    });
  }
  if (message.content) {
    output.push({
      id: `msg_${completion.id}`,
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: message.content, annotations: [] }],
    });
  }
  for (const toolCall of message.tool_calls || []) {
    const name = toolCall.function?.name || "tool";
    const kind = toolKinds.get(name) || "function";
    output.push(kind === "custom"
      ? {
          id: `fc_${toolCall.id}`,
          type: "custom_tool_call",
          call_id: toolCall.id,
          name,
          input: JSON.parse(toolCall.function.arguments).input,
        }
      : {
          id: `fc_${toolCall.id}`,
          type: "function_call",
          call_id: toolCall.id,
          name,
          arguments: toolCall.function.arguments,
        });
  }
  return {
    id: completion.id || `resp_${Date.now()}`,
    object: "response",
    created_at: completion.created || Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output,
    output_text: message.content || "",
    usage: normalizeUsage(completion.usage || {}),
  };
}

function getCallState(calls, delta) {
  const index = Number(delta.index) || 0;
  if (!calls.has(index)) {
    calls.set(index, {
      index,
      callId: delta.id || `call_${index}`,
      name: "",
      argumentsText: "",
      pendingArgumentDeltas: [],
      done: false,
    });
  }
  const state = calls.get(index);
  if (delta.id) state.callId = delta.id;
  if (delta.function?.name) state.name += delta.function.name;
  return state;
}

function finishCalls(calls, writer, toolKinds) {
  for (const state of calls.values()) {
    if (state.done) continue;
    if (!state.name) state.name = "tool";
    emitPendingArguments(state, writer, toolKinds);
    writer.finishFunction({
      index: state.index,
      callId: state.callId,
      name: state.name,
      argumentsText: state.argumentsText,
      kind: toolKinds.get(state.name) || "function",
    });
    state.done = true;
  }
}

function emitPendingArguments(state, writer, toolKinds) {
  const kind = toolKinds.get(state.name) || "function";
  for (const delta of state.pendingArgumentDeltas) {
    writer.functionArgumentsDelta({
      index: state.index,
      callId: state.callId,
      name: state.name || "tool",
      delta,
      kind,
    });
  }
  state.pendingArgumentDeltas.length = 0;
}

function hasPossibleNameContinuation(name, toolKinds) {
  if (!name || toolKinds.has(name)) return false;
  return [...toolKinds.keys()].some((candidate) => candidate.startsWith(name));
}

function normalizeUsage(usage) {
  return {
    input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
    output_tokens: usage.completion_tokens || usage.output_tokens || 0,
    total_tokens: usage.total_tokens || 0,
  };
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value) || "";
}
