import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

/**
 * SQLite-backed persistent store for background tasks.
 * Mirrors the WAL + node:sqlite pattern used by lib/analytics/db.mjs.
 *
 * Task lifecycle: pending -> running -> succeeded | failed | cancelled
 */
export function createTaskStore({ dbPath = "gateway.db" } = {}) {
  const resolvedPath = path.resolve(dbPath);
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(resolvedPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_queue (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payload TEXT NOT NULL DEFAULT '{}',
      result TEXT,
      error TEXT,
      progress REAL NOT NULL DEFAULT 0.0,
      progress_message TEXT NOT NULL DEFAULT '',
      steps_json TEXT NOT NULL DEFAULT '[]',
      current_step TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      retries INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_task_status ON task_queue(status);
    CREATE INDEX IF NOT EXISTS idx_task_type ON task_queue(type);
    CREATE INDEX IF NOT EXISTS idx_task_created ON task_queue(created_at DESC);
  `);

  const stmtInsert = db.prepare(`
    INSERT INTO task_queue (id, type, status, payload, progress, progress_message,
                            steps_json, current_step, created_at)
    VALUES (?, ?, 'pending', ?, 0.0, '', '[]', NULL, ?)
  `);
  const stmtUpdateProgress = db.prepare(`
    UPDATE task_queue SET progress = ?, progress_message = ? WHERE id = ?
  `);
  const stmtUpdateSteps = db.prepare(`
    UPDATE task_queue SET steps_json = ?, current_step = ? WHERE id = ?
  `);
  const stmtSetRunning = db.prepare(`
    UPDATE task_queue SET status = 'running', started_at = ? WHERE id = ?
  `);
  const stmtSetResult = db.prepare(`
    UPDATE task_queue SET status = 'succeeded', result = ?, progress = 1.0,
                          progress_message = 'completed', finished_at = ?
    WHERE id = ?
  `);
  const stmtSetFailed = db.prepare(`
    UPDATE task_queue SET status = 'failed', error = ?, finished_at = ? WHERE id = ?
  `);
  const stmtSetCancelled = db.prepare(`
    UPDATE task_queue SET status = 'cancelled', finished_at = ? WHERE id = ?
  `);
  const stmtRequestCancel = db.prepare(`
    UPDATE task_queue SET cancel_requested = 1 WHERE id = ? AND status IN ('pending','running')
  `);
  const stmtGet = db.prepare(`SELECT * FROM task_queue WHERE id = ?`);
  const stmtList = db.prepare(`
    SELECT * FROM task_queue
    WHERE (? = '' OR type = ?) AND (? = '' OR status = ?)
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `);
  const stmtDelete = db.prepare(`DELETE FROM task_queue WHERE id = ?`);
  const stmtRecover = db.prepare(`
    UPDATE task_queue SET status = 'pending', cancel_requested = 0, started_at = NULL
    WHERE status = 'running'
  `);
  const stmtClaim = db.prepare(`
    SELECT * FROM task_queue
    WHERE status = 'pending' AND cancel_requested = 0
    ORDER BY created_at ASC LIMIT 1
  `);
  const stmtCheckCancel = db.prepare(`
    SELECT cancel_requested FROM task_queue WHERE id = ?
  `);

  function parseRow(row) {
    if (!row) return null;
    return {
      ...row,
      payload: safeJson(row.payload, {}),
      result: safeJson(row.result, null),
      steps: safeJson(row.steps_json, []),
      cancel_requested: Boolean(row.cancel_requested),
      progress: Number(row.progress),
      created_at: Number(row.created_at),
      started_at: row.started_at != null ? Number(row.started_at) : null,
      finished_at: row.finished_at != null ? Number(row.finished_at) : null,
      retries: Number(row.retries),
    };
  }

  return {
    insert(id, type, payload, steps = []) {
      stmtInsert.run(id, type, JSON.stringify(payload), Date.now());
      if (steps.length) {
        stmtUpdateSteps.run(JSON.stringify(steps), steps[0]?.id || null, id);
      }
      return id;
    },
    setRunning(id) { stmtSetRunning.run(Date.now(), id); },
    updateProgress(id, fraction, message) {
      stmtUpdateProgress.run(fraction, message || "", id);
    },
    updateSteps(id, steps, currentStepId) {
      stmtUpdateSteps.run(JSON.stringify(steps), currentStepId, id);
    },
    setResult(id, result) { stmtSetResult.run(JSON.stringify(result), Date.now(), id); },
    setFailed(id, error) {
      stmtSetFailed.run(error instanceof Error ? error.message : String(error), Date.now(), id);
    },
    requestCancel(id) { stmtRequestCancel.run(id); },
    isCancelRequested(id) {
      const row = stmtCheckCancel.get(id);
      return row ? Boolean(row.cancel_requested) : false;
    },
    cancelPending(id) {
      const task = this.get(id);
      if (!task) return false;
      if (task.status === "pending") { stmtSetCancelled.run(Date.now(), id); return true; }
      stmtRequestCancel.run(id);
      return true;
    },
    finalizeCancelled(id) { stmtSetCancelled.run(Date.now(), id); },
    get(id) { return parseRow(stmtGet.get(id)); },
    list({ type = "", status = "", limit = 50, offset = 0 } = {}) {
      return stmtList.all(type, type, status, status, limit, offset).map(parseRow);
    },
    delete(id) {
      const task = this.get(id);
      if (!task) return false;
      if (!["succeeded", "failed", "cancelled"].includes(task.status)) return false;
      stmtDelete.run(id);
      return true;
    },
    recoverRunning() { stmtRecover.run(); },
    claimPending() { return parseRow(stmtClaim.get()); },
    close() { try { db.close(); } catch { /* ignore */ } },
  };
}

function safeJson(text, fallback) {
  if (text == null) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}
