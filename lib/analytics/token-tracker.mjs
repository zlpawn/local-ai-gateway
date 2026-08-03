import { openGatewayDatabase } from "./db.mjs";

function pad2(num) {
  return String(num).padStart(2, "0");
}

function formatDateStrings(ts) {
  const d = new Date(ts);
  const year = d.getFullYear();
  const month = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  const hour = pad2(d.getHours());
  const minute = pad2(d.getMinutes());

  const date_str = `${year}-${month}-${day}`;
  const hour_str = `${date_str} ${hour}:00`;
  const minute_str = `${date_str} ${hour}:${minute}`;
  return { date_str, hour_str, minute_str };
}

export function createTokenTracker({ dbPath = "gateway.db" } = {}) {
  const db = openGatewayDatabase(dbPath);

  const insertStmt = db.prepare(`
    INSERT INTO token_usage_logs (
      timestamp, date_str, hour_str, minute_str,
      client, endpoint_id, endpoint_name, purpose, model,
      prompt_tokens, completion_tokens, total_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return {
    recordUsage(log = {}) {
      try {
        const ts = Number(log.timestamp) || Date.now();
        const { date_str, hour_str, minute_str } = formatDateStrings(ts);

        const client = String(log.client || "unknown").trim();
        const endpoint_id = String(log.endpoint_id || "ep_unknown").trim();
        const endpoint_name = String(log.endpoint_name || endpoint_id).trim();
        const purpose = String(log.purpose || "chat").trim().toLowerCase();
        const model = String(log.model || "unknown").trim();

        const prompt_tokens = Math.max(0, Number(log.prompt_tokens || log.input_tokens) || 0);
        const completion_tokens = Math.max(0, Number(log.completion_tokens || log.output_tokens) || 0);
        const total_tokens = Math.max(0, Number(log.total_tokens) || (prompt_tokens + completion_tokens));

        insertStmt.run(
          ts,
          date_str,
          hour_str,
          minute_str,
          client,
          endpoint_id,
          endpoint_name,
          purpose,
          model,
          prompt_tokens,
          completion_tokens,
          total_tokens
        );
      } catch (err) {
        console.error("TokenTracker recordUsage error:", err);
      }
    },

    queryUsage(options = {}) {
      const granularity = String(options.granularity || "hour").toLowerCase();
      const range = String(options.range || "24h").toLowerCase();
      const purpose = String(options.purpose || "all").toLowerCase();
      const client = String(options.client || "all").toLowerCase();
      const model = String(options.model || "all").toLowerCase();

      const now = Date.now();
      let startTime = now - 24 * 3600 * 1000; // default 24h
      if (range === "1h") startTime = now - 3600 * 1000;
      else if (range === "7d") startTime = now - 7 * 24 * 3600 * 1000;
      else if (range === "30d") startTime = now - 30 * 24 * 3600 * 1000;

      const whereClauses = ["timestamp >= ?"];
      const params = [startTime];

      if (purpose !== "all") {
        whereClauses.push("purpose = ?");
        params.push(purpose);
      }
      if (client !== "all") {
        whereClauses.push("LOWER(client) = ?");
        params.push(client);
      }
      if (model !== "all") {
        whereClauses.push("LOWER(model) = ?");
        params.push(model);
      }

      const whereSql = whereClauses.join(" AND ");

      // 1. Overall Summary
      const summaryStmt = db.prepare(`
        SELECT
          COUNT(*) as total_requests,
          COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
          COALESCE(SUM(completion_tokens), 0) as completion_tokens,
          COALESCE(SUM(total_tokens), 0) as total_tokens
        FROM token_usage_logs
        WHERE ${whereSql}
      `);
      const summaryRow = summaryStmt.get(...params) || {};

      // 2. Timeline Aggregation
      let groupCol = "hour_str";
      if (granularity === "minute") groupCol = "minute_str";
      else if (granularity === "day") groupCol = "date_str";

      const timelineStmt = db.prepare(`
        SELECT
          ${groupCol} as time_key,
          COUNT(*) as requests,
          SUM(prompt_tokens) as prompt_tokens,
          SUM(completion_tokens) as completion_tokens,
          SUM(total_tokens) as total_tokens
        FROM token_usage_logs
        WHERE ${whereSql}
        GROUP BY ${groupCol}
        ORDER BY time_key ASC
      `);
      const timeline = timelineStmt.all(...params);

      // 3. Breakdown by purpose
      const purposeStmt = db.prepare(`
        SELECT
          purpose,
          COUNT(*) as requests,
          SUM(prompt_tokens) as prompt_tokens,
          SUM(completion_tokens) as completion_tokens,
          SUM(total_tokens) as total_tokens
        FROM token_usage_logs
        WHERE ${whereSql}
        GROUP BY purpose
      `);
      const purpose_breakdown = purposeStmt.all(...params);

      // 4. Breakdown by client (codex / desktop / ...)
      const clientStmt = db.prepare(`
        SELECT
          client,
          COUNT(*) as requests,
          SUM(prompt_tokens) as prompt_tokens,
          SUM(completion_tokens) as completion_tokens,
          SUM(total_tokens) as total_tokens
        FROM token_usage_logs
        WHERE ${whereSql}
        GROUP BY client
        ORDER BY total_tokens DESC
      `);
      const client_breakdown = clientStmt.all(...params);

      // 5. Breakdown by endpoint (node name)
      const endpointStmt = db.prepare(`
        SELECT
          endpoint_id,
          endpoint_name,
          purpose,
          COUNT(*) as requests,
          SUM(prompt_tokens) as prompt_tokens,
          SUM(completion_tokens) as completion_tokens,
          SUM(total_tokens) as total_tokens
        FROM token_usage_logs
        WHERE ${whereSql}
        GROUP BY endpoint_id
        ORDER BY total_tokens DESC
      `);
      const endpoint_breakdown = endpointStmt.all(...params);

      // 6. Breakdown by model
      const modelStmt = db.prepare(`
        SELECT
          model,
          purpose,
          COUNT(*) as requests,
          SUM(prompt_tokens) as prompt_tokens,
          SUM(completion_tokens) as completion_tokens,
          SUM(total_tokens) as total_tokens
        FROM token_usage_logs
        WHERE ${whereSql}
        GROUP BY model, purpose
        ORDER BY total_tokens DESC
      `);
      const model_breakdown = modelStmt.all(...params);

      return {
        summary: {
          total_requests: Number(summaryRow.total_requests || 0),
          prompt_tokens: Number(summaryRow.prompt_tokens || 0),
          completion_tokens: Number(summaryRow.completion_tokens || 0),
          total_tokens: Number(summaryRow.total_tokens || 0),
        },
        timeline: timeline.map((row) => ({
          time_key: row.time_key,
          requests: Number(row.requests || 0),
          prompt_tokens: Number(row.prompt_tokens || 0),
          completion_tokens: Number(row.completion_tokens || 0),
          total_tokens: Number(row.total_tokens || 0),
        })),
        purpose_breakdown: purpose_breakdown.map((row) => ({
          purpose: row.purpose,
          requests: Number(row.requests || 0),
          prompt_tokens: Number(row.prompt_tokens || 0),
          completion_tokens: Number(row.completion_tokens || 0),
          total_tokens: Number(row.total_tokens || 0),
        })),
        client_breakdown: client_breakdown.map((row) => ({
          client: row.client,
          requests: Number(row.requests || 0),
          prompt_tokens: Number(row.prompt_tokens || 0),
          completion_tokens: Number(row.completion_tokens || 0),
          total_tokens: Number(row.total_tokens || 0),
        })),
        endpoint_breakdown: endpoint_breakdown.map((row) => ({
          endpoint_id: row.endpoint_id,
          endpoint_name: row.endpoint_name,
          purpose: row.purpose,
          requests: Number(row.requests || 0),
          prompt_tokens: Number(row.prompt_tokens || 0),
          completion_tokens: Number(row.completion_tokens || 0),
          total_tokens: Number(row.total_tokens || 0),
        })),
        model_breakdown: model_breakdown.map((row) => ({
          model: row.model,
          purpose: row.purpose,
          requests: Number(row.requests || 0),
          prompt_tokens: Number(row.prompt_tokens || 0),
          completion_tokens: Number(row.completion_tokens || 0),
          total_tokens: Number(row.total_tokens || 0),
        })),
      };
    },

    close() {
      try { db.close(); } catch {}
    },
  };
}
