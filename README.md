# Local AI Gateway


## Shrimp agent CLI

### Command style

- Readable verbs: `shrimp endpoint list`, `shrimp client copy`
- Short aliases: `shrimp ep ls`, `shrimp c copy`, `shrimp st`, `shrimp key set`
- Agent default JSON; humans can use `--format pretty`
- Cross-platform: same commands on macOS and Windows
- Install tip: `shrimp skill install -- <command...>` (quote dashed flags in PowerShell)

The agent-native CLI entry is `shrimp` (package `@wuhezhizhong/shrimp`).

```bash
npm install -g .   # from source checkout
shrimp schema
shrimp doctor
shrimp endpoint add --client code --name demo --type openai-chat --base-url https://example.com/v1/chat/completions --api-key sk-demo
shrimp client apply --client code
shrimp start

# interactive install (local PTY, same idea as web panel terminal)
shrimp skill install --interactive --command "npx -y skills add owner/repo --skill foo"
shrimp cli-tool install --interactive --command "npm i -g some-cli"

# --command can be omitted; trailing args are the install command
shrimp skill install -- npx -y skills add owner/repo --skill foo
shrimp cli-tool install -- npm i -g some-cli
# PowerShell tip: quote dashed flags or use --command "..." so -y is not eaten by the shell
`````

Default output is JSON for agents. Use `--format pretty` for humans. GitHub repository rename remains a final cutover step after verification.

Local lightweight routing gateway for AI clients and custom model providers.

## Configuration and secrets

`gateway.config.json` contains only public routing configuration. Every
`clients.<client>.endpoints[]` entry has a stable, read-only ID such as
`ep_550e8400-e29b-41d4-a716-446655440000`.

Credentials are stored separately in ignored `gateway.secrets.json`:

```json
{
  "api_keys": {
    "ep_550e8400-e29b-41d4-a716-446655440000": "env:ARK_API_KEY",
    "ep_7c8b91e1-43cd-4dc7-bd13-7ca32a511cee": "sk-local-secret"
  }
}
```

On first start, legacy `providers`, `models`, `official_models`, missing
endpoint IDs, and endpoint `api_key` fields are migrated automatically. The
original config is backed up as `gateway.config.json.<timestamp>.bak`.

Each client can have one `is_default` fallback endpoint. `expose_models` is
independent: when one or more endpoints opt in, only their models are listed;
when none opt in, every endpoint is listed. Public model IDs (the values in
`models` and keys in `model_mapping`) must be unique within a client. Duplicate
IDs are rejected with endpoint-name-based candidate names.

```text
Claude Desktop / Claude Code
  -> http://127.0.0.1:8787/v1/messages
  -> Anthropic-compatible providers
  -> OpenAI Chat-compatible providers

Codex
  -> http://127.0.0.1:8787/codex/v1/responses
  -> OpenAI-compatible providers

OpenAI-compatible clients
  -> http://127.0.0.1:8787/v1/chat/completions
  -> OpenAI Chat, OpenAI Responses, or Anthropic-compatible providers
```

The gateway started as a Volcengine Ark bridge, but the main configuration is
now provider-based. You can add Volcengine, OpenRouter, DeepSeek, Qwen, OpenAI,
Anthropic, or any compatible provider by editing `gateway.config.json`.
Claude Code can also use mixed routing: mapped models go to Ark, while unmapped
real Claude model IDs are forwarded to the official Anthropic Messages endpoint.

## Files

- `server.js`: local gateway server
- `.env.example`: config template
- `docs/providers.md`: provider recipes for Volcengine, OpenRouter, DeepSeek, and Anthropic
- `scripts/gateway.mjs`: cross-platform background gateway control
- `scripts/init-config.mjs`: cross-platform first-run config initializer
- `tests/`: unit, integration, and isolated E2E tests

## Provider Config

New setups should create the local environment file:

```powershell
npm run init
```

