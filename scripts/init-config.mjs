#!/usr/bin/env node

import path from "node:path";

import { initializeConfig } from "../lib/cli/init-config.mjs";

try {
  const rootDir = path.resolve(import.meta.dirname, "..");
  const result = await initializeConfig(rootDir);
  for (const file of result.existing) console.log(`Exists: ${file}`);
  for (const file of result.created) console.log(`Created: ${file}`);
  console.log(`
Next steps:
  1. Edit .env
  2. Start the gateway and open http://127.0.0.1:8787/config
  3. Save the web config page to create gateway.config.json`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
