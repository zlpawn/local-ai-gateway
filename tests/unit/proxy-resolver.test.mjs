import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProxyUrl,
  defaultProxyConfig,
  resolveOutboundProxyAgent,
} from "../../lib/config/proxy-resolver.mjs";

test("default proxy configuration matches Clash Verge HTTP defaults", () => {
  assert.deepEqual(defaultProxyConfig(), {
    enabled: true,
    protocol: "http",
    host: "127.0.0.1",
    port: 7897,
    username: "",
    password: "",
  });
});

test("buildProxyUrl builds valid proxy URLs for http, https, and socks5", () => {
  assert.equal(
    buildProxyUrl({ enabled: true, protocol: "http", host: "127.0.0.1", port: 7897 }),
    "http://127.0.0.1:7897"
  );

  assert.equal(
    buildProxyUrl({ enabled: true, protocol: "socks5", host: "127.0.0.1", port: 1080 }),
    "socks5://127.0.0.1:1080"
  );

  assert.equal(
    buildProxyUrl({ enabled: true, protocol: "http", host: "127.0.0.1", port: 7897, username: "user", password: "pwd" }),
    "http://user:pwd@127.0.0.1:7897"
  );

  assert.equal(
    buildProxyUrl({ enabled: false, protocol: "http", host: "127.0.0.1", port: 7897 }),
    ""
  );
});

test("resolveOutboundProxyAgent respects endpoint proxy overrides", () => {
  const globalConfig = {
    enabled: true,
    protocol: "http",
    host: "127.0.0.1",
    port: 7897
  };

  // 1. Endpoint disabled override -> direct (no agent)
  const disabledEp = { proxy_mode: "disabled" };
  assert.equal(resolveOutboundProxyAgent(disabledEp, globalConfig), null);

  // 2. Endpoint custom override -> custom agent/url
  const customEp = { proxy_mode: "custom", proxy_url: "http://127.0.0.1:8888" };
  const customAgent = resolveOutboundProxyAgent(customEp, globalConfig);
  assert.ok(customAgent);

  // 3. Default global -> returns agent for global 7897
  const defaultEp = {};
  const globalAgent = resolveOutboundProxyAgent(defaultEp, globalConfig);
  assert.ok(globalAgent);
});

test("resolveOutboundProxyAgent uses a SOCKS agent for socks5 URLs", () => {
  const agent = resolveOutboundProxyAgent(
    { proxy_mode: "custom", proxy_url: "socks5://127.0.0.1:1080" },
    {},
  );

  assert.equal(agent?.constructor?.name, "SocksProxyAgent");
});
