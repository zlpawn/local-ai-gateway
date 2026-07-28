import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours (matches AG-Manager SIGNATURE_TTL)
const MIN_LENGTH = 50; // skip short/partial signatures (matches AG-Manager)
const SESSION_LIMIT = 1000; // max tracked sessions (matches AG-Manager SESSION_CACHE_LIMIT)
const PER_SESSION_LIMIT = 64; // call_ids per session cap

// sessionFp -> Map(call_id -> { sig, ts })
const sessions = new Map();
let loadedFromDisk = false;
let persistTimer = null;

export function getStoragePath(env = process.env) {
  if (env.ANTIGRAVITY_SIGNATURES_FILE) {
    return env.ANTIGRAVITY_SIGNATURES_FILE;
  }
  if (env.GATEWAY_CONFIG_FILE) {
    return join(dirname(env.GATEWAY_CONFIG_FILE), "antigravity-signatures.json");
  }
  if (env.GATEWAY_DATA_DIR) {
    return join(env.GATEWAY_DATA_DIR, "antigravity-signatures.json");
  }

  // Check if running from source repository (has .git in cwd)
  const cwd = process.cwd();
  const isSourceRepo = existsSync(join(cwd, ".git"));
  if (isSourceRepo) {
    return join(cwd, "antigravity-signatures.json");
  }

  return join(homedir(), ".local-ai-gateway", "antigravity-signatures.json");
}


function loadFromDisk() {
  if (loadedFromDisk) return;
  loadedFromDisk = true;
  try {
    const filePath = getStoragePath();
    if (!existsSync(filePath)) return;
    const raw = readFileSync(filePath, "utf8");
    const json = JSON.parse(raw);
    if (!json || typeof json !== "object") return;
    const now = Date.now();
    for (const [fp, items] of Object.entries(json)) {
      if (!items || typeof items !== "object") continue;
      let session = sessions.get(fp);
      for (const [callId, val] of Object.entries(items)) {
        if (!val || typeof val.sig !== "string" || typeof val.ts !== "number") continue;
        if (now - val.ts > TTL_MS) continue; // expired
        if (!session) {
          session = new Map();
          sessions.set(fp, session);
        }
        session.set(callId, { sig: val.sig, ts: val.ts });
      }
    }
  } catch {
    // Ignore read/parse errors silently
  }
}

export function saveSignaturesToDisk() {
  try {
    const filePath = getStoragePath();
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const now = Date.now();
    const obj = {};
    for (const [fp, session] of sessions) {
      const activeItems = {};
      for (const [callId, val] of session) {
        if (now - val.ts <= TTL_MS) {
          activeItems[callId] = val;
        }
      }
      if (Object.keys(activeItems).length > 0) {
        obj[fp] = activeItems;
      }
    }
    writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
  } catch {
    // Ignore write errors silently
  }
}

function scheduleSaveToDisk() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    saveSignaturesToDisk();
  }, 200);
  if (typeof persistTimer.unref === "function") {
    persistTimer.unref();
  }
}

function getTextFromContent(content) {
  if (typeof content === "string" && content.trim() !== "") return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((c) => c && typeof c === "object" &&
        (c.type === "input_text" || c.type === "output_text" || c.type === "text"))
      .map((c) => c.text)
      .filter((t) => typeof t === "string" && t.trim() !== "");
    if (texts.length) return texts.join("");
  }
  return null;
}

// Extract the text of the first message item from a Codex /v1/responses input.
// Prefers the first 'user' role message for maximum stability across turns.
function extractFirstMessageText(input) {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return null;

  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const isUser = (item.type === "message" || item.type == null) && item.role === "user";
    if (!isUser) continue;
    const text = getTextFromContent(item.content);
    if (text) return text;
  }

  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const isMessage = item.type === "message" ||
      (item.type == null && (item.role === "assistant" || item.role === "system" || item.role === "developer"));
    if (!isMessage) continue;
    const text = getTextFromContent(item.content);
    if (text) return text;
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
  loadFromDisk();
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
  scheduleSaveToDisk();
}

// Retrieve a cached thoughtSignature for (sessionFp, callId), or null if
// absent / expired. Scoped to the session: a call_id cached under a different
// session fingerprint is invisible unless looking up from _default fallback.
export function getSignature(sessionFp, callId) {
  loadFromDisk();
  if (!callId) return null;
  const cid = String(callId);
  const now = Date.now();

  // 1. Primary lookup under requested sessionFp
  const fp = sessionFp || "_default";
  const session = sessions.get(fp);
  if (session) {
    const entry = session.get(cid);
    if (entry) {
      if (now - entry.ts <= TTL_MS) {
        return entry.sig;
      }
      session.delete(cid);
      if (session.size === 0) sessions.delete(fp);
    }
  }

  // 2. Secondary fallback lookup under _default session if requested under specific fp
  if (fp !== "_default") {
    const defaultSession = sessions.get("_default");
    if (defaultSession) {
      const entry = defaultSession.get(cid);
      if (entry) {
        if (now - entry.ts <= TTL_MS) {
          return entry.sig;
        }
        defaultSession.delete(cid);
        if (defaultSession.size === 0) sessions.delete("_default");
      }
    }
  }

  return null;
}

// Test-only helpers.
export function _clearSignatureCache() {
  sessions.clear();
  loadedFromDisk = true;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}

export function _reloadSignaturesFromDisk() {
  loadedFromDisk = false;
  loadFromDisk();
}

export function _signatureCacheSize() {
  let total = 0;
  for (const session of sessions.values()) total += session.size;
  return total;
}

export function _sessionCount() {
  return sessions.size;
}


