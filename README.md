# Local AI Gateway

Local lightweight routing gateway for AI clients and custom model providers.

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
- `gateway.config.example.json`: provider/model routing config template
- `.env.example`: config template
- `docs/providers.md`: provider recipes for Volcengine, OpenRouter, DeepSeek, and Anthropic
- `models.json`: legacy Volcengine-only model mapping fallback
- `scripts/init-config.ps1`: first-run config initializer for Windows
- `scripts/init-config.sh`: first-run config initializer for Bash/macOS/Linux

## Provider Config

New setups should copy the generic config template:

```powershell
npm run init
```

For Bash/macOS/Linux:

```bash
npm run init:bash
```

On Windows, use `npm run init` unless you are running inside Git Bash or WSL.

The init command creates `.env` and `gateway.config.json` only when they do not
already exist, so it is safe to run again.

The config has two important sections:

```json
{
  "providers": {
    "openrouter": {
      "type": "openai-chat",
      "base_url": "https://openrouter.ai/api/v1",
      "api_key_env": "OPENROUTER_API_KEY",
      "auth": "bearer"
    }
  },
  "models": [
    {
      "id": "deepseek-chat",
      "provider": "openrouter",
      "upstream_model": "deepseek/deepseek-chat",
      "display_name": "DeepSeek Chat"
    },
    {
      "id": "claude-sonnet-openrouter",
      "provider": "openrouter",
      "upstream_model": "deepseek/deepseek-chat",
      "display_name": "Claude-style DeepSeek Chat via OpenRouter"
    }
  ]
}
```

Provider `type` currently supports:

```text
anthropic         -> /v1/messages providers
openai-chat       -> /v1/chat/completions providers
openai-responses  -> /v1/responses providers
```

`openai-chat` providers can also serve Codex `/v1/responses` requests through
the gateway's Responses-to-Chat adapter. This is useful for providers such as
OpenRouter, DeepSeek, Qwen, Moonshot, and other OpenAI Chat-compatible APIs.

The same `openai-chat` providers can serve Claude Desktop / Claude Code
`/v1/messages` requests through the gateway's Anthropic-to-Chat adapter. That
means a Claude-style client model id such as `claude-sonnet-openrouter` can be
mapped to an upstream OpenAI-compatible model such as `deepseek/deepseek-chat`.

If `gateway.config.json` does not exist, the gateway falls back to the old
`.env + models.json` Volcengine setup.

## Legacy Model Mapping

Current mapping in `models.json`:

```text
claude-opus-4-8   -> glm-5.2
claude-opus-4-7   -> minimax-m3
claude-sonnet-4-5 -> deepseek-v4-pro
claude-haiku-4-0  -> doubao-seed-2.0-pro
```

Aliases are also accepted. For example, if a client sends `sonnet` or
`deepseek-v4-pro`, the gateway forwards `deepseek-v4-pro` to Ark.

## Start

```powershell
npm run init
```

Edit `.env` and `gateway.config.json`:

```env
# Optional. If empty, the gateway uses the client's Gateway API key as Ark key.
ARK_API_KEY=your-volcengine-ark-api-key
GATEWAY_HOST=127.0.0.1
GATEWAY_PORT=8787
GATEWAY_CONFIG_FILE=gateway.config.json
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/plan
ARK_CODEX_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3
OFFICIAL_ANTHROPIC_BASE_URL=https://api.anthropic.com
MODEL_MAP_FILE=models.json
```

Then run:

```powershell
npm run validate:config
npm start
```

For background control on Windows, use:

```powershell
npm run gateway:start
npm run gateway:status
npm run gateway:stop
npm run gateway:restart
```

Background mode writes:

```text
gateway.pid
gateway.stdout.log
gateway.stderr.log
gateway.log
```

## Desktop Console

The desktop console is an Electron app for Windows and macOS. It starts the
gateway when the app opens and stops the gateway when the app exits. It does
not install a system service, keep running in the background after close, or
auto-update.

Run it during development:

```powershell
npm install
npm run desktop
```

Build installers:

```powershell
npm run desktop:dist
```

The build config emits a Windows NSIS installer on Windows and a macOS dmg on
macOS. macOS signing/notarization is not configured.

Platform-specific build commands are also available:

```powershell
npm run desktop:dist:win
npm run desktop:dist:mac
```

The repository also includes a GitHub Actions workflow at
`.github/workflows/desktop-build.yml` that builds both platforms on native
hosted runners and uploads the Windows and macOS artifacts.

The desktop console keeps its editable config and logs in Electron's user data
directory, not in the repository root. On first launch it copies the existing
`.env`, `gateway.config.json`, and `models.json` when present; otherwise it
uses the example templates. This keeps the existing CLI and script workflow
unchanged.

Desktop checks:

```powershell
npm run desktop:check
npm run desktop:test
npm run desktop:smoke
```

`desktop:smoke` expects a Windows unpacked build in `dist/win-unpacked`. It
starts the packaged app on a temporary high port, checks `/health`, exits the
app, and verifies that the port is released.

## Validate

Before starting the gateway, validate your provider config:

```powershell
npm run validate:config
node scripts/validate-config.mjs gateway.config.example.json
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

## Global Command

For Bash, add this to `~/.bashrc` or `~/.zshrc`. The Bash CLI does not require
PowerShell:

```bash
agent-gateway() {
  local root="${AGENT_GATEWAY_ROOT:-$HOME/project/AI/local-ai-gateway}"
  local script="$root/scripts/agent-gateway.sh"
  if [ ! -f "$script" ]; then
    echo "agent-gateway.sh not found: $script" >&2
    return 1
  fi
  bash "$script" "$@"
}
```

Then open a new Bash terminal, or run `source ~/.bashrc`.

Global commands:

```bash
agent-gateway start
agent-gateway status
agent-gateway stop
agent-gateway restart
agent-gateway logs
```

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
claude-sonnet-4-5       -> deepseek-v4-pro on Ark, from models.json
glm-5.2                 -> glm-5.2 on Ark, from models.json alias
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

For a lower-risk Codex Desktop experiment, generate the merged model catalog
inside this project instead of writing directly to `~/.codex`:

```powershell
npm run codex:catalog:verify
```

The command writes `.codex/gateway-model-catalog.json`, verifies
that `codex debug models -c ...` can see the custom models, and prints an
optional `config.toml` snippet for manual desktop testing. It does not edit
Codex's user config by itself. If you test the snippet manually, insert it
before the first `[section]` so `model_provider` and `model_catalog_json` remain
top-level TOML keys.

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
