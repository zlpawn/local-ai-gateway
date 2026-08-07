let _lancedb = null;

async function getLancedb() {
  if (!_lancedb) {
    const mod = await import("@lancedb/lancedb");
    _lancedb = mod.default || mod;
  }
  return _lancedb;
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
        // Table doesn't exist yet - create with empty schema
        // LanceDB infers schema from the first batch of data
        return { ok: true, existed: false };
      }
    },

    async upsertChunks(chunks, { dim } = {}) {
    console.log("[video-kb] vectorize: upsertChunks called, count:", chunks.length, "dim:", dim);
      const db = await getDb();

      // Delete existing chunks for any video_id in this batch (upsert semantics)
      const videoIds = [...new Set(chunks.map((c) => c.video_id))];
      let table;
      try {
        table = await db.openTable(tableName);
        for (const videoId of videoIds) {
          try {
            await table.delete(`video_id = '${videoId}'`);
          } catch { /* table may be empty */ }
        }
      } catch {
        // Table doesn't exist yet, will be created by add()
      }

      // Build records with vectors
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

      // Add records (creates table if it doesn't exist)
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
        query_builder = query_builder.where(`video_id = '${videoId}'`);
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
          score: 1 - Number(r._distance || 0), // distance -> similarity
        }))
        .filter((r) => threshold === 0 || r.score >= threshold);
    },

    async deleteByVideo(videoId) {
      const table = await getTable();
      await table.delete(`video_id = '${videoId}'`);
      return { ok: true, video_id: videoId };
    },

    async listVideos() {
      const table = await getTable();
      const rows = await table.query().toArray();

      // Group by video_id
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
    },

    async getVideo(videoId) {
      const table = await getTable();
      const rows = await table.query().where(`video_id = '${videoId}'`).toArray();

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
