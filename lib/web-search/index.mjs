import { getEndpointApiKey } from "../config/gateway-config-store.mjs";
import {
  formatWebSearchResultForModel,
  parseWebSearchToolArguments,
} from "./normalize.mjs";
import { getWebSearchProvider, listWebSearchProviderIds } from "./providers/registry.mjs";
import {
  GATEWAY_WEB_SEARCH_TOOL_NAME,
  buildGatewayWebSearchTool,
} from "./tool-def.mjs";

export {
  GATEWAY_WEB_SEARCH_TOOL_NAME,
  buildGatewayWebSearchTool,
  formatWebSearchResultForModel,
  parseWebSearchToolArguments,
  getWebSearchProvider,
  listWebSearchProviderIds,
};


export function withoutStreamFlag(body) {
  if (!body || typeof body !== "object") return body;
  return { ...body, stream: false };
}

export function isWebSearchEndpoint(endpoint) {
  return endpoint?.purpose === "web_search";
}

export function isGatewayWebSearchEnabled(env = process.env) {
  return !isTruthy(env.GATEWAY_WEB_SEARCH_DISABLED);
}

export function gatewayWebSearchMaxLoops(env = process.env) {
  const raw = Number(env.GATEWAY_WEB_SEARCH_MAX_LOOPS);
  if (!Number.isFinite(raw) || raw <= 0) return 3;
  return Math.min(10, Math.trunc(raw));
}

export function selectWebSearchEndpoint(endpoints = [], { secrets = null, env = process.env } = {}) {
  const candidates = (Array.isArray(endpoints) ? endpoints : [])
    .filter((endpoint) => isWebSearchEndpoint(endpoint))
    .filter((endpoint) => endpoint?.enabled !== false);

  if (!candidates.length) return null;

  const defaults = candidates.filter((endpoint) => endpoint?.is_default === true);
  const ordered = defaults.length ? defaults : candidates;

  for (const endpoint of ordered) {
    const providerId = String(endpoint.provider || endpoint.search_provider || "").trim().toLowerCase();
    const adapter = getWebSearchProvider(providerId);
    if (!adapter) continue;
    const apiKey = resolveSearchApiKey(endpoint, secrets, env);
    if (!apiKey) continue;
    return {
      endpoint,
      providerId,
      adapter,
      apiKey,
      options: endpoint.options && typeof endpoint.options === "object" ? endpoint.options : {},
    };
  }

  return null;
}

export function hasConflictingWebSearchTool(tools) {
  return (Array.isArray(tools) ? tools : []).some((tool) => {
    const type = String(tool?.type || "").toLowerCase();
    const name = String(tool?.name || tool?.function?.name || "").toLowerCase();
    if (type.includes("web_search") || type.includes("websearch")) return true;
    if (name.includes("web_search") || name.includes("websearch")) return true;
    return false;
  });
}

export function maybeInjectGatewayWebSearch(body, {
  endpoints = [],
  secrets = null,
  env = process.env,
  officialRoute = false,
  format = "responses",
} = {}) {
  if (!body || typeof body !== "object") {
    return { body, injected: false, selected: null, reason: "invalid_body" };
  }
  if (officialRoute) {
    return { body, injected: false, selected: null, reason: "official_route" };
  }
  if (!isGatewayWebSearchEnabled(env)) {
    return { body, injected: false, selected: null, reason: "disabled" };
  }

  const selected = selectWebSearchEndpoint(endpoints, { secrets, env });
  if (!selected) {
    return { body, injected: false, selected: null, reason: "no_search_endpoint" };
  }

  const existing = Array.isArray(body.tools) ? body.tools : [];
  if (hasConflictingWebSearchTool(existing)) {
    return { body, injected: false, selected, reason: "conflicting_tool" };
  }

  return {
    body: {
      ...body,
      tools: [...existing, buildGatewayWebSearchToolForFormat(format)],
    },
    injected: true,
    selected,
    reason: "injected",
  };
}

export function buildGatewayWebSearchToolForFormat(format = "responses") {
  const base = buildGatewayWebSearchTool();
  if (format === "chat") {
    return {
      type: "function",
      function: {
        name: base.name,
        description: base.description,
        parameters: base.parameters,
      },
    };
  }
  if (format === "anthropic") {
    return {
      name: base.name,
      description: base.description,
      input_schema: base.parameters,
    };
  }
  return base;
}

