// Full Codex /v1/responses -> Antigravity v1internal generateContent body.
// Mirrors AG-Manager openai/request.rs (Codex/OpenAI -> v1internal) and
// gemini/wrapper.rs field reorder (stable prefix first, contents last).
//
// The antigravity identity is a short stub (see system-prompt.mjs); the Codex
// `instructions` are preserved verbatim per AG openai/request.rs:1102
// ("Codex system/developer prompts are preserved ... must not be overwritten
// or summarized"). This replaces the Phase 2 minimal builder.

import { deriveSessionId } from "./session-id.mjs";
import { ANTIGRAVITY_IDENTITY } from "./system-prompt.mjs";
import { getSignature, getFallbackSignature, computeSessionFingerprint } from "./signature-cache.mjs";

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  return [v];
}

function textPart(text) {
  return { text: String(text ?? "") };
}

function parseDataUrl(url) {
  if (typeof url !== "string") return null;
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  return {
    mimeType: m[1] || "image/png",
    data: m[2] ? m[3] : Buffer.from(decodeURIComponent(m[3]), "utf8").toString("base64"),
  };
}

function contentToParts(content) {
  if (content == null) return [];
  if (typeof content === "string") {
    return content === "" ? [] : [textPart(content)];
  }
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
      if (part.text) parts.push(textPart(part.text));
    } else if (part.type === "input_image" && part.image_url) {
      const img = parseDataUrl(part.image_url);
      if (img) parts.push({ inlineData: img });
    }
  }
  return parts;
}

function mapRole(role) {
  if (role === "assistant") return "model";
  // user / system / developer / tool -> user
  return "user";
}

// Pre-scan function_call / custom_tool_call items to build call_id -> name.
// Codex function_call_output only carries call_id (no name), but Gemini's
// functionResponse requires a name. Mirrors AG openai/request.rs:356-378.
function buildCallIdToName(input) {
  const map = new Map();
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const id = item.call_id || item.id;
      if (id && item.name) map.set(id, item.name);
    }
  }
  return map;
}

function parseArgs(value) {
  if (value == null) return {};
  if (typeof value === "object") return value;
  if (typeof value === "string") {
    if (value.trim() === "") return {};
    try { return JSON.parse(value); } catch { return { _raw: value }; }
  }
  return {};
}

function stringifyOutput(output) {
  if (typeof output === "string") return output;
  if (output == null) return "";
  try { return JSON.stringify(output); } catch { return String(output); }
}

function buildContents(input, callIdToName, sessionFp) {
  const contents = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;

    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const name = item.name || "unknown";
      const args = item.type === "custom_tool_call"
        ? { input: item.input ?? "" }
        : parseArgs(item.arguments);
      const id = String(item.call_id || item.id || "");
      // Re-inject the thoughtSignature the model returned with this function
      // call. The Codex protocol does not carry it, so we look it up from the
      // signature cache (populated by response-streamer on the prior turn).
      // Without it the v1internal backend rejects with status=3.
      const part = { functionCall: { name, args, id } };
      const sig = getSignature(sessionFp, id) || getFallbackSignature(sessionFp);
      if (sig) part.thoughtSignature = sig;
      contents.push({ role: "model", parts: [part] });
      continue;
    }

    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const id = String(item.call_id || item.id || "");
      const name = callIdToName.get(id) || "tool_result";
      const result = stringifyOutput(item.output);
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name, response: { result }, id } }],
      });
      continue;
    }

    const isMessage = item.type === "message" ||
      (item.type == null && (item.role === "user" || item.role === "assistant"));
    if (!isMessage) continue;

    const parts = contentToParts(item.content);
    if (parts.length === 0) continue;
    contents.push({ role: mapRole(item.role), parts });
  }

  const merged = [];
  for (const turn of contents) {
    if (!turn.parts || turn.parts.length === 0) continue;
    if (merged.length > 0 && merged[merged.length - 1].role === turn.role) {
      merged[merged.length - 1].parts.push(...turn.parts);
    } else {
      merged.push({ role: turn.role, parts: [...turn.parts] });
    }
  }

  if (merged.length > 0 && merged[merged.length - 1].role === "model") {
    merged.push({ role: "user", parts: [{ text: "Continue" }] });
  }

  return merged;
}

