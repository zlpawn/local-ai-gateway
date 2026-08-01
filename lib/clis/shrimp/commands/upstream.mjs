import { handleAntigravityCommand } from "../../../antigravity/index.mjs";
import {
  getCodexAuthStatus,
  discoverCodexLocalAuth,
  refreshCodexLocalAuth,
} from "../../../codex/subscription-auth.mjs";
import { listProviders } from "../../../subscription-auth/index.mjs";

function captureIo() {
  const lines = [];
  return {
    lines,
    io: {
      log: (...args) => lines.push(args.map(String).join(" ")),
      error: (...args) => lines.push(args.map(String).join(" ")),
    },
  };
}

async function handleCodexCommand(context = {}, io = console) {
  const sub = String(context.subcommand || "").trim().toLowerCase();
  if (sub === "status") {
    const s = getCodexAuthStatus({ config: context.config || {} });
    io.log(`[codex] auth file: ${s.auth_path}`);
    io.log(`[codex] state: ${s.state_label} (${s.state})`);
    io.log(`[codex] auth_mode: ${s.token.auth_mode || "(none)"}`);
    io.log(`[codex] account_id: ${s.token.account_id || "(none)"}`);
    io.log(`[codex] access_token: ${s.token.access_token_configured ? "(set)" : "(none)"}`);
    io.log(`[codex] refresh_token: ${s.token.refresh_token_configured ? "(set)" : "(none)"}`);
    if (s.token.expires_in_seconds != null) {
      io.log(`[codex] token expires in ${s.token.expires_in_seconds}s`);
    }
    io.log(`[codex] nodes configured: ${s.nodes.configured ? s.nodes.count : 0}`);
    for (const step of s.next_steps || []) io.log(`[codex] next: ${step}`);
    return;
  }
  if (sub === "discover") {
    const result = discoverCodexLocalAuth({ config: context.config || {} });
    io.log(`[codex] ${result.message}`);
    if (result.auth_path) io.log(`[codex] auth path: ${result.auth_path}`);
    if (result.account_id) io.log(`[codex] account_id: ${result.account_id}`);
    if (result.expires_at) io.log(`[codex] expires_at: ${result.expires_at}`);
    return;
  }
  if (sub === "refresh") {
    const result = await refreshCodexLocalAuth({ config: context.config || {} });
    io.log(`[codex] ${result.message}`);
    if (result.status?.token?.expires_at) {
      io.log(`[codex] expires_at: ${result.status.token.expires_at}`);
    }
    return;
  }
  io.log("Usage: shrimp upstream codex-oauth <status|discover|refresh>");
}

export function registerUpstreamCommands(registry) {
  registry.register({
    name: "upstream.list",
    group: "auth",
    aliases: [],
    description: "List upstream auth providers",
    handler: async () => ({
      data: {
        providers: listProviders().map((provider) => ({
          id:
            provider.id === "antigravity"
              ? "google-oauth"
              : provider.id === "codex"
                ? "codex-oauth"
                : provider.id,
          provider_id: provider.id,
          label: provider.label,
          description: provider.description,
          commands: provider.commands,
        })),
      },
    }),
  });

  registry.register({
    name: "upstream.google-oauth.login",
    group: "auth",
    aliases: ["login google", "oauth login"],
    description: "Login to Google/Antigravity OAuth",
    mutating: true,
    dryRun: false,
    handler: async ({ context }) => {
      const cap = captureIo();
      await handleAntigravityCommand({ ...context, subcommand: "login" }, cap.io);
      return { data: { provider: "google-oauth", message: cap.lines.join("\n") } };
    },
  });

  registry.register({
    name: "upstream.google-oauth.status",
    group: "auth",
    aliases: ["oauth status"],
    description: "Show Google/Antigravity OAuth status",
    handler: async ({ context }) => {
      const cap = captureIo();
      await handleAntigravityCommand({ ...context, subcommand: "status" }, cap.io);
      return { data: { provider: "google-oauth", message: cap.lines.join("\n") } };
    },
  });

  registry.register({
    name: "upstream.google-oauth.discover",
    group: "auth",
    aliases: ["oauth discover", "discover google"],
    description: "Discover Antigravity OAuth client credentials from local install",
    mutating: true,
    dryRun: false,
    handler: async ({ context }) => {
      const cap = captureIo();
      await handleAntigravityCommand({ ...context, subcommand: "discover" }, cap.io);
      return { data: { provider: "google-oauth", message: cap.lines.join("\n") } };
    },
  });

  registry.register({
    name: "upstream.codex-oauth.status",
    group: "auth",
    aliases: ["codex status", "status codex"],
    description: "Show local Codex/ChatGPT subscription auth status",
    handler: async ({ context }) => {
      const cap = captureIo();
      await handleCodexCommand({ ...context, subcommand: "status" }, cap.io);
      return { data: { provider: "codex-oauth", message: cap.lines.join("\n") } };
    },
  });

  registry.register({
    name: "upstream.codex-oauth.discover",
    group: "auth",
    aliases: ["discover codex", "codex discover"],
    description: "Discover local Codex/ChatGPT auth.json login state",
    handler: async ({ context }) => {
      const cap = captureIo();
      await handleCodexCommand({ ...context, subcommand: "discover" }, cap.io);
      return { data: { provider: "codex-oauth", message: cap.lines.join("\n") } };
    },
  });

  registry.register({
    name: "upstream.codex-oauth.refresh",
    group: "auth",
    aliases: ["refresh codex", "codex refresh"],
    description: "Refresh local Codex/ChatGPT access token if possible",
    mutating: true,
    dryRun: false,
    handler: async ({ context }) => {
      const cap = captureIo();
      await handleCodexCommand({ ...context, subcommand: "refresh" }, cap.io);
      return { data: { provider: "codex-oauth", message: cap.lines.join("\n") } };
    },
  });
}
