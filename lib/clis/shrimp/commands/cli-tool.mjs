import { resolveInstallInvocation } from "../parse-args.mjs";
import * as cliToolService from "../domain/cli-tool-service.mjs";

export function registerCliToolCommands(registry) {
  registry.register({
    name: "cli-tool.list",
    group: "tools",
    aliases: ["tools ls","clis"],
    description: "Discover installed local CLIs",
    handler: async ({ args }) => {
      const { flags } = resolveListish(args, ["query"], ["probe"]);
      return {
        data: await cliToolService.listCliTools({
          query: flags.query || "",
          probe: Boolean(flags.probe),
        }),
      };
    },
  });

  registry.register({
    name: "cli-tool.install",
    group: "tools",
    aliases: ["tools install"],
    description: "Install a CLI via shell command. --command optional; trailing args become the command.",
    mutating: true,
    dryRun: true,
    params: [
      { name: "command", required: false, type: "string", description: "Optional; if omitted, trailing args form the command" },
      { name: "name", required: false, type: "string" },
      { name: "interactive", required: false, type: "boolean" },
    ],
    handler: async ({ args, flags: globalFlags }) => {
      const { flags, command } = resolveInstallInvocation(args, {
        boolean: ["interactive"],
        value: ["command", "name"],
      });
      return {
        data: await cliToolService.installCliTool({
          command,
          name: flags.name,
          dryRun: globalFlags.dryRun,
          interactive: Boolean(flags.interactive),
        }),
      };
    },
  });

  registry.register({
    name: "cli-tool.history.list",
    group: "tools",
    aliases: [],
    description: "List CLI install history",
    handler: async () => ({ data: cliToolService.listCliHistory() }),
  });

  registry.register({
    name: "cli-tool.history.rerun",
    group: "tools",
    aliases: [],
    description: "Re-run CLI install history record",
    mutating: true,
    dryRun: true,
    handler: async ({ args, flags: globalFlags }) => {
      const { flags, positionals } = resolveListish(args, ["id"], ["interactive"]);
      return {
        data: await cliToolService.rerunCliInstall({
          id: flags.id || positionals[0],
          interactive: Boolean(flags.interactive),
          dryRun: globalFlags.dryRun,
        }),
      };
    },
  });

  registry.register({
    name: "cli-tool.source.list",
    group: "tools",
    aliases: [],
    description: "List CLI scan sources",
    handler: async () => ({ data: cliToolService.listSources() }),
  });

  registry.register({
    name: "cli-tool.source.add",
    group: "tools",
    aliases: [],
    description: "Add CLI scan source",
    mutating: true,
    dryRun: true,
    handler: async ({ args, flags: globalFlags }) => {
      const { flags } = resolveListish(args, ["name", "label", "dirs"]);
      if (globalFlags.dryRun) {
        return { data: { dry_run: true, name: flags.name, label: flags.label, dirs: flags.dirs } };
      }
      return {
        data: cliToolService.addSource({
          name: flags.name,
          label: flags.label,
          dirs: flags.dirs,
        }),
      };
    },
  });

  registry.register({
    name: "cli-tool.source.reset",
    group: "tools",
    aliases: [],
    description: "Reset CLI scan sources to defaults",
    mutating: true,
    dryRun: true,
    handler: async ({ flags: globalFlags }) => {
      if (globalFlags.dryRun) return { data: { dry_run: true } };
      return { data: cliToolService.resetSources() };
    },
  });
}

function resolveListish(argv = [], value = [], boolean = []) {
  const boolSet = new Set(boolean);
  const valueSet = new Set(value);
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i]);
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (token.startsWith("--") && token.includes("=")) {
      const eq = token.indexOf("=");
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const name = token.replace(/^--?/, "");
    if (boolSet.has(name)) {
      flags[name] = true;
      continue;
    }
    if (valueSet.has(name)) {
      flags[name] = argv[++i];
      continue;
    }
    flags[name] = true;
  }
  return { flags, positionals };
}