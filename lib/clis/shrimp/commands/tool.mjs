import { parseCommandFlags } from "../parse-args.mjs";
import * as toolService from "../domain/tool-service.mjs";
import { DEFAULT_PORT } from "../constants.mjs";

export function registerToolCommands(registry) {
  registry.register({
    name: "tool.embedding",
    description: "Embed one text via gateway embeddings endpoint",
    handler: async ({ args, flags: globalFlags }) => {
      const { flags } = parseCommandFlags(args, {
        value: ["client", "endpoint-id", "model", "text", "dimensions", "host", "port"],
      });
      return {
        data: await toolService.embedText({
          client: flags.client || "codex",
          endpointId: flags["endpoint-id"],
          model: flags.model,
          text: flags.text,
          dimensions: flags.dimensions,
          host: flags.host || "127.0.0.1",
          port: Number(flags.port || globalFlags.port || DEFAULT_PORT),
        }),
      };
    },
  });

  registry.register({
    name: "tool.embedding-similarity",
    description: "Embed two texts and compute cosine similarity",
    handler: async ({ args, flags: globalFlags }) => {
      const { flags } = parseCommandFlags(args, {
        value: ["client", "endpoint-id", "model", "text-a", "text-b", "dimensions", "host", "port"],
      });
      return {
        data: await toolService.embedSimilarity({
          client: flags.client || "codex",
          endpointId: flags["endpoint-id"],
          model: flags.model,
          textA: flags["text-a"],
          textB: flags["text-b"],
          dimensions: flags.dimensions,
          host: flags.host || "127.0.0.1",
          port: Number(flags.port || globalFlags.port || DEFAULT_PORT),
        }),
      };
    },
  });
}