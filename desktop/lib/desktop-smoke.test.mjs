import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import vm from "node:vm";

import { findAvailablePort, findDesktopExecutable, getDefaultSmokePort } from "./desktop-smoke.mjs";

const ROOT = path.resolve(".");

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

test("config panel exposes Codex tools, reasoning, and image capabilities", async () => {
  const html = await readFile(
    path.join(ROOT, "desktop", "config-panel.html"),
    "utf8",
  );
  assert.match(html, /Codex 能力/);
  assert.match(html, /capabilities-input-image/);
  assert.match(html, /capabilities-reasoning/);
  assert.match(html, /capabilities-tools/);
  assert.match(html, /wire_api = "responses"/);
});

test("config panel supports stable endpoint ids, secret status, exposure, and conflict suggestions", async () => {
  const html = await readFile(path.join(ROOT, "desktop", "config-panel.html"), "utf8");
  assert.match(html, /crypto\.randomUUID\(\)/);
  assert.match(html, /readonly[^>]*endpoint-id|endpoint-id[^>]*readonly/);
  assert.match(html, /has_api_key/);
  assert.match(html, /expose_models/);
  assert.match(html, /duplicate_public_model/);
  assert.match(html, /suggestion/);
  assert.match(html, /delete endpoint\.api_key/);
  assert.match(html, /createTemplateEndpoint/);
  assert.doesNotMatch(html, /codex:\s*\{\s*endpoints:\s*\[JSON\.parse/);
});

test("endpoint detail provides an explicit manual save action", async () => {
  const html = await readFile(path.join(ROOT, "desktop", "config-panel.html"), "utf8");
  assert.match(html, /id="save-node-\$\{client\}-\$\{index\}"/);
  assert.match(html, /onclick="saveNode\('\$\{client\}', \$\{index\}\)"/);
  assert.match(html, /window\.saveNode\s*=\s*async function/);
  assert.match(html, /saveConfig\(\{\s*button:\s*btn,\s*client,\s*scope:\s*'node'/);
});

test("endpoint cards expose a compact model visibility switch outside the detail form", async () => {
  const html = await readFile(path.join(ROOT, "desktop", "config-panel.html"), "utf8");
  assert.match(html, /\.detail-actions\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*nowrap/s);
  assert.match(html, /class="detail-actions"/);
  assert.match(html, /class="node-card-switch"/);
  assert.match(html, /class="node-card-switch-track"/);
  assert.match(html, /toggleEndpointExposure\(event,\s*'\$\{client\}',\s*\$\{index\},\s*this\)/);
  assert.match(html, /window\.toggleEndpointExposure\s*=\s*async function/);
  assert.doesNotMatch(html, /class="form-group full model-exposure-setting"/);
  assert.doesNotMatch(html, /accent-color:\s*var\(--primary\)/);
});

test("Codex capability updates preserve unrelated fields and do not copy secrets", async () => {
  const sentinel = "sk-task7-ui-must-not-copy";
  const config = {
    future_root: { enabled: true },
    clients: {
      code: { endpoints: [{ name: "other-client", future: "keep" }] },
      codex: {
        future_client: "keep",
        endpoints: [
          {
            name: "target",
            api_key: sentinel,
            future_endpoint: { keep: true },
            capabilities: {
              input_modalities: ["text"],
              reasoning: false,
              tools: true,
              future_capability: "keep",
            },
          },
          { name: "other-endpoint", future: "keep" },
        ],
      },
    },
  };
  const otherClient = structuredClone(config.clients.code);
  const otherEndpoint = structuredClone(config.clients.codex.endpoints[1]);
  const html = await readFile(
    path.join(ROOT, "desktop", "config-panel.html"),
    "utf8",
  );
  const updateSource = html.match(
    /window\.updateCodexCapability = function\(client, index, capability, enabled\) \{[\s\S]*?\n        \}/,
  )?.[0];
  assert.equal(typeof updateSource, "string");
  const context = {
    config,
    window: {},
  };
  vm.runInNewContext(`${updateSource};
    window.updateCodexCapability("codex", 0, "image", true);
    window.updateCodexCapability("codex", 0, "reasoning", true);`, context);

  assert.equal(
    Array.from(
      config.clients.codex.endpoints[0].capabilities.input_modalities,
    ).join(","),
    "text,image",
  );
  assert.equal(config.clients.codex.endpoints[0].capabilities.reasoning, true);
  assert.equal(config.clients.codex.endpoints[0].future_endpoint.keep, true);
  assert.equal(config.clients.codex.endpoints[0].capabilities.future_capability, "keep");
  assert.deepEqual(config.clients.code, otherClient);
  assert.deepEqual(config.clients.codex.endpoints[1], otherEndpoint);
  assert.equal(config.clients.codex.endpoints[0].api_key, sentinel);
  assert.equal(JSON.stringify(config).split(sentinel).length - 1, 1);
});
