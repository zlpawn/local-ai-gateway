import { spawn } from "node:child_process";
import { SkillInstaller } from "../../../session-sync/skill-installer.mjs";
import { InstallHistory } from "../../../skills/install-history.mjs";
import { CliError } from "../protocol.mjs";

export function listSkills({ scope = "all", query = "", category = "all" } = {}) {
  return SkillInstaller.buildLibrarySnapshot({
    scope,
    query,
    category,
  });
}

export function getSkill({ name }) {
  if (!name) {
    throw new CliError({
      type: "validation",
      code: "missing_fields",
      message: "name is required",
      fields: ["name"],
    });
  }
  const library = SkillInstaller.buildLibrarySnapshot({ query: name, scope: "all" });
  const found = (library.skills || []).find((s) => s.name === name)
    || (library.allSkills || []).find((s) => s.name === name);
  if (!found) {
    throw new CliError({
      type: "not_found",
      code: "skill_not_found",
      message: `Skill not found: ${name}`,
    });
  }
  return found;
}

export function unifySkills({ name, all = false, overwrite = false } = {}) {
  if (all) return SkillInstaller.unifyAllToCentral({});
  if (!name) {
    throw new CliError({
      type: "validation",
      code: "missing_fields",
      message: "Provide --name or --all",
      fields: ["name"],
    });
  }
  return SkillInstaller.unifySkillToCentral(name, { overwrite });
}

export function listSkillHistory() {
  return {
    records: InstallHistory.list(),
    filePath: InstallHistory.filePath(),
  };
}

export async function installSkill({ command, name = "", dryRun = false } = {}) {
  if (!command) {
    throw new CliError({
      type: "validation",
      code: "missing_fields",
      message: "command is required",
      fields: ["command"],
    });
  }
  if (dryRun) {
    return { dry_run: true, command, name: name || null };
  }
  const record = InstallHistory.create({ command, skillName: name || null });
  const exitCode = await runShellCommand(command);
  const finished = InstallHistory.finish(record.id, {
    exitCode,
    skillName: name || undefined,
  });
  return { record: finished || record, exitCode };
}

export async function rerunSkillInstall({ id } = {}) {
  const rec = InstallHistory.get(id);
  if (!rec) {
    throw new CliError({
      type: "not_found",
      code: "history_not_found",
      message: `Install history not found: ${id}`,
    });
  }
  return installSkill({ command: rec.command, name: rec.skillName || "" });
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