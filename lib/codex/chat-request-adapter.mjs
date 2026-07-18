export function responsesRequestToChat(source, resolvedModel) {
  const messages = [];
  const toolKinds = new Map();

  if (source.instructions) {
    messages.push({ role: "system", content: String(source.instructions) });
  }

  const input = Array.isArray(source.input)
    ? source.input
    : typeof source.input === "string"
      ? [{ role: "user", content: [{ type: "input_text", text: source.input }] }]
      : [];

  for (const item of input) {
    appendInputItem(messages, item);
  }

  const tools = (source.tools || []).map((tool) => {
    if (tool.type === "function") {
      toolKinds.set(tool.name, "function");
      return {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: tool.parameters || emptyObjectSchema(),
        },
      };
    }
    if (tool.type === "custom") {
      toolKinds.set(tool.name, "custom");
      return {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: {
            type: "object",
            properties: { input: { type: "string" } },
            required: ["input"],
            additionalProperties: false,
          },
        },
      };
    }
    throw new Error(
      `Responses tool type '${tool.type || "unknown"}' cannot be represented by Chat Completions.`,
    );
  });

  const body = {
    model: resolvedModel,
    messages: messages.length ? messages : [{ role: "user", content: "" }],
    stream: Boolean(source.stream),
  };
  if (tools.length) body.tools = tools;
  if (source.tool_choice != null) body.tool_choice = source.tool_choice;
  if (source.max_output_tokens != null) body.max_tokens = source.max_output_tokens;
  if (source.temperature != null) body.temperature = source.temperature;
  if (source.top_p != null) body.top_p = source.top_p;
  if (source.stop != null) body.stop = source.stop;

  return { body, toolKinds };
}

function appendInputItem(messages, item) {
  if (!item || typeof item !== "object") {
    throw new Error(
      "Responses input item type 'unknown' cannot be represented by Chat Completions.",
    );
  }

  if (item.type === "function_call" || item.type === "custom_tool_call") {
    appendToolCall(messages, item);
    return;
  }

  if (
    item.type === "function_call_output" ||
    item.type === "custom_tool_call_output"
  ) {
    messages.push({
      role: "tool",
      tool_call_id: item.call_id || item.id,
      content: stringifyOutput(item.output),
    });
    return;
  }

  const isMessage = item.type === "message" || (
    item.type == null &&
    (item.role === "user" || item.role === "assistant")
  );
  if (!isMessage) {
    throw new Error(
      `Responses input item type '${item.type || "unknown"}' cannot be represented by Chat Completions.`,
    );
  }

  messages.push({
    role: item.role === "assistant" ? "assistant" : "user",
    content: contentToChat(item.content),
  });
}

function appendToolCall(messages, item) {
  const toolCall = {
    id: item.call_id || item.id,
    type: "function",
    function: {
      name: item.name,
      arguments: item.type === "custom_tool_call"
        ? JSON.stringify({ input: item.input || "" })
        : typeof item.arguments === "string"
          ? item.arguments
          : JSON.stringify(item.arguments || {}),
    },
  };

  const previous = messages[messages.length - 1];
  // Coalesce consecutive function/custom tool calls into one assistant message.
  // Chat Completions expects parallel tools in a single assistant turn.
  // If tool results already followed the previous assistant message, the last
  // message will be role:"tool" and we correctly open a new assistant turn.
  if (previous?.role === "assistant") {
    previous.tool_calls = [...(previous.tool_calls || []), toolCall];
    if (previous.content === undefined) previous.content = null;
    return;
  }

  messages.push({
    role: "assistant",
    content: null,
    tool_calls: [toolCall],
  });
}

function contentToChat(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    const contentType = content === null ? "null" : typeof content;
    throw new Error(
      `Responses message content type '${contentType}' cannot be represented by Chat Completions.`,
    );
  }
  return content.map((part) => {
    if (
      part.type === "input_text" ||
      part.type === "output_text" ||
      part.type === "text"
    ) {
      return { type: "text", text: String(part.text || "") };
    }
    if (part.type === "input_image" && part.image_url) {
      return {
        type: "image_url",
        image_url: { url: String(part.image_url) },
      };
    }
    throw new Error(
      `Responses content type '${part.type || "unknown"}' cannot be represented by Chat Completions.`,
    );
  });
}

function stringifyOutput(output) {
  return typeof output === "string" ? output : JSON.stringify(output ?? "");
}

function emptyObjectSchema() {
  return { type: "object", properties: {} };
}
