import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const GATEWAY_PORT = 8788;

test("basic protocol route matrix works through the isolated 8788 gateway", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "gateway-basic-routes-"));
  const requests = new Map();
  const requestHistory = [];
  const upstream = http.createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request) || "{}");
    requests.set(request.url, body);
    requestHistory.push({ url: request.url, body });
    response.setHeader("content-type", "application/json");

    if (request.url === "/vision/chat/completions") {
      response.end(JSON.stringify({
        id: "chatcmpl_vision",
        object: "chat.completion",
        model: body.model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: "图片中显示错误代码 E42。" },
          finish_reason: "stop",
        }],
      }));
      return;
    }
    if (request.url === "/text/chat/completions") {
      if (/image_url|base64,AA==/.test(JSON.stringify(body))) {
        response.statusCode = 400;
        response.end(JSON.stringify({
          error: { message: "image input is not supported by this model" },
        }));
        return;
      }
      response.end(JSON.stringify({
        id: "chatcmpl_text",
        object: "chat.completion",
        model: body.model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: "已根据图片解析结果处理。" },
          finish_reason: "stop",
        }],
      }));
      return;
    }
    if (request.url === "/anthropic/messages") {
      response.end(JSON.stringify({
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 3, output_tokens: 1 },
      }));
      return;
    }
    if (request.url === "/responses") {
      response.end(JSON.stringify({
        id: "resp_mock",
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        model: body.model,
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
      return;
    }
    if (request.url === "/chat/completions") {
      response.end(JSON.stringify({
        id: "chatcmpl_mock",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: "OK" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  const upstreamPort = await listen(upstream);

  const configPath = path.join(tempDir, "gateway.config.json");
  await writeFile(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: GATEWAY_PORT },
    clients: {
      code: {
        endpoints: [
          {
            id: "ep_code_chat",
            name: "mock-chat",
            type: "openai-chat",
            base_url: `http://127.0.0.1:${upstreamPort}/chat/completions`,
            models: ["mock-upstream"],
            model_mapping: { "claude-mock-sonnet": "mock-upstream" },
          },
          {
            id: "ep_code_text",
            name: "text-only",
            type: "openai-chat",
            base_url: `http://127.0.0.1:${upstreamPort}/text/chat/completions`,
            models: ["text-only"],
            model_mapping: { "claude-text-only": "text-only" },
          },
          {
            id: "ep_code_vision",
            name: "vision-fallback",
            purpose: "vision_fallback",
            vision_fallback_enabled: true,
            vision_model: "vision-pro",
            type: "openai-chat",
            base_url: `http://127.0.0.1:${upstreamPort}/vision/chat/completions`,
            models: ["vision-pro"],
            model_mapping: {},
          },
        ],
      },
      codex: {
        endpoints: [{
          id: "ep_codex_chat",
          name: "mock-chat",
          type: "openai-chat",
          base_url: `http://127.0.0.1:${upstreamPort}/chat/completions`,
          models: ["mock-upstream"],
          model_mapping: { "mock-codex-model": "mock-upstream" },
        }],
      },
      desktop: {
        endpoints: [{
          id: "ep_desktop_anthropic",
          name: "mock-anthropic",
          type: "anthropic",
          base_url: `http://127.0.0.1:${upstreamPort}/anthropic/messages`,
          models: ["mock-anthropic-upstream"],
          model_mapping: { "claude-mock-haiku": "mock-anthropic-upstream" },
        }],
      },
      unknown: {
        endpoints: [
          {
            id: "ep_unknown_chat",
            name: "mock-chat",
            type: "openai-chat",
            base_url: `http://127.0.0.1:${upstreamPort}/chat/completions`,
            models: ["mock-upstream"],
            model_mapping: { "mock-chat-model": "mock-upstream" },
          },
          {
            id: "ep_unknown_responses",
            name: "mock-responses",
            type: "openai-responses",
            base_url: `http://127.0.0.1:${upstreamPort}/responses`,
            models: ["mock-responses-upstream"],
            model_mapping: { "mock-responses-model": "mock-responses-upstream" },
          },
        ],
      },
    },
  }));
  await writeFile(path.join(tempDir, "gateway.secrets.json"), JSON.stringify({
    api_keys: {
      ep_code_chat: "test-key",
      ep_code_text: "test-key",
      ep_code_vision: "test-key",
      ep_codex_chat: "test-key",
      ep_desktop_anthropic: "test-key",
      ep_unknown_chat: "test-key",
      ep_unknown_responses: "test-key",
    },
  }));

  const gateway = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      GATEWAY_PORT: String(GATEWAY_PORT),
      GATEWAY_CONFIG_FILE: configPath,
      GATEWAY_SECRETS_FILE: path.join(tempDir, "gateway.secrets.json"),
      GATEWAY_NO_OPEN: "1",
      CLAUDE_3P_SYNC_DISABLED: "1",
      CLAUDE_CODE_SYNC_DISABLED: "1",
      CODEX_WRITE_MODEL_CATALOG_DISABLED: "1",
      LOG_FILE: path.join(tempDir, "gateway.log"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  t.after(async () => {
    gateway.kill();
    await once(gateway, "exit").catch(() => {});
    await closeServer(upstream);
    await rm(tempDir, { recursive: true, force: true });
  });
  await waitForHealth(gateway);

  const claude = await jsonRequest("/code/v1/messages", {
    model: "claude-mock-sonnet",
    max_tokens: 16,
    system: "System note",
    messages: [{ role: "user", content: "Reply OK only." }],
  }, { "anthropic-version": "2023-06-01" });
  assert.equal(claude.content[0].text, "OK");
  assert.equal(claude.model, "claude-mock-sonnet");
  assert.equal(requests.get("/chat/completions").model, "mock-upstream");
  assert.deepEqual(
    requests.get("/chat/completions").messages.map((message) => message.role),
    ["system", "user"],
  );

  const fallbackResult = await jsonRequest("/code/v1/messages", {
    model: "claude-text-only",
    max_tokens: 16,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "帮我分析" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "AA==" },
        },
      ],
    }],
  }, { "anthropic-version": "2023-06-01" });
  assert.equal(fallbackResult.content[0].text, "已根据图片解析结果处理。");
  const visionRequest = requestHistory.find((item) => item.url === "/vision/chat/completions");
  const textRequests = requestHistory.filter((item) => item.url === "/text/chat/completions");
  const textRequest = textRequests.at(-1);
  assert.equal(textRequests.length, 2);
  assert.match(JSON.stringify(visionRequest.body), /data:image\/png;base64,AA==/);
  assert.doesNotMatch(JSON.stringify(textRequest.body), /image_url|base64,AA==/);
  assert.match(JSON.stringify(textRequest.body), /错误代码 E42/);

  const codex = await jsonRequest("/codex/v1/responses", {
    model: "mock-codex-model",
    input: "Reply OK only.",
    max_output_tokens: 16,
  });
  assert.equal(codex.output_text, "OK");
  assert.equal(codex.model, "mock-codex-model");
  assert.equal(requests.get("/chat/completions").messages[0].role, "user");

  const desktop = await jsonRequest("/desktop/v1/messages", {
    model: "claude-mock-haiku",
    max_tokens: 16,
    messages: [{ role: "user", content: "Reply OK only." }],
  }, { "anthropic-version": "2023-06-01" });
  assert.equal(desktop.content[0].text, "OK");
  assert.equal(requests.get("/anthropic/messages").model, "mock-anthropic-upstream");

  const chat = await jsonRequest("/v1/chat/completions", {
    model: "mock-chat-model",
    messages: [{ role: "user", content: "Reply OK only." }],
    max_tokens: 16,
  });
  assert.equal(chat.choices[0].message.content, "OK");
  assert.equal(chat.model, "mock-upstream");

  const translated = await jsonRequest("/v1/chat/completions", {
    model: "mock-responses-model",
    messages: [
      { role: "system", content: "System note" },
      { role: "user", content: "Reply OK only." },
    ],
    max_tokens: 16,
  });
  assert.equal(translated.choices[0].message.content, "OK");
  assert.equal(translated.model, "mock-responses-model");
  assert.equal(requests.get("/responses").model, "mock-responses-upstream");
  assert.equal(requests.get("/responses").instructions, "System note");
  assert.equal(requests.get("/responses").input[0].role, "user");

  const resolved = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/resolve?model=mock-responses-model`, {
    headers: { authorization: "Bearer client-key" },
  }).then((response) => response.json());
  assert.equal(resolved.configured.upstream_model, "mock-responses-upstream");
  assert.equal(resolved.routes.openai_chat.mode, "translated");
  assert.equal(resolved.routes.openai_responses.mode, "direct");
});

async function jsonRequest(pathname, body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${GATEWAY_PORT}${pathname}`, {
    method: "POST",
    headers: {
      authorization: "Bearer client-key",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  return JSON.parse(raw);
}

async function readBody(request) {
  let raw = "";
  request.setEncoding("utf8");
  for await (const chunk of request) raw += chunk;
  return raw;
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function waitForHealth(child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`gateway exited before health check (${child.exitCode})`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/health`);
      if (response.ok) return;
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("gateway health check timed out");
}
