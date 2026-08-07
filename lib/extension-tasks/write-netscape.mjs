import fs from "node:fs";
import path from "node:path";
import { toNetscapeFormat } from "../cookie-extractor/index.mjs";

/**
 * Normalize browser/extension cookie objects and write a Netscape cookies.txt.
 * Shared by task materialization (and optionally import route).
 */
export function writeNetscapeCookieFile({ configDir, domain = "", cookies = [] } = {}) {
  if (!configDir) throw new Error("configDir is required");
  const normalized = (Array.isArray(cookies) ? cookies : [])
    .map((c) => ({
      domain: String(c?.domain || ""),
      path: String(c?.path || "/"),
      name: String(c?.name || ""),
      value: String(c?.value ?? ""),
      secure: Boolean(c?.secure),
      httponly: Boolean(c?.httponly ?? c?.httpOnly),
      expires: Number(c?.expires ?? c?.expirationDate) || 0,
    }))
    .filter((c) => c.domain && c.name);

  if (normalized.length === 0) {
    const err = new Error("No valid cookies after filtering.");
    err.type = "no_cookies";
    throw err;
  }

  const text = toNetscapeFormat(normalized);
  const domains = [...new Set(normalized.map((c) => c.domain))].sort();
  const primaryDomain = String(domain || domains[0] || "").replace(/[^a-zA-Z0-9.-]/g, "_");
  const outputPath = path.join(configDir, primaryDomain ? `cookies-${primaryDomain}.txt` : "cookies.txt");
  fs.writeFileSync(outputPath, text, { mode: 0o600 });
  return { file_path: outputPath, count: normalized.length, domains };
}
