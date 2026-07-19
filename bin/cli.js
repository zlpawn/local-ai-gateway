#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseGatewayArgs,
  runGatewayCommand,
} from "../lib/cli/gateway-service.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(os.homedir(), ".local-ai-gateway");
fs.mkdirSync(dataDir, { recursive: true });

for (const file of ["gateway.config.json", "models.json"]) {
  const source = path.join(packageRoot, file);
  const target = path.join(dataDir, file);
  if (!fs.existsSync(target) && fs.existsSync(source)) {
    fs.copyFileSync(source, target);
  }
}

process.env.GATEWAY_CONFIG_FILE ||= path.join(dataDir, "gateway.config.json");
process.env.GATEWAY_SECRETS_FILE ||= path.join(dataDir, "gateway.secrets.json");

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
