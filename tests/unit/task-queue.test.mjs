import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTaskStore } from "../../lib/task-queue/store.mjs";
import { createHandlerRegistry } from "../../lib/task-queue/handler-registry.mjs";
import { createTaskQueue } from "../../lib/task-queue/queue.mjs";

function tmpDb() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "taskq-"));
  return { dir, dbPath: path.join(dir, "test.db") };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(queue, id, targetStatus, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = queue.get(id);
    if (task && task.status === targetStatus) return;
    if (task && ["succeeded", "failed", "cancelled"].includes(task.status) && task.status !== targetStatus) {
      assert.fail(`expected ${targetStatus} but got ${task.status}: ${task.error || ""}`);
    }
    await sleep(30);
  }
  const task = queue.get(id);
  assert.fail(`timeout waiting for ${targetStatus}, got ${task?.status} (progress=${task?.progress})`);
}

test("store: insert and get a pending task", () => {
  const { dir, dbPath } = tmpDb();
  try {
    const store = createTaskStore({ dbPath });
    store.insert("t1", "test_type", { foo: "bar" }, [{ id: "s1", label: "step1" }]);
    const task = store.get("t1");
    assert.ok(task);
    assert.equal(task.status, "pending");
    assert.equal(task.type, "test_type");
    assert.deepEqual(task.payload, { foo: "bar" });
    assert.equal(task.steps.length, 1);
    assert.equal(task.steps[0].id, "s1");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("store: progress and steps update correctly", () => {
  const { dir, dbPath } = tmpDb();
  try {
    const store = createTaskStore({ dbPath });
    store.insert("t2", "test", {});
    store.setRunning("t2");
    store.updateProgress("t2", 0.5, "halfway");
    store.updateSteps("t2", [{ id: "s1", label: "a", status: "done" }, { id: "s2", label: "b", status: "running" }], "s2");
    const task = store.get("t2");
    assert.equal(task.status, "running");
    assert.equal(task.progress, 0.5);
    assert.equal(task.progress_message, "halfway");
    assert.equal(task.steps.length, 2);
    assert.equal(task.current_step, "s2");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("store: succeed and fail transitions", () => {
  const { dir, dbPath } = tmpDb();
  try {
    const store = createTaskStore({ dbPath });
    store.insert("t3", "test", {});
    store.setRunning("t3");
    store.setResult("t3", { output: "done" });
    assert.equal(store.get("t3").status, "succeeded");
    assert.deepEqual(store.get("t3").result, { output: "done" });

    store.insert("t4", "test", {});
    store.setRunning("t4");
    store.setFailed("t4", new Error("boom"));
    assert.equal(store.get("t4").status, "failed");
    assert.equal(store.get("t4").error, "boom");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("store: cancel pending task immediately", () => {
  const { dir, dbPath } = tmpDb();
  try {
    const store = createTaskStore({ dbPath });
    store.insert("t5", "test", {});
    const ok = store.cancelPending("t5");
    assert.ok(ok);
    assert.equal(store.get("t5").status, "cancelled");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("store: recoverRunning resets running to pending", () => {
  const { dir, dbPath } = tmpDb();
  try {
    const store = createTaskStore({ dbPath });
    store.insert("t6", "test", {});
    store.setRunning("t6");
    assert.equal(store.get("t6").status, "running");
    store.recoverRunning();
    assert.equal(store.get("t6").status, "pending");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("store: delete only allows terminal states", () => {
  const { dir, dbPath } = tmpDb();
  try {
    const store = createTaskStore({ dbPath });
    store.insert("t7", "test", {});
    assert.equal(store.delete("t7"), false);
    store.setResult("t7", {});
    assert.equal(store.delete("t7"), true);
    assert.equal(store.get("t7"), null);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("queue: submit executes task and returns result", async () => {
  const { dir, dbPath } = tmpDb();
  try {
    const store = createTaskStore({ dbPath });
    const registry = createHandlerRegistry();
    registry.register("echo", {
      async run(payload, { onProgress }) {
        onProgress(0.5, "half");
        return { echoed: payload.value };
      },
    });
    const queue = createTaskQueue({ store, registry, concurrency: 1 });
    queue.start();
    const id = queue.submit("echo", { value: 42 });
    await waitFor(queue, id, "succeeded", 3000);
    const task = queue.get(id);
    assert.equal(task.status, "succeeded");
    assert.deepEqual(task.result, { echoed: 42 });
    assert.equal(task.progress, 1.0);
    await queue.shutdown();
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("queue: missing handler returns failed task", async () => {
  const { dir, dbPath } = tmpDb();
  try {
    const store = createTaskStore({ dbPath });
    const registry = createHandlerRegistry();
    const queue = createTaskQueue({ store, registry, concurrency: 1 });
    queue.start();
    const id = queue.submit("nonexistent", {});
    await waitFor(queue, id, "failed", 3000);
    const task = queue.get(id);
    assert.equal(task.status, "failed");
    assert.match(task.error, /No handler registered/);
    await queue.shutdown();
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("queue: handler can report steps", async () => {
  const { dir, dbPath } = tmpDb();
  try {
    const store = createTaskStore({ dbPath });
    const registry = createHandlerRegistry();
    registry.register("stepped", {
      steps: () => [{ id: "a", label: "Step A", status: "pending" }, { id: "b", label: "Step B", status: "pending" }],
      async run(payload, { onProgress, onSteps, signal }) {
        const steps = [{ id: "a", label: "Step A", status: "running" }, { id: "b", label: "Step B", status: "pending" }];
        onSteps(steps, "a");
        onProgress(0.3, "doing A");
        await sleep(50);
        steps[0].status = "done";
        steps[1].status = "running";
        onSteps(steps, "b");
        onProgress(0.7, "doing B");
        await sleep(50);
        steps[1].status = "done";
        onSteps(steps, null);
        return { ok: true };
      },
    });
    const queue = createTaskQueue({ store, registry, concurrency: 1 });
    queue.start();
    const id = queue.submit("stepped", {});
    await waitFor(queue, id, "succeeded", 3000);
    const task = queue.get(id);
    assert.equal(task.status, "succeeded");
    assert.equal(task.steps.length, 2);
    assert.equal(task.steps[0].status, "done");
    assert.equal(task.steps[1].status, "done");
    await queue.shutdown();
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("queue: cancel running task aborts handler", async () => {
  const { dir, dbPath } = tmpDb();
  try {
    const store = createTaskStore({ dbPath });
    const registry = createHandlerRegistry();
    let aborted = false;
    registry.register("slow", {
      async run(payload, { signal, onProgress }) {
        onProgress(0.1, "started");
        for (let i = 0; i < 100; i++) {
          if (signal.aborted) { aborted = true; throw new Error("aborted"); }
          await sleep(30);
        }
        return {};
      },
    });
    const queue = createTaskQueue({ store, registry, concurrency: 1 });
    queue.start();
    const id = queue.submit("slow", {});
    await waitFor(queue, id, "running", 2000);
    queue.cancel(id);
    await waitFor(queue, id, "cancelled", 5000);
    assert.equal(queue.get(id).status, "cancelled");
    assert.ok(aborted, "handler should have observed abort");
    await queue.shutdown();
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("queue: concurrency limit queues extra tasks", async () => {
  const { dir, dbPath } = tmpDb();
  try {
    const store = createTaskStore({ dbPath });
    const registry = createHandlerRegistry();
    const order = [];
    registry.register("tracked", {
      async run(payload, { onProgress }) {
        order.push(`start:${payload.idx}`);
        await sleep(200);
        order.push(`end:${payload.idx}`);
        return {};
      },
    });
    const queue = createTaskQueue({ store, registry, concurrency: 2 });
    queue.start();
    const id1 = queue.submit("tracked", { idx: 1 });
    const id2 = queue.submit("tracked", { idx: 2 });
    const id3 = queue.submit("tracked", { idx: 3 });
    // With concurrency 2, first two start, third waits until one finishes
    await sleep(100);
    assert.ok(order.includes("start:1"), "task 1 should have started");
    assert.ok(order.includes("start:2"), "task 2 should have started");
    assert.ok(!order.includes("start:3"), "task 3 should still be queued");
    await waitFor(queue, id1, "succeeded", 5000);
    await waitFor(queue, id2, "succeeded", 5000);
    await waitFor(queue, id3, "succeeded", 5000);
    assert.ok(order.includes("start:3"), "task 3 should start after a slot frees");
    await queue.shutdown();
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
