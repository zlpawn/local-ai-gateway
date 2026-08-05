import fs from "node:fs";
import path from "node:path";

const ONLINE_THRESHOLD_MS = 90_000;

/**
 * Persistent store for registered browser extensions.
 *
 * - Keyed by extension id (chrome.runtime.id).
 * - Each record is tagged with a capabilities array so future extension
 *   types register without store changes (open/closed).
 * - Online status is derived from last_seen at call time, not stored.
 * - Atomic write via temp-file + rename.
 */
export function createExtensionStore({ dataDir }) {
  const filePath = path.join(dataDir, "extensions.json");
  let cache = null;

  function load() {
    if (cache) return cache;
    try {
      cache = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!Array.isArray(cache)) cache = [];
    } catch {
      cache = [];
    }
    return cache;
  }

  function flush() {
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(load(), null, 2), "utf8");
    fs.renameSync(tmp, filePath);
  }

  function computeOnline(rec) {
    return Date.now() - new Date(rec.last_seen).getTime() < ONLINE_THRESHOLD_MS;
  }

  function register({ id, name, version, capabilities, permissions }) {
    const data = load();
    const now = new Date().toISOString();
    const existing = data.find((e) => e.id === id);
    const rec = {
      id,
      name: name || "Unknown Extension",
      version: version || "0.0.0",
      capabilities: Array.isArray(capabilities) ? capabilities : [],
      permissions: Array.isArray(permissions) ? permissions : [],
      registered_at: existing?.registered_at || now,
      last_seen: now,
    };
    const idx = data.findIndex((e) => e.id === id);
    if (idx >= 0) data[idx] = rec;
    else data.push(rec);
    flush();
    return { ...rec, online: true };
  }

  function heartbeat(id) {
    const data = load();
    const rec = data.find((e) => e.id === id);
    if (!rec) return null;
    rec.last_seen = new Date().toISOString();
    flush();
    return { ...rec, online: true };
  }

  function list() {
    return load().map((rec) => ({ ...rec, online: computeOnline(rec) }));
  }

  function get(id) {
    const rec = load().find((e) => e.id === id);
    return rec ? { ...rec, online: computeOnline(rec) } : null;
  }

  function remove(id) {
    const data = load();
    const idx = data.findIndex((e) => e.id === id);
    if (idx >= 0) {
      data.splice(idx, 1);
      flush();
    }
  }

  function isOnline(id) {
    const rec = load().find((e) => e.id === id);
    return rec ? computeOnline(rec) : false;
  }

  return { register, heartbeat, list, get, remove, isOnline };
}