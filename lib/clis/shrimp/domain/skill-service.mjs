import os from "node:os";
import { SkillInstaller } from "../../../session-sync/skill-installer.mjs";
import { InstallHistory } from "../../../skills/install-history.mjs";
import { CliError } from "../protocol.mjs";
import { runInstallCommand, tailText } from "./install-runner.mjs";

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

function snapshotSkillNames(homeDir = os.homedir()) {
  try {
    return new Set(SkillInstaller.scanDiscoveryRoots(homeDir).keys());
  } catch {
    return new Set();
  }
}

function inferNewSkillName(beforeNames, homeDir = os.homedir()) {
  try {
    const after = SkillInstaller.scanDiscoveryRoots(homeDir);
    for (const name of after.keys()) {
      if (!beforeNames.has(name)) return name;
    }
  } catch {
    // ignore
  }
  return null;
}

export async function installSkill({
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

  const homeDir = os.homedir();
  const beforeNames = snapshotSkillNames(homeDir);
  const record = InstallHistory.create({ command, skillName: name || null });
  let result;
  try {
    result = await runInstallCommand(command, {
      interactive,
      cwd: homeDir,
    });
  } catch (error) {
    InstallHistory.finish(record.id, { exitCode: 1, skillName: name || undefined });
    throw error;
  }

  let skillName = name || null;
  if (!skillName) skillName = inferNewSkillName(beforeNames, homeDir);

  const finished = InstallHistory.finish(record.id, {
    exitCode: result.exitCode,
    skillName: skillName || undefined,
  });

  return {
    record: finished || record,
    exitCode: result.exitCode,
    mode: result.mode,
    inferred_name: skillName,
    output_tail: tailText(result.output),
  };
}

export async function rerunSkillInstall({ id, interactive = false, dryRun = false } = {}) {
  const rec = InstallHistory.get(id);
  if (!rec) {
    throw new CliError({
      type: "not_found",
      code: "history_not_found",
      message: `Install history not found: ${id}`,
    });
  }
  return installSkill({
    command: rec.command,
    name: rec.skillName || "",
    interactive,
    dryRun,
  });
}