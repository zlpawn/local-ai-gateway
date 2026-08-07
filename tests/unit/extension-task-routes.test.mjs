import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createExtensionTaskSystem } from "../../lib/extension-tasks/create-system.mjs";
import { createExtensionStore } from "../../lib/extension-registry/store.mjs";

function mockReqRes({ method = "GET", body = null } = {}) {
  const payload = body == null ? null : JSON.stringify(body);
  let dataCb = null;
  let endCb = null;
  let fired = false;
  const req = {
    method,
    on(event, cb) {
      if (event === "data") dataCb = cb;
      if (event === "end") endCb = cb;
      if (event === "error") return req;
      if (dataCb && endCb && !fired) {
        fired = true;
        queueMicrotask(() => {
          if (payload != null) dataCb(payload);
          endCb();
        });
      }
      return req;
    },
  };
  let status = 0;
  let responsePayload = null;
  const res = {
    writeHead(code) { status = code; },
    end(buf) { responsePayload = JSON.parse(String(buf || "{}")); },
  };
  return {
    req,
    res,
    get result() { return { status, payload: responsePayload }; },
  };
}

async function withSystem(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-sys-"));
  const extensionStore = createExtensionStore({ dataDir });
  const system = createExtensionTaskSystem({ dataDir, configDir: dataDir, extensionStore });
  try {
    await fn({ system, extensionStore, dataDir });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test("create fails without online extension", async () => {
  await withSystem(async ({ system }) => {
    const http = mockReqRes({ method: "POST", body: { domain: "bilibili.com" } });
    await system.routeCookieExportViaExtension(http.req, http.res, {}, "/v1/cookies/export-via-extension");
    assert.equal(http.result.status, 409);
    assert.equal(http.result.payload.error.type, "no_online_extension");
  });
});

test("create + claim + complete happy path", async () => {
  await withSystem(async ({ system, extensionStore, dataDir }) => {
    extensionStore.register({ id: "ext1", name: "Leo", version: "1.1.0", capabilities: ["cookies"], permissions: [] });
    const createHttp = mockReqRes({ method: "POST", body: { domain: "example.com" } });
    await system.routeCookieExportViaExtension(createHttp.req, createHttp.res, {}, "/v1/cookies/export-via-extension");
    assert.equal(createHttp.result.status, 200, JSON.stringify(createHttp.result.payload));
    const taskId = createHttp.result.payload.task_id;
    assert.ok(taskId);
    assert.equal(createHttp.result.payload.poll_after_ms, 2000);
    assert.equal(createHttp.result.payload.max_polls_suggested, 30);

    const claimHttp = mockReqRes({ method: "POST", body: { extension_id: "ext1", capabilities: ["cookies"], limit: 1 } });
    await system.routeExtensionTaskRequest(claimHttp.req, claimHttp.res, {}, "/v1/extension-tasks/claim");
    assert.equal(claimHttp.result.status, 200);
    assert.equal(claimHttp.result.payload.tasks.length, 1);

    const completeHttp = mockReqRes({
      method: "POST",
      body: {
        extension_id: "ext1",
        cookies: [{ domain: ".example.com", path: "/", name: "sid", value: "1", secure: true, httpOnly: false, expirationDate: 1700000000 }],
      },
    });
    await system.routeExtensionTaskRequest(completeHttp.req, completeHttp.res, {}, `/v1/extension-tasks/${taskId}/complete`);
    assert.equal(completeHttp.result.status, 200);
    assert.equal(completeHttp.result.payload.task.status, "succeeded");
    assert.ok(fs.existsSync(completeHttp.result.payload.task.result.file_path));

    const getHttp = mockReqRes({ method: "GET" });
    await system.routeCookieExportViaExtension(getHttp.req, getHttp.res, {}, `/v1/cookies/export-via-extension/${taskId}`);
    assert.equal(getHttp.result.status, 200);
    assert.equal(getHttp.result.payload.status, "succeeded");
    assert.ok(fs.existsSync(getHttp.result.payload.result.file_path));
    assert.ok(getHttp.result.payload.result.file_path.startsWith(dataDir));
  });
});
