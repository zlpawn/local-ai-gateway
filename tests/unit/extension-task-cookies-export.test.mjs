import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeNetscapeCookieFile } from "../../lib/extension-tasks/write-netscape.mjs";
import { createCookiesExportType } from "../../lib/extension-tasks/types/cookies-export.mjs";

test("writeNetscapeCookieFile writes mode-safe netscape file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-"));
  const result = writeNetscapeCookieFile({
    configDir: dir,
    domain: "bilibili.com",
    cookies: [
      { domain: ".bilibili.com", path: "/", name: "SESSDATA", value: "abc", secure: true, httponly: true, expires: 1700000000 },
    ],
  });
  assert.ok(result.file_path.endsWith("cookies-bilibili.com.txt"));
  const text = fs.readFileSync(result.file_path, "utf8");
  assert.ok(text.includes("SESSDATA\tabc"));
  assert.equal(result.count, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("cookies.export validateCreate requires domain", () => {
  const def = createCookiesExportType();
  assert.equal(def.validateCreate({}).ok, false);
  assert.equal(def.validateCreate({ domain: "  " }).ok, false);
  const ok = def.validateCreate({ domain: "Bilibili.com" });
  assert.equal(ok.ok, true);
  assert.equal(ok.payload.domain, "Bilibili.com");
});

test("cookies.export assertCreatable needs online cookies extension", () => {
  const def = createCookiesExportType();
  const offline = { list: () => [{ id: "1", online: false, capabilities: ["cookies"] }] };
  const online = { list: () => [{ id: "1", online: true, capabilities: ["cookies"] }] };
  assert.equal(def.assertCreatable({ domain: "a.com" }, { extensionStore: offline }).ok, false);
  assert.equal(def.assertCreatable({ domain: "a.com" }, { extensionStore: online }).ok, true);
});

test("materializeResult accepts chrome cookie shape", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-"));
  const def = createCookiesExportType();
  const task = { payload: { domain: "example.com" } };
  const result = def.materializeResult(task, {
    cookies: [
      { domain: ".example.com", path: "/", name: "sid", value: "1", secure: true, httpOnly: true, expirationDate: 1700000000 },
    ],
  }, { configDir: dir });
  assert.equal(result.count, 1);
  assert.ok(fs.existsSync(result.file_path));
  fs.rmSync(dir, { recursive: true, force: true });
});
