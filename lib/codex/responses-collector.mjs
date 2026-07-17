import { iterateSse } from "./sse.mjs";

export async function collectResponsesStream(readable, requestedModel) {
  let response = {
    id: `resp_${Date.now()}`,
    object: "response",
    model: requestedModel,
    status: "in_progress",
    output: [],
    output_text: "",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
  };
  const outputByIndex = new Map();
  let terminal = false;

  for await (const frame of iterateSse(readable)) {
    if (frame.data === "[DONE]") continue;
    const payload = JSON.parse(frame.data);

    if (payload.type === "response.created") {
      response = { ...response, ...payload.response, output: response.output };
    }
    if (payload.type === "response.output_item.done") {
      outputByIndex.set(payload.output_index, payload.item);
    }
    if (payload.type === "response.completed") {
      response = { ...response, ...payload.response };
      terminal = true;
    }
    if (payload.type === "response.incomplete") {
      response = { ...response, ...payload.response, status: "incomplete" };
      terminal = true;
    }
    if (payload.type === "response.failed") {
      response = { ...response, ...payload.response, status: "failed" };
      terminal = true;
    }
  }

  if (!terminal) {
    throw new Error("Responses upstream closed without a terminal event.");
  }

  response.output = [...outputByIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, item]) => item);
  response.output_text = response.output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text || "")
    .join("");

  return response;
}
