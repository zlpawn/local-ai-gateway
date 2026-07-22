import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { SkillInstaller } from "../session-sync/skill-installer.mjs";

export function detectDefaultDataDir(packageDir) {
  if (process.env.GATEWAY_DATA_DIR) {
    return process.env.GATEWAY_DATA_DIR;
  }
  const isSourceRepo = fsSync.existsSync(path.join(packageDir, ".git")) || process.cwd() === packageDir;
  if (isSourceRepo) {
    return process.cwd();
  }
  return path.join(os.homedir(), ".local-ai-gateway");
}

const CONFIG_TEMPLATES = [
  [".env.example", ".env"],
  ["gateway.config.example.json", "gateway.config.json"],
];

export async function initializeConfig(packageDir, dataDir = packageDir) {
  const created = [];
  const existing = [];
  await fs.mkdir(dataDir, { recursive: true });

  for (const [templateName, targetName] of CONFIG_TEMPLATES) {
    const template = path.join(packageDir, templateName);
    const target = path.join(dataDir, targetName);
    try {
      await fs.access(target);
      existing.push(targetName);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await fs.copyFile(template, target);
      created.push(targetName);
    }
  }

  return { created, existing };
}

export async function interactiveSetup(packageDir, dataDir = packageDir, options = {}) {
  const initResult = await initializeConfig(packageDir, dataDir);

  let enableSync = options.defaultEnableSync ?? false;
  const isTTY = options.isTTY ?? Boolean(input.isTTY && output.isTTY);

  if (isTTY && options.forceChoice !== undefined) {
    enableSync = options.forceChoice;
  } else if (isTTY) {
    const rl = readline.createInterface({ input, output });
    try {
      console.log(`\n=================================================`);
      console.log(` Welcome to Local AI Gateway Setup!`);
      console.log(`=================================================\n`);
      console.log(`Please select an installation mode:`);
      console.log(`  1) [Standard] Local AI Gateway only`);
      console.log(`  2) [Enhanced] Gateway + Cross-App Session Sync`);
      console.log(`     (Enables directory watcher & installs session-sync Skill)\n`);

      const answer = await rl.question(`Select option [1-2] (default 1): `);
      if (answer.trim() === "2") {
        enableSync = true;
      }
    } finally {
      rl.close();
    }
  }

  if (enableSync) {
    const installedSkill = SkillInstaller.install();
    console.log(`[+] Installed Session Sync Skill to: ${installedSkill}`);

    const configPath = path.join(dataDir, "gateway.config.json");
    try {
      const configContent = await fs.readFile(configPath, "utf8");
      const config = JSON.parse(configContent);
      config.sessionSync = { enabled: true };
      await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
      console.log(`[+] Enabled Session Sync in ${configPath}`);
    } catch {}
  }

  return { ...initResult, enableSync };
}

export async function loadEnvironmentFile(filePath, env = process.env) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return env;
    throw error;
  }

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || env[match[1]] != null) continue;
    env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

export function resolveUserPath(dataDir, configuredPath) {
  const isAbs = path.isAbsolute(configuredPath) || path.win32.isAbsolute(configuredPath);
  return isAbs
    ? path.resolve(configuredPath)
    : path.resolve(dataDir, configuredPath);
}
