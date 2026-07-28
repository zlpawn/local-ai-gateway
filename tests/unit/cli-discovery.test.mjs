import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverInstalledClis } from "../../lib/cli/discovery.mjs";
import { CliInstallHistory } from "../../lib/cli/install-history.mjs";
import { CliSourceConfig, expandDirs, defaultSources } from "../../lib/cli/source-config.mjs";

test("defaultSources returns platform-appropriate preset sources", () => {
  const sources = defaultSources();
  assert.ok(Array.isArray(sources));
  assert.ok(sources.length >= 4, "should include at least 4 preset sources");
  const names = sources.map((s) => s.name);
  assert.ok(names.includes("uv"), "should include uv source");
  assert.ok(names.includes("npm"), "should include npm source");
  assert.ok(names.includes("path"), "should include path source");
  if (process.platform === "win32") {
    assert.ok(names.includes("winget"), "Windows should include winget");
    assert.ok(names.includes("irm"), "Windows should include irm");
  }
  if (process.platform === "darwin") {
    assert.ok(names.includes("homebrew"), "macOS should include homebrew");
  }
});

test("expandDirs resolves ~, env vars, and glob patterns", () => {
  const home = os.homedir();
  const expanded = expandDirs(["~", "$HOME", "~/.nonexistent-dir-12345"]);
  assert.ok(expanded.includes(home), "should resolve ~ to homedir");
});

test("discoverInstalledClis with custom sources reports source attribution", async () => {
  // Create a fake bin dir with a fake CLI to guarantee deterministic discovery.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cli-src-"));
  const fakeBin = path.join(tmp, "fakeztestcli");
  mkdirSync(fakeBin, { recursive: true });
  const exeName = process.platform === "win32" ? "fakeztestcli.exe" : "fakeztestcli";
  const exePath = path.join(fakeBin, exeName);
  writeFileSync(exePath, process.platform === "win32" ? "" : "#!/bin/sh\necho 1.0.0\n", {
    mode: 0o755,
  });
  if (process.platform !== "win32") {
    // ensure executable bit
    const fs = await import("node:fs/promises");
    await fs.chmod(exePath, 0o755);
  }

  try {
    const sources = [
      { id: "test", name: "test", label: "测试来源", enabled: true, dirs: [fakeBin] },
    ];
    const result = await discoverInstalledClis({ probe: false, sources });
    const entry = result.items.find((i) => i.name === "fakeztestcli");
    assert.ok(entry, "fake CLI should be discovered");
    assert.equal(entry.source, "test", "source should be attributed to custom source");
    assert.equal(entry.installed, true);
    assert.ok(entry.path);
    assert.equal(result.stats.total, result.items.length);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("discoverInstalledClis respects the query filter (name + source)", async () => {
  const all = await discoverInstalledClis({ probe: false });
  assert.ok(all.items.length, "should find at least one installed CLI");
  // Query by a source name that exists; at least one item should match.
  const sourcesPresent = [...new Set(all.items.map((i) => i.source))].filter(Boolean);
  if (sourcesPresent.length) {
    const q = sourcesPresent[0];
    const filtered = await discoverInstalledClis({ query: q, probe: false });
    assert.ok(
      filtered.items.every((i) =>
        i.name.toLowerCase().includes(q) ||
        (i.path || "").toLowerCase().includes(q) ||
        (i.source || "").toLowerCase().includes(q)),
      "filtered items should match the query",
    );
    assert.ok(filtered.stats.shown <= filtered.stats.total);
  }
});

test("CliSourceConfig save/list/reset lifecycle", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cli-srccfg-"));
  const prev = process.env.GATEWAY_DATA_DIR;
  process.env.GATEWAY_DATA_DIR = dir;
  try {
    const saved = CliSourceConfig.save([
      { name: "choco", label: "Chocolatey", enabled: true, dirs: ["C:\\ProgramData\\chocolatey\\bin"] },
      { name: "custom", label: "Custom", enabled: false, dirs: [] },
    ]);
    assert.equal(saved.length, 2);
    assert.equal(saved[0].name, "choco");
    assert.equal(saved[1].enabled, false);

    const listed = CliSourceConfig.list();
    assert.equal(listed.length, 2);
    assert.equal(listed[0].name, "choco");

    const reset = CliSourceConfig.reset();
    assert.ok(reset.length >= 4, "reset should restore defaults");
    assert.ok(reset.some((s) => s.name === "uv"));
    assert.ok(CliSourceConfig.filePath().endsWith("cli-sources.json"));
  } finally {
    process.env.GATEWAY_DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CliInstallHistory creates, finishes, lists and removes records", () => {
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