// Discover public OAuth client credentials from a local Antigravity install.
// These values are embedded in the official Antigravity desktop app (not user secrets).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSecrets } from "./token-store.mjs";

const CLIENT_ID_RE = /[0-9]{6,}-[a-z0-9]{10,}\.apps\.googleusercontent\.com/g;
const SECRET_PREFIX = "FAKESEC-";

// Preferred Antigravity desktop client identity. Read at runtime from the
// local secrets file (antigravity.secrets.json) so no credential is hardcoded
// in source. When absent (e.g. first-run before any login), the preferred
// values are null and chooseCredentialPair falls back to the first extracted
// candidate -- functionally identical for the common single-credential case.
function getPreferredCredentials(env = process.env) {
  const s = loadSecrets(env);
  return {
    client_id: s.client_id || null,
    client_secret: s.client_secret || null,
  };
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

export function defaultInstallCandidates(env = process.env, platform = process.platform) {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

  if (platform === "win32") {
    return unique([
      path.join(localAppData, "Programs", "Antigravity"),
      path.join(localAppData, "Antigravity"),
      path.join(programFiles, "Antigravity"),
      path.join(programFilesX86, "Antigravity"),
    ]);
  }

  if (platform === "darwin") {
    return unique([
      "/Applications/Antigravity.app",
      path.join(home, "Applications", "Antigravity.app"),
    ]);
  }

  return unique([
    path.join(home, ".local", "share", "Antigravity"),
    path.join(home, "Antigravity"),
    "/opt/Antigravity",
    "/usr/share/Antigravity",
  ]);
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function dirExists(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

export function resolveInstallRoot(candidates = defaultInstallCandidates()) {
  for (const root of candidates) {
    if (!root || !dirExists(root)) continue;
    if (fileExists(path.join(root, "Antigravity.exe"))) return root;
    if (dirExists(path.join(root, "Contents", "MacOS"))) return root;
    if (dirExists(path.join(root, "resources"))) return root;
  }
  return null;
}

export function collectScanTargets(installRoot) {
  if (!installRoot) return [];
  const targets = [];
  const pushIfFile = (filePath) => {
    if (fileExists(filePath)) targets.push(filePath);
  };

  pushIfFile(path.join(installRoot, "resources", "bin", "language_server.exe"));
  pushIfFile(path.join(installRoot, "resources", "app.asar"));
  pushIfFile(path.join(installRoot, "Antigravity.exe"));
  pushIfFile(path.join(installRoot, "Contents", "Resources", "bin", "language_server"));
  pushIfFile(path.join(installRoot, "Contents", "Resources", "app.asar"));
  pushIfFile(path.join(installRoot, "Contents", "MacOS", "Antigravity"));

  return unique(targets);
}

export function extractClientIdsFromText(text) {
  return unique(String(text || "").match(CLIENT_ID_RE) || []);
}

function isSecretBodyChar(ch) {
  return /[A-Za-z0-9_-]/.test(ch);
}

export function extractClientSecretsFromText(text) {
  const source = String(text || "");
  const secrets = [];
  let index = 0;
  // Observed Antigravity/Google client secrets are FAKESEC- + ~28 body chars.
  const BODY_LEN = 28;
  while (index < source.length) {
    const start = source.indexOf(SECRET_PREFIX, index);
    if (start < 0) break;
    let body = "";
    let cursor = start + SECRET_PREFIX.length;
    while (cursor < source.length && body.length < BODY_LEN && isSecretBodyChar(source[cursor])) {
      // If another secret is concatenated immediately, stop this token.
      if (source.startsWith(SECRET_PREFIX, cursor)) break;
      body += source[cursor];
      cursor += 1;
    }
    if (body.length >= 20 && body.length <= BODY_LEN) {
      secrets.push(SECRET_PREFIX + body);
    }
    index = start + SECRET_PREFIX.length;
  }
  return unique(secrets);
}

export function chooseCredentialPair(clientIds, clientSecrets, env = process.env) {
  const ids = unique(clientIds);
  const secrets = unique(clientSecrets);
  if (!ids.length || !secrets.length) return null;

  const preferred = getPreferredCredentials(env);
  const preferredId = preferred.client_id && ids.includes(preferred.client_id)
    ? preferred.client_id
    : ids[0];
  const preferredSecret = preferred.client_secret && secrets.includes(preferred.client_secret)
    ? preferred.client_secret
    : secrets[0];

  return {
    client_id: preferredId,
    client_secret: preferredSecret,
    client_id_candidates: ids,
    client_secret_count: secrets.length,
  };
}

export function extractCredentialsFromBuffer(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("latin1") : String(buffer || "");
  return chooseCredentialPair(
    extractClientIdsFromText(text),
    extractClientSecretsFromText(text),
  );
}

export function discoverAntigravityClientCredentials({
  env = process.env,
  platform = process.platform,
  candidates = defaultInstallCandidates(env, platform),
  readFileSync = fs.readFileSync,
} = {}) {
  const installRoot = resolveInstallRoot(candidates);
  if (!installRoot) {
    return {
      ok: false,
      code: "install_not_found",
      message:
        "未检测到本机 Antigravity 安装。请先安装 Antigravity Desktop，或手动填写 client_id / client_secret。",
      install_root: null,
      scanned_files: [],
    };
  }

  const scanned = [];
  const allIds = [];
  const allSecrets = [];

  for (const filePath of collectScanTargets(installRoot)) {
    scanned.push(filePath);
    try {
      const buf = readFileSync(filePath);
      const text = Buffer.isBuffer(buf) ? buf.toString("latin1") : String(buf || "");
      allIds.push(...extractClientIdsFromText(text));
      allSecrets.push(...extractClientSecretsFromText(text));
    } catch {
      // keep scanning other targets
    }
  }

  const pair = chooseCredentialPair(allIds, allSecrets, env);
  if (!pair) {
    return {
      ok: false,
      code: "credentials_not_found",
      message:
        "检测到本机 Antigravity，但未能从安装目录提取 OAuth client 凭据。请手动填写 client_id / client_secret。",
      install_root: installRoot,
      scanned_files: scanned,
    };
  }

  return {
    ok: true,
    code: "ok",
    message: "已从本机 Antigravity 安装提取 OAuth client 凭据。",
    install_root: installRoot,
    scanned_files: scanned,
    client_id: pair.client_id,
    client_secret: pair.client_secret,
    client_id_candidates: pair.client_id_candidates,
    client_secret_count: pair.client_secret_count,
  };
}
