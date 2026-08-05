import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = path.join(MODULE_DIR, "scripts", "lancedb_bridge.py");

/**
 * LanceDB vector store - Node.js wrapper over Python lancedb via JSON bridge.
 *
 * Communication: spawn python3 lancedb_bridge.py, write JSON to stdin,
 * read JSON response from stdout. One process per operation (simple, reliable).
 *
 * embeddingFn: (text) => Promise<number[]> provided by the caller,
 * typically calling the gateway's own /v1/embeddings endpoint.
 */

export function createVectorStore({ dbPath, embeddingFn = null, tableName = "video_kb" }) {
  return {
    async ensureTable(dim) {
      return callBridge({
        cmd: "ensure_table",
        db_path: dbPath,
        table: tableName,
        dim,
      });
    },

    async upsertChunks(chunks, { dim }) {
      // chunks: [{ chunk_id, video_id, video_url, video_title, chunk_index,
      //            start_seconds, end_seconds, text, segment_ids, language, created_at }]
      // Each chunk must have a "vector" field, OR embeddingFn must be provided.
      const records = [];
      for (const chunk of chunks) {
        let vector = chunk.vector;
        if (!vector && embeddingFn) {
          vector = await embeddingFn(chunk.text);
        }
        if (!vector) throw new Error(`No vector for chunk ${chunk.chunk_id} and no embeddingFn`);
        records.push({ ...chunk, vector });
      }
      return callBridge({
        cmd: "upsert",
        db_path: dbPath,
        table: tableName,
        records,
      });
    },

    async search(query, { topK = 5, videoId = null, threshold = 0 } = {}) {
      if (!embeddingFn) throw new Error("embeddingFn required for search");
      const queryVector = await embeddingFn(query);
      const result = await callBridge({
        cmd: "search",
        db_path: dbPath,
        table: tableName,
        query_vector: queryVector,
        top_k: topK,
        video_id: videoId,
      });
      // Filter by threshold if specified (LanceDB returns _distance, lower = more similar)
      // Convert distance to similarity score: score = 1 - distance (for L2)
      let results = result.results || [];
      if (threshold > 0) {
        results = results.filter((r) => (1 - r.score) >= threshold);
      }
      return results.map((r) => ({
        ...r,
        score: 1 - r.score, // convert distance to similarity
      }));
    },

    async deleteByVideo(videoId) {
      return callBridge({
        cmd: "delete_by_video",
        db_path: dbPath,
        table: tableName,
        video_id: videoId,
      });
    },

    async listVideos() {
      const result = await callBridge({
        cmd: "list_videos",
        db_path: dbPath,
        table: tableName,
      });
      return result.videos || [];
    },

    async getVideo(videoId) {
      return callBridge({
        cmd: "get_video",
        db_path: dbPath,
        table: tableName,
        video_id: videoId,
      });
    },

    async getStats() {
      return callBridge({
        cmd: "get_stats",
        db_path: dbPath,
        table: tableName,
      });
    },
  };
}

/**
 * Call the Python bridge script with a JSON command.
 * Returns the parsed JSON response.
 */
function callBridge(command) {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [BRIDGE_SCRIPT], {
      timeout: 60000,
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });

    proc.on("error", (err) => {
      reject(new Error(`Failed to start lancedb bridge: ${err.message}. Is python3 installed?`));
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`lancedb bridge failed (exit ${code}): ${stderr.trim()}`));
        return;
      }
      try {
        const result = JSON.parse(stdout);
        if (result.error) {
          reject(new Error(result.error));
        } else {
          resolve(result);
        }
      } catch (err) {
        reject(new Error(`Failed to parse lancedb bridge output: ${err.message}. stderr: ${stderr.trim()}`));
      }
    });

    // Send the command as JSON to stdin
    proc.stdin.write(JSON.stringify(command));
    proc.stdin.end();
  });
}
