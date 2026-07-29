import { parseCommandFlags } from "../parse-args.mjs";
import * as secretService from "../domain/secret-service.mjs";

export function registerSecretCommands(registry) {
  registry.register({
    name: "secret.list",
    description: "List secret states by endpoint",
    handler: async ({ args, context }) => {
      const { flags } = parseCommandFlags(args, { value: ["client"] });
      return { data: secretService.listSecrets({ ...context.paths, client: flags.client }) };
    },
  });

  registry.register({
    name: "secret.get",
    description: "Get one endpoint secret state",
    handler: async ({ args, context }) => {
      const { flags } = parseCommandFlags(args, { value: ["endpoint-id", "id"] });
      return {
        data: secretService.getSecret({
          ...context.paths,
          endpointId: flags["endpoint-id"] || flags.id || args[0],
        }),
      };
    },
  });

  registry.register({
    name: "secret.set",
    description: "Set endpoint API key or env reference",
    mutating: true,
    dryRun: true,
    handler: async ({ args, flags: globalFlags, context }) => {
      const { flags } = parseCommandFlags(args, {
        value: ["endpoint-id", "id", "api-key", "api-key-env"],
      });
      return {
        data: secretService.setSecret({
          ...context.paths,
          endpointId: flags["endpoint-id"] || flags.id,
          apiKey: flags["api-key"],
          apiKeyEnv: flags["api-key-env"],
          dryRun: globalFlags.dryRun,
        }),
      };
    },
  });

  registry.register({
    name: "secret.unset",
    description: "Remove endpoint secret",
    mutating: true,
    dryRun: true,
    handler: async ({ args, flags: globalFlags, context }) => {
      const { flags } = parseCommandFlags(args, {
        boolean: ["yes"],
        value: ["endpoint-id", "id"],
      });
      return {
        data: secretService.unsetSecret({
          ...context.paths,
          endpointId: flags["endpoint-id"] || flags.id || args[0],
          yes: globalFlags.yes || flags.yes,
          dryRun: globalFlags.dryRun,
        }),
      };
    },
  });
}