/**
 * Plugin registry for task handlers.
 *
 * A handler is:
 *   { type: string,
 *     validate?(payload) -> string[] | null,  // optional, returns issue list
 *     async run(payload, { signal, onProgress, onSteps, store }) -> result }
 *
 * - signal: AbortSignal (handler should check periodically)
 * - onProgress(fraction, message): update task progress 0..1
 * - onSteps(steps, currentStepId): update step list for UI display
 * - store: the task store (for cancel checks via isCancelRequested)
 */
export function createHandlerRegistry() {
  const handlers = new Map();

  return {
    register(type, handler) {
      if (typeof type !== "string" || !type) throw new Error("handler type must be a non-empty string");
      if (typeof handler?.run !== "function") throw new Error(`handler for '${type}' must have a run() function`);
      handlers.set(type, handler);
    },
    get(type) { return handlers.get(type) || null; },
    has(type) { return handlers.has(type); },
    list() { return [...handlers.keys()].sort(); },
  };
}
