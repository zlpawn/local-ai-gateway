import fs from "node:fs/promises";
import path from "node:path";

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
