import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER_PATH = path.join(ROOT, "server.js");

function loadInjectHelpers(env = {}) {
  const src = fs.readFileSync(SERVER_PATH, "utf8");
  const start = src.indexOf("function isOfficialHostedToolsInjectEnabled");
  const end = src.indexOf("function normalizeOfficialCodexBody");
  assert.ok(start > 0 && end > start, "inject helper block not found in server.js");

  const context = {
    process: { env: { ...env } },
    isTruthy(value) {
      if (value == null) return false;
      const normalized = String(value).trim().toLowerCase();
      return (
        normalized !== ""
        && normalized !== "0"
        && normalized !== "false"
        && normalized !== "no"
        && normalized !== "off"
      );
    },
    firstHeaderValue(value) {
      if (Array.isArray(value)) return value[0] || "";
      return value ? String(value) : "";
    },
  };
  vm.createContext(context);
  vm.runInContext(
    `${src.slice(start, end)}\nthis.api = { maybeInjectOfficialHostedTools };`,
    context,
  );
  return context.api;
}

function asJson(value) {
  // vm realm arrays/objects are not deepStrictEqual-compatible with host values.
  return JSON.parse(JSON.stringify(value));
}

test("Desktop requests only inject web_search, never image_generation", () => {
  const { maybeInjectOfficialHostedTools } = loadInjectHelpers({
    CODEX_INJECT_IMAGE_GENERATION: "1",
  });
  const result = maybeInjectOfficialHostedTools(
    { tools: [] },
    { headers: { originator: "Codex Desktop", "user-agent": "Codex Desktop/0.145" } },
  );

  assert.deepEqual(asJson(result.injected_types), ["web_search"]);
  assert.equal(
    result.body.tools.some((tool) => tool.type === "image_generation"),
    false,
  );
});

test("non-Desktop can opt into hosted image_generation", () => {
  const { maybeInjectOfficialHostedTools } = loadInjectHelpers({
    CODEX_INJECT_IMAGE_GENERATION: "1",
  });
  const result = maybeInjectOfficialHostedTools(
    { tools: [] },
    { headers: { originator: "codex_cli_rs" } },
  );

  assert.deepEqual(
    asJson(result.injected_types).sort(),
    ["image_generation", "web_search"],
  );
});

test("function image_gen.imagegen strips hosted image_generation", () => {
  const { maybeInjectOfficialHostedTools } = loadInjectHelpers({
    CODEX_INJECT_IMAGE_GENERATION: "1",
  });
  const result = maybeInjectOfficialHostedTools(
    {
      tools: [
        { type: "function", name: "image_gen.imagegen" },
        { type: "image_generation" },
      ],
    },
    { headers: { originator: "Codex Desktop" } },
  );

  assert.equal(
    result.body.tools.some((tool) => tool.type === "image_generation"),
    false,
  );
  assert.deepEqual(asJson(result.stripped_types), ["image_generation"]);
  assert.equal(
    result.body.tools.some((tool) => tool.name === "image_gen.imagegen"),
    true,
  );
  assert.equal(
    result.body.tools.some((tool) => tool.type === "web_search"),
    true,
  );
});
