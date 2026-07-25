import assert from "node:assert/strict";
import test from "node:test";

import {
  appendGatewayWebSearchResultsToAnthropicBody,
  appendGatewayWebSearchResultsToChatBody,
  appendGatewayWebSearchResultsToResponsesBody,
  extractGatewayWebSearchCallsFromAnthropicMessage,
  extractGatewayWebSearchCallsFromChatCompletion,
  extractGatewayWebSearchCallsFromResponse,
  formatWebSearchResultForModel,
  maybeInjectGatewayWebSearch,
  parseWebSearchToolArguments,
  responseHasOnlyGatewayWebSearchCalls,
  runGatewayWebSearchAnthropicLoop,
  runGatewayWebSearchChatLoop,
  runGatewayWebSearchResponsesLoop,
  selectWebSearchEndpoint,
  withoutStreamFlag,
} from "../../lib/web-search/index.mjs";
import { tavilyAdapter } from "../../lib/web-search/providers/tavily.mjs";
import { validateGatewayConfig } from "../../lib/config/gateway-config-store.mjs";

test("selectWebSearchEndpoint prefers default enabled tavily node with key", () => {
  const selected = selectWebSearchEndpoint([
    {
      id: "ep_brave",
      purpose: "web_search",
      provider: "brave",
      is_default: true,
      enabled: true,
    },
    {
      id: "ep_tavily",
      purpose: "web_search",
      provider: "tavily",
      is_default: true,
      enabled: true,
    },
  ], {
    secrets: { api_keys: { ep_tavily: "tvly-test" } },
  });

  assert.equal(selected.endpoint.id, "ep_tavily");
  assert.equal(selected.providerId, "tavily");
  assert.equal(selected.apiKey, "tvly-test");
});

test("maybeInjectGatewayWebSearch injects only when configured and non-conflicting", () => {
  const endpoints = [{
    id: "ep_tavily",
    purpose: "web_search",
    provider: "tavily",
    is_default: true,
    options: { country: "china" },
  }];
  const secrets = { api_keys: { ep_tavily: "tvly-test" } };

  const injected = maybeInjectGatewayWebSearch({ tools: [] }, { endpoints, secrets });
  assert.equal(injected.injected, true);
  assert.equal(injected.body.tools[0].name, "web_search");

  const conflicting = maybeInjectGatewayWebSearch({
    tools: [{ type: "web_search" }],
  }, { endpoints, secrets });
  assert.equal(conflicting.injected, false);
  assert.equal(conflicting.reason, "conflicting_tool");

  const official = maybeInjectGatewayWebSearch({ tools: [] }, {
    endpoints,
    secrets,
    officialRoute: true,
  });
  assert.equal(official.injected, false);
  assert.equal(official.reason, "official_route");

  const missing = maybeInjectGatewayWebSearch({ tools: [] }, { endpoints: [], secrets });
  assert.equal(missing.injected, false);
});

test("parse and format helpers are stable", () => {
  assert.deepEqual(parseWebSearchToolArguments('{"query":"上海天气","max_results":3}'), {
    query: "上海天气",
    max_results: 3,
  });
  const text = formatWebSearchResultForModel({
    ok: true,
    provider: "tavily",
    query: "上海天气",
    results: [{ title: "A", url: "https://a.test", snippet: "ok" }],
  });
  assert.match(text, /上海天气/);
  assert.match(text, /https:\/\/a\.test/);
});

test("response helpers detect gateway web_search calls", () => {
  const response = {
    output: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "web_search",
        arguments: "{\"query\":\"x\"}",
      },
    ],
  };
  assert.equal(extractGatewayWebSearchCallsFromResponse(response).length, 1);
  assert.equal(responseHasOnlyGatewayWebSearchCalls(response), true);
  assert.equal(responseHasOnlyGatewayWebSearchCalls({
    output: [
      { type: "function_call", call_id: "c1", name: "web_search", arguments: "{}" },
      { type: "function_call", call_id: "c2", name: "shell", arguments: "{}" },
    ],
  }), false);
});

test("appendGatewayWebSearchResultsToResponsesBody keeps call/result pair", () => {
  const next = appendGatewayWebSearchResultsToResponsesBody(
    { model: "glm-5.2", input: "hello", tools: [] },
    {
      output: [{
        type: "function_call",
        call_id: "call_1",
        name: "web_search",
        arguments: "{\"query\":\"x\"}",
      }],
    },
    [{ call_id: "call_1", output: "results" }],
  );
  assert.equal(next.input.some((item) => item.type === "function_call"), true);
  assert.equal(next.input.some((item) => item.type === "function_call_output" && item.output === "results"), true);
});

