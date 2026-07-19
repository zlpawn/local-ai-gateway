import fs from "node:fs/promises";
import path from "node:path";

export async function initializeConfig(rootDir) {
  const created = [];
  const existing = [];
  const template = path.join(rootDir, ".env.example");
  const target = path.join(rootDir, ".env");

  try {
    await fs.access(target);
    existing.push(".env");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fs.copyFile(template, target);
    created.push(".env");
  }

  return { created, existing };
}
