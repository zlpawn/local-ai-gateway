import { CliError } from "../protocol.mjs";
import { fetchHealth } from "./live-gateway.mjs";
import { DEFAULT_PORT } from "../constants.mjs";

function cosine(a = [], b = []) {
  if (!a.length || !b.length || a.length !== b.length) {
    throw new CliError({
      type: "validation",
      code: "vector_mismatch",
      message: "Vectors must be non-empty and same length",
    });
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (!denom) {
    throw new CliError({
      type: "validation",
      code: "zero_vector",
      message: "Vector norm is zero; cannot compute similarity",
    });
  }
  return Number((dot / denom).toFixed(4));
}

async function embedOnce({
  host = "127.0.0.1",
  port = DEFAULT_PORT,
  client = "codex",
  endpointId,
  model,
  text,
  dimensions,
}) {
  if (!text) {
    throw new CliError({
      type: "validation",
      code: "missing_fields",
      message: "text is required",
      fields: ["text"],
    });
  }
  const health = await fetchHealth({ host, port });
  if (!health.ok) {
    throw new CliError({
      type: "runtime",
      code: "gateway_not_running",
      message: `Gateway is not healthy on ${host}:${port}`,
      hint: "Run `shrimp start` first",
      retryable: true,
    });
  }
  const url = new URL(`http://${host}:${port}/v1/embeddings`);
  if (endpointId) url.searchParams.set("endpoint_id", endpointId);
  const body = { model, input: text };
  if (dimensions != null && dimensions !== "") body.dimensions = Number(dimensions);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-gateway-client": client,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new CliError({
      type: "external",
      code: "embedding_failed",
      message: payload?.error?.message || payload?.message || `HTTP ${response.status}`,
      details: payload,
    });
  }
  const vector = payload?.data?.[0]?.embedding || [];
  return {
    vector,
    model: payload?.model || model,
    usage: payload?.usage || null,
    dimensions: vector.length,
  };
}

export async function embedText(input) {
  return embedOnce(input);
}

export async function embedSimilarity(input) {
  const a = await embedOnce({ ...input, text: input.textA || input["text-a"] });
  const b = await embedOnce({ ...input, text: input.textB || input["text-b"] });
  return {
    similarity: cosine(a.vector, b.vector),
    a: { model: a.model, dimensions: a.dimensions, usage: a.usage },
    b: { model: b.model, dimensions: b.dimensions, usage: b.usage },
  };
}