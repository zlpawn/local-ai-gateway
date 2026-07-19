import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { syncClaudeCodeSettings } from "../../lib/config/claude-code-settings.mjs";

test("Claude Code settings sync preserves unrelated settings and writes generated model slots", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "claude-code-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({
    theme: "dark",
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "keep-me" }] }] },
    env: {
      KEEP_ME: "yes",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "stale-model",
      ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: "stale-model",
    },
  }, null, 2));

  const result = syncClaudeCodeSettings({
    settingsPath,
    config: {
      server: { host: "127.0.0.1", port: 8787 },
      clients: {
        code: {
          model_slots: {
            opus: "minimax-m3",
            sonnet: "glm-5.2",
            fable: "deepseek-v4-pro",
          },
          endpoints: [{
            id: "ep_exact",
            name: "huoshan-codingplan",
            is_default: true,
            models: ["glm-5.2", "minimax-m3", "deepseek-v4-pro"],
          }],
        },
      },
    },
  });

  assert.equal(result.updated, true);
  assert.equal(result.path, settingsPath);
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(settings.theme, "dark");
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, "keep-me");
  assert.equal(settings.env.KEEP_ME, "yes");
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8787/code");
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "all");
  assert.equal(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
  assert.equal(
    settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    "anthropic.gateway.ep_exact.minimax-m3",
  );
  assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, "minimax-m3");
  assert.equal(
    settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    "anthropic.gateway.ep_exact.glm-5.2",
  );
  assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, "glm-5.2");
  assert.equal(
    settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL,
    "anthropic.gateway.ep_exact.deepseek-v4-pro",
  );
  assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME, "deepseek-v4-pro");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
  assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME, undefined);
});

test("Claude Code settings sync rejects a slot model outside the default endpoint", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "claude-code-settings-invalid-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, "settings.json");
  await writeFile(settingsPath, "{}");

  const result = syncClaudeCodeSettings({
    settingsPath,
    config: {
      clients: {
        code: {
          model_slots: { opus: "not-configured" },
          endpoints: [{
            id: "ep_exact",
            is_default: true,
            models: ["minimax-m3"],
          }],
        },
      },
    },
  });

  assert.equal(result.updated, false);
  assert.equal(result.reason, "invalid-model-slot");
  assert.equal(result.slot, "opus");
});

test("Claude Code settings sync can use the gateway process listen URL", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "claude-code-settings-port-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, "settings.json");
  await writeFile(settingsPath, "{}");

  const result = syncClaudeCodeSettings({
    settingsPath,
    gatewayBaseUrl: "http://127.0.0.1:8788/code",
    config: {
      server: { host: "127.0.0.1", port: 8787 },
      clients: {
        code: {
          endpoints: [{
            id: "ep_exact",
            is_default: true,
            models: ["minimax-m3"],
          }],
        },
      },
    },
  });

  assert.equal(result.updated, true);
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8788/code");
});

test("Claude Code settings sync ignores vision fallback endpoints for default selection", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "claude-code-settings-vision-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, "settings.json");
  await writeFile(settingsPath, "{}");

  const result = syncClaudeCodeSettings({
    settingsPath,
    config: {
      clients: {
        code: {
          endpoints: [{
            id: "ep_vision",
            purpose: "vision_fallback",
            vision_model: "vision-pro",
            models: ["vision-pro"],
          }],
        },
      },
    },
  });

  assert.equal(result.updated, false);
  assert.equal(result.reason, "no-code-endpoints");
});
