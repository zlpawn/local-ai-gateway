import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "agent-gateway.sh");
const bash = findBash();

function findBash() {
  const command = process.platform === "win32" ? "where.exe" : "command";
  const args = process.platform === "win32" ? ["bash"] : ["-v", "bash"];
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) return "";
  const candidates = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (process.platform !== "win32") return candidates[0] || "";

  return candidates.find((candidate) => {
    const lower = candidate.toLowerCase();
    return !lower.includes("\\system32\\bash.exe") && !lower.includes("\\windowsapps\\bash.exe");
  }) || "";
}

function normalizeScriptPath(value) {
  const text = value.trim();
  if (process.platform === "win32") {
    const match = text.match(/^\/([a-zA-Z])\/(.*)$/);
    if (match) {
      return `${match[1].toUpperCase()}:\\${match[2].replaceAll("/", "\\")}`;
    }
  }
  return path.resolve(text);
}

test("agent-gateway help works with the detected Bash runtime", { skip: !bash }, async () => {
  const { stdout } = await execFileAsync(bash, [script, "help"]);

  assert.match(stdout, /Usage: agent-gateway <command>/);
  assert.match(stdout, /start\s+Start gateway in background/);
});

test("agent-gateway path prints the project root", { skip: !bash }, async () => {
  const { stdout } = await execFileAsync(bash, [script, "path"]);

  assert.equal(normalizeScriptPath(stdout), root);
});