export function extractGatewayWebSearchCallsFromResponse(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const calls = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    if (item.type !== "function_call" && item.type !== "custom_tool_call") continue;
    const name = String(item.name || "").trim();
    if (name !== GATEWAY_WEB_SEARCH_TOOL_NAME) continue;
    const callId = item.call_id || item.id;
    if (!callId) continue;
    const rawArguments = item.type === "custom_tool_call"
      ? JSON.stringify({ query: item.input || "" })
      : (typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}));
    calls.push({
      call_id: callId,
      name,
      arguments: rawArguments,
      item,
    });
  }
  return calls;
}

export function responseHasOnlyGatewayWebSearchCalls(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const toolCalls = output.filter((item) =>
    item
    && (item.type === "function_call" || item.type === "custom_tool_call")
  );
  if (!toolCalls.length) return false;
  return toolCalls.every((item) => String(item.name || "") === GATEWAY_WEB_SEARCH_TOOL_NAME);
}

export async function executeGatewayWebSearchCall(call, selected, { signal } = {}) {
  const args = parseWebSearchToolArguments(call?.arguments);
  if (!selected?.adapter || !selected?.apiKey) {
    return {
      call_id: call.call_id,
      output: formatWebSearchResultForModel({
        ok: false,
        provider: selected?.providerId || "unknown",
        query: args.query,
        error: "Web search endpoint is not configured.",
      }),
      result: null,
      item: call?.item || null,
    };
  }

  try {
    const result = await selected.adapter.search({
      query: args.query,
      max_results: args.max_results,
      time_range: args.time_range,
      options: selected.options || {},
      apiKey: selected.apiKey,
      signal,
    });
    return {
      call_id: call.call_id,
      output: formatWebSearchResultForModel(result),
      result,
      item: call?.item || null,
    };
  } catch (error) {
    return {
      call_id: call.call_id,
      output: formatWebSearchResultForModel({
        ok: false,
        provider: selected.providerId,
        query: args.query,
        error: error instanceof Error ? error.message : String(error),
      }),
      result: null,
      item: call?.item || null,
    };
  }
}

export function appendGatewayWebSearchResultsToResponsesBody(body, response, executedCalls) {
  const input = Array.isArray(body.input)
    ? [...body.input]
    : typeof body.input === "string"
      ? [{ type: "message", role: "user", content: [{ type: "input_text", text: body.input }] }]
      : [];

  const output = Array.isArray(response?.output) ? response.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      input.push(stripOutputIndex(item));
    } else if (item.type === "message" && item.role === "assistant") {
      input.push(stripOutputIndex(item));
    } else if (item.type === "reasoning") {
      // Keep reasoning out of follow-up input for third-party adapters that may
      // reject unknown item types. Search results remain the durable signal.
      continue;
    }
  }

  for (const executed of executedCalls) {
    const isCustom = executed.item?.type === "custom_tool_call";
    input.push({
      type: isCustom ? "custom_tool_call_output" : "function_call_output",
      call_id: executed.call_id,
      output: executed.output,
    });
  }

  return {
    ...body,
    input,
    // Continue without forcing the model to call tools again.
    tool_choice: body.tool_choice && body.tool_choice !== "required" ? body.tool_choice : "auto",
  };
}

export async function runGatewayWebSearchResponsesLoop({
  body,
  selected,
  fetchResponse,
  maxLoops = 3,
  signal,
  onSearch,
} = {}) {
  if (!selected) {
    return {
      body,
      response: null,
      loops: 0,
      executed: [],
      stopReason: "no_search_endpoint",
    };
  }

  let currentBody = body;
  let loops = 0;
  const executed = [];

  while (loops < maxLoops) {
    const response = await fetchResponse(currentBody);
    if (!response || response.status === "failed") {
      return {
        body: currentBody,
        response,
        loops,
        executed,
        stopReason: "upstream_failed",
      };
    }

    const calls = extractGatewayWebSearchCallsFromResponse(response);
    if (!calls.length) {
      return {
        body: currentBody,
        response,
        loops,
        executed,
        stopReason: "completed",
      };
    }

    if (!responseHasOnlyGatewayWebSearchCalls(response)) {
      return {
        body: currentBody,
        response,
        loops,
        executed,
        stopReason: "mixed_tool_calls",
      };
    }

    const batch = [];
    for (const call of calls) {
      const started = Date.now();
      const result = await executeGatewayWebSearchCall(call, selected, { signal });
      batch.push(result);
      executed.push(result);
      if (typeof onSearch === "function") {
        onSearch({
          call_id: call.call_id,
          query: parseWebSearchToolArguments(call.arguments).query,
          latency_ms: Date.now() - started,
          ok: result.result?.ok !== false && !result.result?.error,
          result_count: Array.isArray(result.result?.results) ? result.result.results.length : 0,
          provider: selected.providerId,
          endpoint_id: selected.endpoint?.id || null,
        });
      }
    }

    currentBody = appendGatewayWebSearchResultsToResponsesBody(currentBody, response, batch);
    loops += 1;
  }

  // One last attempt after max tool rounds so the model can answer with results.
  const finalResponse = await fetchResponse(currentBody);
  return {
    body: currentBody,
    response: finalResponse,
    loops,
    executed,
    stopReason: "max_loops",
  };
}

