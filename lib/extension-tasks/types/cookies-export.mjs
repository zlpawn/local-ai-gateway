import { writeNetscapeCookieFile } from "../write-netscape.mjs";

/**
 * cookies.export task type plugin.
 * Open for replacement/extension without editing core claim/complete routes.
 */
export function createCookiesExportType() {
  return {
    type: "cookies.export",
    capability: "cookies",

    validateCreate(body = {}) {
      const domain = String(body.domain || body?.payload?.domain || "").trim();
      if (!domain) {
        return {
          ok: false,
          status: 400,
          error: { type: "invalid_request_error", message: "Missing 'domain' field." },
        };
      }
      return { ok: true, payload: { domain } };
    },

    dedupeKey(payload = {}) {
      const domain = String(payload.domain || "").trim().toLowerCase().replace(/^www\./, "");
      return domain ? `cookies.export:${domain}` : null;
    },

    assertCreatable(_payload, { extensionStore } = {}) {
      const list = typeof extensionStore?.list === "function" ? extensionStore.list() : [];
      const online = list.some((ext) => ext.online && Array.isArray(ext.capabilities) && ext.capabilities.includes("cookies"));
      if (!online) {
        return {
          ok: false,
          status: 409,
          error: {
            type: "no_online_extension",
            message: "No online browser extension with cookies capability. Open Chrome and load Leo cookie.txt Locally.",
          },
        };
      }
      return { ok: true };
    },

    materializeResult(task, body = {}, { configDir } = {}) {
      if (!Array.isArray(body.cookies)) {
        const err = new Error("Missing or empty 'cookies' array.");
        err.type = "invalid_request_error";
        throw err;
      }
      if (body.cookies.length === 0) {
        const err = new Error(`No cookies for domain ${task?.payload?.domain || ""}`.trim());
        err.type = "no_cookies";
        throw err;
      }
      try {
        return writeNetscapeCookieFile({
          configDir,
          domain: task?.payload?.domain || body.domain || "",
          cookies: body.cookies,
        });
      } catch (err) {
        if (!err.type) err.type = "no_cookies";
        throw err;
      }
    },

    mapFailError(body = {}) {
      return {
        type: String(body?.error?.type || "extension_error"),
        message: String(body?.error?.message || "Task failed"),
      };
    },
  };
}
