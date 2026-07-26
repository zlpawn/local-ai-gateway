import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { handleAntigravityCommand } from "../../lib/antigravity/index.mjs";

function tmpSecretsEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-cli-"));
  return path.join(dir, "antigravity.secrets.json");
}

function captureIo() {
  const lines = [];
  return { log: (...a) => lines.push(a.join(" ")), lines };
}

test("help subcommand prints usage with login and status", async () => {
  const old = process.env.ANTIGRAVITY_SECRETS_FILE;
  process.env.ANTIGRAVITY_SECRETS_FILE = tmpSecretsEnv();
  try {
    const io = captureIo();
    await handleAntigravityCommand({ subcommand: "help" }, io);
    const out = io.lines.join("\n");
    assert.match(out, /login/);
    assert.match(out, /status/);
  } finally {
    process.env.ANTIGRAVITY_SECRETS_FILE = old;
  }
});

test("status subcommand reports missing client_id when secrets empty", async () => {
  const old = process.env.ANTIGRAVITY_SECRETS_FILE;
  process.env.ANTIGRAVITY_SECRETS_FILE = tmpSecretsEnv();
  try {
    const io = captureIo();
    await handleAntigravityCommand({ subcommand: "status" }, io);
    const out = io.lines.join("\n");
    assert.match(out, /client_id/);
    assert.match(out, /\(missing\)/);
  } finally {
    process.env.ANTIGRAVITY_SECRETS_FILE = old;
  }
});

test("default subcommand falls back to help", async () => {
  const old = process.env.ANTIGRAVITY_SECRETS_FILE;
  process.env.ANTIGRAVITY_SECRETS_FILE = tmpSecretsEnv();
  try {
    const io = captureIo();
    await handleAntigravityCommand({}, io);
    assert.match(io.lines.join("\n"), /login/);
  } finally {
    process.env.ANTIGRAVITY_SECRETS_FILE = old;
  }
});