import type { AppConfig, Selection, ToolsView } from "./types";

export const state = {
  config: {
    server: { host: "127.0.0.1", port: 8787 },
    clients: {
      code: { endpoints: [], model_slots: {} },
      desktop: { endpoints: [] },
      codex: { endpoints: [] },
      deeptutor: { endpoints: [] },
    },
  } as AppConfig,
  codexModelCatalogPath: "~/.codex/gateway-model-catalog.json",
  selectedEndpoint: null as Selection | null,
  activeClient: "code",
  toolsView: "cards" as ToolsView,
};
