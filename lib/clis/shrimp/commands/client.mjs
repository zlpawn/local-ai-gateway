import { parseCommandFlags } from "../parse-args.mjs";
import * as clientService from "../domain/client-service.mjs";

export function registerClientCommands(registry) {
  registry.register({
    name: "client.list",
    group: "client",
    aliases: ["c ls"],
    description: "List clients",
    handler: async ({ context }) => ({ data: clientService.listClients(context.paths) }),
  });

  registry.register({
    name: "client.get",
    group: "client",
    aliases: ["c get"],
    description: "Get one client",
    handler: async ({ args, context }) => {
      const { flags } = parseCommandFlags(args, { value: ["client"] });
      return {
        data: clientService.getClient({
          ...context.paths,
          client: flags.client || args[0],
        }),
      };
    },
  });

  registry.register({
    name: "client.copy",
    group: "client",
    aliases: ["c copy"],
    description: "Copy endpoints+secrets between clients",
    mutating: true,
    dryRun: true,
    handler: async ({ args, flags: globalFlags, context }) => {
      const { flags } = parseCommandFlags(args, {
        value: ["from", "to", "mode"],
      });
      return {
        data: clientService.copyClient({
          ...context.paths,
          from: flags.from,
          to: flags.to,
          mode: flags.mode || "replace",
          dryRun: globalFlags.dryRun,
        }),
      };
    },
  });

  registry.register({
    name: "client.add",
    group: "client",
    aliases: ["c add"],
    description: "Add client, optionally copy from another",
    mutating: true,
    dryRun: true,
    handler: async ({ args, flags: globalFlags, context }) => {
      const { flags } = parseCommandFlags(args, {
        value: ["client", "copy-from", "mode"],
      });
      return {
        data: clientService.addClient({
          ...context.paths,
          client: flags.client || args[0],
          copyFrom: flags["copy-from"],
          mode: flags.mode || "replace",
          dryRun: globalFlags.dryRun,
        }),
      };
    },
  });

  registry.register({
    name: "client.remove",
    group: "client",
    aliases: ["c rm"],
    description: "Remove client",
    mutating: true,
    dryRun: true,
    handler: async ({ args, flags: globalFlags, context }) => {
      const { flags } = parseCommandFlags(args, {
        boolean: ["yes"],
        value: ["client"],
      });
      return {
        data: clientService.removeClient({
          ...context.paths,
          client: flags.client || args[0],
          yes: globalFlags.yes || flags.yes,
          dryRun: globalFlags.dryRun,
        }),
      };
    },
  });
}