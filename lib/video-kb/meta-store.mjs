import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

function parseJsonField(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function serializeJsonField(value, fallback = []) {
  if (value == null) return JSON.stringify(fallback);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function rowToVideo(row) {
  if (!row) return null;
  return {
    video_id: row.video_id,
    video_url: row.video_url || "",
    source_title: row.source_title || "",
    display_title: row.display_title || row.source_title || "untitled",
    video_title: row.display_title || row.source_title || "untitled",
    uploader: row.uploader || "",
    duration: Number(row.duration || 0),
    language: row.language || "",
    summary_short: row.summary_short || "",
    summary_full: row.summary_full || "",
    key_points: parseJsonField(row.key_points_json, []),
    topics: parseJsonField(row.topics_json, []),
    steps_done: parseJsonField(row.steps_done_json, []),
    assets: parseJsonField(row.assets_json, {}),
    chunk_count: Number(row.chunk_count || 0),
    vector_dim: Number(row.vector_dim || 0),
    status: row.status || "ready",
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
  };
}

/**
 * SQLite metadata store for video knowledge base.
 * LanceDB remains the vector chunk store; this table owns titles/summaries/assets.
 */
export function createMetaStore({ dbPath }) {
  const resolvedPath = path.resolve(dbPath);
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(resolvedPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      video_id TEXT PRIMARY KEY,
      video_url TEXT NOT NULL DEFAULT '',
      source_title TEXT NOT NULL DEFAULT '',
      display_title TEXT NOT NULL DEFAULT '',
      uploader TEXT NOT NULL DEFAULT '',
      duration REAL NOT NULL DEFAULT 0,
      language TEXT NOT NULL DEFAULT '',
      summary_short TEXT NOT NULL DEFAULT '',
      summary_full TEXT NOT NULL DEFAULT '',
      key_points_json TEXT NOT NULL DEFAULT '[]',
      topics_json TEXT NOT NULL DEFAULT '[]',
      steps_done_json TEXT NOT NULL DEFAULT '[]',
      assets_json TEXT NOT NULL DEFAULT '{}',
      chunk_count INTEGER NOT NULL DEFAULT 0,
      vector_dim INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ready',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_videos_updated_at ON videos(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_videos_display_title ON videos(display_title);
  `);

  // Future-proof schema drift without destructive migrations.
  ensureColumn(db, "videos", "summary_short", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "videos", "summary_full", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "videos", "key_points_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "videos", "topics_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "videos", "steps_done_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "videos", "assets_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "videos", "chunk_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "videos", "vector_dim", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "videos", "status", "TEXT NOT NULL DEFAULT 'ready'");

  const selectById = db.prepare("SELECT * FROM videos WHERE video_id = ?");
  const selectAll = db.prepare("SELECT * FROM videos ORDER BY updated_at DESC, created_at DESC");
  const deleteById = db.prepare("DELETE FROM videos WHERE video_id = ?");
  const insertStmt = db.prepare(`
    INSERT INTO videos (
      video_id, video_url, source_title, display_title, uploader, duration, language,
      summary_short, summary_full, key_points_json, topics_json, steps_done_json, assets_json,
      chunk_count, vector_dim, status, created_at, updated_at
    ) VALUES (
      @video_id, @video_url, @source_title, @display_title, @uploader, @duration, @language,
      @summary_short, @summary_full, @key_points_json, @topics_json, @steps_done_json, @assets_json,
      @chunk_count, @vector_dim, @status, @created_at, @updated_at
    )
    ON CONFLICT(video_id) DO UPDATE SET
      video_url = excluded.video_url,
      source_title = CASE
        WHEN excluded.source_title != '' THEN excluded.source_title
        ELSE videos.source_title
      END,
      display_title = CASE
        WHEN excluded.display_title != '' THEN excluded.display_title
        ELSE videos.display_title
      END,
      uploader = CASE WHEN excluded.uploader != '' THEN excluded.uploader ELSE videos.uploader END,
      duration = CASE WHEN excluded.duration > 0 THEN excluded.duration ELSE videos.duration END,
      language = CASE WHEN excluded.language != '' THEN excluded.language ELSE videos.language END,
      summary_short = CASE WHEN excluded.summary_short != '' THEN excluded.summary_short ELSE videos.summary_short END,
      summary_full = CASE WHEN excluded.summary_full != '' THEN excluded.summary_full ELSE videos.summary_full END,
      key_points_json = CASE WHEN excluded.key_points_json != '[]' THEN excluded.key_points_json ELSE videos.key_points_json END,
      topics_json = CASE WHEN excluded.topics_json != '[]' THEN excluded.topics_json ELSE videos.topics_json END,
      steps_done_json = CASE WHEN excluded.steps_done_json != '[]' THEN excluded.steps_done_json ELSE videos.steps_done_json END,
      assets_json = CASE WHEN excluded.assets_json != '{}' THEN excluded.assets_json ELSE videos.assets_json END,
      chunk_count = CASE WHEN excluded.chunk_count > 0 THEN excluded.chunk_count ELSE videos.chunk_count END,
      vector_dim = CASE WHEN excluded.vector_dim > 0 THEN excluded.vector_dim ELSE videos.vector_dim END,
      status = excluded.status,
      updated_at = excluded.updated_at
  `);

  return {
    upsertVideo(input = {}) {
      const now = Date.now();
      const existing = input.video_id ? selectById.get(input.video_id) : null;
      const sourceTitle = String(input.source_title || input.video_title || existing?.source_title || "").trim();
      const displayTitle = String(
        input.display_title || input.video_title || existing?.display_title || sourceTitle || "untitled",
      ).trim() || "untitled";
      const payload = {
        video_id: String(input.video_id || "").trim(),
        video_url: String(input.video_url || existing?.video_url || "").trim(),
        source_title: sourceTitle,
        display_title: displayTitle,
        uploader: String(input.uploader || existing?.uploader || "").trim(),
        duration: Number(input.duration ?? existing?.duration ?? 0) || 0,
        language: String(input.language || existing?.language || "").trim(),
        summary_short: String(input.summary_short ?? existing?.summary_short ?? "").trim(),
        summary_full: String(input.summary_full ?? existing?.summary_full ?? "").trim(),
        key_points_json: serializeJsonField(input.key_points ?? parseJsonField(existing?.key_points_json, []), []),
        topics_json: serializeJsonField(input.topics ?? parseJsonField(existing?.topics_json, []), []),
        steps_done_json: serializeJsonField(input.steps_done ?? parseJsonField(existing?.steps_done_json, []), []),
        assets_json: serializeJsonField(input.assets ?? parseJsonField(existing?.assets_json, {}), {}),
        chunk_count: Number(input.chunk_count ?? existing?.chunk_count ?? 0) || 0,
        vector_dim: Number(input.vector_dim ?? existing?.vector_dim ?? 0) || 0,
        status: String(input.status || existing?.status || "ready"),
        created_at: Number(existing?.created_at || input.created_at || now),
        updated_at: now,
      };
      if (!payload.video_id) throw new Error("video_id is required");
      insertStmt.run(payload);
      return rowToVideo(selectById.get(payload.video_id));
    },

    getVideo(videoId) {
      return rowToVideo(selectById.get(String(videoId || "")));
    },

    listVideos() {
      return selectAll.all().map(rowToVideo);
    },

    updateTitle(videoId, displayTitle) {
      const title = String(displayTitle || "").trim();
      if (!title) throw new Error("display_title is required");
      const existing = selectById.get(String(videoId || ""));
      if (!existing) throw new Error(`Video not found: ${videoId}`);
      db.prepare(`
        UPDATE videos
        SET display_title = ?, updated_at = ?
        WHERE video_id = ?
      `).run(title, Date.now(), String(videoId));
      return rowToVideo(selectById.get(String(videoId)));
    },

    updateSummary(videoId, summary = {}) {
      const existing = selectById.get(String(videoId || ""));
      if (!existing) throw new Error(`Video not found: ${videoId}`);
      db.prepare(`
        UPDATE videos
        SET summary_short = ?,
            summary_full = ?,
            key_points_json = ?,
            topics_json = ?,
            updated_at = ?
        WHERE video_id = ?
      `).run(
        String(summary.summary_short || "").trim(),
        String(summary.summary_full || "").trim(),
        serializeJsonField(summary.key_points || [], []),
        serializeJsonField(summary.topics || [], []),
        Date.now(),
        String(videoId),
      );
      return rowToVideo(selectById.get(String(videoId)));
    },

    deleteVideo(videoId) {
      deleteById.run(String(videoId || ""));
      return { ok: true, video_id: String(videoId || "") };
    },

    close() {
      try { db.close(); } catch { /* ignore */ }
    },
  };
}
