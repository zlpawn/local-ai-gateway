import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";

import { findAvailablePort, findDesktopExecutable, getDefaultSmokePort } from "./desktop-smoke.mjs";

test("findDesktopExecutable returns the expected Windows unpacked app path", () => {
  const root = path.resolve("D:/example gateway");
  const exe = findDesktopExecutable(root, "win32");

  assert.equal(exe, path.join(root, "dist", "win-unpacked", "Local AI Gateway.exe"));
});

test("findDesktopExecutable returns the expected macOS unpacked app binary path", () => {
  const root = path.resolve("/tmp/example-gateway");
  const exe = findDesktopExecutable(root, "darwin");

  assert.equal(
    exe,
    path.join(root, "dist", "mac", "Local AI Gateway.app", "Contents", "MacOS", "Local AI Gateway"),
  );
});

test("getDefaultSmokePort uses a high non-default port", () => {
  const port = getDefaultSmokePort();

  assert.equal(Number.isInteger(port), true);
  assert.equal(port > 1024, true);
  assert.notEqual(port, 8787);
});

test("findAvailablePort skips the preferred port when it is busy", async () => {
  const preferredPort = 19877;
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(preferredPort, "127.0.0.1", resolve);
  });

  try {
    const port = await findAvailablePort(preferredPort);
    assert.equal(port > preferredPort, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
