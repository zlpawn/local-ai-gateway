#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  detectDefaultDataDir,
  initializeConfig,
  loadEnvironmentFile,
  resolveUserPath,
} from "../lib/cli/init-config.mjs";
import {
  parseGatewayArgs,
  runGatewayCommand,
} from "../lib/cli/gateway-service.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = detectDefaultDataDir(packageRoot);
await initializeConfig(packageRoot, dataDir);
await loadEnvironmentFile(path.join(dataDir, ".env"));

process.env.GATEWAY_CONFIG_FILE = resolveUserPath(
  dataDir,
  process.env.GATEWAY_CONFIG_FILE || "gateway.config.json",
);
process.env.GATEWAY_SECRETS_FILE = resolveUserPath(
  dataDir,
  process.env.GATEWAY_SECRETS_FILE || "gateway.secrets.json",
);

try {
  const args = process.argv.slice(2);
  const options = parseGatewayArgs(args.length ? args : ["start"]);
  options.rootDir ||= packageRoot;
  options.runtimeDir ||= dataDir;
  await runGatewayCommand(options);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
