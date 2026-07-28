import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discoverInstalledClis,
  listCliCatalog,
} from "../../lib/cli/discovery.mjs";
import { CliInstallHistory } from "../../lib/cli/install-history.mjs";

test("cli catalog lists curated tools with stable fields", () => {
  const catalog = listCliCatalog();
  assert.ok(catalog.length >= 8);
  for (const entry of catalog) {
    assert.ok(entry.name, "name is required");
    assert.ok(entry.title, "title is required");
    assert.ok(entry.category, "category is required");
    assert.ok(entry.command, "command is required");
  }
  const names = catalog.map((e) => e.name);
  assert.ok(names.includes("codex"));
  assert.ok(names.includes("claude"));
  assert.ok(names.includes("node"));
});

test("discoverInstalledClis reports install status and respects query filter", () => {
  const all = discoverInstalledClis();
  assert.ok(all.items.length);
  assert.equal(all.stats.total, all.items.length + 0 || all.stats.total);
  assert.ok(all.stats.total >= 8);
  // node is essentially always present in a Node test run
  const nodeEntry = all.items.find((i) => i.name === "node");
  assert.ok(nodeEntry, "node should be in the catalog");
  assert.equal(nodeEntry.installed, true);
  assert.ok(nodeEntry.version, "node version should be probed");

  const filtered = discoverInstalledClis({ query: "node" });
  assert.ok(filtered.items.every((i) =>
    i.name.toLowerCase().includes("node") ||
    i.title.toLowerCase().includes("node") ||
    i.category.toLowerCase().includes("node")));
  assert.ok(filtered.stats.shown <= all.stats.total);
});

test("CliInstallHistory creates, finishes, lists and removes records in isolation from skills", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cli-hist-"));
  const prev = process.env.GATEWAY_DATA_DIR;
  process.env.GATEWAY_DATA_DIR = dir;
  try {
    const rec = CliInstallHistory.create({ command: "npm install -g fake-cli", cliName: "" });
    assert.equal(rec.status, "running");
    assert.equal(rec.cliName, null);
    assert.ok(rec.id);

    const finished = CliInstallHistory.finish(rec.id, { exitCode: 0, cliName: "fake-cli" });
    assert.equal(finished.status, "success");
    assert.equal(finished.cliName, "fake-cli");

    const list = CliInstallHistory.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, rec.id);

    assert.equal(CliInstallHistory.get(rec.id).exitCode, 0);

    const removed = CliInstallHistory.remove(rec.id);
    assert.equal(removed, true);
    assert.equal(CliInstallHistory.list().length, 0);

    assert.ok(CliInstallHistory.filePath().endsWith("cli-install-history.json"));
  } finally {
    process.env.GATEWAY_DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
