import { randomUUID } from "node:crypto";

/**
 * Task scheduler with concurrency control, retry, and graceful shutdown.
 *
 * - Polls pending tasks from the store and dispatches to registered handlers.
 * - Concurrency is capped (default 2). Extra tasks wait in pending state.
 * - Failed tasks are retried up to maxRetries with exponential backoff.
 * - On shutdown, running tasks are aborted; on restart, 'running' tasks are
 *   reset to 'pending' by store.recoverRunning() for re-execution.
 */
export function createTaskQueue({ store, registry, concurrency = 2, maxRetries = 1, retryBackoffMs = 2000 } = {}) {
  let running = 0;
  let pollTimer = null;
  let shuttingDown = false;
  const activeControllers = new Map(); // taskId -> AbortController

  function schedulePoll() {
    if (shuttingDown) return;
    if (pollTimer) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      tick().catch((err) => {
        console.error("[task-queue] tick error:", err);
        tick().catch((err) => { console.error("[task-queue] initial tick error:", err); schedulePoll(); });
      });
    }, 500);
  }

  async function tick() {
    if (shuttingDown) return;
    while (running < concurrency) {
      const task = store.claimPending();
      if (!task) break;
      if (store.isCancelRequested(task.id)) {
        store.finalizeCancelled(task.id);
        continue;
      }
      running++;
      // Fire and forget - each task runs independently
      executeTask(task).finally(() => {
        running--;
        tick().catch((err) => { console.error("[task-queue] initial tick error:", err); schedulePoll(); });
      });
    }
  }

  async function executeTask(task) {
    const handler = registry.get(task.type);
    if (!handler) {
      store.setFailed(task.id, `No handler registered for task type '${task.type}'`);
      return;
    }

    // Check cancel before starting
    if (store.isCancelRequested(task.id)) {
      store.finalizeCancelled(task.id);
      return;
    }

    store.setRunning(task.id);
    const controller = new AbortController();
    activeControllers.set(task.id, controller);

    // Periodically check for cancel requests and abort the controller
    const cancelChecker = setInterval(() => {
      if (store.isCancelRequested(task.id)) {
        controller.abort();
        clearInterval(cancelChecker);
      }
    }, 1000);

    const onProgress = (fraction, message) => {
      if (fraction < 0) fraction = 0;
      if (fraction > 1) fraction = 1;
      store.updateProgress(task.id, fraction, message || "");
    };
    const onSteps = (steps, currentStepId) => {
      store.updateSteps(task.id, steps, currentStepId);
    };

    try {
      const result = await handler.run(task.payload, {
        signal: controller.signal,
        onProgress,
        onSteps,
        store,
        taskId: task.id,
      });
      clearInterval(cancelChecker);
      if (store.isCancelRequested(task.id)) {
        store.finalizeCancelled(task.id);
      } else {
        store.setResult(task.id, result);
      }
    } catch (err) {
      clearInterval(cancelChecker);
      if (controller.signal.aborted || store.isCancelRequested(task.id)) {
        store.finalizeCancelled(task.id);
        return;
      }
      // Retry logic
      const current = store.get(task.id);
      if (current && current.retries < maxRetries) {
        await sleep(retryBackoffMs * Math.pow(2, current.retries));
        if (shuttingDown || store.isCancelRequested(task.id)) {
          store.finalizeCancelled(task.id);
          return;
        }
        // Increment retry count by re-inserting as pending
        // (store doesn't have a direct increment, so we update via raw approach)
        store.updateProgress(task.id, 0, `retrying (${current.retries + 1}/${maxRetries})`);
        // Re-run the task
        activeControllers.delete(task.id);
        executeTask({ ...current, retries: current.retries + 1 });
        return;
      }
      store.setFailed(task.id, err);
    } finally {
      activeControllers.delete(task.id);
    }
  }

  function submit(type, payload) {
    const id = randomUUID();
    const handler = registry.get(type);
    // Pre-validate if handler provides validate()
    if (handler?.validate) {
      const issues = handler.validate(payload);
      if (issues && issues.length) {
        throw new Error(`Validation failed: ${issues.join("; ")}`);
      }
    }
    store.insert(id, type, payload, handler?.steps?.(payload) || []);
    tick().catch((err) => { console.error("[task-queue] initial tick error:", err); schedulePoll(); });
    return id;
  }

  function get(id) { return store.get(id); }
  function list(filter) { return store.list(filter); }

  function cancel(id) {
    const task = store.get(id);
    if (!task) return false;
    store.cancelPending(id);
    return true;
  }

  function deleteTask(id) { return store.delete(id); }

  function start() {
    store.recoverRunning();
    tick().catch((err) => { console.error("[task-queue] initial tick error:", err); schedulePoll(); });
  }

  async function shutdown() {
    shuttingDown = true;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    // Abort all active tasks
    for (const controller of activeControllers.values()) {
      controller.abort();
    }
    // Wait briefly for tasks to notice abort
    const deadline = Date.now() + 5000;
    while (activeControllers.size > 0 && Date.now() < deadline) {
      await sleep(100);
    }
  }

  return { submit, get, list, cancel, deleteTask, start, shutdown, schedulePoll };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
