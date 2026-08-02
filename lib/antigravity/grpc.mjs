// gRPC transport for Antigravity v1internal PredictionService.
// Uses Node.js built-in http2 + tls with HTTP CONNECT proxy tunnel.
// No external runtime dependencies (respects the "no new deps" constraint).

import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import http2 from "node:http2";

import { encodeGenerateContentRequest, decodeGenerateContentResponse } from "./proto-codec.mjs";
import { UPSTREAM_USER_AGENT, ANTIGRAVITY_VERSION } from "./upstream.mjs";

// Configurable via env vars for testing (points at a mock gRPC server).
const GRPC_HOST = process.env.ANTIGRAVITY_GRPC_HOST || "daily-cloudcode-pa.googleapis.com";
const GRPC_PORT = parseInt(process.env.ANTIGRAVITY_GRPC_PORT || "443", 10);
const GENERATE_PATH = "/google.internal.cloud.code.v1internal.PredictionService/GenerateContent";
const STREAM_PATH = "/google.internal.cloud.code.v1internal.PredictionService/StreamGenerateContent";

// Resolve proxy: explicit proxyUrl (from endpoint config) takes precedence,
// then env vars (https_proxy / http_proxy).
function getProxyConfig(proxyUrl) {
  const url = proxyUrl ||
    process.env.https_proxy || process.env.HTTPS_PROXY ||
    process.env.http_proxy || process.env.HTTP_PROXY;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname, port: parseInt(parsed.port, 10) || 8080 };
  } catch {
    return null;
  }
}

// Establish a TLS connection to the target host, optionally tunneled through
// an HTTP proxy via CONNECT. Returns a tls.TLSSocket with ALPN h2 negotiated.
function createTlsSocket(host = GRPC_HOST, port = GRPC_PORT, proxyUrl = null) {
  const proxy = getProxyConfig(proxyUrl);
  return new Promise((resolve, reject) => {
    if (!proxy) {
      // Direct connection (no proxy in env).
      const socket = tls.connect({ host, port, servername: host, ALPNProtocols: ["h2"] }, () => resolve(socket));
      socket.on("error", reject);
      return;
    }
    // CONNECT tunnel through HTTP proxy.
    const req = http.request({
      host: proxy.host, port: proxy.port,
      method: "CONNECT", path: `${host}:${port}`,
      headers: { Host: `${host}:${port}` },
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        reject(new Error(`proxy CONNECT failed: ${res.statusCode}`));
        return;
      }
      const tlsSocket = tls.connect({ socket, servername: host, ALPNProtocols: ["h2"] }, () => resolve(tlsSocket));
      tlsSocket.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(15000, () => reject(new Error("proxy CONNECT timeout")));
    req.end();
  });
}

// Read gRPC length-prefixed frames from an HTTP/2 response stream.
// Each frame: 1 byte (compression flag) + 4 bytes (big-endian length) + payload.
async function* readGrpcFrames(stream) {
  let buffer = Buffer.alloc(0);
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 5) {
      const len = buffer.readUInt32BE(1);
      if (buffer.length < 5 + len) break; // need more data
      const payload = buffer.subarray(5, 5 + len);
      buffer = buffer.subarray(5 + len);
      yield payload;
    }
  }
}

// Build common gRPC metadata headers.
function buildHeaders(accessToken) {
  return {
    "content-type": "application/grpc",
    "te": "trailers",
    "authorization": `Bearer ${accessToken}`,
    "user-agent": UPSTREAM_USER_AGENT,
    "x-client-name": "antigravity",
    "x-client-version": ANTIGRAVITY_VERSION,
  };
}

// Send a gRPC GenerateContent (server-streaming) request and yield decoded
// response objects. Each yielded object has the shape:
//   { response: { candidates, usageMetadata, ... }, traceId }
// matching what response-streamer.mjs expects.
// Create an HTTP/2 client. Insecure mode (plain h2c) for testing;
// TLS with optional proxy tunnel for production.
function createH2Client(proxyUrl = null) {
  if (process.env.ANTIGRAVITY_GRPC_INSECURE === "1") {
    return Promise.resolve(http2.connect(`http://${GRPC_HOST}:${GRPC_PORT}`));
  }
  return createTlsSocket(GRPC_HOST, GRPC_PORT, proxyUrl).then((socket) =>
    http2.connect(`https://${GRPC_HOST}`, { createConnection: () => socket }),
  );
}

export async function* grpcGenerateContent({ accessToken, body, proxyUrl = null }) {
  const requestBuf = encodeGenerateContentRequest(body);
  const frame = Buffer.alloc(5);
  frame.writeUInt32BE(requestBuf.length, 1);

  const client = await createH2Client(proxyUrl);

  try {
    const req = client.request({
      ":method": "POST",
      ":path": GENERATE_PATH,
      ...buildHeaders(accessToken),
    });
    req.end(Buffer.concat([frame, requestBuf]));

    // Collect response headers and trailers for grpc-status / grpc-message.
    // gRPC servers may send grpc-status in either initial headers (error,
    // no data) or trailing headers (success, after data).
    let respHeaders = {};
    let trailers = {};
    req.on("response", (h) => { respHeaders = h; });
    const trailerPromise = new Promise((resolve) => {
      req.on("trailers", (t) => { trailers = t; resolve(); });
      req.on("close", () => resolve());
    });

    for await (const payload of readGrpcFrames(req)) {
      yield decodeGenerateContentResponse(payload);
    }

    await trailerPromise;
    const status = trailers["grpc-status"] || respHeaders["grpc-status"];
    if (status && status !== "0") {
      const msg = trailers["grpc-message"] || respHeaders["grpc-message"] || "";
      const err = new Error(`gRPC error: status=${status} message=${decodeURIComponent(msg)}`);
      err.grpcStatus = String(status);
      throw err;
    }
  } finally {
    client.destroy();
  }
}

// Stream variant using StreamGenerateContent (client+server streaming).
// Currently sends a single request frame (same as GenerateContent).
export async function* grpcStreamGenerateContent({ accessToken, body, proxyUrl = null }) {
  yield* grpcGenerateContent({ accessToken, body, proxyUrl });
}