The init command creates `.env` and `gateway.config.json` from public templates
only when the target files do not already exist, so it is safe to run again.
Local `.env` and `gateway.secrets.json` are ignored by Git;
`gateway.config.json` is safe to commit because endpoint credentials are stored
separately. The published npm package intentionally excludes the repository's
configured `gateway.config.json` and installs an empty endpoint template for
each user.

Start the gateway, open `http://127.0.0.1:8787/config`, add endpoints, and save
the page to create `gateway.config.json`.

The web config stores endpoints under each client:

```json
{
  "server": { "host": "127.0.0.1", "port": 8787 },
  "clients": {
    "code": { "endpoints": [] },
    "desktop": { "endpoints": [] },
    "codex": { "endpoints": [] }
  }
}
```

Provider `type` currently supports:

```text
anthropic         -> /v1/messages providers
openai-chat       -> /v1/chat/completions providers
openai-responses  -> /v1/responses providers
```

For configured third-party providers, `base_url` is the exact upstream request
URL. The gateway does not append `/messages`, `/chat/completions`, or
`/responses` to it.

`openai-chat` providers can also serve Codex `/v1/responses` requests through
the gateway's Responses-to-Chat adapter. This is useful for providers such as
OpenRouter, DeepSeek, Qwen, Moonshot, and other OpenAI Chat-compatible APIs.

The same `openai-chat` providers can serve Claude Desktop / Claude Code
`/v1/messages` requests through the gateway's Anthropic-to-Chat adapter. That
means a Claude-style client model id such as `claude-sonnet-openrouter` can be
mapped to an upstream OpenAI-compatible model such as `deepseek/deepseek-chat`.

## Start

```powershell
npm run init
```

Edit `.env`:

```env
# Optional. If empty, the gateway uses the client's Gateway API key as Ark key.
ARK_API_KEY=your-volcengine-ark-api-key
GATEWAY_HOST=127.0.0.1
GATEWAY_PORT=8787
GATEWAY_CONFIG_FILE=gateway.config.json
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/plan
ARK_CODEX_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3
OFFICIAL_ANTHROPIC_BASE_URL=https://api.anthropic.com
```

Then run:

```powershell
npm start
```

Open `http://127.0.0.1:8787/config` and save the web config page to create
`gateway.config.json`.

For background control on Windows, macOS, or Linux, use:

```powershell
npm run gateway:start
npm run gateway:status
npm run gateway:stop
npm run gateway:restart
```

Background mode writes:

```text
gateway.pid.json
gateway.stdout.log
gateway.stderr.log
gateway.log
```

Use the unified command directly when you need an isolated port or runtime
directory:

```bash
npm run gateway -- start --test
npm run gateway -- status --test
npm run gateway -- stop --test
```

Test mode always uses port `8788`, writes runtime files under `.gateway-test`,
and disables Claude Desktop, Claude Code, and Codex configuration sync.

## Web Config UI

The shared web config page lives at `desktop/config-panel.html` and is served at
`/config` after the gateway starts. Prefer this path over any former desktop shell:

```powershell
npm start
# then open http://127.0.0.1:8787/config
```

or:

```powershell
npm run gateway:start
```

Keep these concepts separate:

- `desktop/config-panel.html`: web configuration UI
- `clients.desktop` in `gateway.config.json`: Claude Desktop client endpoints
- `/desktop/...` routes: Claude Desktop request prefix / client identity

The Electron desktop shell, packaging scripts, and desktop build workflow have
been removed. Configuration and day-to-day use are web/CLI only.

## Validate

After saving `gateway.config.json`, validate your provider config:

```powershell
npm run validate:config
```

Run adapter tests without calling any real upstream provider:

```powershell
npm run check
npm run test:adapters
```

Run the local doctor when a client cannot connect or a model does not appear:

```powershell
npm run doctor
```

## Gateway Web Search

Third-party models (e.g. GLM, DeepSeek) often lack hosted web search. The
gateway can inject a `web_search` tool into their request, execute the search
via a configured provider, and feed results back through a tool loop, so these
models gain search without any client-side changes.

Official GPT routes are not affected. They continue to use OpenAI hosted
`web_search` and never touch the gateway-local search path.

