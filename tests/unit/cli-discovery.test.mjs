import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverInstalledClis, __test__ } from "../../lib/cli/discovery.mjs";
import { CliInstallHistory } from "../../lib/cli/install-history.mjs";
import { CliSourceConfig, expandDirs, defaultSources } from "../../lib/cli/source-config.mjs";

const { isIgnoredPath, classifyTier, isSatelliteCliName } = __test__;

function writeExe(dir, name) {
  const isWin = process.platform === "win32";
  const file = path.join(dir, isWin ? `${name}.exe` : name);
  writeFileSync(file, isWin ? "" : "#!/bin/sh\necho 1.0.0\n");
  if (!isWin) {
    try { chmodSync(file, 0o755); } catch {}
  }
  return file;
}

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
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cli-src-"));
  const fakeBin = path.join(tmp, "fakeztestcli");
  mkdirSync(fakeBin, { recursive: true });
  writeExe(fakeBin, "fakeztestcli");

  try {
    const sources = [
      { id: "test", name: "test", label: "测试来源", enabled: true, dirs: [fakeBin] },
    ];
    const result = await discoverInstalledClis({ probe: false, sources, view: "all" });
    const entry = result.items.find((i) => i.name === "fakeztestcli");
    assert.ok(entry, "fake CLI should be discovered");
    assert.equal(entry.source, "test", "source should be attributed to custom source");
    assert.equal(entry.installed, true);
    assert.equal(entry.tier, "recommended", "custom source installs are recommended");
    assert.ok(entry.path);
    assert.equal(result.stats.total, result.items.length);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("discoverInstalledClis respects the query filter (name + source)", async () => {
  const all = await discoverInstalledClis({ probe: false, view: "all" });
  assert.ok(all.items.length, "should find at least one installed CLI");
  const sourcesPresent = [...new Set(all.items.map((i) => i.source))].filter(Boolean);
  if (sourcesPresent.length) {
    const q = sourcesPresent[0];
    const filtered = await discoverInstalledClis({ query: q, probe: false, view: "all" });
    assert.ok(
      filtered.items.every((i) =>
        i.name.toLowerCase().includes(q) ||
        (i.path || "").toLowerCase().includes(q) ||
        (i.source || "").toLowerCase().includes(q) ||
        (i.tier || "").toLowerCase().includes(q)),
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

test("discoverInstalledClis skips ignored names and defaults probe to false", async () => {
  const sep = process.platform === "win32" ? ";" : ":";
  const firstPathDir = (process.env.PATH || process.env.Path || "").split(sep)[0];
  const sources = [{ name: "test", label: "t", enabled: true, dirs: [firstPathDir] }];
  const r1 = await discoverInstalledClis({ sources, probe: false, view: "all" });
  assert.equal(r1.stats.total, r1.items.length);
  const someName = r1.items.length ? r1.items[0].name : null;
  if (someName) {
    const r2 = await discoverInstalledClis({ sources, probe: false, ignored: new Set([someName]), view: "all" });
    assert.ok(!r2.items.find((i) => i.name === someName));
    assert.ok(r2.stats.total < r1.stats.total);
  }
});

test("discoverInstalledClis filters GUI apps, helpers, and runtime-internal binaries by name and path", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cli-filter-"));
  const isWin = process.platform === "win32";
  const ext = isWin ? ".exe" : "";
  const fakeNames = [
    "antigravity",
    "javaw",
    "gitk",
    "elevate",
    "refreshenv",
    "helper",
    "uninstaller",
  ];
  for (const n of fakeNames) {
    writeFileSync(path.join(dir, n + ext), "");
  }
  for (const n of ["mytool", "node", "git"]) {
    writeFileSync(path.join(dir, n + ext), "");
  }
  if (!isWin) {
    for (const ent of ["antigravity", "javaw", "gitk", "elevate", "refreshenv", "helper", "uninstaller", "mytool", "node", "git"]) {
      try { chmodSync(path.join(dir, ent), 0o755); } catch {}
    }
  }

  const runtimeDir = path.join(dir, "codex-runtimes", "override");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(path.join(runtimeDir, "pdfinfo" + ext), "");

  const sources = [{ name: "test", label: "t", enabled: true, dirs: [dir, runtimeDir] }];
  const r = await discoverInstalledClis({ sources, probe: false, view: "all" });
  const names = r.items.map((i) => i.name);

  for (const bad of ["antigravity", "javaw", "gitk", "elevate", "refreshenv", "helper", "uninstaller", "pdfinfo"]) {
    assert.ok(!names.includes(bad), `expected ${bad} to be filtered out`);
  }
  for (const good of ["mytool", "node", "git"]) {
    assert.ok(names.includes(good), `expected ${good} to be kept`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("discoverInstalledClis hard-filters Git/MinGW toolchain dumps", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cli-mingw-"));
  try {
    const gitBin = path.join(root, "Git", "cmd");
    const mingwBin = path.join(root, "Git", "mingw64", "bin");
    const usrBin = path.join(root, "Git", "usr", "bin");
    mkdirSync(gitBin, { recursive: true });
    mkdirSync(mingwBin, { recursive: true });
    mkdirSync(usrBin, { recursive: true });

    writeExe(gitBin, "git");
    writeExe(mingwBin, "adig");
    writeExe(mingwBin, "openssl");
    writeExe(usrBin, "bash");
    writeExe(usrBin, "ls");

    const sources = [{ name: "path", label: "PATH", enabled: true, dirs: [gitBin, mingwBin, usrBin] }];
    const all = await discoverInstalledClis({ sources, probe: false, view: "all" });
    const names = all.items.map((i) => i.name);

    assert.ok(names.includes("git"), "git from Git/cmd should remain");
    for (const noise of ["adig", "openssl", "bash", "ls"]) {
      assert.ok(!names.includes(noise), `${noise} from Git toolchain bins should be hard-filtered`);
    }
    assert.equal(isIgnoredPath(path.join(mingwBin, "adig.exe")), true);
    assert.equal(isIgnoredPath(path.join(usrBin, "bash.exe")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverInstalledClis defaults to recommended view with tier stats", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cli-tiers-"));
  try {
    const userBin = path.join(root, ".local", "bin");
    const pathBin = path.join(root, "misc-path");
    mkdirSync(userBin, { recursive: true });
    mkdirSync(pathBin, { recursive: true });

    writeExe(userBin, "my-custom-agent");
    writeExe(pathBin, "node");
    writeExe(pathBin, "obscuretool");

    const sources = [
      { name: "uv", label: "uv", enabled: true, dirs: [userBin] },
      { name: "path", label: "PATH", enabled: true, dirs: [pathBin] },
    ];

    const recommended = await discoverInstalledClis({ sources, probe: false });
    assert.equal(recommended.stats.view, "recommended");
    assert.ok(recommended.stats.recommended >= 2, "node + user-installed tool should be recommended");
    assert.ok(recommended.stats.total > recommended.stats.recommended, "obscure PATH tool should inflate total");
    assert.ok(recommended.items.every((i) => i.tier === "recommended"));
    assert.ok(recommended.items.some((i) => i.name === "node"));
    assert.ok(recommended.items.some((i) => i.name === "my-custom-agent"));
    assert.ok(!recommended.items.some((i) => i.name === "obscuretool"));

    const all = await discoverInstalledClis({ sources, probe: false, view: "all" });
    assert.equal(all.stats.view, "all");
    assert.ok(all.items.some((i) => i.name === "obscuretool"));
    const obscure = all.items.find((i) => i.name === "obscuretool");
    assert.equal(obscure.tier, "other");
    assert.equal(all.stats.total, recommended.stats.total);
    assert.equal(all.stats.recommended, recommended.stats.recommended);
    assert.equal(all.stats.other, all.stats.total - all.stats.recommended);

    assert.equal(classifyTier({ name: "node", source: "path", path: pathBin }), "recommended");
    assert.equal(classifyTier({ name: "obscuretool", source: "path", path: path.join(pathBin, "obscuretool") }), "other");
    assert.equal(classifyTier({ name: "whatever", source: "npm", path: pathBin }), "recommended");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverInstalledClis demotes satellite toolchain helpers from recommended", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cli-satellite-"));
  try {
    const cargoBin = path.join(root, ".cargo", "bin");
    mkdirSync(cargoBin, { recursive: true });
    for (const n of ["cargo", "cargo-clippy", "cargo-fmt", "clippy-driver", "rustc", "rustup"]) {
      writeExe(cargoBin, n);
    }

    const sources = [{ name: "path", label: "PATH", enabled: true, dirs: [cargoBin] }];
    const recommended = await discoverInstalledClis({ sources, probe: false, view: "recommended" });
    const all = await discoverInstalledClis({ sources, probe: false, view: "all" });
    const recNames = recommended.items.map((i) => i.name);
    const allNames = all.items.map((i) => i.name);

    for (const keep of ["cargo", "rustc", "rustup"]) {
      assert.ok(recNames.includes(keep), `${keep} should stay recommended`);
    }
    for (const demote of ["cargo-clippy", "cargo-fmt", "clippy-driver"]) {
      assert.ok(!recNames.includes(demote), `${demote} should leave recommended`);
      assert.ok(allNames.includes(demote), `${demote} should remain in all`);
      assert.equal(all.items.find((i) => i.name === demote).tier, "other");
    }

    assert.equal(isSatelliteCliName("cargo-clippy"), true);
    assert.equal(isSatelliteCliName("clippy-driver"), true);
    assert.equal(isSatelliteCliName("cargo"), false);
    // cargo bin bulk dumps no longer auto-promote unknown names
    assert.equal(classifyTier({ name: "cargo-clippy", source: "path", path: path.join(cargoBin, "cargo-clippy") }), "other");
    assert.equal(classifyTier({ name: "random-helper", source: "path", path: path.join(cargoBin, "random-helper") }), "other");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("user can pin CLIs as favorites into recommended view", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cli-fav-"));
  const prev = process.env.GATEWAY_DATA_DIR;
  process.env.GATEWAY_DATA_DIR = root;
  try {
    const pathBin = path.join(root, "misc-path");
    mkdirSync(pathBin, { recursive: true });
    writeExe(pathBin, "obscuretool");
    writeExe(pathBin, "cargo-clippy");

    const sources = [{ name: "path", label: "PATH", enabled: true, dirs: [pathBin] }];
    const before = await discoverInstalledClis({ sources, probe: false, view: "recommended" });
    assert.ok(!before.items.some((i) => i.name === "obscuretool"));
    assert.ok(!before.items.some((i) => i.name === "cargo-clippy"));

    const favorites = CliSourceConfig.addFavorite("obscuretool");
    assert.deepEqual(favorites, ["obscuretool"]);
    // pinning a satellite helper should still force it into recommended
    CliSourceConfig.addFavorite("cargo-clippy");

    const rec = await discoverInstalledClis({
      sources,
      probe: false,
      view: "recommended",
      favorites: CliSourceConfig.listFavorites(),
    });
    const obscure = rec.items.find((i) => i.name === "obscuretool");
    const clippy = rec.items.find((i) => i.name === "cargo-clippy");
    assert.ok(obscure, "favorite obscure tool should enter recommended");
    assert.equal(obscure.tier, "recommended");
    assert.equal(obscure.favorite, true);
    assert.ok(clippy, "favorite satellite helper should enter recommended");
    assert.equal(clippy.tier, "recommended");
    assert.equal(clippy.favorite, true);
    // favorites sort before non-favorites
    assert.ok(rec.items[0].favorite);

    const removed = CliSourceConfig.removeFavorite("obscuretool");
    assert.ok(!removed.includes("obscuretool"));
  } finally {
    process.env.GATEWAY_DATA_DIR = prev;
    rmSync(root, { recursive: true, force: true });
  }
});
