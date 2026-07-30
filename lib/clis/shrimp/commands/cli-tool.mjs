import { parseCommandFlags } from "../parse-args.mjs";
import * as cliToolService from "../domain/cli-tool-service.mjs";

export function registerCliToolCommands(registry) {
  registry.register({
    name: "cli-tool.list",
    description: "Discover installed local CLIs",
    handler: async ({ args }) => {
      const { flags } = parseCommandFlags(args, {
        boolean: ["probe"],
        value: ["query"],
      });
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
    description: "Install a CLI via shell command",
    mutating: true,
    dryRun: true,
    handler: async ({ args, flags: globalFlags }) => {
      const { flags } = parseCommandFlags(args, { value: ["command", "name"] });
      return {
        data: await cliToolService.installCliTool({
          command: flags.command,
          name: flags.name,
          dryRun: globalFlags.dryRun,
        }),
      };
    },
  });

  registry.register({
    name: "cli-tool.history.list",
    description: "List CLI install history",
    handler: async () => ({ data: cliToolService.listCliHistory() }),
  });

  registry.register({
    name: "cli-tool.history.rerun",
    description: "Re-run CLI install history record",
    mutating: true,
    dryRun: true,
    handler: async ({ args, flags: globalFlags }) => {
      const { flags } = parseCommandFlags(args, { value: ["id"] });
      if (globalFlags.dryRun) return { data: { dry_run: true, id: flags.id || args[0] } };
      return { data: await cliToolService.rerunCliInstall({ id: flags.id || args[0] }) };
    },
  });

  registry.register({
    name: "cli-tool.source.list",
    description: "List CLI scan sources",
    handler: async () => ({ data: cliToolService.listSources() }),
  });

  registry.register({
    name: "cli-tool.source.add",
    description: "Add CLI scan source",
    mutating: true,
    dryRun: true,
    handler: async ({ args, flags: globalFlags }) => {
      const { flags } = parseCommandFlags(args, {
        value: ["name", "label", "dirs"],
      });
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
    description: "Reset CLI scan sources to defaults",
    mutating: true,
    dryRun: true,
    handler: async ({ flags: globalFlags }) => {
      if (globalFlags.dryRun) return { data: { dry_run: true } };
      return { data: cliToolService.resetSources() };
    },
  });
}