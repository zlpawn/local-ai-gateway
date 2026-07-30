import { spawn } from "node:child_process";
import { discoverInstalledClis } from "../../../cli/discovery.mjs";
import { CliSourceConfig } from "../../../cli/source-config.mjs";
import { CliInstallHistory } from "../../../cli/install-history.mjs";
import { CliError } from "../protocol.mjs";

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

export async function installCliTool({ command, name = "", dryRun = false } = {}) {
  if (!command) {
    throw new CliError({
      type: "validation",
      code: "missing_fields",
      message: "command is required",
      fields: ["command"],
    });
  }
  if (dryRun) return { dry_run: true, command, name: name || null };
  const record = CliInstallHistory.create({ command, cliName: name || null });
  const exitCode = await runShellCommand(command);
  const finished = CliInstallHistory.finish(record.id, {
    exitCode,
    cliName: name || undefined,
  });
  return { record: finished || record, exitCode };
}

export async function rerunCliInstall({ id } = {}) {
  const rec = CliInstallHistory.get(id);
  if (!rec) {
    throw new CliError({
      type: "not_found",
      code: "history_not_found",
      message: `Install history not found: ${id}`,
    });
  }
  return installCliTool({ command: rec.command, name: rec.cliName || "" });
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
    dirs: Array.isArray(dirs) ? dirs : String(dirs).split(/[;]/).map((s) => s.trim()).filter(Boolean),
  });
  return { sources: CliSourceConfig.save(sources) };
}

export function saveSources(sources) {
  return { sources: CliSourceConfig.save(sources) };
}

export function resetSources() {
  return { sources: CliSourceConfig.reset() };
}

function runShellCommand(command) {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const child = spawn(isWin ? "cmd.exe" : "/bin/sh", isWin ? ["/d", "/s", "/c", command] : ["-c", command], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code == null ? 1 : code));
  });
}