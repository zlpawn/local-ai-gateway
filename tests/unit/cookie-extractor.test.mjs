import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { toNetscapeFormat } from "../../lib/cookie-extractor/index.mjs";

// We test the Netscape format output and domain filtering logic.
// Browser detection and actual cookie decryption are tested manually
// since they require real browser installations.

test("toNetscapeFormat: produces valid Netscape cookie file", () => {
  const cookies = [
    { domain: ".example.com", path: "/", name: "session", value: "abc123", secure: true, httponly: false, expires: 1700000000 },
    { domain: "www.example.com", path: "/api", name: "token", value: "xyz", secure: false, httponly: true, expires: 0 },
  ];
  const text = toNetscapeFormat(cookies);
  const lines = text.split("\n");
  assert.ok(lines[0].startsWith("# Netscape"), "first line should be header comment");
  assert.ok(lines[1].startsWith("# This is"), "second line should be header comment");
  assert.equal(lines[3], ".example.com\tTRUE\t/\tTRUE\t1700000000\tsession\tabc123");
  assert.equal(lines[4], "www.example.com\tFALSE\t/api\tFALSE\tFALSE\ttoken\txyz");
});

test("toNetscapeFormat: handles empty cookie list", () => {
  const text = toNetscapeFormat([]);
  const lines = text.split("\n");
  assert.equal(lines.length, 4); // 2 headers + empty + trailing
  assert.equal(lines[3], "");
});

test("toNetscapeFormat: subdomain flag correct", () => {
  const cookies = [
    { domain: ".sub.example.com", path: "/", name: "a", value: "1", secure: false, httponly: false, expires: 0 },
    { domain: "example.com", path: "/", name: "b", value: "2", secure: false, httponly: false, expires: 0 },
  ];
  const text = toNetscapeFormat(cookies);
  const lines = text.split("\n");
  // .sub.example.com -> includeSubdomains = TRUE
  assert.ok(lines[3].startsWith(".sub.example.com\tTRUE\t"));
  // example.com (no leading dot) -> includeSubdomains = FALSE
  assert.ok(lines[4].startsWith("example.com\tFALSE\t"));
});

test("toNetscapeFormat: special characters in value are preserved", () => {
  const cookies = [
    { domain: ".example.com", path: "/", name: "data", value: "a=b&c=d", secure: false, httponly: false, expires: 0 },
  ];
  const text = toNetscapeFormat(cookies);
  const lines = text.split("\n");
  assert.ok(lines[3].includes("a=b&c=d"), "special chars should be preserved");
});
