import { parseCommandFlags } from "../parse-args.mjs";
import * as configService from "../domain/config-service.mjs";

export function registerConfigCommands(registry) {
  registry.register({
    name: "config.get",
    description: "Get public config and secret states",
    handler: async ({ context }) => ({
      data: await configService.getConfig(context.paths),
    }),
  });

  registry.register({
    name: "config.validate",
    description: "Validate gateway config",
    handler: async ({ context }) => ({
      data: await configService.validateConfig(context.paths),
    }),
  });

  registry.register({
    name: "config.restore-template",
    description: "Restore gateway.config.json from public template",
    mutating: true,
    dryRun: true,
    handler: async ({ flags, context }) => ({
      data: await configService.restoreTemplate({
        packageRoot: context.packageRoot,
        dataDir: context.dataDir,
        yes: flags.yes,
        dryRun: flags.dryRun,
      }),
    }),
  });
}