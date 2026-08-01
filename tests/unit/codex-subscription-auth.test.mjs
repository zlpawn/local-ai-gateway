import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decodeJwtPayload,
  extractCodexTokens,
  inspectAccessToken,
  readCodexAuthFile,
  resolveCodexAuthPath,
  writeCodexAuthTokens,
  ensureFreshCodexAuth,
} from "../../lib/codex/local-auth.mjs";
import {
  getCodexAuthStatus,
  discoverCodexLocalAuth,
} from "../../lib/codex/subscription-auth.mjs";
import {
  listProviders,
  getProviderStatus,
  runProviderAction,
} from "../../lib/subscription-auth/index.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-"));
}

function fakeJwt({ expOffsetSec = 3600, client_id = "app_test" } = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + expOffsetSec,
    client_id,
  })).toString("base64url");
  return `${header}.${payload}.sig`;
}

test("resolveCodexAuthPath expands default and custom paths", () => {
  const home = "C:\\\\Users\\\\demo";
  assert.equal(
    resolveCodexAuthPath({ home, env: {} }),
    path.join(home, ".codex", "auth.json"),
  );
  assert.equal(
    resolveCodexAuthPath({ authPath: "~/.codex/custom-auth.json", home, env: {} }),
    path.join(home, ".codex", "custom-auth.json"),
  );
});

test("extract/inspect tokens from chatgpt auth.json shape", () => {
  const token = fakeJwt({ expOffsetSec: 120 });
  const tokens = extractCodexTokens({
    auth_mode: "chatgpt",
    tokens: {
      access_token: token,
      refresh_token: "rt.demo",
      account_id: "acc-1",
    },
    last_refresh: "2026-08-01T00:00:00.000Z",
  });
  assert.equal(tokens.account_id, "acc-1");
  assert.equal(tokens.refresh_token, "rt.demo");
  const access = inspectAccessToken(token);
  assert.equal(access.expired, false);
  assert.ok(access.expires_in_seconds > 0);
  assert.equal(decodeJwtPayload(token).client_id, "app_test");
});

test("status reports ready when local auth exists", () => {
  const dir = tmpDir();
  const authPath = path.join(dir, "auth.json");
  fs.writeFileSync(authPath, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: fakeJwt({ expOffsetSec: 600 }),
      refresh_token: "rt.demo",
      account_id: "acc-ready",
    },
    last_refresh: "2026-08-01T00:00:00.000Z",
  }));
  const status = getCodexAuthStatus({
    env: { CODEX_AUTH_PATH: authPath },
    config: {
      clients: {
        desktop: {
          endpoints: [{ id: "ep1", type: "codex-subscription", models: ["gpt-5.4"] }],
        },
      },
    },
  });
  assert.equal(status.provider, "codex");
  assert.equal(status.state, "ready");
  assert.equal(status.token.account_id, "acc-ready");
  assert.equal(status.nodes.count, 1);
});

test("discover fails when auth file missing", () => {
  const dir = tmpDir();
  const result = discoverCodexLocalAuth({
    env: { CODEX_AUTH_PATH: path.join(dir, "missing-auth.json") },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "auth_not_found");
});

test("subscription-auth registry lists codex and supports discover", async () => {
  const providers = listProviders();
  assert.ok(providers.some((p) => p.id === "codex"));
  const dir = tmpDir();
  const authPath = path.join(dir, "auth.json");
  fs.writeFileSync(authPath, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: fakeJwt({ expOffsetSec: 600 }),
      refresh_token: "rt.demo",
      account_id: "acc-2",
    },
  }));
  const status = getProviderStatus("codex", {
    env: { CODEX_AUTH_PATH: authPath },
  });
  assert.equal(status.provider, "codex");
  const discovered = await runProviderAction("codex", "discover", {
    env: { CODEX_AUTH_PATH: authPath },
  });
  assert.equal(discovered.ok, true);
  assert.equal(discovered.status.token.account_id, "acc-2");
});

test("ensureFreshCodexAuth refreshes near-expiry token and rewrites auth.json", async () => {
  const dir = tmpDir();
  const authPath = path.join(dir, "auth.json");
  const oldAccess = fakeJwt({ expOffsetSec: 30 });
  fs.writeFileSync(authPath, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: oldAccess,
      refresh_token: "rt.old",
      account_id: "acc-refresh",
    },
  }));
  const newAccess = fakeJwt({ expOffsetSec: 7200, client_id: "app_new" });
  const fresh = await ensureFreshCodexAuth({
    authPath,
    skewSeconds: 300,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: newAccess,
        refresh_token: "rt.new",
        id_token: "id.new",
        expires_in: 7200,
      }),
    }),
  });
  assert.equal(fresh.accessToken, newAccess);
  assert.equal(fresh.source, "auth_file_refreshed");
  const rewritten = JSON.parse(fs.readFileSync(authPath, "utf8"));
  assert.equal(rewritten.tokens.access_token, newAccess);
  assert.equal(rewritten.tokens.refresh_token, "rt.new");
  assert.equal(rewritten.tokens.account_id, "acc-refresh");
});

test("readCodexAuthFile reports invalid json", () => {
  const dir = tmpDir();
  const authPath = path.join(dir, "auth.json");
  fs.writeFileSync(authPath, "{bad");
  const loaded = readCodexAuthFile({ authPath });
  assert.equal(loaded.ok, false);
  assert.equal(loaded.code, "auth_invalid");
});

test("writeCodexAuthTokens preserves unrelated fields", () => {
  const dir = tmpDir();
  const authPath = path.join(dir, "auth.json");
  fs.writeFileSync(authPath, JSON.stringify({
    auth_mode: "chatgpt",
    keep_me: true,
    tokens: { access_token: "a", refresh_token: "r", account_id: "acc" },
  }));
  writeCodexAuthTokens({
    authPath,
    tokens: { access_token: "a2" },
  });
  const next = JSON.parse(fs.readFileSync(authPath, "utf8"));
  assert.equal(next.keep_me, true);
  assert.equal(next.tokens.access_token, "a2");
  assert.equal(next.tokens.refresh_token, "r");
});
