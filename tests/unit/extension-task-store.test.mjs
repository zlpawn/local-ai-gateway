import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createExtensionTaskStore } from "../../lib/extension-tasks/store.mjs";

function tmpStore(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-tasks-"));
  let now = opts.nowMs ?? Date.now();
  const store = createExtensionTaskStore({
    dataDir,
    ttlMs: opts.ttlMs ?? 90_000,
    maxTasks: opts.maxTasks ?? 200,
    now: () => now,
  });
  return {
    store,
    dataDir,
    setNow(ms) { now = ms; },
    cleanup() { fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

test("create returns queued task with expires_at", () => {
  const t = tmpStore({ nowMs: 1_000_000 });
  const task = t.store.create({ type: "cookies.export", capability: "cookies", payload: { domain: "bilibili.com" } });
  assert.equal(task.status, "queued");
  assert.ok(task.id.startsWith("etsk_"));
  assert.equal(task.payload.domain, "bilibili.com");
  assert.equal(task.expires_at, new Date(1_000_000 + 90_000).toISOString());
  t.cleanup();
});

test("dedupe returns existing active task", () => {
  const t = tmpStore();
  const a = t.store.create({ type: "cookies.export", capability: "cookies", payload: { domain: "x.com" }, dedupeKey: "cookies.export:x.com" });
  const b = t.store.create({ type: "cookies.export", capability: "cookies", payload: { domain: "x.com" }, dedupeKey: "cookies.export:x.com" });
  assert.equal(a.id, b.id);
  assert.equal(t.store.list().length, 1);
  t.cleanup();
});

test("claim moves queued to running and filters by capability", () => {
  const t = tmpStore();
  t.store.create({ type: "cookies.export", capability: "cookies", payload: { domain: "a.com" } });
  t.store.create({ type: "other", capability: "tabs", payload: {} });
  const claimed = t.store.claim({ extensionId: "ext1", capabilities: ["cookies"], limit: 1 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].status, "running");
  assert.equal(claimed[0].claimed_by, "ext1");
  assert.equal(t.store.claim({ extensionId: "ext1", capabilities: ["cookies"], limit: 1 }).length, 0);
  t.cleanup();
});

test("complete and fail enforce owner and status", () => {
  const t = tmpStore();
  const task = t.store.create({ type: "cookies.export", capability: "cookies", payload: { domain: "a.com" } });
  t.store.claim({ extensionId: "ext1", capabilities: ["cookies"], limit: 1 });
  assert.throws(() => t.store.complete(task.id, { extensionId: "other", result: { ok: true } }));
  const done = t.store.complete(task.id, { extensionId: "ext1", result: { file_path: "/tmp/c.txt", count: 1, domains: [".a.com"] } });
  assert.equal(done.status, "succeeded");
  assert.equal(done.result.count, 1);

  const task2 = t.store.create({ type: "cookies.export", capability: "cookies", payload: { domain: "b.com" }, dedupeKey: "b" });
  t.store.claim({ extensionId: "ext1", capabilities: ["cookies"], limit: 1 });
  const failed = t.store.fail(task2.id, { extensionId: "ext1", error: { type: "no_cookies", message: "none" } });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.type, "no_cookies");
  t.cleanup();
});

test("expireDue marks timed out queued/running as failed", () => {
  const t = tmpStore({ nowMs: 0, ttlMs: 1000 });
  const task = t.store.create({ type: "cookies.export", capability: "cookies", payload: { domain: "a.com" } });
  t.setNow(2000);
  t.store.expireDue();
  const got = t.store.get(task.id);
  assert.equal(got.status, "failed");
  assert.equal(got.error.type, "timeout");
  t.cleanup();
});

test("persists across store instances", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-tasks-"));
  const s1 = createExtensionTaskStore({ dataDir });
  const task = s1.create({ type: "cookies.export", capability: "cookies", payload: { domain: "z.com" } });
  const s2 = createExtensionTaskStore({ dataDir });
  assert.equal(s2.get(task.id)?.payload.domain, "z.com");
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("fail rejects non-owner running task", () => {
  const t = tmpStore();
  const task = t.store.create({ type: "cookies.export", capability: "cookies", payload: { domain: "a.com" } });
  t.store.claim({ extensionId: "ext1", capabilities: ["cookies"], limit: 1 });
  assert.throws(() => t.store.fail(task.id, { extensionId: "ext2", error: { type: "x", message: "nope" } }));
  const still = t.store.get(task.id);
  assert.equal(still.status, "running");
  t.cleanup();
});

test("fail rejects extension failing queued task it does not own", () => {
  const t = tmpStore();
  const task = t.store.create({ type: "cookies.export", capability: "cookies", payload: { domain: "a.com" } });
  assert.throws(() => t.store.fail(task.id, { extensionId: "ext1", error: { type: "x", message: "nope" } }));
  assert.equal(t.store.get(task.id).status, "queued");
  // system/timeout path without extensionId still allowed
  const failed = t.store.fail(task.id, { error: { type: "timeout", message: "expired" } });
  assert.equal(failed.status, "failed");
  t.cleanup();
});
