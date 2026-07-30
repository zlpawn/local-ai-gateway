export function registerSchemaCommands(registry) {
  registry.register({
    name: "help",
    description: "Show grouped commands and common tips",
    group: "general",
    aliases: ["h", "--help"],
    handler: async ({ registry: reg }) => ({
      data: reg.helpData(),
    }),
  });

  registry.register({
    name: "schema",
    description: "Inspect command schema (machine friendly)",
    group: "general",
    aliases: ["s"],
    params: [{ name: "command", required: false, type: "string" }],
    handler: async ({ args, registry: reg }) => {
      if (!args.length) return { data: { commands: reg.toSchema() } };
      const joined = args.join(" ");
      const dotted = args.join(".");
      const resolved = reg.toSchema(joined) || reg.toSchema(dotted) || reg.toSchema(args[0]);
      if (!resolved) {
        const err = new Error(`Unknown command schema: ${args.join(" ")}`);
        err.type = "not_found";
        err.code = "schema_not_found";
        throw err;
      }
      return { data: resolved };
    },
  });
}