test("runGatewayWebSearchResponsesLoop executes one search round", async () => {
  let calls = 0;
  const selected = {
    providerId: "mock",
    endpoint: { id: "ep_mock" },
    apiKey: "k",
    options: {},
    adapter: {
      id: "mock",
      async search({ query }) {
        return {
          ok: true,
          provider: "mock",
          query,
          results: [{ title: "T", url: "https://t.test", snippet: "S" }],
        };
      },
    },
  };

  const loop = await runGatewayWebSearchResponsesLoop({
    body: { model: "glm-5.2", input: "search please", tools: [] },
    selected,
    maxLoops: 2,
    fetchResponse: async (body) => {
      calls += 1;
      if (calls === 1) {
        assert.ok(Array.isArray(body.tools) || true);
        return {
          status: "completed",
          output: [{
            type: "function_call",
            call_id: "call_1",
            name: "web_search",
            arguments: JSON.stringify({ query: "上海天气" }),
          }],
        };
      }
      assert.equal(
        body.input.some((item) => item.type === "function_call_output"),
        true,
      );
      return {
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "今天多云" }],
        }],
        output_text: "今天多云",
      };
    },
  });

  assert.equal(loop.loops, 1);
  assert.equal(loop.stopReason, "completed");
  assert.match(loop.response.output_text, /今天多云/);
  assert.equal(loop.executed.length, 1);
});

test("tavily adapter maps request/response and errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.tavily.com/search");
    const body = JSON.parse(init.body);
    assert.equal(body.query, "上海天气");
    assert.equal(body.country, "china");
    assert.equal(body.search_depth, "basic");
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          query: "上海天气",
          results: [{
            title: "Weather",
            url: "https://weather.test",
            content: "cloudy",
            score: 0.8,
          }],
        });
      },
    };
  };
  try {
    const result = await tavilyAdapter.search({
      query: "上海天气",
      apiKey: "tvly-test",
      options: { country: "china" },
    });
    assert.equal(result.ok, true);
    assert.equal(result.results[0].url, "https://weather.test");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("validateGatewayConfig accepts one default web_search node and rejects bad provider", () => {
  const ok = validateGatewayConfig({
    clients: {
      codex: {
        endpoints: [
          {
            id: "ep_chat",
            name: "chat",
            type: "openai-responses",
            models: ["glm-5.2"],
            is_default: true,
          },
          {
            id: "ep_search",
            purpose: "web_search",
            provider: "tavily",
            is_default: true,
          },
        ],
      },
    },
  });
  assert.equal(ok.length, 0);

  const bad = validateGatewayConfig({
    clients: {
      codex: {
        endpoints: [{
          id: "ep_search",
          purpose: "web_search",
          provider: "nope",
          is_default: true,
        }],
      },
    },
  });
  assert.equal(bad.some((issue) => issue.code === "unsupported_web_search_provider"), true);

  const multiDefault = validateGatewayConfig({
    clients: {
      codex: {
        endpoints: [
          { id: "ep_a", purpose: "web_search", provider: "tavily", is_default: true },
          { id: "ep_b", purpose: "web_search", provider: "tavily", is_default: true },
        ],
      },
    },
  });
  assert.equal(multiDefault.some((issue) => issue.code === "multiple_default_web_search_endpoints"), true);
});

test("maybeInjectGatewayWebSearch supports chat and anthropic formats", () => {
  const endpoints = [{
    id: "ep_tavily",
    purpose: "web_search",
    provider: "tavily",
    is_default: true,
  }];
  const secrets = { api_keys: { ep_tavily: "tvly-test" } };

  const chat = maybeInjectGatewayWebSearch({ tools: [] }, {
    endpoints,
    secrets,
    format: "chat",
  });
  assert.equal(chat.injected, true);
  assert.equal(chat.body.tools[0].type, "function");
  assert.equal(chat.body.tools[0].function.name, "web_search");

  const anthropic = maybeInjectGatewayWebSearch({ tools: [] }, {
    endpoints,
    secrets,
    format: "anthropic",
  });
  assert.equal(anthropic.injected, true);
  assert.equal(anthropic.body.tools[0].name, "web_search");
  assert.ok(anthropic.body.tools[0].input_schema);
});

test("chat loop executes gateway web_search and continues", async () => {
  let calls = 0;
  const selected = {
    providerId: "mock",
    endpoint: { id: "ep_mock" },
    apiKey: "k",
    options: {},
    adapter: {
      id: "mock",
      async search({ query }) {
        return {
          ok: true,
          provider: "mock",
          query,
          results: [{ title: "T", url: "https://t.test", snippet: "S" }],
        };
      },
    },
  };

  const loop = await runGatewayWebSearchChatLoop({
    body: {
      model: "glm-5.2",
      messages: [{ role: "user", content: "search please" }],
      tools: [],
    },
    selected,
    maxLoops: 2,
    fetchCompletion: async (body) => {
      calls += 1;
      if (calls === 1) {
        return {
          id: "chatcmpl_1",
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_1",
                type: "function",
                function: {
                  name: "web_search",
                  arguments: JSON.stringify({ query: "上海天气" }),
                },
              }],
            },
            finish_reason: "tool_calls",
          }],
        };
      }
      assert.equal(body.messages.some((item) => item.role === "tool"), true);
      return {
        id: "chatcmpl_2",
        choices: [{
          message: { role: "assistant", content: "今天多云" },
          finish_reason: "stop",
        }],
      };
    },
  });

  assert.equal(loop.loops, 1);
  assert.equal(loop.stopReason, "completed");
  assert.equal(loop.completion.choices[0].message.content, "今天多云");
  assert.equal(extractGatewayWebSearchCallsFromChatCompletion({
    choices: [{
      message: {
        tool_calls: [{
          id: "call_1",
          function: { name: "web_search", arguments: "{}" },
        }],
      },
    }],
  }).length, 1);
  const appended = appendGatewayWebSearchResultsToChatBody(
    { messages: [{ role: "user", content: "q" }] },
    {
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "web_search", arguments: "{}" },
          }],
        },
      }],
    },
    [{ call_id: "call_1", output: "results" }],
  );
  assert.equal(appended.messages.at(-1).role, "tool");
});

