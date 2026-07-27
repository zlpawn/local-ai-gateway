// Two-layer in-memory cache: sessionFingerprint -> call_id -> thoughtSignature.
// Mirrors AG-Manager signature_cache.rs Layer 3 (session_signatures), scoped by
// conversation so signatures from one conversation can never leak into another.
//
// Why session scoping: Google's v1internal backend requires every functionCall
// part in conversation history to carry the EXACT thoughtSignature the model
// returned alongside it. The Codex /v1/responses protocol does NOT carry it, so
// the gateway captures it from the model response and re-injects it on the next
// turn. Without it the backend rejects with gRPC status=3 "Function call is
// missing a thought_signature". A wrong signature yields "Corrupted thought
// signature" - so the cache must never return a signature from a different
// conversation. Scoping by session fingerprint (in addition to call_id) makes a
// cross-conversation collision require BOTH a matching first message AND a
// matching 8-char model-generated call_id - effectively impossible.
//
// Session fingerprint: SHA-256 of the first user message text, stable across
// turns of one conversation (turn 2 only APPENDS to the history; the first
// message is unchanged). Computed identically by request-builder (lookup) and
// by the server (caching), both from the same request `input`.

import { createHash } from "node:crypto";

const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours (matches AG-Manager SIGNATURE_TTL)
const MIN_LENGTH = 50; // skip short/partial signatures (matches AG-Manager)
const SESSION_LIMIT = 1000; // max tracked sessions (matches AG-Manager SESSION_CACHE_LIMIT)
const PER_SESSION_LIMIT = 64; // call_ids per session cap

// sessionFp -> Map(call_id -> { sig, ts })
const sessions = new Map();

// Extract the text of the first message item from a Codex /v1/responses input.
// Stable across turns (the first message never changes; later turns only append).
function extractFirstMessageText(input) {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return null;
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const isMessage = item.type === "message" ||
      (item.type == null && (item.role === "user" || item.role === "assistant" ||
        item.role === "system" || item.role === "developer"));
    if (!isMessage) continue;
    const content = item.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const texts = content
        .filter((c) => c && typeof c === "object" &&
          (c.type === "input_text" || c.type === "output_text" || c.type === "text"))
        .map((c) => c.text)
        .filter((t) => typeof t === "string" && t.length > 0);
      if (texts.length) return texts.join("");
    }
  }
  return null;
}

// Derive a stable per-conversation fingerprint from the request input.
// Returns "_default" when no message text is available (degrades to a shared
// bucket, still correct within a single conversation).
export function computeSessionFingerprint(input) {
  const text = extractFirstMessageText(input);
  if (!text) return "_default";
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function evictSession(sessionFp) {
  const session = sessions.get(sessionFp);
  if (!session) return;
  const now = Date.now();
  for (const [k, v] of session) {
    if (now - v.ts > TTL_MS) session.delete(k);
  }
  if (session.size === 0) sessions.delete(sessionFp);
}

function evictExpiredSessions() {
  const now = Date.now();
  for (const [fp, session] of sessions) {
    let alive = false;
    for (const [, v] of session) {
      if (now - v.ts <= TTL_MS) { alive = true; break; }
    }
    if (!alive) sessions.delete(fp);
  }
}

// Store a thoughtSignature for (sessionFp, callId).
// No-ops on missing id or signatures shorter than MIN_LENGTH.
export function cacheSignature(sessionFp, callId, signature) {
  if (!callId || typeof signature !== "string" || signature.length < MIN_LENGTH) return;
  const fp = sessionFp || "_default";
  let session = sessions.get(fp);
  if (!session) {
    session = new Map();
    sessions.set(fp, session);
  }
  session.set(String(callId), { sig: signature, ts: Date.now() });
  if (session.size > PER_SESSION_LIMIT) evictSession(fp);
  if (sessions.size > SESSION_LIMIT) evictExpiredSessions();
}

// Retrieve a cached thoughtSignature for (sessionFp, callId), or null if
// absent / expired. Scoped to the session: a call_id cached under a different
// session fingerprint is invisible here.
export function getSignature(sessionFp, callId) {
  if (!callId) return null;
  const session = sessions.get(sessionFp || "_default");
  if (!session) return null;
  const entry = session.get(String(callId));
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) {
    session.delete(String(callId));
    if (session.size === 0) sessions.delete(sessionFp || "_default");
    return null;
  }
  return entry.sig;
}

// Test-only helpers.
export function _clearSignatureCache() {
  sessions.clear();
}

export function _signatureCacheSize() {
  let total = 0;
  for (const session of sessions.values()) total += session.size;
  return total;
}

export function _sessionCount() {
  return sessions.size;
}
