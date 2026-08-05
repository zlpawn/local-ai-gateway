import { test } from "node:test";
import assert from "node:assert/strict";
import { createExtensionStore } from "../../lib/extension-registry/store.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

test("register upserts and returns online extension", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ext-store-"));
  const store = createExtensionStore({ dataDir: tmp });
  const ext = store.register({ id: "abc123", name: "Test", version: "1.0.0", capabilities: ["cookies"], permissions: ["cookies"] });
  assert.equal(ext.id, "abc123");
  assert.equal(ext.online, true);
  assert.ok(ext.last_seen);
  assert.ok(ext.registered_at);
  const ext2 = store.register({ id: "abc123", name: "Test", version: "1.1.0", capabilities: ["cookies"], permissions: ["cookies"] });
  assert.equal(ext2.version, "1.1.0");
  assert.equal(store.list().length, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("heartbeat updates last_seen and isOnline", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ext-store-"));
  const store = createExtensionStore({ dataDir: tmp });
  store.register({ id: "ext1", name: "T", version: "1", capabilities: ["cookies"], permissions: [] });
  assert.equal(store.isOnline("ext1"), true);
  const updated = store.heartbeat("ext1");
  assert.ok(updated);
  assert.equal(store.isOnline("ext1"), true);
  assert.equal(store.isOnline("nonexistent"), false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("remove deletes extension", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ext-store-"));
  const store = createExtensionStore({ dataDir: tmp });
  store.register({ id: "ext2", name: "T", version: "1", capabilities: [], permissions: [] });
  store.remove("ext2");
  assert.equal(store.list().length, 0);
  assert.equal(store.get("ext2"), null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("list computes online status at call time", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ext-store-"));
  const store = createExtensionStore({ dataDir: tmp });
  store.register({ id: "ext3", name: "T", version: "1", capabilities: ["cookies"], permissions: [] });
  const list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].online, true);
  assert.ok(list[0].capabilities.includes("cookies"));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("persists across store instances", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ext-store-"));
  const s1 = createExtensionStore({ dataDir: tmp });
  s1.register({ id: "persist1", name: "T", version: "1", capabilities: [], permissions: [] });
  const s2 = createExtensionStore({ dataDir: tmp });
  assert.equal(s2.get("persist1")?.id, "persist1");
  fs.rmSync(tmp, { recursive: true, force: true });
});