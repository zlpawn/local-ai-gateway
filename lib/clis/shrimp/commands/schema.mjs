export function registerSchemaCommands(registry) {
  registry.register({
    name: "schema",
    description: "Inspect command schemas",
    params: [{ name: "command", required: false, type: "string" }],
    handler: async ({ args, registry: reg }) => {
      const name = args[0] || null;
      if (name) {
        const schema = reg.toSchema(name.includes(".") ? name : name.replaceAll(" ", "."));
        // also try joined tokens
        const joined = args.join(".");
        const resolved = schema || reg.toSchema(joined);
        if (!resolved) {
          const err = new Error(`Unknown command schema: ${args.join(" ")}`);
          err.type = "not_found";
          err.code = "schema_not_found";
          throw err;
        }
        return { data: resolved };
      }
      return { data: { commands: reg.toSchema() } };
    },
  });

  registry.register({
    name: "help",
    description: "Show available commands",
    handler: async ({ registry: reg }) => ({
      data: {
        usage: "shrimp <command> [options]",
        commands: reg.list().map((c) => ({ name: c.name, description: c.description })),
      },
    }),
  });
}