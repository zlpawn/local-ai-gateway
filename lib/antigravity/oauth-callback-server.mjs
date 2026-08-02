// Local HTTP server to receive the OAuth redirect callback.
// Listens on 127.0.0.1 only; resolves the authorization code once received.
import http from "node:http";
import net from "node:net";

export function isPortFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, host);
  });
}

export async function findFreePort(preferredPort, { host = "127.0.0.1", attempts = 20 } = {}) {
  const start = Number(preferredPort) || 18789;
  for (let i = 0; i < attempts; i += 1) {
    const port = start + i;
    if (await isPortFree(port, host)) return port;
  }
  const error = new Error(
    `No free OAuth callback port in range ${start}-${start + attempts - 1} on ${host}`,
  );
  error.code = "callback_port_in_use";
  throw error;
}

export function startCallbackServer({
  port,
  state,
  pathPrefix = "/callback",
  host = "127.0.0.1",
  timeoutMs = 5 * 60 * 1000,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { server.close(); } catch {}
      fn(value);
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${host}:${port}`);
      if (url.pathname !== pathPrefix) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const returnedState = url.searchParams.get("state");
      if (error) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
        settle(reject, Object.assign(new Error(`OAuth authorization failed: ${error}`), {
          code: "oauth_denied",
        }));
        return;
      }
      if (returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>State mismatch</h1>");
        settle(reject, Object.assign(new Error("OAuth state mismatch (possible CSRF)"), {
          code: "oauth_state_mismatch",
        }));
        return;
      }
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("missing code");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<h1>Authorization successful</h1>" +
          "<p>You can close this tab and return to Shrimp.</p>",
      );
      settle(resolve, code);
    });

    server.on("error", (err) => {
      settle(reject, err);
    });

    server.listen(port, host, () => {
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          settle(
            reject,
            Object.assign(
              new Error(`OAuth login timed out after ${Math.round(timeoutMs / 1000)}s waiting for browser callback`),
              { code: "oauth_timeout" },
            ),
          );
        }, timeoutMs);
        // don't keep process alive solely for the timer
        if (typeof timer.unref === "function") timer.unref();
      }
    });
  });
}

// Start callback server on the first free port near preferredPort.
// Returns { port, codePromise } so callers can build redirect_uri before opening the browser.
export async function startCallbackServerOnFreePort({
  preferredPort,
  state,
  pathPrefix = "/callback",
  host = "127.0.0.1",
  attempts = 1,
  timeoutMs = 5 * 60 * 1000,
} = {}) {
  // Always use the exact preferredPort (18789) - Google OAuth console only allows
  // http://localhost:18789/callback as redirect_uri. Do NOT fall back to other ports.
  const port = Number(preferredPort) || 18789;
  let serverRef = null;

  const codePromise = new Promise((resolve, reject) => {
    const result = startCallbackServerWithHandle({ port, state, pathPrefix, host, timeoutMs });
    serverRef = result.server;
    result.codePromise.then(resolve, reject);
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  return { port, codePromise, server: serverRef };
}

function startCallbackServerWithHandle({
  port,
  state,
  pathPrefix = "/callback",
  host = "127.0.0.1",
  timeoutMs = 5 * 60 * 1000,
} = {}) {
  let server = null;
  const codePromise = new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { server?.close(); } catch {}
      fn(value);
    };

    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${host}:${port}`);
      if (url.pathname !== pathPrefix) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const returnedState = url.searchParams.get("state");
      if (error) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
        settle(reject, Object.assign(new Error(`OAuth authorization failed: ${error}`), {
          code: "oauth_denied",
        }));
        return;
      }
      if (returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>State mismatch</h1>");
        settle(reject, Object.assign(new Error("OAuth state mismatch (possible CSRF)"), {
          code: "oauth_state_mismatch",
        }));
        return;
      }
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("missing code");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<h1>Authorization successful</h1>" +
          "<p>You can close this tab and return to Shrimp.</p>",
      );
      settle(resolve, code);
    });

    server.on("error", (err) => {
      settle(reject, err);
    });

    server.listen(port, host, () => {
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          settle(
            reject,
            Object.assign(
              new Error(`OAuth login timed out after ${Math.round(timeoutMs / 1000)}s waiting for browser callback`),
              { code: "oauth_timeout" },
            ),
          );
        }, timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
      }
    });
  });

  return { server, codePromise };
}
