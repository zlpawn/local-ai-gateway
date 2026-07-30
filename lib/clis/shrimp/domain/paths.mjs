import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_DATA_DIR_NAME } from "../constants.mjs";

export function detectDataDir(packageRoot, { cwd = process.cwd(), env = process.env } = {}) {
  if (env.GATEWAY_DATA_DIR) return path.resolve(env.GATEWAY_DATA_DIR);
  if (env.SHRIMP_DATA_DIR) return path.resolve(env.SHRIMP_DATA_DIR);
  const isSourceRepo =
    fs.existsSync(path.join(packageRoot, ".git")) || path.resolve(cwd) === path.resolve(packageRoot);
  if (isSourceRepo) return path.resolve(cwd);
  return path.join(os.homedir(), DEFAULT_DATA_DIR_NAME);
}

export function resolveConfigPaths(dataDir, flags = {}, env = process.env) {
  const configFile = flags.configFile || env.GATEWAY_CONFIG_FILE || "gateway.config.json";
  const secretsFile = flags.secretsFile || env.GATEWAY_SECRETS_FILE || "gateway.secrets.json";
  return {
    dataDir,
    configPath: path.isAbsolute(configFile) ? configFile : path.join(dataDir, configFile),
    secretsPath: path.isAbsolute(secretsFile) ? secretsFile : path.join(dataDir, secretsFile),
    envPath: path.join(dataDir, ".env"),
  };
}
