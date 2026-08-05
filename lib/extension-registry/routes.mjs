import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { toNetscapeFormat } from "../cookie-extractor/index.mjs";

/**
 * REST routes for browser extension management.
 *
 * Routes are dispatched by the /v1/extensions prefix; new sub-routes are
 * added here without touching the server's main dispatch (open/closed).
 *
 * Self-contained: sends its own JSON responses so it does not depend on
 * server.js internals beyond the raw (req, res) pair.
 */
export function routeExtensionRequest(req, res, _context, reqPath, deps) {
  const { store, extensionsDir } = deps;

  // POST /v1/extensions/register
  if (reqPath === "/v1/extensions/register" && req.method === "POST") {
    return readJsonBody(req)
      .then((body) => {
        if (!body.id) return sendJson(res, 400, { error: { type: "invalid_request_error", message: "Missing 'id' field." } });
        const ext = store.register({
          id: String(body.id),
          name: String(body.name || "Unknown Extension"),
          version: String(body.version || "0.0.0"),
          capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
          permissions: Array.isArray(body.permissions) ? body.permissions : [],
        });
        sendJson(res, 200, { extension: ext });
      })
      .catch(() => sendJson(res, 400, { error: { type: "invalid_request_error", message: "Invalid JSON body." } }));
  }

  // POST /v1/extensions/heartbeat
  if (reqPath === "/v1/extensions/heartbeat" && req.method === "POST") {
    return readJsonBody(req)
      .then((body) => {
        if (!body.id) return sendJson(res, 400, { error: { type: "invalid_request_error", message: "Missing 'id' field." } });
        const ext = store.heartbeat(String(body.id));
        if (!ext) return sendJson(res, 404, { error: { type: "not_found", message: "Extension not registered." } });
        sendJson(res, 200, { ok: true });
      })
      .catch(() => sendJson(res, 400, { error: { type: "invalid_request_error", message: "Invalid JSON body." } }));
  }

  // GET /v1/extensions/list
  if (reqPath === "/v1/extensions/list" && req.method === "GET") {
    sendJson(res, 200, { extensions: store.list() });
    return;
  }

  // GET /v1/extensions/download
  if (reqPath === "/v1/extensions/download" && req.method === "GET") {
    const cookieHelperDir = path.join(extensionsDir, "cookie-helper");
    if (!fs.existsSync(cookieHelperDir)) {
      sendJson(res, 404, { error: { type: "not_found", message: "Extension package not found." } });
      return;
    }
    const tmpZip = path.join(os.tmpdir(), `cookie-helper-${Date.now()}.zip`);
    try {
      if (process.platform === "win32") {
        execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${cookieHelperDir}\\*' -DestinationPath '${tmpZip}' -Force"`, { windowsHide: true });
      } else {
        execSync(`cd "${cookieHelperDir}" && zip -r "${tmpZip}" .`, { stdio: "ignore" });
      }
      const zipBuf = fs.readFileSync(tmpZip);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="cookie-helper.zip"',
        "Content-Length": zipBuf.length,
      });
      res.end(zipBuf);
    } catch {
      sendJson(res, 500, { error: { type: "zip_error", message: "Failed to create extension ZIP." } });
    } finally {
      try { fs.unlinkSync(tmpZip); } catch { /* ignore */ }
    }
    return;
  }

  // DELETE /v1/extensions/:id
  if (reqPath.startsWith("/v1/extensions/") && req.method === "DELETE") {
    const id = decodeURIComponent(reqPath.slice("/v1/extensions/".length));
    if (!id) {
      sendJson(res, 400, { error: { type: "invalid_request_error", message: "Missing extension id." } });
      return;
    }
    store.remove(id);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: { type: "not_found", message: `${req.method} ${reqPath} is not available on the extensions API.` } });
}

/**
 * POST /v1/cookies/import
 * Receives already-decrypted cookies from a browser extension and writes
 * them as a Netscape cookies.txt file. Reuses toNetscapeFormat so the
 * output is identical to the local-file extraction path.
 */
export function routeCookieImport(req, res, _context, deps) {
  const { configDir } = deps;
  return readJsonBody(req)
    .then((body) => {
      if (!Array.isArray(body.cookies) || body.cookies.length === 0) {
        return sendJson(res, 400, { error: { type: "invalid_request_error", message: "Missing or empty 'cookies' array." } });
      }
      const cookies = body.cookies
        .map((c) => ({
          domain: String(c.domain || ""),
          path: String(c.path || "/"),
          name: String(c.name || ""),
          value: String(c.value || ""),
          secure: Boolean(c.secure),
          httponly: Boolean(c.httponly),
          expires: Number(c.expires) || 0,
        }))
        .filter((c) => c.domain && c.name);
      if (cookies.length === 0) {
        return sendJson(res, 400, { error: { type: "invalid_request_error", message: "No valid cookies after filtering." } });
      }
      const text = toNetscapeFormat(cookies);
      const outputPath = path.join(configDir, "cookies.txt");
      fs.writeFileSync(outputPath, text, { mode: 0o600 });
      const domains = [...new Set(cookies.map((c) => c.domain))].sort();
      sendJson(res, 200, { file_path: outputPath, count: cookies.length, domains });
    })
    .catch(() => sendJson(res, 400, { error: { type: "invalid_request_error", message: "Invalid JSON body." } }));
}

// --- self-contained helpers ---

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch { reject(new Error("invalid json")); }
    });
    req.on("error", reject);
  });
}