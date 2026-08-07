import { readJsonBody, sendJson } from "./http.mjs";

/**
 * Generic extension-task bus routes.
 * Type-specific behavior lives in registry plugins (open/closed).
 */
export async function routeExtensionTaskRequest(req, res, _context, reqPath, deps) {
  const { store, registry, extensionStore } = deps;

  // POST /v1/extension-tasks
  if (reqPath === "/v1/extension-tasks" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      return createTaskFromBody(res, body, deps);
    } catch {
      return sendJson(res, 400, { error: { type: "invalid_request_error", message: "Invalid JSON body." } });
    }
  }

  // POST /v1/extension-tasks/claim
  if (reqPath === "/v1/extension-tasks/claim" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const extensionId = String(body.extension_id || "").trim();
      if (!extensionId) {
        return sendJson(res, 400, { error: { type: "invalid_request_error", message: "Missing 'extension_id' field." } });
      }
      const ext = extensionStore.get(extensionId);
      if (!ext) {
        return sendJson(res, 404, { error: { type: "extension_not_registered", message: "Extension not registered." } });
      }
      if (typeof extensionStore.heartbeat === "function") {
        extensionStore.heartbeat(extensionId);
      }
      const capabilities = Array.isArray(body.capabilities) && body.capabilities.length
        ? body.capabilities.map(String)
        : (ext.capabilities || []);
      const limit = Number(body.limit) > 0 ? Number(body.limit) : 1;
      const tasks = store.claim({ extensionId, capabilities, limit });
      return sendJson(res, 200, { tasks });
    } catch {
      return sendJson(res, 400, { error: { type: "invalid_request_error", message: "Invalid JSON body." } });
    }
  }

  // POST /v1/extension-tasks/:id/complete
  if (reqPath.startsWith("/v1/extension-tasks/") && reqPath.endsWith("/complete") && req.method === "POST") {
    const id = decodeURIComponent(reqPath.slice("/v1/extension-tasks/".length, -"/complete".length).replace(/\/$/, ""));
    return handleComplete(req, res, id, deps);
  }

  // POST /v1/extension-tasks/:id/fail
  if (reqPath.startsWith("/v1/extension-tasks/") && reqPath.endsWith("/fail") && req.method === "POST") {
    const id = decodeURIComponent(reqPath.slice("/v1/extension-tasks/".length, -"/fail".length).replace(/\/$/, ""));
    return handleFail(req, res, id, deps);
  }

  // GET /v1/extension-tasks/:id
  if (reqPath.startsWith("/v1/extension-tasks/") && req.method === "GET") {
    const id = decodeURIComponent(reqPath.slice("/v1/extension-tasks/".length));
    if (!id || id.includes("/")) {
      return sendJson(res, 404, { error: { type: "not_found", message: "Task not found." } });
    }
    const task = store.get(id);
    if (!task) return sendJson(res, 404, { error: { type: "not_found", message: "Task not found." } });
    return sendJson(res, 200, { task });
  }

  return sendJson(res, 404, { error: { type: "not_found", message: `${req.method} ${reqPath} is not available on the extension-tasks API.` } });
}

function createTaskObject(body, deps) {
  const { store, registry, extensionStore } = deps;
  const type = String(body.type || "").trim();
  if (!type) {
    return { ok: false, status: 400, error: { type: "invalid_request_error", message: "Missing 'type' field." } };
  }
  const def = registry.get(type);
  if (!def) {
    return { ok: false, status: 400, error: { type: "unknown_task_type", message: `Unknown task type '${type}'.` } };
  }
  const validated = def.validateCreate(body.payload ?? body);
  if (!validated?.ok) {
    return {
      ok: false,
      status: validated?.status || 400,
      error: validated?.error || { type: "invalid_request_error", message: "Invalid payload." },
    };
  }
  if (typeof def.assertCreatable === "function") {
    const guard = def.assertCreatable(validated.payload, { extensionStore });
    if (!guard?.ok) {
      return {
        ok: false,
        status: guard?.status || 409,
        error: guard?.error || { type: "no_online_extension", message: "No online extension." },
      };
    }
  }
  const dedupeKey = typeof def.dedupeKey === "function" ? def.dedupeKey(validated.payload) : null;
  const task = store.create({
    type: def.type || type,
    capability: String(body.capability || def.capability),
    payload: validated.payload,
    dedupeKey,
  });
  return { ok: true, task };
}

function createTaskFromBody(res, body, deps) {
  const created = createTaskObject(body, deps);
  if (!created.ok) return sendJson(res, created.status, { error: created.error });
  return sendJson(res, 200, { task: created.task });
}

