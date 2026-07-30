import fs from "node:fs";
import os from "node:os";
import { discoverInstalledClis } from "../../../cli/discovery.mjs";
import { CliSourceConfig } from "../../../cli/source-config.mjs";
import { CliInstallHistory } from "../../../cli/install-history.mjs";
import { CliError } from "../protocol.mjs";
import { runInstallCommand, tailText } from "./install-runner.mjs";

export async function listCliTools({ query = "", probe = false } = {}) {
  const ignored = CliSourceConfig.listIgnored();
  return discoverInstalledClis({ query, probe, ignored });
}

export function listCliHistory() {
  return {
    records: CliInstallHistory.list(),
    filePath: CliInstallHistory.filePath(),
  };
}

function snapshotPathEntries() {
  const names = new Set();
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of String(process.env.PATH || process.env.Path || "").split(sep)) {
    const trimmed = (dir || "").trim();
    if (!trimmed) continue;
    try {
      for (const f of fs.readdirSync(trimmed)) names.add(f);
    } catch {
      // ignore
    }
  }
  return names;
}

function baseName(name) {
  return process.platform === "win32"
    ? String(name).replace(/\.(exe|cmd|bat)$/i, "")
    : String(name);
}

function inferNewCliName(beforeNames) {
  const after = snapshotPathEntries();
  for (const name of after) {
    if (!beforeNames.has(name)) return baseName(name);
  }
  return null;
}

export async function installCliTool({
  command,
  name = "",
  dryRun = false,
  interactive = false,
} = {}) {
  if (!command) {
    throw new CliError({
      type: "validation",
      code: "missing_fields",
      message: "command is required",
      fields: ["command"],
    });
  }
  if (dryRun) {
    return {
      dry_run: true,
      command,
      name: name || null,
      mode: interactive ? "interactive" : "noninteractive",
    };
  }

  const beforeNames = snapshotPathEntries();
  const record = CliInstallHistory.create({ command, cliName: name || null });
  const result = await runInstallCommand(command, {
    interactive,
    cwd: os.homedir(),
  });

  let cliName = name || null;
  if (!cliName) cliName = inferNewCliName(beforeNames);

  const finished = CliInstallHistory.finish(record.id, {
    exitCode: result.exitCode,
    cliName: cliName || undefined,
  });

  return {
    record: finished || record,
    exitCode: result.exitCode,
    mode: result.mode,
    inferred_name: cliName,
    output_tail: tailText(result.output),
  };
}

export async function rerunCliInstall({ id, interactive = false, dryRun = false } = {}) {
  const rec = CliInstallHistory.get(id);
  if (!rec) {
    throw new CliError({
      type: "not_found",
      code: "history_not_found",
      message: `Install history not found: ${id}`,
    });
  }
  return installCliTool({
    command: rec.command,
    name: rec.cliName || "",
    interactive,
    dryRun,
  });
}

export function listSources() {
  return {
    sources: CliSourceConfig.list(),
    ignored: CliSourceConfig.listIgnored(),
    filePath: CliSourceConfig.filePath(),
  };
}

export function addSource({ name, label, dirs = [] } = {}) {
  if (!name) {
    throw new CliError({
      type: "validation",
      code: "missing_fields",
      message: "name is required",
      fields: ["name"],
    });
  }
  const sources = CliSourceConfig.list();
  sources.push({
    id: `src_${Date.now().toString(36)}`,
    name,
    label: label || name,
    enabled: true,
    dirs: Array.isArray(dirs)
      ? dirs
      : String(dirs).split(/[;]/).map((s) => s.trim()).filter(Boolean),
  });
  return { sources: CliSourceConfig.save(sources) };
}

export function saveSources(sources) {
  return { sources: CliSourceConfig.save(sources) };
}

export function resetSources() {
  return { sources: CliSourceConfig.reset() };
}