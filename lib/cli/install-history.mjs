import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { detectDefaultDataDir } from "../cli/init-config.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, "..", "..");

function resolveDataDir() {
  // Same resolution as the skills install history: next to gateway.config.json.
  try {
    return detectDefaultDataDir(PROJECT_ROOT);
  } catch {
    return path.join(os.homedir(), ".local-ai-gateway");
  }
}

function resolveHistoryFile() {
  return path.join(resolveDataDir(), "cli-install-history.json");
}

function readRaw() {
  const file = resolveHistoryFile();
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (Array.isArray(data?.records)) return data;
  } catch {
    // missing or corrupt -> start fresh
  }
  return { version: 1, records: [] };
}

function writeRaw(data) {
  const file = resolveHistoryFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function newId() {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Parallel to the skills InstallHistory, but tracks CLI installs separately so
// CLI and skill records never mix. Same record shape and lifecycle so the UI
// can stay consistent with the preset-skills install-history tab.
export const CliInstallHistory = {
  filePath() {
    return resolveHistoryFile();
  },

  list() {
    return readRaw().records
      .slice()
      .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  },

  get(id) {
    return readRaw().records.find((r) => r.id === id) || null;
  },

  create({ command, cliName }) {
    const data = readRaw();
    const record = {
      id: newId(),
      cliName: cliName ? String(cliName).trim() : null,
      command: String(command || "").trim(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      status: "running",
    };
    data.records.unshift(record);
    writeRaw(data);
    return record;
  },

  finish(id, { exitCode, cliName }) {
    const data = readRaw();
    const rec = data.records.find((r) => r.id === id);
    if (!rec) return null;
    rec.finishedAt = new Date().toISOString();
    rec.exitCode = Number.isFinite(Number(exitCode)) ? Number(exitCode) : null;
    rec.status = rec.exitCode === 0 ? "success" : "failed";
    if (cliName) rec.cliName = String(cliName).trim();
    writeRaw(data);
    return rec;
  },

  remove(id) {
    const data = readRaw();
    const before = data.records.length;
    data.records = data.records.filter((r) => r.id !== id);
    if (data.records.length !== before) writeRaw(data);
    return data.records.length !== before;
  },
};
