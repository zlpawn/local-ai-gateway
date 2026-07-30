import { runDoctor } from "../domain/doctor-service.mjs";
import { DEFAULT_PORT } from "../constants.mjs";

export function registerDoctorCommands(registry) {
  registry.register({
    name: "doctor",
    group: "runtime",
    aliases: ["doc","check"],
    description: "Structured diagnostics",
    handler: async ({ flags, context }) => {
      const report = await runDoctor({
        configPath: context.paths.configPath,
        secretsPath: context.paths.secretsPath,
        host: process.env.GATEWAY_HOST || "127.0.0.1",
        port: flags.port || Number(process.env.GATEWAY_PORT || process.env.PORT || DEFAULT_PORT),
      });
      return { data: report, next: report.recommendations || [] };
    },
  });

  registry.register({
    name: "validate",
    group: "config",
    aliases: ["cfg check"],
    description: "Alias of config validate",
    handler: async ({ context }) => {
      const { validateConfig } = await import("../domain/config-service.mjs");
      return { data: await validateConfig(context.paths) };
    },
  });
}