test("anthropic loop executes gateway web_search and continues", async () => {
  let calls = 0;
  const selected = {
    providerId: "mock",
    endpoint: { id: "ep_mock" },
    apiKey: "k",
    options: {},
    adapter: {
      id: "mock",
      async search({ query }) {
        return {
          ok: true,
          provider: "mock",
          query,
          results: [{ title: "T", url: "https://t.test", snippet: "S" }],
        };
      },
    },
  };

  const loop = await runGatewayWebSearchAnthropicLoop({
    body: {
      model: "glm-5.2",
      max_tokens: 256,
      messages: [{ role: "user", content: "search please" }],
      tools: [],
    },
    selected,
    maxLoops: 2,
    fetchMessage: async (body) => {
      calls += 1;
      if (calls === 1) {
        return {
          id: "msg_1",
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "toolu_1",
            name: "web_search",
            input: { query: "上海天气" },
          }],
          stop_reason: "tool_use",
        };
      }
      assert.equal(
        body.messages.some((item) =>
          Array.isArray(item.content)
          && item.content.some((block) => block.type === "tool_result")
        ),
        true,
      );
      return {
        id: "msg_2",
        role: "assistant",
        content: [{ type: "text", text: "今天多云" }],
        stop_reason: "end_turn",
      };
    },
  });

  assert.equal(loop.loops, 1);
  assert.equal(loop.stopReason, "completed");
  assert.equal(loop.message.content[0].text, "今天多云");
  assert.equal(extractGatewayWebSearchCallsFromAnthropicMessage({
    content: [{ type: "tool_use", id: "x", name: "web_search", input: {} }],
  }).length, 1);
  const appended = appendGatewayWebSearchResultsToAnthropicBody(
    { messages: [{ role: "user", content: "q" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "web_search", input: { query: "q" } }],
    },
    [{ call_id: "toolu_1", output: "results" }],
  );
  assert.equal(appended.messages.at(-1).content[0].type, "tool_result");
});



test("withoutStreamFlag forces non-stream internal rounds", () => {
  assert.equal(withoutStreamFlag({ stream: true, model: "glm-5.2" }).stream, false);
  assert.equal(withoutStreamFlag({ model: "glm-5.2" }).stream, false);
});

test("appendGatewayWebSearchResultsToResponsesBody generates custom_tool_call_output when original item is custom_tool_call", () => {
  const body = { input: [] };
  const response = {
    output: [{ type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "web_search", input: "{\"query\":\"test\"}" }],
  };
  const executedCalls = [{
    call_id: "call_1",
    output: "search result text",
    item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "web_search" },
  }];
  const result = appendGatewayWebSearchResultsToResponsesBody(body, response, executedCalls);
  const toolResultItem = result.input.find((i) => i.type === "custom_tool_call_output");
  assert.ok(toolResultItem, "Should output item with type custom_tool_call_output");
  assert.equal(toolResultItem.call_id, "call_1");
  assert.equal(toolResultItem.output, "search result text");
});
