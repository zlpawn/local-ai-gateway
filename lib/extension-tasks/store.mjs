import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Persistent store for extension-claimed tasks.
 *
 * Lifecycle: queued -> running -> succeeded | failed
 * Separate from lib/task-queue (server-executed jobs).
 */
export function createExtensionTaskStore({
  dataDir,
  now = () => Date.now(),
  ttlMs = 90_000,
  maxTasks = 200,
} = {}) {
  if (!dataDir) throw new Error("createExtensionTaskStore requires dataDir");
  const filePath = path.join(dataDir, "extension-tasks.json");
  let cache = null;

  function load() {
    if (cache) return cache;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      cache = Array.isArray(raw) ? raw : [];
    } catch {
      cache = [];
    }
    return cache;
  }

  function flush() {
    const data = load();
    if (data.length > maxTasks) {
      data.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      data.length = maxTasks;
    }
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, filePath);
  }

  function iso(ms = now()) {
    return new Date(ms).toISOString();
  }

  function clone(task) {
    return task ? { ...task, payload: task.payload ? { ...task.payload } : {}, result: task.result ? { ...task.result } : null, error: task.error ? { ...task.error } : null } : null;
  }

  function expireDue() {
    const data = load();
    const current = now();
    let changed = false;
    for (const task of data) {
      if ((task.status === "queued" || task.status === "running") && Date.parse(task.expires_at) <= current) {
        task.status = "failed";
        task.error = { type: "timeout", message: "Task expired before completion." };
        task.finished_at = iso(current);
        task.updated_at = iso(current);
        changed = true;
      }
    }
    if (changed) flush();
  }

  function create({ type, capability, payload = {}, dedupeKey = null } = {}) {
    if (!type) throw new Error("type is required");
    if (!capability) throw new Error("capability is required");
    expireDue();
    const data = load();
    if (dedupeKey) {
      const existing = data.find(
        (t) => t.dedupe_key === dedupeKey && (t.status === "queued" || t.status === "running"),
      );
      if (existing) return clone(existing);
    }
    const createdMs = now();
    const task = {
      id: `etsk_${randomUUID().replaceAll("-", "")}`,
      type: String(type),
      capability: String(capability),
      status: "queued",
      payload: payload && typeof payload === "object" ? { ...payload } : {},
      result: null,
      error: null,
      claimed_by: null,
      dedupe_key: dedupeKey ? String(dedupeKey) : null,
      created_at: iso(createdMs),
      updated_at: iso(createdMs),
      started_at: null,
      finished_at: null,
      expires_at: iso(createdMs + ttlMs),
    };
    data.push(task);
    flush();
    return clone(task);
  }

  function get(id) {
    expireDue();
    return clone(load().find((t) => t.id === id) || null);
  }

  function list({ status, type, limit } = {}) {
    expireDue();
    let rows = load().slice();
    if (status) rows = rows.filter((t) => t.status === status);
    if (type) rows = rows.filter((t) => t.type === type);
    rows.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    if (Number.isFinite(limit) && limit >= 0) rows = rows.slice(0, limit);
    return rows.map(clone);
  }

  function claim({ extensionId, capabilities = [], limit = 1 } = {}) {
    if (!extensionId) throw new Error("extensionId is required");
    expireDue();
    const caps = new Set((capabilities || []).map(String));
    const data = load();
    const claimed = [];
    const current = now();
    // oldest first
    const candidates = data
      .filter((t) => t.status === "queued" && caps.has(t.capability))
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    for (const task of candidates) {
      if (claimed.length >= limit) break;
      task.status = "running";
      task.claimed_by = String(extensionId);
      task.started_at = iso(current);
      task.updated_at = iso(current);
      claimed.push(clone(task));
    }
    if (claimed.length) flush();
    return claimed;
  }

  function complete(id, { extensionId, result } = {}) {
    expireDue();
    const data = load();
    const task = data.find((t) => t.id === id);
    if (!task) throw new Error("not_found");
    if (task.status !== "running" || task.claimed_by !== extensionId) {
      const err = new Error("conflict");
      err.code = "conflict";
      throw err;
    }
    const current = now();
    task.status = "succeeded";
    task.result = result && typeof result === "object" ? { ...result } : result ?? null;
    task.error = null;
    task.finished_at = iso(current);
    task.updated_at = iso(current);
    flush();
    return clone(task);
  }

  function fail(id, { extensionId, error } = {}) {
    expireDue();
    const data = load();
    const task = data.find((t) => t.id === id);
    if (!task) throw new Error("not_found");
    if (task.status === "succeeded" || task.status === "failed") {
      const err = new Error("conflict");
      err.code = "conflict";
      throw err;
    }
    // Only the claiming extension may fail a running task.
    // Queued tasks may be failed without owner (timeout/admin), but an
    // extension_id caller must not fail tasks it does not own.
    if (extensionId) {
      if (task.status !== "running" || task.claimed_by !== extensionId) {
        const err = new Error("conflict");
        err.code = "conflict";
        throw err;
      }
    }
    const current = now();
    task.status = "failed";
    task.error = {
      type: String(error?.type || "extension_error"),
      message: String(error?.message || "Task failed"),
    };
    task.finished_at = iso(current);
    task.updated_at = iso(current);
    flush();
    return clone(task);
  }

  return { create, get, list, claim, complete, fail, expireDue };
}