### Add a web search node

Add an endpoint with `purpose: "web_search"` to any client in
`gateway.config.json`. Search nodes are excluded from `/v1/models` and do not
appear as selectable models.

```json
{
  "id": "ep_web_search_1",
  "name": "tavily-search",
  "purpose": "web_search",
  "provider": "tavily",
  "enabled": true,
  "is_default": true,
  "options": {
    "search_depth": "basic",
    "max_results": 5,
    "topic": "general",
    "country": "china",
    "include_answer": false,
    "include_raw_content": false
  }
}
```

Each client may have multiple web search nodes but only one `is_default: true`.
The gateway uses the default node (or the first enabled node with a valid API
key) when injecting the tool.

### Configure the API key

Store the Tavily key in `gateway.secrets.json`, keyed by the endpoint ID:

```json
{
  "api_keys": {
    "ep_web_search_1": "env:TAVILY_API_KEY"
  }
}
```

The `env:` prefix reads from the environment variable `TAVILY_API_KEY`. You can
also set the key directly as a literal string instead of `env:TAVILY_API_KEY`.
As a fallback, the gateway checks `process.env.TAVILY_API_KEY` when no
per-endpoint key is configured.

### Supported protocols

Gateway web search works across all third-party request paths:

```text
Codex / Responses        -> web_search tool injected in Responses format
OpenAI Chat              -> web_search tool injected in Chat function format
Claude / Anthropic       -> web_search tool injected in Anthropic tool_use format
```

Streaming requests run the tool loop internally with `stream: false`, then
re-emit the final answer as SSE to preserve the streaming contract.

### Environment variables

```text
TAVILY_API_KEY             Tavily API key (also settable per-endpoint in secrets)
GATEWAY_WEB_SEARCH_DISABLED  Set to 1/true to disable gateway web search globally
GATEWAY_WEB_SEARCH_MAX_LOOPS Max tool-loop rounds before forcing a final answer (default 3)
```

## Global Command

After installing the package globally, the same cross-platform control is
available without npm:

```bash
npm install -g @wuhezhizhong/local-ai-gateway
local-ai-gateway start
local-ai-gateway status
local-ai-gateway stop
local-ai-gateway restart
local-ai-gateway logs
```

The first command creates user-owned configuration under
`~/.local-ai-gateway/`. Existing `.env` and `gateway.config.json` files are
never overwritten.

## Claude Desktop/Gateway Config

- Gateway base URL: `http://127.0.0.1:8787/desktop`
- Gateway auth scheme: `bearer`
- Gateway API key: your Volcengine Ark API key, unless `ARK_API_KEY` is set in `.env`
- Model discovery: enabled

## Claude Code Config

Use a different base URL so logs can distinguish Claude Code from Claude Desktop:

```text
http://127.0.0.1:8787/code
```

For pure Volcengine third-party mode, keep `ANTHROPIC_AUTH_TOKEN` set to your
Ark key in `~/.claude/settings.json`.