export function extractGatewayWebSearchCallsFromChatCompletion(completion) {
  const message = completion?.choices?.[0]?.message || {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const calls = [];
  for (const toolCall of toolCalls) {
    const name = String(toolCall?.function?.name || toolCall?.name || "").trim();
    if (name !== GATEWAY_WEB_SEARCH_TOOL_NAME) continue;
    const callId = toolCall?.id || toolCall?.call_id;
    if (!callId) continue;
    calls.push({
      call_id: callId,
      name,
      arguments: typeof toolCall?.function?.arguments === "string"
        ? toolCall.function.arguments
        : JSON.stringify(toolCall?.function?.arguments || toolCall?.arguments || {}),
      item: toolCall,
    });
  }
  return calls;
}

export function chatCompletionHasOnlyGatewayWebSearchCalls(completion) {
  const message = completion?.choices?.[0]?.message || {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (!toolCalls.length) return false;
  return toolCalls.every((toolCall) =>
    String(toolCall?.function?.name || toolCall?.name || "") === GATEWAY_WEB_SEARCH_TOOL_NAME
  );
}

export function appendGatewayWebSearchResultsToChatBody(body, completion, executedCalls) {
  const messages = Array.isArray(body.messages) ? [...body.messages] : [];
  const message = completion?.choices?.[0]?.message;
  if (message) {
    messages.push({
      role: "assistant",
      content: message.content ?? null,
      ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}),
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
    });
  }
  for (const executed of executedCalls) {
    messages.push({
      role: "tool",
      tool_call_id: executed.call_id,
      content: executed.output,
    });
  }
  return {
    ...body,
    messages,
    tool_choice: body.tool_choice && body.tool_choice !== "required" ? body.tool_choice : "auto",
  };
}

export async function runGatewayWebSearchChatLoop({
  body,
  selected,
  fetchCompletion,
  maxLoops = 3,
  signal,
  onSearch,
} = {}) {
  if (!selected) {
    return {
      body,
      completion: null,
      loops: 0,
      executed: [],
      stopReason: "no_search_endpoint",
    };
  }

  let currentBody = body;
  let loops = 0;
  const executed = [];

  while (loops < maxLoops) {
    const completion = await fetchCompletion(currentBody);
    if (!completion) {
      return {
        body: currentBody,
        completion: null,
        loops,
        executed,
        stopReason: "upstream_failed",
      };
    }

    const calls = extractGatewayWebSearchCallsFromChatCompletion(completion);
    if (!calls.length) {
      return {
        body: currentBody,
        completion,
        loops,
        executed,
        stopReason: "completed",
      };
    }

    if (!chatCompletionHasOnlyGatewayWebSearchCalls(completion)) {
      return {
        body: currentBody,
        completion,
        loops,
        executed,
        stopReason: "mixed_tool_calls",
      };
    }

    const batch = [];
    for (const call of calls) {
      const started = Date.now();
      const result = await executeGatewayWebSearchCall(call, selected, { signal });
      batch.push(result);
      executed.push(result);
      if (typeof onSearch === "function") {
        onSearch({
          call_id: call.call_id,
          query: parseWebSearchToolArguments(call.arguments).query,
          latency_ms: Date.now() - started,
          ok: result.result?.ok !== false && !result.result?.error,
          result_count: Array.isArray(result.result?.results) ? result.result.results.length : 0,
          provider: selected.providerId,
          endpoint_id: selected.endpoint?.id || null,
        });
      }
    }

    currentBody = appendGatewayWebSearchResultsToChatBody(currentBody, completion, batch);
    loops += 1;
  }

  const finalCompletion = await fetchCompletion(currentBody);
  return {
    body: currentBody,
    completion: finalCompletion,
    loops,
    executed,
    stopReason: "max_loops",
  };
}

