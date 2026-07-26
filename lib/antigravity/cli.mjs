// Antigravity CLI subcommands (login, status).
import { spawn } from "node:child_process";
import { REDIRECT_PORT, redirectUri } from "./constants.mjs";
import {
  getClientCredentials,
  getSecretsPath,
  getStoredToken,
  loadSecrets,
  saveSecrets,
} from "./token-store.mjs";
import { buildAuthUrl, exchangeCode, getUserInfo, randomState } from "./oauth.mjs";
import { startCallbackServer } from "./oauth-callback-server.mjs";

export async function handleAntigravityCommand(context, io = console) {
  const subcommand = context.subcommand || "help";
  switch (subcommand) {
    case "login":
      return login(context, io);
    case "status":
      return status(context, io);
    case "help":
    default:
      io.log("Usage: local-ai-gateway antigravity <login|status>");
  }
}

function openBrowser(url, io) {
  const platform = process.platform;
  let cmd;
  if (platform === "win32") cmd = ["cmd", "/c", "start", "", url];
  else if (platform === "darwin") cmd = ["open", url];
  else cmd = ["xdg-open", url];
  try {
    spawn(cmd[0], cmd.slice(1), { detached: true, stdio: "ignore" }).unref();
  } catch {
    io.log(`[antigravity] Could not launch browser. Open this URL manually:\n${url}`);
  }
}

async function login(context, io) {
  let creds;
  try {
    creds = getClientCredentials();
  } catch (err) {
    io.log(`[antigravity] ${err.message}`);
    io.log(`[antigravity] Fill client_id/client_secret in: ${getSecretsPath()}`);
    return;
  }
  const state = randomState();
  const uri = redirectUri();
  const authUrl = buildAuthUrl({ clientId: creds.client_id, redirectUri: uri, state });
  io.log(`[antigravity] Callback server on http://127.0.0.1:${REDIRECT_PORT} ...`);
  io.log(`[antigravity] Opening browser for Google authorization...`);
  io.log(`[antigravity] If the browser does not open, visit:\n${authUrl}`);
  openBrowser(authUrl, io);
  let code;
  try {
    code = await startCallbackServer({ port: REDIRECT_PORT, state });
  } catch (err) {
    io.log(`[antigravity] Login failed: ${err.message}`);
    return;
  }
  io.log(`[antigravity] Got authorization code, exchanging for token...`);
  const token = await exchangeCode({
    code,
    redirectUri: uri,
    clientId: creds.client_id,
    clientSecret: creds.client_secret,
  });
  const userInfo = await getUserInfo({ accessToken: token.access_token });
  saveSecrets({
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: token.expires_at,
    account_id: userInfo.email,
  });
  io.log(`[antigravity] Login successful. account_id=${userInfo.email}`);
  io.log(`[antigravity] Token stored in: ${getSecretsPath()}`);
}

function status(context, io) {
  const s = loadSecrets();
  const t = getStoredToken();
  io.log(`[antigravity] secrets file: ${getSecretsPath()}`);
  io.log(`[antigravity] client_id: ${s.client_id ? "(set)" : "(missing)"}`);
  io.log(`[antigravity] account_id: ${t.account_id || "(none)"}`);
  io.log(`[antigravity] access_token: ${t.access_token ? "(set)" : "(none)"}`);
  io.log(`[antigravity] refresh_token: ${t.refresh_token ? "(set)" : "(none)"}`);
  if (t.expires_at) {
    const now = Math.floor(Date.now() / 1000);
    io.log(`[antigravity] token expires in ${t.expires_at - now}s (refresh skew 900s)`);
  }
}