import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "agent-gateway.sh");

test("agent-gateway help works without PowerShell", async () => {
  const env = { ...process.env, PATH: "/usr/bin:/bin" };
  const { stdout } = await execFileAsync("bash", [script, "help"], { env });

  assert.match(stdout, /Usage: agent-gateway <command>/);
  assert.match(stdout, /start\s+Start gateway in background/);
});

test("agent-gateway path prints the project root without PowerShell", async () => {
  const env = { ...process.env, PATH: "/usr/bin:/bin" };
  const { stdout } = await execFileAsync("bash", [script, "path"], { env });

  assert.equal(stdout.trim(), root);
});
