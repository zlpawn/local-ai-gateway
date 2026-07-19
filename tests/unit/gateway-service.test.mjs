import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildGatewayEnvironment,
  buildRuntimePaths,
  legacyPidMatchesHealth,
  metadataMatchesHealth,
  parseGatewayArgs,
  parseListeningPid,
  pidMetadataMatchesHealth,
  recoverMetadataFromHealth,
  resolveGatewayPort,
  processProbeIndicatesRunning,
} from "../../lib/cli/gateway-service.mjs";

test("gateway arguments keep the command simple while supporting isolated ports", () => {
  assert.deepEqual(
    parseGatewayArgs(["restart", "--root", ".", "--port", "8788", "--runtime-dir", "tmp"]),
    {
      command: "restart",
      rootDir: ".",
      runtimeDir: "tmp",
      port: 8788,
      force: false,
      testMode: false,
    },
  );
});

test("test mode defaults to port 8788 and an isolated runtime directory", async () => {
  const options = parseGatewayArgs(["start", "--test"]);
  assert.equal(options.testMode, true);
  assert.equal(options.port, 0);
  assert.equal(
    await resolveGatewayPort("D:\\gateway", {
      cliPort: options.port,
      testMode: options.testMode,
      env: {},
    }),
    8788,
  );
});

test("gateway port prefers CLI, then environment, then config", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "gateway-service-port-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await writeFile(
    path.join(rootDir, "gateway.config.json"),
    JSON.stringify({ server: { port: 8999 } }),
  );

  assert.equal(await resolveGatewayPort(rootDir, { cliPort: 8788, env: { GATEWAY_PORT: "8777" } }), 8788);
  assert.equal(await resolveGatewayPort(rootDir, { env: { GATEWAY_PORT: "8777" } }), 8777);
  assert.equal(await resolveGatewayPort(rootDir, { env: {} }), 8999);
});

test("runtime files are isolated from project configuration", () => {
  const paths = buildRuntimePaths("C:\\temp\\gateway-runtime");
  assert.equal(paths.pidFile, path.resolve("C:\\temp\\gateway-runtime", "gateway.pid.json"));
  assert.equal(paths.stdoutLog, path.resolve("C:\\temp\\gateway-runtime", "gateway.stdout.log"));
  assert.equal(paths.stderrLog, path.resolve("C:\\temp\\gateway-runtime", "gateway.stderr.log"));
});

test("stop only trusts health from the exact gateway instance", () => {
  const metadata = { pid: 123, port: 8788, instanceId: "instance-a" };
  assert.equal(pidMetadataMatchesHealth(metadata, { ok: true, instance_id: "instance-a" }), true);
  assert.equal(pidMetadataMatchesHealth(metadata, { ok: true, instance_id: "instance-b" }), false);
  assert.equal(pidMetadataMatchesHealth(metadata, { ok: true }), false);
});

test("legacy PID migration only accepts a recognizable gateway health payload", () => {
  assert.equal(
    legacyPidMatchesHealth({
      ok: true,
      client: "claude",
      protocol: "anthropic-messages",
      models: ["claude-sonnet"],
    }),
    true,
  );
  assert.equal(legacyPidMatchesHealth({ ok: true }), false);
  assert.equal(legacyPidMatchesHealth(null), false);
});

test("managed metadata selects strict or legacy health matching consistently", () => {
  assert.equal(
    metadataMatchesHealth(
      { pid: 123, port: 8788, instanceId: "instance-a" },
      { ok: true, instance_id: "instance-a" },
    ),
    true,
  );
  assert.equal(
    metadataMatchesHealth(
      { pid: 123, port: 8788, legacy: true },
      {
        ok: true,
        client: "unknown",
        protocol: "anthropic-messages",
        models: [],
      },
    ),
    true,
  );
});

test("managed metadata can be recovered from health when the PID file is missing", () => {
  assert.deepEqual(
    recoverMetadataFromHealth(8788, {
      ok: true,
      service: "local-ai-gateway",
      process_id: 456,
      instance_id: "instance-b",
    }),
    {
      pid: 456,
      port: 8788,
      instanceId: "instance-b",
      recovered: true,
    },
  );
  assert.equal(recoverMetadataFromHealth(8788, { ok: true, process_id: 456 }), null);
});

test("listener PID parsing is scoped to the requested port", () => {
  const windows = [
    "  TCP    127.0.0.1:8787    0.0.0.0:0    LISTENING    36148",
    "  TCP    127.0.0.1:8788    0.0.0.0:0    LISTENING    44200",
  ].join("\r\n");
  assert.equal(parseListeningPid(windows, 8788, "win32"), 44200);
  assert.equal(parseListeningPid("44200\n", 8788, "darwin"), 44200);
  assert.equal(parseListeningPid("", 8788, "linux"), 0);
});

test("permission denied while probing a PID means the process still exists", () => {
  assert.equal(processProbeIndicatesRunning(null), true);
  assert.equal(processProbeIndicatesRunning({ code: "EPERM" }), true);
  assert.equal(processProbeIndicatesRunning({ code: "ESRCH" }), false);
});

test("test environment disables browser and client config synchronization", () => {
  const env = buildGatewayEnvironment("D:\\gateway", {
    baseEnv: { NODE_ENV: "test" },
    port: 8788,
    instanceId: "test-instance",
    configPath: "D:\\gateway\\gateway.config.json",
    runtimeDir: "D:\\runtime",
  });

  assert.equal(env.GATEWAY_PORT, "8788");
  assert.equal(env.GATEWAY_INSTANCE_ID, "test-instance");
  assert.equal(env.GATEWAY_NO_OPEN, "1");
  assert.equal(env.CLAUDE_3P_SYNC_DISABLED, "1");
  assert.equal(env.CLAUDE_CODE_SYNC_DISABLED, "1");
  assert.equal(env.CODEX_WRITE_MODEL_CATALOG_DISABLED, "1");
  assert.equal(env.LOG_FILE, path.resolve("D:\\runtime", "gateway.log"));
});
