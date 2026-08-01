// Antigravity CLI subcommands (login, status, discover).
import {
  discoverAndSaveAntigravityClientCredentials,
  getAntigravityAuthStatus,
  loginAntigravitySubscription,
} from "./auth-service.mjs";

export async function handleAntigravityCommand(context = {}, io = console) {
  const subcommand = context.subcommand || "help";
  switch (subcommand) {
    case "login":
      return login(context, io);
    case "status":
      return status(context, io);
    case "discover":
      return discover(context, io);
    case "help":
    default:
      io.log("Usage: shrimp upstream google-oauth <login|status|discover>");
  }
}

async function login(context, io) {
  try {
    const result = await loginAntigravitySubscription();
    if (!result.browser_opened) {
      io.log(`[antigravity] Could not launch browser. Open this FULL URL manually:\n${result.auth_url}`);
    } else {
      io.log("[antigravity] Opening browser for Google authorization...");
      io.log("[antigravity] If the wrong account is selected, use '使用其他账号' / account chooser.");
      io.log(`[antigravity] If the browser page errors, open this FULL URL manually:\n${result.auth_url}`);
    }
    io.log(`[antigravity] Login successful. account_id=${result.account_id}`);
    io.log(`[antigravity] Token stored in: ${result.secrets_path}`);
  } catch (err) {
    if (err?.code === "missing_client_credentials") {
      io.log(`[antigravity] ${err.message}`);
      io.log("[antigravity] Run: shrimp upstream google-oauth discover");
      io.log("[antigravity] Or fill client_id/client_secret manually, then login again.");
      return;
    }
    io.log(`[antigravity] Login failed: ${err.message}`);
    if (err?.auth_url) {
      io.log(`[antigravity] FULL auth URL:\n${err.auth_url}`);
    }
  }
}

function status(context, io) {
  const s = getAntigravityAuthStatus({ config: context.config || {} });
  io.log(`[antigravity] secrets file: ${s.secrets_path}`);
  io.log(`[antigravity] state: ${s.state_label} (${s.state})`);
  io.log(`[antigravity] client_id: ${s.client.configured ? "(set)" : "(missing)"}`);
  io.log(`[antigravity] account_id: ${s.token.account_id || "(none)"}`);
  io.log(`[antigravity] access_token: ${s.token.access_token_configured ? "(set)" : "(none)"}`);
  io.log(`[antigravity] refresh_token: ${s.token.refresh_token_configured ? "(set)" : "(none)"}`);
  if (s.token.expires_at) {
    io.log(
      `[antigravity] token expires in ${s.token.expires_in_seconds}s (refresh skew ${s.token.refresh_skew_seconds}s)`,
    );
  }
  io.log(
    `[antigravity] local install: ${s.install.detected ? s.install.install_root : "(not found)"}`,
  );
  io.log(
    `[antigravity] nodes configured: ${s.nodes.configured ? s.nodes.count : 0}`,
  );
  for (const step of s.next_steps || []) {
    io.log(`[antigravity] next: ${step}`);
  }
}

function discover(context, io) {
  const result = discoverAndSaveAntigravityClientCredentials({
    save: context.save !== false,
  });
  if (!result.ok) {
    io.log(`[antigravity] ${result.message}`);
    if (result.install_root) io.log(`[antigravity] install root: ${result.install_root}`);
    return;
  }
  io.log(`[antigravity] ${result.message}`);
  io.log(`[antigravity] install root: ${result.install_root}`);
  io.log(`[antigravity] client_id: ${result.client_id}`);
  io.log(`[antigravity] client_secret: ${result.client_secret_masked}`);
  io.log(`[antigravity] saved: ${result.saved ? "yes" : "no"}`);
}
