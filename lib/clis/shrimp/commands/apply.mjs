import { parseCommandFlags } from "../parse-args.mjs";
import * as applyService from "../domain/apply-service.mjs";

export function registerApplyCommands(registry) {
  registry.register({
    name: "client.slots.get",
    description: "Get Claude Code model slots",
    handler: async ({ args, context }) => {
      const { flags } = parseCommandFlags(args, { value: ["client"] });
      return {
        data: applyService.getModelSlots({
          ...context.paths,
          client: flags.client || "code",
        }),
      };
    },
  });

  registry.register({
    name: "client.slots.set",
    description: "Set Claude Code model slots",
    mutating: true,
    dryRun: true,
    handler: async ({ args, flags: globalFlags, context }) => {
      const { flags } = parseCommandFlags(args, {
        value: ["client", "opus", "sonnet", "haiku", "fable"],
      });
      return {
        data: applyService.setModelSlots({
          ...context.paths,
          client: flags.client || "code",
          slots: {
            opus: flags.opus,
            sonnet: flags.sonnet,
            haiku: flags.haiku,
            fable: flags.fable,
          },
          dryRun: globalFlags.dryRun,
        }),
      };
    },
  });

  registry.register({
    name: "client.apply",
    description: "Apply client integration files/snippets",
    mutating: true,
    dryRun: true,
    handler: async ({ args, flags: globalFlags, context }) => {
      const { flags } = parseCommandFlags(args, {
        boolean: ["write-config", "yes"],
        value: ["client"],
      });
      return {
        data: applyService.applyClient({
          ...context.paths,
          client: flags.client || args[0],
          writeConfig: Boolean(flags["write-config"]),
          yes: globalFlags.yes || flags.yes,
          dryRun: globalFlags.dryRun,
        }),
      };
    },
  });

  registry.register({
    name: "client.snippet",
    description: "Show client connection snippet",
    handler: async ({ args, context }) => {
      const { flags } = parseCommandFlags(args, { value: ["client"] });
      return {
        data: applyService.snippetForClient({
          ...context.paths,
          client: flags.client || args[0],
        }),
      };
    },
  });

  registry.register({
    name: "codex.catalog.write",
    description: "Write Codex model catalog file",
    mutating: true,
    dryRun: true,
    handler: async ({ args, flags: globalFlags, context }) => {
      const { flags } = parseCommandFlags(args, { value: ["out", "output"] });
      if (globalFlags.dryRun) {
        return { data: { dry_run: true, would_write: flags.out || flags.output || "default catalog path" } };
      }
      return {
        data: applyService.writeCodexCatalog({
          ...context.paths,
          outputPath: flags.out || flags.output,
        }),
      };
    },
  });

  registry.register({
    name: "codex.history.unify",
    description: "Preview or apply Codex history provider unify",
    mutating: true,
    dryRun: true,
    handler: async ({ args, flags: globalFlags }) => {
      const { flags } = parseCommandFlags(args, {
        boolean: ["apply", "yes", "allow-running"],
      });
      return {
        data: applyService.unifyHistory({
          apply: Boolean(flags.apply),
          yes: globalFlags.yes || flags.yes,
          dryRun: globalFlags.dryRun || !flags.apply,
          allowRunningCodex: Boolean(flags["allow-running"]),
        }),
      };
    },
  });
}