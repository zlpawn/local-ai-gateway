let _lancedb = null;

async function getLancedb() {
  if (!_lancedb) {
    const mod = await import("@lancedb/lancedb");
    _lancedb = mod.default || mod;
  }
  return _lancedb;
}

function escapeSqlLiteral(value) {
  return String(value || "").replace(/'/g, "''");
}

/**
 * LanceDB vector store - pure Node.js, no Python dependency.
 *
 * Uses the @lancedb/lancedb npm package directly.
 *
 * embeddingFn: (text) => Promise<number[]> provided by the caller,
 * typically calling the gateway's own /v1/embeddings endpoint.
 */

export function createVectorStore({ dbPath, embeddingFn = null, tableName = "video_kb" }) {
  let _db = null;

  async function getDb() {
    if (!_db) {
      _db = await (await getLancedb()).connect(dbPath);
    }
    return _db;
  }

  async function getTable() {
    const db = await getDb();
    return db.openTable(tableName);
  }

  return {
    async ensureTable(dim) {
      console.log("[video-kb] vectorize: ensureTable called, dim:", dim);
      const db = await getDb();
      try {
        await db.openTable(tableName);
        return { ok: true, existed: true };
      } catch {
        return { ok: true, existed: false };
      }
    },

    async upsertChunks(chunks, { dim } = {}) {
      console.log("[video-kb] vectorize: upsertChunks called, count:", chunks.length, "dim:", dim);
      const db = await getDb();

      const videoIds = [...new Set(chunks.map((c) => c.video_id))];
      let table;
      try {
        table = await db.openTable(tableName);
        for (const videoId of videoIds) {
          try {
            await table.delete(`video_id = '${escapeSqlLiteral(videoId)}'`);
          } catch { /* table may be empty */ }
        }
      } catch {
        // Table doesn't exist yet, will be created by add()
      }

      const records = [];
      for (const chunk of chunks) {
        let vector = chunk.vector;
        if (!vector && embeddingFn) {
          vector = await embeddingFn(chunk.text);
        }
        if (!vector) throw new Error(`No vector for chunk ${chunk.chunk_id} and no embeddingFn`);
        records.push({
          chunk_id: chunk.chunk_id,
          video_id: chunk.video_id,
          video_url: chunk.video_url || "",
          video_title: chunk.video_title || "",
          chunk_index: chunk.chunk_index || 0,
          start_seconds: chunk.start_seconds || 0,
          end_seconds: chunk.end_seconds || 0,
          text: chunk.text || "",
          segment_ids: chunk.segment_ids && chunk.segment_ids.length > 0 ? chunk.segment_ids : [""],
          vector,
          language: chunk.language || "",
          created_at: chunk.created_at || Date.now(),
        });
      }

      try {
        table = await db.openTable(tableName);
        console.log("[video-kb] vectorize: adding", records.length, "records to existing table");
        await table.add(records);
      } catch {
        console.log("[video-kb] vectorize: creating table with", records.length, "records");
        await db.createTable(tableName, records);
      }

      return { ok: true, count: records.length };
    },

    async search(query, { topK = 5, videoId = null, threshold = 0 } = {}) {
      if (!embeddingFn) throw new Error("embeddingFn required for search");
      const queryVector = await embeddingFn(query);
      const table = await getTable();

      let query_builder = table.search(queryVector).limit(topK);
      if (videoId) {
        query_builder = query_builder.where(`video_id = '${escapeSqlLiteral(videoId)}'`);
      }

      const results = await query_builder.toArray();

      return results
        .map((r) => ({
          chunk_id: r.chunk_id || "",
          video_id: r.video_id || "",
          video_url: r.video_url || "",
          video_title: r.video_title || "",
          start_seconds: Number(r.start_seconds || 0),
          end_seconds: Number(r.end_seconds || 0),
          text: r.text || "",
          segment_ids: r.segment_ids || [],
          score: 1 - Number(r._distance || 0),
        }))
        .filter((r) => threshold === 0 || r.score >= threshold);
    },

    async deleteByVideo(videoId) {
      try {
        const table = await getTable();
        await table.delete(`video_id = '${escapeSqlLiteral(videoId)}'`);
      } catch {
        // table may not exist yet
      }
      return { ok: true, video_id: videoId };
    },

    async updateVideoTitle(videoId, title) {
      const nextTitle = String(title || "").trim();
      if (!nextTitle) throw new Error("title is required");
      let table;
      try {
        table = await getTable();
      } catch {
        return { ok: true, updated: 0, video_id: videoId };
      }

      const rows = await table.query().where(`video_id = '${escapeSqlLiteral(videoId)}'`).toArray();
      if (!rows.length) return { ok: true, updated: 0, video_id: videoId };

      const records = rows.map((row) => ({
        chunk_id: row.chunk_id,
        video_id: row.video_id,
        video_url: row.video_url || "",
        video_title: nextTitle,
        chunk_index: Number(row.chunk_index || 0),
        start_seconds: Number(row.start_seconds || 0),
        end_seconds: Number(row.end_seconds || 0),
        text: row.text || "",
        segment_ids: row.segment_ids && row.segment_ids.length > 0 ? row.segment_ids : [""],
        vector: row.vector,
        language: row.language || "",
        created_at: Number(row.created_at || Date.now()),
      }));

      await table.delete(`video_id = '${escapeSqlLiteral(videoId)}'`);
      await table.add(records);
      return { ok: true, updated: records.length, video_id: videoId };
    },

    async listVideos() {
      try {
        const table = await getTable();
        const rows = await table.query().toArray();
        const videoMap = new Map();
        for (const row of rows) {
          const vid = row.video_id;
          if (!videoMap.has(vid)) {
            videoMap.set(vid, {
              video_id: vid,
              video_url: row.video_url || "",
              video_title: row.video_title || "",
              chunk_count: 0,
              duration_start: Infinity,
              duration_end: 0,
              language: row.language || "",
              created_at: Number(row.created_at || 0),
            });
          }
          const v = videoMap.get(vid);
          v.chunk_count++;
          v.duration_start = Math.min(v.duration_start, Number(row.start_seconds || 0));
          v.duration_end = Math.max(v.duration_end, Number(row.end_seconds || 0));
        }
        return [...videoMap.values()];
      } catch {
        return [];
      }
    },

    async getVideo(videoId) {
      try {
        const table = await getTable();
        const rows = await table.query().where(`video_id = '${escapeSqlLiteral(videoId)}'`).toArray();
        const chunks = rows
          .map((r) => ({
            chunk_id: r.chunk_id || "",
            chunk_index: Number(r.chunk_index || 0),
            start_seconds: Number(r.start_seconds || 0),
            end_seconds: Number(r.end_seconds || 0),
            text: r.text || "",
            segment_ids: r.segment_ids || [],
          }))
          .sort((a, b) => a.chunk_index - b.chunk_index);
        return { video_id: videoId, chunks, chunk_count: chunks.length };
      } catch {
        return { video_id: videoId, chunks: [], chunk_count: 0 };
      }
    },

    async getStats() {
      try {
        const table = await getTable();
        const count = await table.countRows();
        return { total_chunks: count, table: tableName };
      } catch {
        return { total_chunks: 0, table: tableName };
      }
    },
  };
}
