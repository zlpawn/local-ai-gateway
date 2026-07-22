export function sanitizeGrokResponsesInput(source) {
  if (!source || typeof source !== "object") return source;

  const result = { ...source };

  // 1. Sanitize tools
  if (Array.isArray(source.tools)) {
    result.tools = source.tools
      .map((tool) => {
        if (!tool || typeof tool !== "object") return null;
        if (tool.type === "function") return tool;
        if (tool.type === "custom") {
          return {
            type: "function",
            name: tool.name,
            description: tool.description || "",
            parameters: {
              type: "object",
              properties: { input: { type: "string" } },
              required: ["input"],
              additionalProperties: false,
            },
          };
        }
        // Filter out non-standard / namespace tool definitions
        return null;
      })
      .filter(Boolean);
  }

  // 2. Sanitize input items
  if (Array.isArray(source.input)) {
    result.input = source.input
      .map((item) => {
        if (!item || typeof item !== "object") return null;

        // Convert custom_tool_call -> standard function_call
        if (item.type === "custom_tool_call") {
          const callId = item.call_id || item.id || `call_${Math.random().toString(36).slice(2, 10)}`;
          let argsStr = "";
          if (typeof item.input === "string") {
            argsStr = item.input;
          } else if (item.arguments) {
            argsStr = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments);
          } else {
            argsStr = JSON.stringify(item.input || {});
          }
          return {
            type: "function_call",
            id: item.id || callId,
            call_id: callId,
            name: item.name || "custom_tool",
            arguments: argsStr,
          };
        }

        // Convert custom_tool_call_output -> standard function_call_output
        if (item.type === "custom_tool_call_output") {
          const callId = item.call_id || item.id;
          let outputStr = "";
          if (typeof item.output === "string") {
            outputStr = item.output;
          } else {
            outputStr = JSON.stringify(item.output ?? "");
          }
          return {
            type: "function_call_output",
            call_id: callId,
            output: outputStr,
          };
        }

        // Keep standard function_call
        if (item.type === "function_call") {
          return {
            type: "function_call",
            id: item.id || item.call_id,
            call_id: item.call_id || item.id,
            name: item.name,
            arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
          };
        }

        // Keep standard function_call_output
        if (item.type === "function_call_output") {
          return {
            type: "function_call_output",
            call_id: item.call_id || item.id,
            output: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
          };
        }

        // Keep standard message or role-based item
        const isMessage = item.type === "message" || (
          item.type == null && (item.role === "user" || item.role === "assistant" || item.role === "system")
        );
        if (isMessage) {
          return {
            type: "message",
            role: item.role || "user",
            content: sanitizeContent(item.content),
          };
        }

        // Filter out compaction, item_reference, reasoning, summary, etc.
        return null;
      })
      .filter(Boolean);
  }

  // 3. Remove non-standard top-level properties
  delete result.instructions_variables;
  delete result.dynamic_tools;
  delete result.collaboration_mode;

  return result;
}

function sanitizeContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => {
    if (!part || typeof part !== "object") return false;
    return part.type === "input_text" || part.type === "text" || part.type === "image_url";
  });
}
