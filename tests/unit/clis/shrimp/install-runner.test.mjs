import assert from "node:assert/strict";
import test from "node:test";
import {
  runInstallCommand,
  tailText,
} from "../../../../lib/clis/shrimp/domain/install-runner.mjs";

test("noninteractive install captures stdout and exit code", async () => {
  const isWin = process.platform === "win32";
  const command = isWin ? "echo hello-shrimp" : "echo hello-shrimp";
  const result = await runInstallCommand(command, { interactive: false });
  assert.equal(result.mode, "noninteractive");
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /hello-shrimp/);
});

test("interactive mode without TTY fails with structured error", async () => {
  // In node:test, stdin is typically not a usable interactive TTY for our purpose.
  // Force the path by temporarily marking isTTY false.
  const stdin = process.stdin;
  const stdout = process.stdout;
  const oldIn = stdin.isTTY;
  const oldOut = stdout.isTTY;
  Object.defineProperty(stdin, "isTTY", { configurable: true, value: false });
  Object.defineProperty(stdout, "isTTY", { configurable: true, value: false });
  try {
    await assert.rejects(
      () => runInstallCommand("echo hi", { interactive: true }),
      (err) => err.code === "tty_required",
    );
  } finally {
    Object.defineProperty(stdin, "isTTY", { configurable: true, value: oldIn });
    Object.defineProperty(stdout, "isTTY", { configurable: true, value: oldOut });
  }
});

test("tailText keeps suffix", () => {
  assert.equal(tailText("abcdef", 3), "def");
  assert.equal(tailText("abc", 10), "abc");
});