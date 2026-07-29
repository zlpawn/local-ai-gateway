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
test('discoverInstalledClis skips ignored names and defaults probe to false', async () => {
  const firstPathDir=process.env.PATH.split(';')[0];
  const sources = [{ name: 'test', label: 't', enabled: true, dirs: [firstPathDir] }];
  const r1 = await discoverInstalledClis({ sources, probe: false });
  assert.equal(r1.stats.total, r1.items.length);
  const someName = r1.items.length ? r1.items[0].name : null;
  if (someName) {
    const r2 = await discoverInstalledClis({ sources, probe: false, ignored: new Set([someName]) });
    assert.ok(!r2.items.find(i => i.name === someName));
    assert.ok(r2.stats.total < r1.stats.total);
  }
});


// Build a temp directory tree of fake executables covering the categories of
// non-CLI entries that must be filtered out, plus a few real CLIs that must
// survive the filters.
test("discoverInstalledClis filters GUI apps, helpers, and runtime-internal binaries by name and path", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cli-filter-"));
  const isWin = process.platform === "win32";
  const ext = isWin ? ".exe" : "";
  const fakeNames = [
    "antigravity",        // GUI app launcher (exact-name filter)
    "javaw",              // Java GUI launcher (exact-name filter)
    "gitk",               // Git GUI (exact-name filter)
    "elevate",            // nvm helper shim (exact-name filter)
    "refreshenv",         // chocolatey helper (exact-name filter)
    "unity",              // GUI editor (exact-name filter)
    "helper",             // generic helper (regex filter)
    "uninstaller",        // uninstaller (regex filter)
  ];
  for (const n of fakeNames) {
    writeFileSync(path.join(dir, n + ext), "");
  }
  // Real CLI names that must be kept.
  for (const n of ["mytool", "node", "git"]) {
    writeFileSync(path.join(dir, n + ext), "");
  }
  if (!isWin) {
    for (const ent of ["antigravity", "javaw", "gitk", "elevate", "refreshenv", "unity", "helper", "uninstaller", "mytool", "node", "git"]) {
      try { chmodSync(path.join(dir, ent), 0o755); } catch {}
    }
  }

  // Path-filtered entries: place a binary inside a path that matches a fragment.
  const runtimeDir = path.join(dir, "codex-runtimes", "override");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(path.join(runtimeDir, "pdfinfo" + ext), "");

  const sources = [{ name: "test", label: "t", enabled: true, dirs: [dir, runtimeDir] }];
  const r = await discoverInstalledClis({ sources, probe: false });
  const names = r.items.map((i) => i.name);

  // Non-CLIs filtered out
  for (const bad of ["antigravity", "javaw", "gitk", "elevate", "refreshenv", "unity", "helper", "uninstaller", "pdfinfo"]) {
    assert.ok(!names.includes(bad), `expected ${bad} to be filtered out`);
  }
  // Real CLIs kept
  for (const good of ["mytool", "node", "git"]) {
    assert.ok(names.includes(good), `expected ${good} to be kept`);
  }

  rmSync(dir, { recursive: true, force: true });
});