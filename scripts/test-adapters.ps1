$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Tmp = Join-Path $env:TEMP "local-ai-gateway-adapter-tests"
$GatewayPort = 18889
$MockPort = 18888

function Wait-ForHttp {
  param([string]$Uri)

  $deadline = (Get-Date).AddSeconds(8)
  do {
    try {
      Invoke-RestMethod -Uri $Uri -TimeoutSec 1 | Out-Null
      return
    } catch {
      Start-Sleep -Milliseconds 250
    }
  } while ((Get-Date) -lt $deadline)

  Write-Host "Gateway stdout:"
  Get-Content -LiteralPath (Join-Path $Tmp "gateway.out.log") -ErrorAction SilentlyContinue
  Write-Host "Gateway stderr:"
  Get-Content -LiteralPath (Join-Path $Tmp "gateway.err.log") -ErrorAction SilentlyContinue
  throw "Timed out waiting for $Uri"
}

function Test-AnthropicToChat {
  $body = @{
    model = "claude-mock-sonnet"
    max_tokens = 16
    system = "System note"
    messages = @(@{ role = "user"; content = "Reply OK only." })
  } | ConvertTo-Json -Depth 20

  $res = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$GatewayPort/code/v1/messages" `
    -Method Post `
    -Headers @{ Authorization = "Bearer client-key"; "anthropic-version" = "2023-06-01" } `
    -ContentType "application/json" `
    -Body $body

  if ($res.content[0].text -ne "OK") {
    throw "Anthropic adapter returned unexpected text: $($res.content[0].text)"
  }
  if ($res.model -ne "claude-mock-sonnet") {
    throw "Anthropic adapter returned unexpected model: $($res.model)"
  }

  $upstream = Get-Content -LiteralPath (Join-Path $Tmp "last-chat_completions.json") -Raw | ConvertFrom-Json
  if ($upstream.model -ne "mock-upstream") {
    throw "Anthropic adapter sent unexpected upstream model: $($upstream.model)"
  }
  if ($upstream.messages[0].role -ne "system" -or $upstream.messages[1].role -ne "user") {
    throw "Anthropic adapter did not convert system/user messages correctly."
  }
}

function Test-ResponsesToChat {
  $body = @{
    model = "mock-codex-model"
    input = "Reply OK only."
    max_output_tokens = 16
  } | ConvertTo-Json -Depth 20

  $res = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$GatewayPort/codex/v1/responses" `
    -Method Post `
    -Headers @{ Authorization = "Bearer client-key" } `
    -ContentType "application/json" `
    -Body $body

  if ($res.output_text -ne "OK") {
    throw "Responses adapter returned unexpected output_text: $($res.output_text)"
  }
  if ($res.model -ne "mock-codex-model") {
    throw "Responses adapter returned unexpected model: $($res.model)"
  }

  $upstream = Get-Content -LiteralPath (Join-Path $Tmp "last-chat_completions.json") -Raw | ConvertFrom-Json
  if ($upstream.model -ne "mock-upstream") {
    throw "Responses adapter sent unexpected upstream model: $($upstream.model)"
  }
  if ($upstream.messages[0].role -ne "user") {
    throw "Responses adapter did not convert input to a user message."
  }
}

function Test-AnthropicExactBaseUrl {
  $body = @{
    model = "claude-mock-haiku"
    max_tokens = 16
    messages = @(@{ role = "user"; content = "Reply OK only." })
  } | ConvertTo-Json -Depth 20

  $res = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$GatewayPort/desktop/v1/messages" `
    -Method Post `
    -Headers @{ Authorization = "Bearer client-key"; "anthropic-version" = "2023-06-01" } `
    -ContentType "application/json" `
    -Body $body

  if ($res.content[0].text -ne "OK") {
    throw "Anthropic exact base URL returned unexpected text: $($res.content[0].text)"
  }

  $upstream = Get-Content -LiteralPath (Join-Path $Tmp "last-root.json") -Raw | ConvertFrom-Json
  if ($upstream.model -ne "mock-anthropic-upstream") {
    throw "Anthropic exact base URL sent unexpected upstream model: $($upstream.model)"
  }
}

function Test-OpenAIChatCompletions {
  $body = @{
    model = "mock-chat-model"
    messages = @(@{ role = "user"; content = "Reply OK only." })
    max_tokens = 16
  } | ConvertTo-Json -Depth 20

  $res = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$GatewayPort/v1/chat/completions" `
    -Method Post `
    -Headers @{ Authorization = "Bearer client-key" } `
    -ContentType "application/json" `
    -Body $body

  if ($res.choices[0].message.content -ne "OK") {
    throw "Chat Completions route returned unexpected content: $($res.choices[0].message.content)"
  }
  if ($res.model -ne "mock-upstream") {
    throw "Chat Completions route returned unexpected upstream model: $($res.model)"
  }

  $upstream = Get-Content -LiteralPath (Join-Path $Tmp "last-chat_completions.json") -Raw | ConvertFrom-Json
  if ($upstream.model -ne "mock-upstream") {
    throw "Chat Completions route sent unexpected upstream model: $($upstream.model)"
  }
  if ($upstream.messages[0].role -ne "user") {
    throw "Chat Completions route did not pass through user message."
  }
}

function Test-OpenAIChatToResponses {
  $body = @{
    model = "mock-responses-model"
    messages = @(
      @{ role = "system"; content = "System note" },
      @{ role = "user"; content = "Reply OK only." }
    )
    max_tokens = 16
  } | ConvertTo-Json -Depth 20

  $res = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$GatewayPort/v1/chat/completions" `
    -Method Post `
    -Headers @{ Authorization = "Bearer client-key" } `
    -ContentType "application/json" `
    -Body $body

  if ($res.choices[0].message.content -ne "OK") {
    throw "Chat-to-Responses adapter returned unexpected content: $($res.choices[0].message.content)"
  }
  if ($res.model -ne "mock-responses-model") {
    throw "Chat-to-Responses adapter returned unexpected model: $($res.model)"
  }

  $upstream = Get-Content -LiteralPath (Join-Path $Tmp "last-responses.json") -Raw | ConvertFrom-Json
  if ($upstream.model -ne "mock-responses-upstream") {
    throw "Chat-to-Responses adapter sent unexpected upstream model: $($upstream.model)"
  }
  if ($upstream.instructions -ne "System note") {
    throw "Chat-to-Responses adapter did not convert system message to instructions."
  }
  if ($upstream.input[0].role -ne "user") {
    throw "Chat-to-Responses adapter did not convert user message to Responses input."
  }
}

function Test-ResolveRoute {
  $res = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$GatewayPort/v1/resolve?model=mock-responses-model" `
    -Method Get `
    -Headers @{ Authorization = "Bearer client-key" }

  if ($res.configured.upstream_model -ne "mock-responses-upstream") {
    throw "Resolve route returned unexpected upstream model: $($res.configured.upstream_model)"
  }
  if ($res.routes.openai_chat.mode -ne "translated") {
    throw "Resolve route did not report Chat-to-Responses translation."
  }
  if ($res.routes.openai_responses.mode -ne "direct") {
    throw "Resolve route did not report direct Responses support."
  }
}

Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $Tmp | Out-Null

$MockScript = @'
const http = require("http");
const fs = require("fs");

const outDir = process.argv[2];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => raw += chunk);
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    const safeName = req.url.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "") || "root";
    fs.writeFileSync(`${outDir}/last-${safeName}.json`, JSON.stringify(body, null, 2));

    if (req.url === "/") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 3, output_tokens: 1 }
      }));
      return;
    }

    if (req.url === "/responses") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "resp_mock",
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        model: body.model,
        status: "completed",
        output_text: "OK",
        output: [
          {
            id: "msg_mock",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "OK", annotations: [] }]
          }
        ],
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 }
      }));
      return;
    }

    if (req.url !== "/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl_mock",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "OK" },
          finish_reason: "stop"
        }
      ],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
    }));
  });
});

server.listen(18888, "127.0.0.1");
'@

Set-Content -LiteralPath (Join-Path $Tmp "mock.js") -Value $MockScript -Encoding ASCII

$Config = @{
  server = @{
    host = "127.0.0.1"
    port = $GatewayPort
  }
  clients = @{
    code = @{
      endpoints = @(
        @{
          name = "mock-chat"
          type = "openai-chat"
          base_url = "http://127.0.0.1:$MockPort/chat/completions"
          api_key = "env:MOCK_API_KEY"
          models = @("mock-upstream")
          model_mapping = @{
            "claude-mock-sonnet" = "mock-upstream"
          }
        }
      )
    }
    codex = @{
      endpoints = @(
        @{
          name = "mock-chat"
          type = "openai-chat"
          base_url = "http://127.0.0.1:$MockPort/chat/completions"
          api_key = "env:MOCK_API_KEY"
          models = @("mock-upstream")
          model_mapping = @{
            "mock-codex-model" = "mock-upstream"
          }
        }
      )
    }
    desktop = @{
      endpoints = @(
        @{
          name = "mock-anthropic"
          type = "anthropic"
          base_url = "http://127.0.0.1:$MockPort"
          api_key = "env:MOCK_API_KEY"
          models = @("mock-anthropic-upstream")
          model_mapping = @{
            "claude-mock-haiku" = "mock-anthropic-upstream"
          }
        }
      )
    }
    unknown = @{
      endpoints = @(
        @{
          name = "mock-chat"
          type = "openai-chat"
          base_url = "http://127.0.0.1:$MockPort/chat/completions"
          api_key = "env:MOCK_API_KEY"
          models = @("mock-upstream")
          model_mapping = @{
            "mock-chat-model" = "mock-upstream"
          }
        }
        @{
          name = "mock-responses"
          type = "openai-responses"
          base_url = "http://127.0.0.1:$MockPort/responses"
          api_key = "env:MOCK_API_KEY"
          models = @("mock-responses-upstream")
          model_mapping = @{
            "mock-responses-model" = "mock-responses-upstream"
          }
        }
      )
    }
  }
} | ConvertTo-Json -Depth 20

Set-Content -LiteralPath (Join-Path $Tmp "gateway.config.json") -Value $Config -Encoding UTF8

$Mock = $null
$Gateway = $null

try {
  $Mock = Start-Process `
    -FilePath node `
    -ArgumentList @((Join-Path $Tmp "mock.js"), $Tmp) `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $Tmp "mock.out.log") `
    -RedirectStandardError (Join-Path $Tmp "mock.err.log")

  Start-Sleep -Milliseconds 500

  $env:GATEWAY_CONFIG_FILE = Join-Path $Tmp "gateway.config.json"
  $env:GATEWAY_PORT = "$GatewayPort"
  $env:MOCK_API_KEY = "test-key"

  $Gateway = Start-Process `
    -FilePath node `
    -ArgumentList @("server.js") `
    -WorkingDirectory $Root `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $Tmp "gateway.out.log") `
    -RedirectStandardError (Join-Path $Tmp "gateway.err.log")

  Wait-ForHttp "http://127.0.0.1:$GatewayPort/health"

  Test-AnthropicToChat
  Test-ResponsesToChat
  Test-AnthropicExactBaseUrl
  Test-OpenAIChatCompletions
  Test-OpenAIChatToResponses
  Test-ResolveRoute

  Write-Host "Adapter tests passed."
} finally {
  if ($Gateway) {
    Stop-Process -Id $Gateway.Id -Force -ErrorAction SilentlyContinue
  }
  if ($Mock) {
    Stop-Process -Id $Mock.Id -Force -ErrorAction SilentlyContinue
  }
  Remove-Item Env:GATEWAY_CONFIG_FILE -ErrorAction SilentlyContinue
  Remove-Item Env:GATEWAY_PORT -ErrorAction SilentlyContinue
  Remove-Item Env:MOCK_API_KEY -ErrorAction SilentlyContinue
}
