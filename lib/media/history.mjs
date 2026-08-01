import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const HISTORY_FILENAME = "media-history.json";
const MAX_ENTRIES = 200;

function historyPath(dataDir) {
  return path.join(dataDir, HISTORY_FILENAME);
}

export function loadHistory(dataDir) {
  const p = historyPath(dataDir);
  if (!fs.existsSync(p)) return { entries: [] };
  try {
    const obj = JSON.parse(fs.readFileSync(p, "utf8"));
    return { entries: Array.isArray(obj.entries) ? obj.entries : [] };
  } catch {
    return { entries: [] };
  }
}

function saveHistory(dataDir, history) {
  const p = historyPath(dataDir);
  const text = JSON.stringify(history, null, 2) + "\n";
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, p);
}

export function addHistoryEntry(dataDir, entry) {
  const history = loadHistory(dataDir);
  const fullEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...entry,
  };
  history.entries.push(fullEntry);
  if (history.entries.length > MAX_ENTRIES) {
    history.entries = history.entries.slice(-MAX_ENTRIES);
  }
  saveHistory(dataDir, history);
  return fullEntry;
}

export function deleteHistoryEntry(dataDir, id) {
  const history = loadHistory(dataDir);
  history.entries = history.entries.filter((e) => e.id !== id);
  saveHistory(dataDir, history);
}

export function listHistory(dataDir, mediaType) {
  const history = loadHistory(dataDir);
  if (!mediaType) return history.entries;
  return history.entries.filter((e) => e.media_type === mediaType);
}
