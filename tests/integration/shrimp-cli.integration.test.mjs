import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, "../..");
const cliPath = path.join(rootDir, "bin", "shrimp.js");

async function run(args, env = {}) {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: rootDir,
    env: { ...process.env, ...env },
    timeout: 20_000,
    windowsHide: true,
  });
  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

test("agent bootstrap flow: init -> endpoint add -> doctor", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "shrimp-cli-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const init = await run(["init", "--data-dir", dataDir]);
  const initJson = JSON.parse(init.stdout);
  assert.equal(initJson.ok, true);

  const add = await run([
    "endpoint", "add",
    "--data-dir", dataDir,
    "--client", "code",
    "--name", "openrouter",
    "--type", "openai-chat",
    "--base-url", "https://example.com/v1/chat/completions",
    "--models", "glm-5.2",
    "--api-key", "sk-test",
  ]);
  const addJson = JSON.parse(add.stdout);
  assert.equal(addJson.ok, true);
  assert.equal(addJson.data.endpoint.secret_state, "stored");

  const doctor = await run(["doctor", "--data-dir", dataDir, "--port", "8798"]);
  const doctorJson = JSON.parse(doctor.stdout);
  assert.equal(doctorJson.ok, true);
  assert.equal(doctorJson.data.config.valid, true);
  assert.ok(doctorJson.data.endpoints.some((ep) => ep.name === "openrouter"));
});