For Claude Code subscription pass-through plus custom Ark models, set only the
base URL and remove `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` from the
Claude Code env block:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787/code",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-5",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "glm-5.2"
  },
  "model": "sonnet"
}
```

Routing behavior:

```text
claude-sonnet-4-5       -> deepseek-v4-pro on Ark, from gateway.config.json
glm-5.2                 -> glm-5.2 on Ark, from gateway.config.json alias
claude-sonnet-4-6       -> official Anthropic upstream
claude-haiku-4-5-...    -> official Anthropic upstream
```

Both prefixed and unprefixed routes work:

```text
http://127.0.0.1:8787/v1/messages          -> client: unknown or inferred
http://127.0.0.1:8787/desktop/v1/messages  -> client: desktop
http://127.0.0.1:8787/code/v1/messages     -> client: code
```

The gateway also accepts `x-gateway-client: desktop` or `x-gateway-client: code`,
but URL prefixes are the most reliable.

## Codex Desktop Config

Use the Codex-prefixed base URL:

```text
http://127.0.0.1:8787/codex
```

Current OpenAI-style routes exposed for Codex testing:

```text
http://127.0.0.1:8787/codex/v1/models
http://127.0.0.1:8787/codex/v1/chat/completions
http://127.0.0.1:8787/codex/v1/responses
http://127.0.0.1:8787/codex/v1/config
http://127.0.0.1:8787/codex/v1/providers
http://127.0.0.1:8787/codex/health
```

These Codex routes are forwarded through configured OpenAI-compatible providers,
with model mapping handled locally by this gateway.

Supported Codex provider matrix:

| Codex upstream | Text | Image | Reasoning | Tools |
| --- | --- | --- | --- | --- |
| Official subscription | Native | Native | Native | Native |
| OpenAI Responses | Native | Capability-based | Native | Native |
| OpenAI Chat | Adapted | Capability-based | Adapted summary | Adapted |
| Grok Responses | Native | Capability-based | Native | Native |
| Grok Chat | Adapted | Capability-based | Adapted summary | Adapted |

`GET /codex/v1/models` merges official models with configured third-party IDs.
Official discovery starts from the local Codex bundled catalog, then optionally
refreshes that bundled list and adds any extra `gpt-*` / `o*` IDs from
`https://api.openai.com/v1/models` when local Codex auth is available. Live
fetch failures fall back to bundled data and never change request routing.
Disable live refresh with `CODEX_MODELS_LIVE_DISABLED=1`.

Generate or refresh the Desktop model catalog:

```powershell
npm run codex:catalog
npm run codex:catalog:verify
```

Both the gateway (on start/save) and `npm run codex:catalog` write the same
default file:

```text
~/.codex/gateway-model-catalog.json
```

Override with `CODEX_MODEL_CATALOG_PATH` if you need a project-local file.
`codex:catalog:verify` checks that `codex debug models -c ...` can see the
custom models and prints an optional `config.toml` snippet. It does not edit
Codex's user config by itself. If you test the snippet manually, insert it
before the first `[section]` so `model_provider` and `model_catalog_json` remain
top-level TOML keys.

### Codex isolated verification

Run `npm run test:codex:e2e` before editing `~/.codex/config.toml`.
The harness uses a temporary Codex home, temporary fixture, local mock provider,
and a temporary gateway port.

After it passes, back up `~/.codex/config.toml`, add the generated local-gateway
provider snippet, and verify one official subscription model before selecting a
third-party model. Roll back by restoring the backup and restarting Codex
Desktop; `~/.codex/auth.json` is not modified.

## OpenAI-Compatible Client Config

For clients that speak OpenAI Chat Completions directly, use the unprefixed base
URL:

```text
http://127.0.0.1:8787
```

The gateway exposes:

```text
http://127.0.0.1:8787/v1/models
http://127.0.0.1:8787/v1/chat/completions
http://127.0.0.1:8787/v1/responses
http://127.0.0.1:8787/v1/config
http://127.0.0.1:8787/v1/providers
http://127.0.0.1:8787/v1/resolve?model=glm-5.2
```

Use any local model id from `gateway.config.json`; the gateway maps it to the
provider's `upstream_model`. Chat Completions requests can be forwarded directly
to `openai-chat` providers, or translated to `openai-responses` and `anthropic`
providers when the selected model uses one of those upstream types.

`/v1/resolve?model=...` is a safe local debug endpoint. It shows the selected
provider, upstream model, and whether Claude Messages, OpenAI Chat, and OpenAI
Responses routes are direct, translated, official, or unsupported.

## Test

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
Invoke-RestMethod http://127.0.0.1:8787/v1/models
Invoke-RestMethod http://127.0.0.1:8787/v1/config
```

Messages test:

```powershell
$body = @{
  model = "claude-sonnet-4-5"
  max_tokens = 256
  messages = @(
    @{ role = "user"; content = "hello" }
  )
} | ConvertTo-Json -Depth 10

Invoke-RestMethod `
  -Uri http://127.0.0.1:8787/v1/messages `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```




