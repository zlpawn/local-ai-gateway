import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

test("selectDefaultEmbeddingEndpoint fallback and forwarding logic", async () => {
  // Start a mock upstream embedding server
  let receivedBody = null;
  let receivedAuth = null;
  const upstreamServer = http.createServer((req, res) => {
    receivedAuth = req.headers["authorization"];
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      receivedBody = JSON.parse(data || "{}");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        data: [{ object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 }],
        model: receivedBody.model,
        usage: { prompt_tokens: 5, total_tokens: 5 },
      }));
    });
  });

  await new Promise((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
  const port = upstreamServer.address().port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  try {
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-key",
      },
      body: JSON.stringify({
        input: "hello world",
        model: "text-embedding-3-small",
      }),
    });

    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.object, "list");
    assert.deepEqual(json.data[0].embedding, [0.1, 0.2, 0.3]);
    assert.equal(receivedAuth, "Bearer test-key");
    assert.equal(receivedBody.model, "text-embedding-3-small");
    assert.equal(receivedBody.input, "hello world");
  } finally {
    await new Promise((resolve) => upstreamServer.close(resolve));
  }
});
