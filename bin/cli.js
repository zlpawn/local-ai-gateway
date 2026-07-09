#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRootDir = path.resolve(__dirname, "..");

const dataDir = path.join(os.homedir(), ".local-ai-gateway");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Copy default configurations if they don't exist
const filesToCopy = ["gateway.config.json", "models.json"];
for (const file of filesToCopy) {
  const destPath = path.join(dataDir, file);
  if (!fs.existsSync(destPath)) {
    const srcPath = path.join(packageRootDir, file);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Set environment variables for the server to pick up
process.env.GATEWAY_CONFIG_FILE = path.join(dataDir, "gateway.config.json");
process.env.MODEL_MAP_FILE = path.join(dataDir, "models.json");
process.env.LOG_FILE = path.join(dataDir, "gateway.log");

// Load .env from dataDir if it exists, otherwise copy from package root
const dotEnvDest = path.join(dataDir, ".env");
if (!fs.existsSync(dotEnvDest)) {
  const dotEnvSrc = path.join(packageRootDir, ".env");
  if (fs.existsSync(dotEnvSrc)) {
    fs.copyFileSync(dotEnvSrc, dotEnvDest);
  }
}

// Dynamically import the main server script
import("../server.js").catch((err) => {
  console.error("Failed to start gateway server:", err);
  process.exit(1);
});
