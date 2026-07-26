import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSecrets, saveSecrets, getSecretsPath, getClientCredentials, getStoredToken } from "../../lib/antigravity/token-store.mjs";

function tmpEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-secrets-"));
  return { dir, env: { ANTIGRAVITY_SECRETS_FILE: path.join(dir, "antigravity.secrets.json") } };
}

test("getSecretsPath honors ANTIGRAVITY_SECRETS_FILE", () => {
  const { env } = tmpEnv();
  assert.equal(getSecretsPath(env), env.ANTIGRAVITY_SECRETS_FILE);
});

test("getSecretsPath defaults to config dir when env unset", () => {
  const env = { GATEWAY_CONFIG_FILE: "/some/dir/gateway.config.json" };
  assert.equal(getSecretsPath(env), path.join("/some/dir", "antigravity.secrets.json"));
});

test("loadSecrets returns empty when file missing", () => {
  const { env } = tmpEnv();
  assert.deepEqual(loadSecrets(env), {});
});

test("saveSecrets writes and merges fields, loadSecrets reads them back", () => {
  const { env } = tmpEnv();
  saveSecrets({ client_id: "cid", client_secret: "csec" }, env);
  saveSecrets({ access_token: "tok", refresh_token: "rt", expires_at: 123, account_id: "u@x.com" }, env);
  const s = loadSecrets(env);
  assert.equal(s.client_id, "cid");
  assert.equal(s.client_secret, "csec");
  assert.equal(s.access_token, "tok");
  assert.equal(s.refresh_token, "rt");
  assert.equal(s.expires_at, 123);
  assert.equal(s.account_id, "u@x.com");
});

test("saveSecrets only persists known fields", () => {
  const { env } = tmpEnv();
  saveSecrets({ client_id: "cid", bogus: "evil" }, env);
  const raw = JSON.parse(fs.readFileSync(env.ANTIGRAVITY_SECRETS_FILE, "utf8"));
  assert.equal(raw.bogus, undefined);
  assert.equal(raw.client_id, "cid");
});

test("getClientCredentials throws when missing", () => {
  const { env } = tmpEnv();
  assert.throws(() => getClientCredentials(env), /client_id\/client_secret missing/);
});

test("getClientCredentials returns creds when set", () => {
  const { env } = tmpEnv();
  saveSecrets({ client_id: "cid", client_secret: "csec" }, env);
  assert.deepEqual(getClientCredentials(env), { client_id: "cid", client_secret: "csec" });
});

test("getStoredToken returns defaults when empty", () => {
  const { env } = tmpEnv();
  const t = getStoredToken(env);
  assert.equal(t.access_token, "");
  assert.equal(t.refresh_token, "");
  assert.equal(t.expires_at, 0);
  assert.equal(t.account_id, "");
});