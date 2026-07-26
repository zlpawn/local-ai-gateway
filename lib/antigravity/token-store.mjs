// Antigravity credentials store - standalone file, fully isolated from
// gateway.secrets.json (whose prepareState rebuilds secrets as { api_keys }
// and would erase any non-api_keys top-level field). The antigravity module
// owns all reads/writes here; historical secrets handling is untouched.
import fs from "node:fs";
import path from "node:path";

const SECRETS_FILENAME = "antigravity.secrets.json";
const FIELDS = ["client_id", "client_secret", "access_token", "refresh_token", "expires_at", "account_id"];

export function getSecretsPath(env = process.env) {
  if (env.ANTIGRAVITY_SECRETS_FILE) return env.ANTIGRAVITY_SECRETS_FILE;
  const configDir = env.GATEWAY_CONFIG_FILE
    ? path.dirname(env.GATEWAY_CONFIG_FILE)
    : process.cwd();
  return path.join(configDir, SECRETS_FILENAME);
}

export function loadSecrets(env = process.env) {
  const p = getSecretsPath(env);
  if (!fs.existsSync(p)) return {};
  try {
    const obj = JSON.parse(fs.readFileSync(p, "utf8"));
    const out = {};
    for (const k of FIELDS) if (obj[k] != null) out[k] = obj[k];
    return out;
  } catch {
    return {};
  }
}

export function saveSecrets(partial, env = process.env) {
  const p = getSecretsPath(env);
  const current = loadSecrets(env);
  const next = { ...current, ...partial };
  const obj = {};
  for (const k of FIELDS) if (next[k] != null) obj[k] = next[k];
  const text = JSON.stringify(obj, null, 2) + "\n";
  // atomic write: temp file + rename
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, p);
  return next;
}

export function getClientCredentials(env = process.env) {
  const s = loadSecrets(env);
  if (!s.client_id || !s.client_secret) {
    throw new Error(
      `Antigravity OAuth client_id/client_secret missing in ${getSecretsPath(env)}. ` +
        `Extract them from AG-Manager src-tauri/src/modules/oauth.rs:6-9 and fill in.`,
    );
  }
  return { client_id: s.client_id, client_secret: s.client_secret };
}

export function getStoredToken(env = process.env) {
  const s = loadSecrets(env);
  return {
    access_token: s.access_token || "",
    refresh_token: s.refresh_token || "",
    expires_at: s.expires_at || 0,
    account_id: s.account_id || "",
  };
}