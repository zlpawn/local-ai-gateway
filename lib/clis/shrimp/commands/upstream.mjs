import { handleAntigravityCommand } from "../../../antigravity/index.mjs";
import { parseCommandFlags } from "../parse-args.mjs";

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

export function registerUpstreamCommands(registry) {
  registry.register({
    name: "upstream.list",
    description: "List upstream auth providers",
    handler: async () => ({
      data: {
        providers: [
          {
            id: "google-oauth",
            label: "Google OAuth / Antigravity provider",
            commands: ["login", "status"],
          },
        ],
      },
    }),
  });

  registry.register({
    name: "upstream.google-oauth.login",
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
    description: "Show Google/Antigravity OAuth status",
    handler: async ({ context }) => {
      const cap = captureIo();
      await handleAntigravityCommand({ ...context, subcommand: "status" }, cap.io);
      return { data: { provider: "google-oauth", message: cap.lines.join("\n") } };
    },
  });

  // temporary compatibility alias
  registry.register({
    name: "antigravity.login",
    description: "Deprecated alias of upstream google-oauth login",
    mutating: true,
    handler: async ({ context }) => {
      const cap = captureIo();
      await handleAntigravityCommand({ ...context, subcommand: "login" }, cap.io);
      return {
        data: { provider: "google-oauth", deprecated: true, message: cap.lines.join("\n") },
        next: [{ command: "upstream google-oauth login", reason: "Preferred command" }],
      };
    },
  });

  registry.register({
    name: "antigravity.status",
    description: "Deprecated alias of upstream google-oauth status",
    handler: async ({ context }) => {
      const cap = captureIo();
      await handleAntigravityCommand({ ...context, subcommand: "status" }, cap.io);
      return {
        data: { provider: "google-oauth", deprecated: true, message: cap.lines.join("\n") },
        next: [{ command: "upstream google-oauth status", reason: "Preferred command" }],
      };
    },
  });
}