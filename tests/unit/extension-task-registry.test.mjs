import { test } from "node:test";
import assert from "node:assert/strict";
import { createExtensionTaskTypeRegistry } from "../../lib/extension-tasks/registry.mjs";

test("register and get type definition", () => {
  const reg = createExtensionTaskTypeRegistry();
  const def = { type: "demo", capability: "demo", validateCreate: () => ({ ok: true, payload: {} }) };
  reg.register("demo", def);
  assert.equal(reg.get("demo"), def);
  assert.deepEqual(reg.list(), ["demo"]);
});

test("register rejects missing run contract fields", () => {
  const reg = createExtensionTaskTypeRegistry();
  assert.throws(() => reg.register("", {}));
  assert.throws(() => reg.register("x", { type: "x" })); // missing capability/validateCreate
});
