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
      tools: [{
        type: "function",
        function: {
          name: "shell",
          description: "Run a shell command",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
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
  assert.deepEqual(capturedBody.tools, [{
    type: "function",
    name: "shell",
    description: "Run a shell command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  }]);
});

test("Claude Desktop receives Grok Responses function calls as tool_use blocks", async (t) => {
  const capturedBodies = [];
  const mock = http.createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      capturedBodies.push(JSON.parse(raw));
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (capturedBodies.length > 1) {
        const events = [
          ["response.output_text.delta", {
            type: "response.output_text.delta",
            output_index: 0,
            content_index: 0,
            delta: "Done",
          }],
          ["response.completed", {
            type: "response.completed",
            response: {
              id: "resp_done",
              status: "completed",
              usage: { input_tokens: 15, output_tokens: 1, total_tokens: 16 },
            },
          }],
        ];
        for (const [event, data] of events) {
          response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
        response.end();
        return;
      }
      const events = [
        ["response.created", {
          type: "response.created",
          response: { id: "resp_tool", status: "in_progress" },
        }],
        ["response.output_item.added", {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "fc_shell",
            type: "function_call",
            call_id: "call_shell",
            name: "shell",
            arguments: "",
          },
        }],
        ["response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "fc_shell",
          delta: "{\"command\":\"ls\"}",
        }],
        ["response.output_item.done", {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: "fc_shell",
            type: "function_call",
            call_id: "call_shell",
            name: "shell",
            arguments: "{\"command\":\"ls\"}",
          },
        }],
        ["response.completed", {
          type: "response.completed",
          response: {
            id: "resp_tool",
            status: "completed",
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        }],
      ];
      for (const [event, data] of events) {
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
      response.end();
    });
  });
  const mockPort = await listen(mock);
  t.after(() => mock.close());

  const reservation = http.createServer();
  const gatewayPort = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));

  const tempDir = await mkdtemp(path.join(tmpdir(), "local-ai-gateway-grok-tool-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const authFile = path.join(tempDir, "auth.json");
  await writeFile(authFile, JSON.stringify({
    "https://auth.x.ai": {
      key: "test-session-key",
      user_id: "test-user",
      expires_at: "2099-01-01T00:00:00.000Z",
    },
  }));
  const configFile = path.join(tempDir, "gateway.config.json");
  await writeFile(configFile, JSON.stringify({
    server: { host: "127.0.0.1", port: gatewayPort },
    clients: {
      desktop: {
        endpoints: [{
          name: "mock-grok",
          type: "grok",
          base_url: `http://127.0.0.1:${mockPort}`,
          auth_path: authFile,
          proxy: "",
          models: ["grok-4.5"],
          model_mapping: { "claude-opus-4-7": "grok-4.5" },
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
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (gateway.exitCode == null) gateway.kill();
  });
  await waitForHealth(gatewayPort, gateway);

  const result = await fetch(`http://127.0.0.1:${gatewayPort}/desktop/v1/messages`, {
    method: "POST",
    headers: {
      authorization: "Bearer client-key",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-4-7",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "Run ls." }],
      tools: [{
        name: "shell",
        description: "Run a shell command",
        input_schema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      }],
    }),
  });

  assert.equal(result.status, 200);
  const stream = await result.text();
  assert.match(stream, /"type":"tool_use"/);
  assert.match(stream, /"name":"shell"/);
  assert.match(stream, /"partial_json":"\{\\"command\\":\\"ls\\"\}"/);
  assert.match(stream, /"stop_reason":"tool_use"/);
  assert.equal(capturedBodies[0].tools[0].name, "shell");

  const followUp = await fetch(`http://127.0.0.1:${gatewayPort}/desktop/v1/messages`, {
    method: "POST",
    headers: {
      authorization: "Bearer client-key",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-4-7",
      max_tokens: 64,
      stream: true,
      messages: [
        { role: "user", content: "Run ls." },
        {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "call_shell",
            name: "shell",
            input: { command: "ls" },
          }],
        },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "call_shell",
            content: "file.txt",
          }],
        },
      ],
      tools: [{
        name: "shell",
        description: "Run a shell command",
        input_schema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      }],
    }),
  });

  assert.equal(followUp.status, 200);
  assert.match(await followUp.text(), /"text":"Done"/);
  assert.deepEqual(capturedBodies[1].input.slice(1), [
    {
      type: "function_call",
      call_id: "call_shell",
      name: "shell",
      arguments: "{\"command\":\"ls\"}",
    },
    {
      type: "function_call_output",
      call_id: "call_shell",
      output: "file.txt",
    },
  ]);
});
