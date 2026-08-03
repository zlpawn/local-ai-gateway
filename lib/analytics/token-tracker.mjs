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
      prompt_tokens, completion_tokens, total_tokens,
      cache_creation_tokens, cache_read_tokens,
      cost_native, cost_usd, native_currency, price_source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

        const cache_creation_tokens = Math.max(0, Number(log.cache_creation_tokens || 0));
        const cache_read_tokens = Math.max(0, Number(log.cache_read_tokens || 0));

        // --- Cost calculation ---
        const price = log.price || null;
        const fxRate = log.fxRate || null;

        let cost_native = 0;
        let cost_usd = 0;
        let native_currency = "";
        let price_source = "unknown";

        if (price && price.currency) {
          const billablePrompt = Math.max(0, prompt_tokens - cache_creation_tokens - cache_read_tokens);

          cost_native = (cache_creation_tokens * (price.cache_creation || 0)
                       + cache_read_tokens * (price.cache_read || 0)
                       + billablePrompt * (price.prompt || 0)
                       + completion_tokens * (price.completion || 0)) / 1_000_000;

          native_currency = price.currency;
          price_source = price.source || "unknown";
          cost_usd = price.currency === "usd"
            ? cost_native
            : (fxRate?.usd_to_cny ? cost_native / fxRate.usd_to_cny : 0);
        }

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
          total_tokens,
          cache_creation_tokens,
          cache_read_tokens,
          cost_native,
          cost_usd,
          native_currency,
          price_source
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

      // Cost columns to add to every aggregation query
      const costCols = `
        COALESCE(SUM(cost_native), 0) as cost_native,
        COALESCE(SUM(cost_usd), 0) as cost_usd,
        COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
        MAX(native_currency) as native_currency
      `;

      // 1. Overall Summary
      const summaryStmt = db.prepare(`
        SELECT
          COUNT(*) as total_requests,
          COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
          COALESCE(SUM(completion_tokens), 0) as completion_tokens,
          COALESCE(SUM(total_tokens), 0) as total_tokens,
          ${costCols}
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
          SUM(total_tokens) as total_tokens,
          ${costCols}
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
          SUM(total_tokens) as total_tokens,
          ${costCols}
        FROM token_usage_logs
        WHERE ${whereSql}
        GROUP BY purpose
      `);
      const purpose_breakdown = purposeStmt.all(...params);

      // 4. Breakdown by client
      const clientStmt = db.prepare(`
        SELECT
          client,
          COUNT(*) as requests,
          SUM(prompt_tokens) as prompt_tokens,
          SUM(completion_tokens) as completion_tokens,
          SUM(total_tokens) as total_tokens,
          ${costCols}
        FROM token_usage_logs
        WHERE ${whereSql}
        GROUP BY client
        ORDER BY total_tokens DESC
      `);
      const client_breakdown = clientStmt.all(...params);

      // 5. Breakdown by endpoint
      const endpointStmt = db.prepare(`
        SELECT
          endpoint_id,
          endpoint_name,
          purpose,
          COUNT(*) as requests,
          SUM(prompt_tokens) as prompt_tokens,
          SUM(completion_tokens) as completion_tokens,
          SUM(total_tokens) as total_tokens,
          ${costCols}
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
          SUM(total_tokens) as total_tokens,
          ${costCols}
        FROM token_usage_logs
        WHERE ${whereSql}
        GROUP BY model, purpose
        ORDER BY total_tokens DESC
      `);
      const model_breakdown = modelStmt.all(...params);

      // 7. Detail breakdown
      const detailStmt = db.prepare(`
        SELECT
          client,
          endpoint_id,
          endpoint_name,
          purpose,
          model,
          COUNT(*) as requests,
          SUM(prompt_tokens) as prompt_tokens,
          SUM(completion_tokens) as completion_tokens,
          SUM(total_tokens) as total_tokens,
          ${costCols}
        FROM token_usage_logs
        WHERE ${whereSql}
        GROUP BY client, endpoint_id, model
        ORDER BY total_tokens DESC
      `);
      const detail_breakdown = detailStmt.all(...params);

      const mapRow = (row) => ({
        ...row,
        requests: Number(row.requests || 0),
        prompt_tokens: Number(row.prompt_tokens || 0),
        completion_tokens: Number(row.completion_tokens || 0),
        total_tokens: Number(row.total_tokens || 0),
        cost_native: Number(row.cost_native || 0),
        cost_usd: Number(row.cost_usd || 0),
        cache_creation_tokens: Number(row.cache_creation_tokens || 0),
        cache_read_tokens: Number(row.cache_read_tokens || 0),
      });

      return {
        summary: {
          total_requests: Number(summaryRow.total_requests || 0),
          prompt_tokens: Number(summaryRow.prompt_tokens || 0),
          completion_tokens: Number(summaryRow.completion_tokens || 0),
          total_tokens: Number(summaryRow.total_tokens || 0),
          cache_creation_tokens: Number(summaryRow.cache_creation_tokens || 0),
          cache_read_tokens: Number(summaryRow.cache_read_tokens || 0),
          cost_native: Number(summaryRow.cost_native || 0),
          cost_usd: Number(summaryRow.cost_usd || 0),
        },
        timeline: timeline.map(mapRow),
        purpose_breakdown: purpose_breakdown.map(mapRow),
        client_breakdown: client_breakdown.map(mapRow),
        endpoint_breakdown: endpoint_breakdown.map(mapRow),
        model_breakdown: model_breakdown.map(mapRow),
        detail_breakdown: detail_breakdown.map(mapRow),
      };
    },

    close() {
      try { db.close(); } catch {}
    },
  };
}