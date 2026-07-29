import assert from "node:assert/strict";
import test from "node:test";
import { createRegistry } from "../../../../lib/clis/shrimp/registry.mjs";

test("registry dispatches a command and returns handler result", async () => {
  const reg = createRegistry();
  reg.register({
    name: "ping",
    description: "ping",
    handler: async () => ({ data: { pong: true } }),
  });
  const result = await reg.dispatch(["ping"], { format: "json" });
  assert.equal(result.ok, true);
  assert.equal(result.envelope.data.pong, true);
});

test("unknown command becomes usage error", async () => {
  const reg = createRegistry();
  const result = await reg.dispatch(["nope"], {});
  assert.equal(result.ok, false);
  assert.equal(result.envelope.error.type, "usage");
});

test("schema export includes registered params", () => {
  const reg = createRegistry();
  reg.register({
    name: "endpoint.add",
    description: "add endpoint",
    mutating: true,
    dryRun: true,
    params: [{ name: "client", required: true, type: "string" }],
    handler: async () => ({ data: {} }),
  });
  const schema = reg.toSchema("endpoint.add");
  assert.equal(schema.name, "endpoint.add");
  assert.equal(schema.params[0].name, "client");
});