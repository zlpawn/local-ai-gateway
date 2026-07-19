import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, "../..");
const cliPath = path.join(rootDir, "scripts", "gateway.mjs");
const testPort = 8788;

test("cross-platform gateway CLI manages an isolated gateway on port 8788", async (t) => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "gateway-cli-"));
  const env = {
    ...process.env,
    NODE_ENV: "test",
    GATEWAY_NO_OPEN: "1",
  };

  t.after(async () => {
    await run(["stop", "--root", rootDir, "--runtime-dir", runtimeDir, "--port", String(testPort), "--force"], env)
      .catch(() => {});
    await rm(runtimeDir, { recursive: true, force: true });
  });

  assert.equal(await isPortFree(testPort), true, `port ${testPort} must be free before this test`);

  const started = await run(
    ["start", "--test", "--root", rootDir, "--runtime-dir", runtimeDir],
    env,
  );
  assert.match(started.stdout, /Gateway started on 127\.0\.0\.1:8788/);

  const health = await fetch(`http://127.0.0.1:${testPort}/health`).then((response) => response.json());
  assert.equal(health.ok, true);
  assert.match(health.instance_id, /.+/);

  const metadata = JSON.parse(await readFile(path.join(runtimeDir, "gateway.pid.json"), "utf8"));
  assert.equal(metadata.port, testPort);
  assert.equal(metadata.instanceId, health.instance_id);

  const status = await run(
    ["status", "--test", "--root", rootDir, "--runtime-dir", runtimeDir],
    env,
  );
  assert.match(status.stdout, /Gateway listening on 127\.0\.0\.1:8788/);
  assert.match(status.stdout, /Health: ok=true/);

  const stopped = await run(
    ["stop", "--test", "--root", rootDir, "--runtime-dir", runtimeDir],
    env,
  );
  assert.match(stopped.stdout, /Gateway stopped/);
  await waitForPortFree(testPort);
  assert.equal(await isPortFree(testPort), true);
});

function run(args, env) {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: rootDir,
    env,
    timeout: 20_000,
    windowsHide: true,
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function waitForPortFree(port) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await isPortFree(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`port ${port} was not released`);
}
