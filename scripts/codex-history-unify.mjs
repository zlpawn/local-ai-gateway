import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const shouldApply = args.includes("--apply");
const shouldDryRun = args.includes("--dry-run") || !shouldApply;
const allowRunningCodex = args.includes("--allow-running-codex");
const restoreIndex = args.indexOf("--restore");
const restoreRoot = restoreIndex >= 0 ? args[restoreIndex + 1] : "";

const codexHome = path.resolve(valueAfter("--codex-home") || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
const stateDb = path.join(codexHome, "state_5.sqlite");
const targetProvider = valueAfter("--target") || "custom";
const sourceProviders = (valueAfter("--sources") || "openai,volcengine-agent-plan,ccswitch_gateway,deepseek")
  .split(",")
  .map((item) => item.trim())
  .filter((item) => item && item !== targetProvider);

if (restoreRoot) {
  restoreBackup(path.resolve(restoreRoot));
  process.exit(0);
}

if (!fs.existsSync(stateDb)) {
  fail(`Codex state DB not found: ${stateDb}`);
}

if (sourceProviders.length === 0) {
  fail("No source providers to migrate. Pass --sources openai,other-provider.");
}

const rows = queryThreads(stateDb, sourceProviders);
const counts = countBy(rows, "model_provider");
const rolloutPaths = rows
  .map((row) => normalizeFsPath(row.rollout_path))
  .filter((filePath) => filePath && fs.existsSync(filePath));

const summary = {
  ok: true,
  dryRun: shouldDryRun,
  codexHome,
  stateDb,
  targetProvider,
  sourceProviders,
  affectedThreads: rows.length,
  providerCounts: counts,
  existingRolloutFiles: rolloutPaths.length,
  missingRolloutFiles: rows.length - rolloutPaths.length,
  sampleThreads: rows.slice(0, 10).map((row) => ({
    id: row.id,
    title: row.title,
    model_provider: row.model_provider,
    rollout_path: normalizeFsPath(row.rollout_path),
  })),
};

if (shouldDryRun) {
  console.log(JSON.stringify(summary, null, 2));
  console.log("");
  console.log("Dry run only. To apply, run:");
  console.log("  npm run codex:history:apply");
  process.exit(0);
}

const runningCodex = listRunningCodexProcesses();
if (runningCodex.length > 0 && !allowRunningCodex) {
  fail([
    "Codex appears to be running. Close Codex Desktop and any Codex CLI sessions before applying history migration.",
    "Running processes:",
    ...runningCodex.map((line) => `  ${line}`),
    "If you are absolutely sure this is safe, rerun with --allow-running-codex.",
  ].join("\n"));
}

const backupRoot = path.join(codexHome, "history-unify-backups", timestamp());
fs.mkdirSync(backupRoot, { recursive: true });

const backedUp = [];
for (const filePath of [stateDb, `${stateDb}-wal`, `${stateDb}-shm`]) {
  if (backupFile(backupRoot, codexHome, filePath)) backedUp.push(filePath);
}

let backedUpRollouts = 0;
let updatedRollouts = 0;
for (const rolloutPath of rolloutPaths) {
  if (backupFile(backupRoot, codexHome, rolloutPath)) backedUpRollouts += 1;
  if (replaceSessionMetaProvider(rolloutPath, new Set(sourceProviders), targetProvider)) {
    updatedRollouts += 1;
  }
}

updateThreads(stateDb, sourceProviders, targetProvider);

const manifest = {
  ...summary,
  dryRun: false,
  backupRoot,
  backedUpFiles: backedUp.length,
  backedUpRollouts,
  updatedRollouts,
  appliedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(backupRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

console.log(JSON.stringify(manifest, null, 2));
console.log("");
console.log("Restore command:");
console.log(`  node scripts/codex-history-unify.mjs --restore "${backupRoot}"`);

function valueAfter(name) {
  const index = args.indexOf(name);
  if (index < 0) return "";
  return args[index + 1] || "";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    "_",
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join("");
}

function queryThreads(dbPath, providers) {
  const code = String.raw`
import json, sqlite3, sys
db_path = sys.argv[1]
providers = json.loads(sys.argv[2])
placeholders = ",".join(["?"] * len(providers))
sql = f"""
SELECT id, rollout_path, model_provider, title, updated_at
FROM threads
WHERE model_provider IN ({placeholders})
  AND rollout_path IS NOT NULL
  AND rollout_path != ''
ORDER BY updated_at DESC
"""
con = sqlite3.connect(db_path)
con.row_factory = sqlite3.Row
try:
    rows = [dict(row) for row in con.execute(sql, providers)]
finally:
    con.close()
print(json.dumps(rows, ensure_ascii=False))
`;
  const out = execFileSync("python", ["-c", code, dbPath, JSON.stringify(providers)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  });
  return out.trim() ? JSON.parse(out) : [];
}

function updateThreads(dbPath, providers, target) {
  const code = String.raw`
import json, sqlite3, sys
db_path = sys.argv[1]
providers = json.loads(sys.argv[2])
target = sys.argv[3]
placeholders = ",".join(["?"] * len(providers))
sql = f"UPDATE threads SET model_provider = ? WHERE model_provider IN ({placeholders})"
con = sqlite3.connect(db_path)
try:
    con.execute("BEGIN IMMEDIATE")
    cur = con.execute(sql, [target] + providers)
    con.commit()
    print(cur.rowcount)
except Exception:
    con.rollback()
    raise
finally:
    con.close()
`;
  execFileSync("python", ["-c", code, dbPath, JSON.stringify(providers), target], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  });
}

function countBy(rows, key) {
  const counts = {};
  for (const row of rows) {
    const value = row[key] || "";
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function normalizeFsPath(filePath) {
  if (!filePath) return "";
  let text = String(filePath);
  if (text.startsWith("\\\\?\\")) text = text.slice(4);
  return path.normalize(text);
}

function backupFile(root, baseRoot, filePath) {
  const normalized = normalizeFsPath(filePath);
  if (!normalized || !fs.existsSync(normalized)) return false;
  const relative = safeRelative(baseRoot, normalized);
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(normalized, target);
  return true;
}

function safeRelative(baseRoot, filePath) {
  const base = path.resolve(baseRoot);
  const full = path.resolve(filePath);
  const relative = path.relative(base, full);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return path.join("_external", full.replace(/^[A-Za-z]:/, (drive) => drive.replace(":", "")));
  }
  return relative;
}

function replaceSessionMetaProvider(filePath, sourceSet, targetProviderValue) {
  const original = fs.readFileSync(filePath, "utf8");
  const lines = original.split(/\r?\n/);
  let changed = false;
  const next = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      const item = JSON.parse(line);
      if (
        item?.type === "session_meta" &&
        item.payload &&
        sourceSet.has(item.payload.model_provider)
      ) {
        item.payload.model_provider = targetProviderValue;
        changed = true;
        return JSON.stringify(item);
      }
    } catch {
      return line;
    }
    return line;
  }).join("\n");

  if (changed) fs.writeFileSync(filePath, next, "utf8");
  return changed;
}

function restoreBackup(root) {
  const manifestPath = path.join(root, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    fail(`Backup manifest not found: ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const restoreCodexHome = manifest.codexHome || codexHome;
  const files = walk(root).filter((filePath) => path.basename(filePath) !== "manifest.json");
  let restored = 0;

  for (const backupPath of files) {
    const relative = path.relative(root, backupPath);
    if (relative.startsWith("_external")) continue;
    const target = path.join(restoreCodexHome, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(backupPath, target);
    restored += 1;
  }

  console.log(JSON.stringify({ ok: true, restored, restoreCodexHome, backupRoot: root }, null, 2));
}

function listRunningCodexProcesses() {
  if (process.platform !== "win32") return [];
  try {
    const out = execFileSync("powershell", [
      "-NoProfile",
      "-Command",
      "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'codex|OpenAI Codex' } | Select-Object ProcessName,Id,Path | ConvertTo-Csv -NoTypeInformation",
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
    });
    return out
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function walk(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