export function extractGatewayWebSearchCallsFromAnthropicMessage(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const calls = [];
  for (const block of content) {
    if (!block || block.type !== "tool_use") continue;
    const name = String(block.name || "").trim();
    if (name !== GATEWAY_WEB_SEARCH_TOOL_NAME) continue;
    const callId = block.id;
    if (!callId) continue;
    calls.push({
      call_id: callId,
      name,
      arguments: JSON.stringify(block.input || {}),
      item: block,
    });
  }
  return calls;
}

export function anthropicMessageHasOnlyGatewayWebSearchCalls(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const toolUses = content.filter((block) => block?.type === "tool_use");
  if (!toolUses.length) return false;
  return toolUses.every((block) => String(block.name || "") === GATEWAY_WEB_SEARCH_TOOL_NAME);
}

export function appendGatewayWebSearchResultsToAnthropicBody(body, message, executedCalls) {
  const messages = Array.isArray(body.messages) ? [...body.messages] : [];
  if (message) {
    messages.push({
      role: "assistant",
      content: Array.isArray(message.content) ? message.content : [],
    });
  }
  messages.push({
    role: "user",
    content: executedCalls.map((executed) => ({
      type: "tool_result",
      tool_use_id: executed.call_id,
      content: executed.output,
    })),
  });
  return {
    ...body,
    messages,
    tool_choice: body.tool_choice && body.tool_choice?.type !== "any"
      ? body.tool_choice
      : { type: "auto" },
  };
}

export async function runGatewayWebSearchAnthropicLoop({
  body,
  selected,
  fetchMessage,
  maxLoops = 3,
  signal,
  onSearch,
} = {}) {
  if (!selected) {
    return {
      body,
      message: null,
      loops: 0,
      executed: [],
      stopReason: "no_search_endpoint",
    };
  }

  let currentBody = body;
  let loops = 0;
  const executed = [];

  while (loops < maxLoops) {
    const message = await fetchMessage(currentBody);
    if (!message) {
      return {
        body: currentBody,
        message: null,
        loops,
        executed,
        stopReason: "upstream_failed",
      };
    }

    const calls = extractGatewayWebSearchCallsFromAnthropicMessage(message);
    if (!calls.length) {
      return {
        body: currentBody,
        message,
        loops,
        executed,
        stopReason: "completed",
      };
    }

    if (!anthropicMessageHasOnlyGatewayWebSearchCalls(message)) {
      return {
        body: currentBody,
        message,
        loops,
        executed,
        stopReason: "mixed_tool_calls",
      };
    }

    const batch = [];
    for (const call of calls) {
      const started = Date.now();
      const result = await executeGatewayWebSearchCall(call, selected, { signal });
      batch.push(result);
      executed.push(result);
      if (typeof onSearch === "function") {
        onSearch({
          call_id: call.call_id,
          query: parseWebSearchToolArguments(call.arguments).query,
          latency_ms: Date.now() - started,
          ok: result.result?.ok !== false && !result.result?.error,
          result_count: Array.isArray(result.result?.results) ? result.result.results.length : 0,
          provider: selected.providerId,
          endpoint_id: selected.endpoint?.id || null,
        });
      }
    }

    currentBody = appendGatewayWebSearchResultsToAnthropicBody(currentBody, message, batch);
    loops += 1;
  }

  const finalMessage = await fetchMessage(currentBody);
  return {
    body: currentBody,
    message: finalMessage,
    loops,
    executed,
    stopReason: "max_loops",
  };
}

function resolveSearchApiKey(endpoint, secrets, env) {
  if (secrets) {
    const fromSecrets = getEndpointApiKey(endpoint, secrets, env);
    if (fromSecrets) return fromSecrets;
  }
  if (typeof endpoint?.api_key === "string" && endpoint.api_key) {
    if (endpoint.api_key.startsWith("env:")) {
      return String(env[endpoint.api_key.slice(4)] || "").trim() || null;
    }
    return endpoint.api_key;
  }
  if (typeof endpoint?.api_key_env === "string" && endpoint.api_key_env) {
    return String(env[endpoint.api_key_env] || "").trim() || null;
  }
  // Common convenience for the first provider.
  if (String(endpoint?.provider || "").toLowerCase() === "tavily") {
    return String(env.TAVILY_API_KEY || "").trim() || null;
  }
  return null;
}

function stripOutputIndex(item) {
  const copy = { ...item };
  delete copy.output_index;
  delete copy.status;
  return copy;
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}