async function handleComplete(req, res, id, deps) {
  const { store, registry, configDir } = deps;
  try {
    const body = await readJsonBody(req);
    const extensionId = String(body.extension_id || "").trim();
    if (!extensionId) {
      return sendJson(res, 400, { error: { type: "invalid_request_error", message: "Missing 'extension_id' field." } });
    }
    const task = store.get(id);
    if (!task) return sendJson(res, 404, { error: { type: "not_found", message: "Task not found." } });
    const def = registry.get(task.type);
    if (!def || typeof def.materializeResult !== "function") {
      try {
        const failed = store.fail(id, {
          extensionId,
          error: { type: "unsupported_task_type", message: `No materializer for type '${task.type}'.` },
        });
        return sendJson(res, 200, { task: failed });
      } catch (err) {
        if (err?.message === "conflict" || err?.code === "conflict") {
          return sendJson(res, 409, { error: { type: "conflict", message: "Task is not runnable by this extension." } });
        }
        throw err;
      }
    }
    try {
      const result = def.materializeResult(task, body, { configDir });
      const done = store.complete(id, { extensionId, result });
      return sendJson(res, 200, { task: done });
    } catch (err) {
      if (err?.message === "conflict" || err?.code === "conflict") {
        return sendJson(res, 409, { error: { type: "conflict", message: "Task is not runnable by this extension." } });
      }
      try {
        const failed = store.fail(id, {
          extensionId,
          error: {
            type: String(err?.type || "extension_error"),
            message: err instanceof Error ? err.message : String(err),
          },
        });
        return sendJson(res, 200, { task: failed });
      } catch (failErr) {
        if (failErr?.message === "conflict" || failErr?.code === "conflict") {
          return sendJson(res, 409, { error: { type: "conflict", message: "Task is not runnable by this extension." } });
        }
        throw failErr;
      }
    }
  } catch {
    return sendJson(res, 400, { error: { type: "invalid_request_error", message: "Invalid JSON body." } });
  }
}

async function handleFail(req, res, id, deps) {
  const { store, registry } = deps;
  try {
    const body = await readJsonBody(req);
    const extensionId = String(body.extension_id || "").trim();
    if (!extensionId) {
      return sendJson(res, 400, { error: { type: "invalid_request_error", message: "Missing 'extension_id' field." } });
    }
    const task = store.get(id);
    if (!task) return sendJson(res, 404, { error: { type: "not_found", message: "Task not found." } });
    const def = registry.get(task.type);
    const error = typeof def?.mapFailError === "function"
      ? def.mapFailError(body)
      : {
          type: String(body?.error?.type || "extension_error"),
          message: String(body?.error?.message || "Task failed"),
        };
    try {
      const failed = store.fail(id, { extensionId, error });
      return sendJson(res, 200, { task: failed });
    } catch (err) {
      if (err?.message === "conflict" || err?.code === "conflict") {
        return sendJson(res, 409, { error: { type: "conflict", message: "Task is not fail-able by this extension." } });
      }
      throw err;
    }
  } catch {
    return sendJson(res, 400, { error: { type: "invalid_request_error", message: "Invalid JSON body." } });
  }
}

/**
 * Thin cookie facade for skills/agents.
 */
export async function routeCookieExportViaExtension(req, res, _context, reqPath, deps) {
  // POST /v1/cookies/export-via-extension
  if (reqPath === "/v1/cookies/export-via-extension" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const created = createTaskObject({ type: "cookies.export", payload: body, domain: body?.domain }, deps);
      if (!created.ok) {
        return sendJson(res, created.status, { error: created.error });
      }
      const task = created.task;
      return sendJson(res, 200, {
        task_id: task.id,
        status: task.status,
        poll_after_ms: 2000,
        max_polls_suggested: 30,
        task,
      });
    } catch (err) {
      return sendJson(res, 400, { error: { type: "invalid_request_error", message: err instanceof Error ? err.message : "Invalid JSON body." } });
    }
  }

  // GET /v1/cookies/export-via-extension/:taskId
  if (reqPath.startsWith("/v1/cookies/export-via-extension/") && req.method === "GET") {
    const taskId = decodeURIComponent(reqPath.slice("/v1/cookies/export-via-extension/".length));
    if (!taskId) {
      return sendJson(res, 400, { error: { type: "invalid_request_error", message: "Missing task id." } });
    }
    const task = deps.store.get(taskId);
    if (!task) return sendJson(res, 404, { error: { type: "not_found", message: "Task not found." } });
    return sendJson(res, 200, {
      task_id: task.id,
      status: task.status,
      result: task.result,
      error: task.error,
      task,
    });
  }

  return sendJson(res, 404, { error: { type: "not_found", message: `${req.method} ${reqPath} is not available on the cookie export-via-extension API.` } });
}
