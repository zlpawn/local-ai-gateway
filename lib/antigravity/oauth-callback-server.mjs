// Local HTTP server to receive the OAuth redirect callback.
// Listens on 127.0.0.1 only; resolves the authorization code once received.
import http from "node:http";

export function startCallbackServer({ port, state, pathPrefix = "/callback" }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
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
        server.close();
        reject(new Error(`OAuth authorization failed: ${error}`));
        return;
      }
      if (returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>State mismatch</h1>");
        server.close();
        reject(new Error("OAuth state mismatch (possible CSRF)"));
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
        "<p>You can close this tab and return to the terminal.</p>",
      );
      server.close();
      resolve(code);
    });
    server.on("error", (err) => {
      server.close();
      reject(err);
    });
    server.listen(port, "127.0.0.1");
  });
}