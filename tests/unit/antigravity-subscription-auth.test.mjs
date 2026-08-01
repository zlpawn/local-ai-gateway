import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractClientIdsFromText,
  extractClientSecretsFromText,
  chooseCredentialPair,
  discoverAntigravityClientCredentials,
} from "../../lib/antigravity/client-discovery.mjs";
import {
  getAntigravityAuthStatus,
  saveAntigravityClientCredentials,
  discoverAndSaveAntigravityClientCredentials,
} from "../../lib/antigravity/auth-service.mjs";
import {
  listProviders,
  getProviderStatus,
  runProviderAction,
} from "../../lib/subscription-auth/index.mjs";
import { maskSecret } from "../../lib/subscription-auth/mask.mjs";

function tmpEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-auth-"));
  return {
    dir,
    env: { ANTIGRAVITY_SECRETS_FILE: path.join(dir, "antigravity.secrets.json") },
  };
}

test("maskSecret keeps edges and hides middle", () => {
  assert.equal(maskSecret("FAKESEC-aaaaaaaaaaaaaaaaaaaaaaaaxAAA", { keepStart: 7, keepEnd: 4 }), "FAKESEC-****qDAf");
});

test("extracts concatenated GOCSPX secrets from binary-like text", () => {
  const text = "xxFAKESEC-aaaaaaaaaaaaaaaaaaaaaaaaxAAA://";
  const secrets = extractClientSecretsFromText(text);
  assert.ok(secrets.includes("FAKESEC-aaaaaaaaaaaaaaaaaaaaaaaaxAAA"));
  assert.ok(secrets.includes("FAKESEC-aaaaaaaaaaaaaaaaaaaaaaaaxAAA"));
});

test("chooseCredentialPair prefers known Antigravity client id", () => {
  const pair = chooseCredentialPair(
    [
      "9999999999-fakeclientid0fortesting0.apps.googleuser.test",
      "9999999999-fakeclientid0fortesting0.apps.googleuser.test",
    ],
    ["FAKESEC-aaaaaaaaaaaaaaaaaaaaaaaaxAAA", "FAKESEC-aaaaaaaaaaaaaaaaaaaaaaaaxAAA"],
  );
  assert.equal(
    pair.client_id,
    "9999999999-fakeclientid0fortesting0.apps.googleuser.test",
  );
  assert.equal(pair.client_secret, "FAKESEC-aaaaaaaaaaaaaaaaaaaaaaaaxAAA");
});

test("extractClientIdsFromText finds googleusercontent client ids", () => {
  const ids = extractClientIdsFromText(
    "id=9999999999-fakeclientid0fortesting0.apps.googleuser.test;",
  );
  assert.deepEqual(ids, [
    "9999999999-fakeclientid0fortesting0.apps.googleuser.test",
  ]);
});

test("discoverAntigravityClientCredentials reports install_not_found", () => {
  const result = discoverAntigravityClientCredentials({
    candidates: [path.join(os.tmpdir(), "no-such-antigravity-install")],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "install_not_found");
});

test("discoverAntigravityClientCredentials extracts from provided install root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ag-install-"));
  const binDir = path.join(root, "resources", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  // Make resolveInstallRoot accept this root via resources dir.
  fs.writeFileSync(
    path.join(binDir, "language_server.exe"),
    [
      "noise",
      "9999999999-fakeclientid0fortesting0.apps.googleuser.test",
      "FAKESEC-aaaaaaaaaaaaaaaaaaaaaaaaxAAA",
      "tail",
    ].join(""),
  );

  const result = discoverAntigravityClientCredentials({
    candidates: [root],
  });
  assert.equal(result.ok, true);
  assert.equal(
    result.client_id,
    "9999999999-fakeclientid0fortesting0.apps.googleuser.test",
  );
  assert.equal(result.client_secret, "FAKESEC-aaaaaaaaaaaaaaaaaaaaaaaaxAAA");
});

test("auth status reports missing client and node presence", () => {
  const { env } = tmpEnv();
  const status = getAntigravityAuthStatus({
    env,
    config: {
      clients: {
        codex: {
          endpoints: [{ id: "ep1", name: "Antigravity", type: "antigravity", models: ["m1"] }],
        },
      },
    },
    discover: () => ({
      ok: false,
      code: "install_not_found",
      message: "missing",
      install_root: null,
      scanned_files: [],
    }),
  });
  assert.equal(status.state, "missing_client");
  assert.equal(status.nodes.configured, true);
  assert.equal(status.nodes.count, 1);
  assert.equal(status.client.configured, false);
});

test("save and discover-save write client credentials", () => {
  const { env } = tmpEnv();
  const status = saveAntigravityClientCredentials(
    {
      client_id: "9999999999-fakeclientid0fortesting0.apps.googleuser.test",
      client_secret: "FAKESEC-aaaaaaaaaaaaaaaaaaaaaaaaxAAA",
    },
    { env },
  );
  assert.equal(status.client.configured, true);
  assert.equal(status.state, "ready_to_login");

  const discovered = discoverAndSaveAntigravityClientCredentials({
    env,
    discover: () => ({
      ok: true,
      code: "ok",
      message: "ok",
      install_root: "C:/fake",
      scanned_files: [],
      client_id: "9999999999-fakeclientid0fortesting0.apps.googleuser.test",
      client_secret: "FAKESEC-aaaaaaaaaaaaaaaaaaaaaaaaxAAA",
    }),
  });
  assert.equal(discovered.ok, true);
  assert.equal(discovered.saved, true);
  assert.equal(discovered.status.client.configured, true);
  assert.equal(discovered.client_secret, undefined);
});

test("subscription-auth registry lists antigravity and supports status action", async () => {
  const providers = listProviders();
  assert.ok(providers.some((p) => p.id === "antigravity"));
  const { env } = tmpEnv();
  const status = getProviderStatus("antigravity", {
    env,
    discover: () => ({
      ok: false,
      code: "install_not_found",
      message: "missing",
      install_root: null,
      scanned_files: [],
    }),
  });
  assert.equal(status.provider, "antigravity");

  const saved = await runProviderAction("antigravity", "save-client", {
    env,
    payload: {
      client_id: "9999999999-fakeclientid0fortesting0.apps.googleuser.test",
      client_secret: "FAKESEC-aaaaaaaaaaaaaaaaaaaaaaaaxAAA",
    },
  });
  assert.equal(saved.client.configured, true);
});
