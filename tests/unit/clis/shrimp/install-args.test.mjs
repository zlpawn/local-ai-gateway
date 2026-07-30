import assert from "node:assert/strict";
import test from "node:test";
import { resolveInstallInvocation } from "../../../../lib/clis/shrimp/parse-args.mjs";

test("accepts --command string", () => {
  const r = resolveInstallInvocation(["--command", "npx -y foo", "--name", "bar"]);
  assert.equal(r.command, "npx -y foo");
  assert.equal(r.flags.name, "bar");
});

test("trailing args form command and keep dashed flags", () => {
  const r = resolveInstallInvocation([
    "--interactive",
    "npx",
    "-y",
    "skills",
    "add",
    "owner/repo",
    "--skill",
    "foo",
  ]);
  assert.equal(r.flags.interactive, true);
  assert.equal(r.command, "npx -y skills add owner/repo --skill foo");
});

test("explicit -- separator starts command", () => {
  const r = resolveInstallInvocation([
    "--name",
    "foo",
    "--",
    "npm",
    "i",
    "-g",
    "some-cli",
  ]);
  assert.equal(r.flags.name, "foo");
  assert.equal(r.command, "npm i -g some-cli");
});