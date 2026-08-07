import { createExtensionTaskStore } from "./store.mjs";
import { createExtensionTaskTypeRegistry } from "./registry.mjs";
import { createCookiesExportType } from "./types/cookies-export.mjs";
import { routeCookieExportViaExtension, routeExtensionTaskRequest } from "./routes.mjs";

/**
 * Wire store + type plugins + routes for the gateway process.
 * New task types: register here (or via registry.register) without editing claim/complete.
 */
export function createExtensionTaskSystem({ dataDir, configDir, extensionStore, ttlMs = 90_000 } = {}) {
  if (!dataDir) throw new Error("dataDir is required");
  if (!configDir) throw new Error("configDir is required");
  if (!extensionStore) throw new Error("extensionStore is required");

  const store = createExtensionTaskStore({ dataDir, ttlMs });
  const registry = createExtensionTaskTypeRegistry();
  registry.register("cookies.export", createCookiesExportType());

  const deps = { store, registry, extensionStore, configDir };

  return {
    store,
    registry,
    deps,
    routeExtensionTaskRequest: (req, res, context, reqPath) =>
      routeExtensionTaskRequest(req, res, context, reqPath, deps),
    routeCookieExportViaExtension: (req, res, context, reqPath) =>
      routeCookieExportViaExtension(req, res, context, reqPath, deps),
  };
}
