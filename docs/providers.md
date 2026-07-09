# Provider Recipes

Local AI Gateway routes by model id. Each model points to a provider, and each
provider declares the upstream API shape it supports.
The `base_url` value is used exactly as written; the gateway does not append
protocol paths such as `/messages`, `/chat/completions`, or `/responses`.

## Provider Types

```text
anthropic         Claude/Anthropic Messages compatible /v1/messages
openai-chat       OpenAI Chat Completions compatible /v1/chat/completions
openai-responses  OpenAI Responses compatible /v1/responses
```

Compatibility matrix:

```text
Claude Desktop / Claude Code -> anthropic
Claude Desktop / Claude Code -> openai-chat, through Anthropic-to-Chat adapter
Codex / OpenAI Responses     -> openai-responses
Codex / OpenAI Responses     -> openai-chat, through Responses-to-Chat adapter
OpenAI Chat clients          -> openai-chat
OpenAI Chat clients          -> openai-responses, through Chat-to-Responses adapter
OpenAI Chat clients          -> anthropic, through Chat-to-Anthropic adapter
```

## Volcengine Ark Agent Plan

```json
{
  "providers": {
    "volcengine-anthropic": {
      "type": "anthropic",
      "base_url": "https://ark.cn-beijing.volces.com/api/plan",
      "api_key_env": "ARK_API_KEY",
      "auth": "bearer"
    },
    "volcengine-openai": {
      "type": "openai-responses",
      "base_url": "https://ark.cn-beijing.volces.com/api/plan/v3",
      "api_key_env": "ARK_API_KEY",
      "auth": "bearer"
    }
  },
  "models": [
    {
      "id": "claude-sonnet-4-5",
      "provider": "volcengine-anthropic",
      "upstream_model": "deepseek-v4-pro"
    },
    {
      "id": "glm-5.2",
      "provider": "volcengine-openai",
      "upstream_model": "glm-5.2"
    }
  ]
}
```

## OpenRouter

OpenRouter is OpenAI Chat compatible, so it can serve both Claude-style clients
and Codex-style clients through the gateway adapters.

```json
{
  "providers": {
    "openrouter": {
      "type": "openai-chat",
      "base_url": "https://openrouter.ai/api/v1/chat/completions",
      "api_key_env": "OPENROUTER_API_KEY",
      "auth": "bearer"
    }
  },
  "models": [
    {
      "id": "claude-sonnet-openrouter",
      "provider": "openrouter",
      "upstream_model": "deepseek/deepseek-chat",
      "aliases": ["sonnet-openrouter"]
    },
    {
      "id": "openrouter-deepseek-chat",
      "provider": "openrouter",
      "upstream_model": "deepseek/deepseek-chat"
    }
  ]
}
```

## DeepSeek

```json
{
  "providers": {
    "deepseek": {
      "type": "openai-chat",
      "base_url": "https://api.deepseek.com/v1/chat/completions",
      "api_key_env": "DEEPSEEK_API_KEY",
      "auth": "bearer"
    }
  },
  "models": [
    {
      "id": "deepseek-chat",
      "provider": "deepseek",
      "upstream_model": "deepseek-chat"
    },
    {
      "id": "claude-sonnet-deepseek",
      "provider": "deepseek",
      "upstream_model": "deepseek-chat"
    }
  ]
}
```

## Official Anthropic

```json
{
  "providers": {
    "anthropic": {
      "type": "anthropic",
      "base_url": "https://api.anthropic.com/v1/messages",
      "api_key_env": "ANTHROPIC_API_KEY",
      "auth": "x-api-key"
    }
  },
  "models": [
    {
      "id": "claude-sonnet-official",
      "provider": "anthropic",
      "upstream_model": "claude-sonnet-4-6"
    }
  ]
}
```

## Key Rules

- Prefer `api_key_env` instead of inline `api_key`.
- Set `base_url` to the exact upstream request URL shown by the provider for
  that protocol.
- Use a Claude-like local model id when a Claude client needs to display a
  third-party model as a Claude choice.
- Use the provider's real upstream model id in `upstream_model`.
- Run `npm run validate:config` after editing `gateway.config.json`.
- Run `npm run doctor` when a client cannot connect or a model does not appear.
