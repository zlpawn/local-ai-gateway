// Phase 2 minimal request builder: single-turn text, no tools, no antigravity
// identity systemInstruction yet. Phase 3 will add the full mapping
// (instructions->systemInstruction+identity, input[]->contents, tools->functionDeclarations).
import crypto from "node:crypto";
import { deriveSessionId } from "./session-id.mjs";
import { UPSTREAM_USER_AGENT } from "./upstream.mjs";

export function buildMinimalGenerateContentRequest({ prompt, project, accountId }) {
  return {
    request: {
      contents: [{ role: "user", parts: [{ text: String(prompt) }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
    },
    project,
    sessionId: deriveSessionId(accountId),
    userAgent: UPSTREAM_USER_AGENT,
    requestId: crypto.randomUUID(),
  };
}