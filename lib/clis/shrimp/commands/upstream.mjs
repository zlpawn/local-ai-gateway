import { handleAntigravityCommand } from "../../../antigravity/index.mjs";
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

export function registerUpstreamCommands(registry) {
  registry.register({
    name: "upstream.list",
    group: "auth",
    aliases: [],
    description: "List upstream auth providers",
    handler: async () => ({
      data: {
        providers: listProviders().map((provider) => ({
          id: provider.id === "antigravity" ? "google-oauth" : provider.id,
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
}
