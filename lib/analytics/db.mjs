import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

/**
 * Add a column to a table if it does not already exist (idempotent).
 * SQLite does not support ADD COLUMN IF NOT EXISTS, so we check PRAGMA table_info.
 */
function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

export function openGatewayDatabase(dbFilePath = "gateway.db") {
  const resolvedPath = path.resolve(dbFilePath);
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(resolvedPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      date_str TEXT NOT NULL,
      hour_str TEXT NOT NULL,
      minute_str TEXT NOT NULL,
      client TEXT NOT NULL,
      endpoint_id TEXT NOT NULL,
      endpoint_name TEXT NOT NULL,
      purpose TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON token_usage_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_logs_date ON token_usage_logs(date_str);
    CREATE INDEX IF NOT EXISTS idx_logs_hour ON token_usage_logs(hour_str);
    CREATE INDEX IF NOT EXISTS idx_logs_minute ON token_usage_logs(minute_str);
    CREATE INDEX IF NOT EXISTS idx_logs_purpose ON token_usage_logs(purpose);
  `);

  // --- Cost analytics schema migration (idempotent) ---
  ensureColumn(db, "token_usage_logs", "cost_native", "REAL NOT NULL DEFAULT 0.0");
  ensureColumn(db, "token_usage_logs", "cost_usd", "REAL NOT NULL DEFAULT 0.0");
  ensureColumn(db, "token_usage_logs", "native_currency", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "token_usage_logs", "cache_creation_tokens", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "token_usage_logs", "cache_read_tokens", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "token_usage_logs", "price_source", "TEXT NOT NULL DEFAULT ''");

  return db;
}