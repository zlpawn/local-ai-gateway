import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`Gateway exited before becoming healthy (code ${child.exitCode})`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // The gateway has not started listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for gateway health");
}

test("Chat Completions images survive conversion to Responses input", async (t) => {
  let capturedBody;
  const mock = http.createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      capturedBody = JSON.parse(raw);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "resp_mock",
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        model: capturedBody.model,
        status: "completed",
        output_text: "OK",
        output: [{
          id: "msg_mock",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "OK", annotations: [] }],
        }],
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      }));
    });
  });
  const mockPort = await listen(mock);
  t.after(() => mock.close());

  const reservation = http.createServer();
  const gatewayPort = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));

  const tempDir = await mkdtemp(path.join(tmpdir(), "local-ai-gateway-adapter-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const configFile = path.join(tempDir, "gateway.config.json");
  await writeFile(configFile, JSON.stringify({
    server: { host: "127.0.0.1", port: gatewayPort },
    clients: {
      unknown: {
        endpoints: [{
          name: "mock-responses",
          type: "openai-responses",
          base_url: `http://127.0.0.1:${mockPort}/responses`,
          api_key: "env:MOCK_API_KEY",
          models: ["mock-responses-upstream"],
          model_mapping: { "mock-responses-model": "mock-responses-upstream" },
        }],
      },
    },
  }));

  const gateway = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GATEWAY_CONFIG_FILE: configFile,
      GATEWAY_PORT: String(gatewayPort),
      MOCK_API_KEY: "test-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (gateway.exitCode == null) gateway.kill();
  });
  await waitForHealth(gatewayPort, gateway);

  const imageUrl = "data:image/png;base64,iVBORw0KGgo=";
  const result = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer client-key",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "mock-responses-model",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this image." },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      }],
      max_tokens: 16,
    }),
  });

  assert.equal(result.status, 200);
  assert.deepEqual(capturedBody.input[0], {
    role: "user",
    content: [
      { type: "input_text", text: "Describe this image." },
      { type: "input_image", image_url: imageUrl },
    ],
  });
});
