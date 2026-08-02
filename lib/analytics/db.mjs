import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

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

  return db;
}
