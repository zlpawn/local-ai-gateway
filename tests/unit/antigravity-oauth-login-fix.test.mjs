import { test } from "node:test";
import assert from "node:assert/strict";
import { openBrowser } from "../../lib/antigravity/auth-service.mjs";
import { buildAuthUrl } from "../../lib/antigravity/oauth.mjs";
import { REDIRECT_PORT } from "../../lib/antigravity/constants.mjs";
import {
  beginAntigravityLogin,
  getAntigravityLoginSession,
} from "../../lib/antigravity/auth-service.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveSecrets } from "../../lib/antigravity/token-store.mjs";

test("default OAuth callback port prefers uncommon 18789", () => {
  assert.equal(REDIRECT_PORT, 18789);
});

test("buildAuthUrl forces account chooser and keeps response_type", () => {
  const url = buildAuthUrl({
    clientId: "cid.apps.googleuser.test",
    redirectUri: "http://localhost:18080/callback",
    state: "st",
  });
  const u = new URL(url);
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("prompt"), "select_account consent");
});

test("openBrowser on Windows uses rundll32 FileProtocolHandler with full URL", () => {
  const calls = [];
  const url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=cid&response_type=code&scope=openid&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcallback";
  const ok = openBrowser(url, {
    platform: "win32",
    spawnImpl: (cmd, args) => {
      calls.push({ cmd, args });
      return { unref() {} };
    },
  });
  assert.equal(ok, true);
  assert.equal(calls[0].cmd, "rundll32");
  assert.equal(calls[0].args[0], "url.dll,FileProtocolHandler");
  assert.equal(calls[0].args[1], url);
  assert.match(calls[0].args[1], /response_type=code/);
});

test("beginAntigravityLogin returns full auth_url immediately", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-login-"));
  const env = { ANTIGRAVITY_SECRETS_FILE: path.join(dir, "antigravity.secrets.json") };
  saveSecrets({
    client_id: "9999999999-fakeclientid0fortesting0.apps.googleuser.test",
    client_secret: "FAKESEC-aaaaaaaaaaaaaaaaaaaaaaaaxAAA",
  }, env);

  const started = await beginAntigravityLogin({
    env,
    preferredPort: 19000,
    openBrowserImpl: () => true,
  });
  assert.equal(started.ok, true);
  assert.ok(started.session_id);
  assert.match(started.auth_url, /response_type=code/);
  assert.match(started.auth_url, /prompt=select_account/);
  assert.ok(started.callback_port >= 19000);

  // session should be waiting
  const session = getAntigravityLoginSession(started.session_id, { env });
  assert.equal(session.phase, "waiting");
});
