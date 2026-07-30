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
    group: "auth",
    aliases: [],
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
    group: "auth",
    aliases: ["login google","oauth login"],
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

}