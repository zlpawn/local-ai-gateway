import { parseCommandFlags } from "../parse-args.mjs";
import * as endpointService from "../domain/endpoint-service.mjs";

function commonValueFlags() {
  return [
    "client", "name", "type", "purpose", "base-url", "models", "model-mapping",
    "upstream-model", "embedding-model", "dimensions", "options", "api-key",
    "api-key-env", "id",
  ];
}

function mapFlags(flags) {
  return {
    client: flags.client,
    name: flags.name,
    type: flags.type,
    purpose: flags.purpose,
    base_url: flags["base-url"],
    models: flags.models,
    model_mapping: flags["model-mapping"],
    upstream_model: flags["upstream-model"],
    embedding_model: flags["embedding-model"],
    dimensions: flags.dimensions,
    is_default: flags["is-default"] || flags.default || false,
    expose_models: flags["expose-models"],
    enabled: flags.enabled,
    options: flags.options,
    api_key: flags["api-key"],
    api_key_env: flags["api-key-env"],
    id: flags.id,
  };
}

export function registerEndpointCommands(registry) {
  registry.register({
    name: "endpoint.list",
    description: "List endpoints",
    params: [
      { name: "client", required: false, type: "string" },
      { name: "purpose", required: false, type: "string" },
    ],
    handler: async ({ args, context }) => {
      const { flags } = parseCommandFlags(args, { value: ["client", "purpose"] });
      return {
        data: endpointService.listEndpoints({
          ...context.paths,
          client: flags.client,
          purpose: flags.purpose,
        }),
      };
    },
  });

  registry.register({
    name: "endpoint.get",
    description: "Get one endpoint",
    mutating: false,
    handler: async ({ args, context }) => {
      const { flags } = parseCommandFlags(args, { value: ["id"] });
      return {
        data: endpointService.getEndpoint({ ...context.paths, id: flags.id || args[0] }),
      };
    },
  });

  registry.register({
    name: "endpoint.add",
    description: "Add endpoint",
    mutating: true,
    dryRun: true,
    handler: async ({ args, flags: globalFlags, context }) => {
      const { flags } = parseCommandFlags(args, {
        boolean: ["is-default", "default", "enabled", "expose-models"],
        value: commonValueFlags(),
      });
      return {
        data: endpointService.addEndpoint({
          ...context.paths,
          ...mapFlags(flags),
          dryRun: globalFlags.dryRun,
        }),
      };
    },
  });

  registry.register({
    name: "endpoint.update",
    description: "Update endpoint",
    mutating: true,
    dryRun: true,
    handler: async ({ args, flags: globalFlags, context }) => {
      const { flags } = parseCommandFlags(args, {
        boolean: ["is-default", "default", "enabled", "expose-models"],
        value: commonValueFlags(),
      });
      return {
        data: endpointService.updateEndpoint({
          ...context.paths,
          ...mapFlags(flags),
          dryRun: globalFlags.dryRun,
        }),
      };
    },
  });

  registry.register({
    name: "endpoint.remove",
    description: "Remove endpoint",
    mutating: true,
    dryRun: true,
    handler: async ({ args, flags: globalFlags, context }) => {
      const { flags } = parseCommandFlags(args, { boolean: ["yes"], value: ["id"] });
      return {
        data: endpointService.removeEndpoint({
          ...context.paths,
          id: flags.id || args[0],
          yes: globalFlags.yes || flags.yes,
          dryRun: globalFlags.dryRun,
        }),
      };
    },
  });

  registry.register({
    name: "endpoint.set-default",
    description: "Mark endpoint default",
    mutating: true,
    dryRun: true,
    handler: async ({ args, flags: globalFlags, context }) => {
      const { flags } = parseCommandFlags(args, { value: ["id"] });
      return {
        data: endpointService.setDefaultEndpoint({
          ...context.paths,
          id: flags.id || args[0],
          dryRun: globalFlags.dryRun,
        }),
      };
    },
  });

  registry.register({
    name: "endpoint.enable",
    description: "Enable endpoint",
    mutating: true,
    dryRun: true,
    handler: async ({ args, flags: globalFlags, context }) => {
      const { flags } = parseCommandFlags(args, { value: ["id"] });
      return {
        data: endpointService.enableEndpoint({
          ...context.paths,
          id: flags.id || args[0],
          enabled: true,
          dryRun: globalFlags.dryRun,
        }),
      };
    },
  });

  registry.register({
    name: "endpoint.disable",
    description: "Disable endpoint",
    mutating: true,
    dryRun: true,
    handler: async ({ args, flags: globalFlags, context }) => {
      const { flags } = parseCommandFlags(args, { value: ["id"] });
      return {
        data: endpointService.enableEndpoint({
          ...context.paths,
          id: flags.id || args[0],
          enabled: false,
          dryRun: globalFlags.dryRun,
        }),
      };
    },
  });
}