function cleanParameters(schema) {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  const clone = JSON.parse(JSON.stringify(schema));
  delete clone.$schema;
  return clone;
}

function flattenTools(tools) {
  const decls = [];
  for (const tool of asArray(tools)) {
    if (!tool || typeof tool !== "object") continue;
    // Codex responses: { type: "function"|"custom", name, description, parameters }
    // OpenAI chat: { type: "function", function: { name, description, parameters } }
    const fn = tool.function || tool;
    const name = fn.name || tool.name;
    if (!name) continue;
    if (tool.type === "custom") {
      decls.push({
        name,
        description: tool.description || fn.description || "",
        parameters: {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
          additionalProperties: false,
        },
      });
    } else {
      decls.push({
        name,
        description: tool.description || fn.description || "",
        parameters: cleanParameters(fn.parameters || tool.parameters || { type: "object", properties: {} }),
      });
    }
  }
  // Stable order for prefix caching (AG sorts functionDeclarations by name).
  decls.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return decls;
}

function buildGenerationConfig(codexReq) {
  const gc = {};
  if (codexReq.temperature != null) gc.temperature = codexReq.temperature;
  if (codexReq.max_output_tokens != null) gc.maxOutputTokens = codexReq.max_output_tokens;
  if (codexReq.top_p != null) gc.topP = codexReq.top_p;
  if (codexReq.thinking != null) {
    const budget = typeof codexReq.thinking === "object"
      ? codexReq.thinking.budget_tokens
      : codexReq.thinking;
    if (budget != null) gc.thinkingConfig = { thinkingBudget: budget };
  }
  return gc;
}

function buildSystemInstruction(instructions) {
  const parts = [{ text: ANTIGRAVITY_IDENTITY }];
  const text = typeof instructions === "string" ? instructions.trim() : "";
  if (text) parts.push({ text });
  return { role: "user", parts };
}

// Build the v1internal generateContent/streamGenerateContent request body.
// Outer shape (AG wrapper.rs / openai/request.rs):
//   { project, request, model, userAgent, requestType, requestId, enabledCreditTypes }
// Inner `request` field order (stable prefix -> dynamic contents last):
//   systemInstruction -> tools -> toolConfig -> generationConfig -> sessionId -> contents
export function buildGenerateContentRequest(codexReq, { project, accountId, model }) {
  const rawInput = codexReq.input;
  // Session fingerprint scopes the thoughtSignature cache to this conversation
  // (stable across turns; see signature-cache.mjs). Computed from the raw input
  // so it matches the value the server passes when caching on the response.
  const sessionFp = computeSessionFingerprint(rawInput);
  const input = typeof rawInput === "string"
    ? [{ type: "message", role: "user", content: [{ type: "input_text", text: rawInput }] }]
    : asArray(rawInput);
  const callIdToName = buildCallIdToName(input);
  const contents = buildContents(input, callIdToName, sessionFp);
  const functionDeclarations = flattenTools(codexReq.tools);

  const request = {};
  request.systemInstruction = buildSystemInstruction(codexReq.instructions);
  if (functionDeclarations.length) {
    request.tools = [{ functionDeclarations }];
    request.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
  }
  const gc = buildGenerationConfig(codexReq);
  if (Object.keys(gc).length) request.generationConfig = gc;
  request.sessionId = deriveSessionId(accountId);
  request.contents = contents;

  const sidPrefix = request.sessionId.slice(0, 8);
  const messageCount = Math.max(contents.length, 1);
  const requestId = `agent/antigravity/${sidPrefix}/${messageCount}`;

  return {
    project,
    request,
    model,
    userAgent: "antigravity",
    requestType: "agent",
    requestId,
    enabledCreditTypes: ["GOOGLE_ONE_AI"],
  };
}