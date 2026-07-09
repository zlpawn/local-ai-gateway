import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "agent-gateway.sh");

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

if (!existsSync(script)) {
  console.error(`Missing Bash gateway script: ${script}`);
  process.exit(1);
}

const bash = findBash();
if (!bash) {
  console.log("Skipping Bash syntax check: bash was not found on PATH.");
  process.exit(0);
}

const result = spawnSync(bash, ["-n", script], { stdio: "inherit" });
process.exit(result.status ?? 1);
