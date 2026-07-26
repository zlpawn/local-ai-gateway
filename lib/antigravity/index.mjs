// Antigravity v1internal integration - module entry.
// Phase 1: OAuth + token management + CLI login (login/status).
// Phase 2: session-id + v1internal upstream + minimal request builder.
// Phase 3: full request builder (systemInstruction identity + contents/tools
//          mapping) + response streamer (v1internal SSE -> Codex responses).
// Phase 4+: handleAntigravityResponses (server.js routing + model catalog).
export { handleAntigravityCommand } from "./cli.mjs";
export {
  ensureFreshToken,
  buildAuthUrl,
  exchangeCode,
  refreshToken,
  getUserInfo,
} from "./oauth.mjs";
export {
  loadSecrets,
  saveSecrets,
  getStoredToken,
  getClientCredentials,
  getSecretsPath,
} from "./token-store.mjs";
export { REDIRECT_PORT, redirectUri, SCOPES, V1INTERNAL_BASE_URLS } from "./constants.mjs";
export { deriveSessionId } from "./session-id.mjs";
export {
  loadCodeAssist,
  generateContent,
  streamGenerateContent,
  callV1Internal,
} from "./upstream.mjs";
export { buildGenerateContentRequest } from "./request-builder.mjs";
export { streamResponses } from "./response-streamer.mjs";
export { ANTIGRAVITY_IDENTITY, ANTIGRAVITY_WEB_SEARCH_IDENTITY } from "./system-prompt.mjs";