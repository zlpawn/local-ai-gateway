import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callV1Internal,
  loadCodeAssist,
  buildUrl,
  shouldTryNextEndpoint,
} from "../../lib/antigravity/upstream.mjs";

function makeFetch(handler) {
  return async (url, init) => {
    const r = await handler(url, init);
    const body = r.body ?? "";
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      json: async () => (typeof body === "string" ? JSON.parse(body || "null") : body),
      body: r.stream ?? null,
    };
  };
}

test("buildUrl with and without query", () => {
  assert.equal(buildUrl("https://x/v1internal", "generateContent"), "https://x/v1internal:generateContent");
  assert.equal(buildUrl("https://x/v1internal", "streamGenerateContent", "alt=sse"), "https://x/v1internal:streamGenerateContent?alt=sse");
});

test("shouldTryNextEndpoint: 408/404/5xx retry, others not", () => {
  assert.equal(shouldTryNextEndpoint(408), true);
  assert.equal(shouldTryNextEndpoint(404), true);
  assert.equal(shouldTryNextEndpoint(500), true);
  assert.equal(shouldTryNextEndpoint(503), true);
  assert.equal(shouldTryNextEndpoint(401), false);
  assert.equal(shouldTryNextEndpoint(403), false);
  assert.equal(shouldTryNextEndpoint(429), false);
});

test("loadCodeAssist returns cloudaicompanionProject", async () => {
  const fetchImpl = makeFetch(() => ({
    status: 200,
    body: JSON.stringify({ cloudaicompanionProject: "proj-abc", currentTier: { name: "Pro" } }),
  }));
  const { project } = await loadCodeAssist({ accessToken: "tok", fetchImpl });
  assert.equal(project, "proj-abc");
});

test("loadCodeAssist throws when no project (ineligible)", async () => {
  const fetchImpl = makeFetch(() => ({ status: 200, body: JSON.stringify({}) }));
  await assert.rejects(() => loadCodeAssist({ accessToken: "tok", fetchImpl }), /no cloudaicompanionProject/);
});

test("callV1Internal falls back to next endpoint on 5xx", async () => {
  const urls = [];
  const fetchImpl = makeFetch((url) => {
    urls.push(url);
    return url.startsWith("https://cloudcode-pa.googleapis.com") ? { status: 500 } : { status: 200, body: "{}" };
  });
  const res = await callV1Internal({ method: "loadCodeAssist", accessToken: "tok", body: {}, fetchImpl });
  assert.ok(res.ok);
  assert.equal(urls.length, 2);
});

test("callV1Internal 403 with project header triggers downgrade retry", async () => {
  const calls = [];
  const fetchImpl = makeFetch((url, init) => {
    calls.push({ hasProjectHeader: !!init.headers["x-goog-user-project"] });
    return calls.length === 1 ? { status: 403 } : { status: 200, body: "{}" };
  });
  const res = await callV1Internal({ method: "generateContent", accessToken: "tok", body: {}, project: "proj", fetchImpl });
  assert.ok(res.ok);
  assert.equal(calls[0].hasProjectHeader, true);
  assert.equal(calls[1].hasProjectHeader, false);
});

test("callV1Internal throws when all endpoints return 5xx", async () => {
  const fetchImpl = makeFetch(() => ({ status: 500 }));
  await assert.rejects(
    () => callV1Internal({ method: "generateContent", accessToken: "tok", body: {}, project: "proj", fetchImpl }),
    /returned 500|failed/,
  );
});

test("callV1Internal returns non-retryable 401 without throwing", async () => {
  const fetchImpl = makeFetch(() => ({ status: 401 }));
  const res = await callV1Internal({ method: "generateContent", accessToken: "tok", body: {}, project: "proj", fetchImpl });
  assert.equal(res.status, 401);
  assert.equal(res.ok, false);
});