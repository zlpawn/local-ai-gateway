/**
 * Open/closed registry for extension task type plugins.
 *
 * A definition is:
 *   {
 *     type: string,
 *     capability: string,
 *     validateCreate(body) -> { ok:true, payload } | { ok:false, status, error },
 *     dedupeKey?(payload) -> string|null,
 *     assertCreatable?(payload, ctx) -> { ok:true } | { ok:false, status, error },
 *     materializeResult?(task, body, ctx) -> result,
 *     mapFailError?(body) -> { type, message },
 *   }
 */
export function createExtensionTaskTypeRegistry() {
  const handlers = new Map();

  return {
    register(type, definition) {
      if (typeof type !== "string" || !type) {
        throw new Error("handler type must be a non-empty string");
      }
      if (!definition || typeof definition !== "object") {
        throw new Error(`definition for '${type}' must be an object`);
      }
      if (typeof definition.capability !== "string" || !definition.capability) {
        throw new Error(`definition for '${type}' must include capability string`);
      }
      if (typeof definition.validateCreate !== "function") {
        throw new Error(`definition for '${type}' must have validateCreate()`);
      }
      if (!definition.type) definition.type = type;
      handlers.set(type, definition);
      return definition;
    },
    get(type) {
      return handlers.get(type) || null;
    },
    list() {
      return [...handlers.keys()].sort();
    },
  };
}
