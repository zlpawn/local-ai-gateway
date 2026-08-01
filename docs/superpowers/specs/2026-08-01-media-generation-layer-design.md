# Media Generation Layer Design

## Overview

Add a unified media generation layer (image / video / TTS) to the gateway, covering node configuration, gateway media routes, mini-tool UI, and two new subscription-based image generation skills (Codex, Antigravity). Follows the existing capability-endpoint pattern (`web_search` / `embedding` / `vision_fallback`) and the provider-adapter pattern (`lib/web-search/providers/`).

## Context

The gateway already abstracts chat protocols (anthropic / openai-chat / openai-responses / grok / antigravity / codex-subscription) but media generation is unstructured: `leo-grok-imagine` and `leo-huoshan-imagine` are standalone skill scripts that hardcode their respective upstream APIs. Codex Desktop and Antigravity Desktop both have built-in image generation but no public media API surface; their protocols were reverse-engineered from local logs and existing gateway code:

- **Codex**: built-in `image_gen` tool posts to `chatgpt.com/backend-api/codex/images/generations` using `~/.codex/auth.json`. The gateway already proxies this via `proxyOfficialCodexImages` (server.js:3533, `getOfficialCodexImageAuth` server.js:8150).
- **Antigravity**: built-in `generate_image` tool calls `cloudcode-pa.googleapis.com` `streamGenerateContent` with model `gemini-3.1-flash-image`, authenticated via `antigravity.secrets.json` OAuth (token-store.mjs).
- **Grok**: `~/.grok/auth.json` Bearer JWT, `cli-chat-proxy.grok.com/v1`. Has image + video, no TTS.
- **Huoshan**: Ark API Key from `gateway.secrets.json`, `ark.cn-beijing.volces.com/api/v3`. Has image (Seedream) + video (Seedance, async) + TTS (Seed TTS, separate `openspeech.bytedance.com` host).

Scope is mini-tools + gateway API only (Approach A). No LLM function-tool injection into chat requests.

## Part 1: Node Configuration

### New capability purposes

Three new `purpose` values join the existing capability endpoints in `clients.<client>.endpoints`:

| Purpose | Media type | Providers |
|---------|-----------|-----------|
| `image_generation` | Image | grok-subscription, codex-subscription, antigravity, huoshan-agentplan |
| `video_generation` | Video | grok-subscription, huoshan-agentplan |
| `audio_tts` | TTS | huoshan-agentplan |

### Endpoint shape

```json
{
  "id": "ep_media_001",
  "name": "Grok 图片生成",
  "purpose": "image_generation",
  "provider": "grok-subscription",
  "models": ["grok-imagine-image-quality"],
  "is_default": true
}
```

Uses `provider` (not `type`) to declare the media protocol, mirroring how `web_search` uses `provider`. The `type` field stays reserved for chat protocol.

### Provider matrix

| Provider | Purposes | base_url behavior | Credential source |
|----------|---------|-------------------|-------------------|
| `grok-subscription` | image, video | Read-only display: `https://cli-chat-proxy.grok.com/v1` | `~/.grok/auth.json` |
| `codex-subscription` | image | Read-only display: `https://chatgpt.com/backend-api/codex` | `~/.codex/auth.json` |
| `antigravity` | image | Read-only display: `https://daily-cloudcode-pa.googleapis.com` | `antigravity.secrets.json` |
| `huoshan-agentplan` | image, video, tts | Editable, default `https://ark.cn-beijing.volces.com/api/v3` | `gateway.secrets.json` |

For subscription providers (grok/codex/antigravity), the config panel shows the base_url in a read-only input so the user can see the actual endpoint. For huoshan, the field is editable.

### Config panel changes

The "Add Node" dropdown gains three new options: "图片生成节点", "视频生成节点", "TTS 节点". When selected, the form shows a provider `select` with the four options above. Selecting a subscription provider auto-fills the read-only base_url display and hides the API Key field. Selecting huoshan shows the editable base_url and API Key fields (same as existing huoshan chat nodes).

### Validation changes

`lib/config/gateway-config-store.mjs`:

- `isCapabilityEndpoint()`: add `image_generation`, `video_generation`, `audio_tts` to the purpose check.
- `validateGatewayConfig()`: add validation blocks for each new purpose - check `provider` is one of the four, check `provider` supports the declared `purpose` (e.g. `codex-subscription` cannot be used with `video_generation`), allow at most one `is_default` per purpose per client.

`scripts/validate-config.mjs`:

- Skip `base_url` requirement for subscription providers (grok/codex/antigravity) on media endpoints, same as how `antigravity` chat type is already skipped.
- Add `image_generation` / `video_generation` / `audio_tts` to the early-return capability check (currently only `web_search` returns early).

## Part 2: Gateway Media Layer

### Module structure

```
lib/media/
  providers/
    grok.mjs          # image: /images/generations (b64_json), video: /videos/generations + poll
    codex.mjs         # image: chatgpt.com/backend-api/codex/images/generations (reuses getOfficialCodexImageAuth)
    antigravity.mjs   # image: streamGenerateContent + gemini-3.1-flash-image (reuses token-store)
    huoshan.mjs       # image: Seedream, video: Seedance (async tasks), TTS: Seed TTS (openspeech host)
  registry.mjs        # filter endpoints by purpose, dispatch to provider adapter
  storage.mjs         # download (fetch + curl fallback), semantic filename, slugify
  history.mjs         # media-history.json read/write/prune
```

### Adapter interface

Each provider module exports a default object with optional methods (implemented per capability):

```js
export default {
  generateImage(options, ctx) { },      // sync - returns { b64Json | url, revisedPrompt? }
  createVideoTask(options, ctx) { },    // async submit - returns { taskId }
  pollVideoTask(taskId, ctx) { },       // poll - returns { status, videoUrl?, progress? }
  synthesizeSpeech(options, ctx) { },   // sync - returns { b64Audio | binary, format }
}
```

`ctx` contains `{ endpoint, getApiKey, signal }`. `getApiKey(endpoint)` resolves credentials from `gateway.secrets.json` or subscription files depending on provider.

### Registry

`registry.mjs` exposes:

- `selectMediaEndpoints(endpoints, purpose)` - filter by purpose.
- `selectDefaultMediaEndpoint(endpoints, purpose)` - prefer `is_default`, else first.
- `getAdapter(provider)` - return the provider module from a static map.

### HTTP routes (added to server.js)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/media/image` | Generate image - sync, returns b64 or downloads to disk |
| POST | `/v1/media/video` | Submit video task - returns taskId immediately |
| GET | `/v1/media/tasks/:id` | Poll video task status |
| POST | `/v1/media/tts` | Synthesize speech - sync, returns audio |
| GET | `/v1/media/history` | List history (optional `?media_type=` filter) |
| DELETE | `/v1/media/history/:id` | Delete one history entry (and optionally its file) |

Request bodies carry `endpoint_id` (optional, defaults to the first/default media node for the client) plus media-specific parameters. The `X-Gateway-Client` header identifies the client (same as embedding tool).

### Video async flow

1. `POST /v1/media/video` calls adapter `createVideoTask()`, returns `{ taskId }`, HTTP 200 immediately.
2. Frontend polls `GET /v1/media/tasks/:id` every 4-5 seconds.
3. When status becomes `succeeded`, adapter downloads the video via `storage.mjs`, writes to `./videos/`, creates a history entry, returns `{ status, filePath }`.
4. If `failed`, returns `{ status, error }`.

### Storage module

Extracted from existing skill scripts (`leo-grok-imagine`, `leo-huoshan-imagine`):

- `downloadMediaFile(url, targetPath)` - fetch with 60s timeout, curl fallback.
- `slugifyPrompt(prompt, maxLength)` - same logic as existing skills.
- `generateSemanticFilename(prompt, ext, providerPrefix)` - e.g. `grok_cyberpunk_20260801210000.jpg`.
- `ensureOutputDir(type)` - creates `./images/`, `./videos/`, or `./audios/` if missing.

### History module

`media-history.json` lives in the gateway data directory (same dir as `gateway.config.json`). Each entry: `id` (uuid), `timestamp`, `media_type` (image/video/tts), `endpoint_name`, `provider`, `model`, `prompt`, `file_path`, `file_size`, `status` (completed/failed), `error`, `task_id`.

- Cap at 200 entries. When exceeded, prune oldest (and delete their files unless the file no longer exists).
- Atomic write (temp file + rename), same pattern as `token-store.mjs`.

## Part 3: Mini-Tool UI

### New tool cards

Three cards added to `renderToolsCards()` in `desktop/config-panel.html`:

| Card | `openTool()` id | Icon |
|------|-----------------|------|
| 图片生成 | `image-gen` | Image icon |
| 视频生成 | `video-gen` | Film icon |
| TTS 语音合成 | `tts-gen` | Audio waveform icon |

### Shared layout pattern

Each tool detail page follows the embedding tool pattern: left input panel + right result/history panel.

Node + model selectors use the same pattern as `getEmbeddingEndpoints`:

```js
function getMediaEndpoints(client, purpose) {
  return (config.clients[client]?.endpoints || []).filter(
    ep => ep.purpose === purpose && ep.enabled !== false
  );
}
```

Node dropdown shows `节点名 · 模型 · provider`. Model dropdown renders from the selected node's `models` array. Client selector reuses the existing client switch (code/desktop/codex/deeptutor).

### Image generation tool

Input fields:

- Node selector + model selector
- Prompt (textarea)
- Aspect ratio (select: 1:1 / 16:9 / 9:16 / 3:2 / 2:3 / auto)
- Reference image paths (optional, comma-separated)
- Prompt suggestions (collapsible, see below)
- Generate button

### Video generation tool

Input fields:

- Node selector + model selector
- Prompt (textarea)
- Aspect ratio
- Duration (seconds, range depends on model, default 5)
- Reference image paths (optional)
- Prompt suggestions (collapsible, see below)
- Generate button (shows polling progress bar after submit)

### TTS tool

Input fields:

- Node selector + model selector
- Text (textarea)
- Voice (select, default `zh_female_qingxin`, shown only for huoshan provider)
- Audio format (select: mp3 / wav / ogg_opus / pcm)
- Speed ratio (range 0.5-2.0, default 1.0)
- Voice description reference (static text listing voice characteristics)
- Generate button

### Result panel

On success, the right panel shows the result inline:

- Image: inline preview + copy-path button + open-file button
- Video: `<video controls>` inline player + copy-path button + open-file button
- TTS: `<audio controls>` inline player + copy-path button + open-file button

### History panel

Below the result area, a collapsible history list fetched from `GET /v1/media/history?media_type=<type>`. Each entry shows:

- Thumbnail/icon (small image thumbnail for images, film icon for video, waveform icon for TTS)
- Timestamp
- Prompt (first 40 chars)
- Node name + model
- File path (click to copy)
- Delete button

Clicking an entry expands to show full prompt and file path.

### Prompt suggestions

Collapsible area below the prompt textarea, default expanded. Content is static JS constants (not fetched from backend).

Image suggestions:

- Use-case quick tags (click to insert): 摄影写实, 产品图, UI 模板, 信息图, 插画故事, 风格概念, Logo 品牌, 场景生成
- Structure template (click to fill): 主体 / 风格 / 构图 / 光影 / 约束 fields
- Standing tips: describe specifically, match aspect ratio to use case, use negation phrasing for things to avoid

Video suggestions (based on Seedance 2.0 guide):

- Shot-sequence template (click to fill): 镜头1/2/3 with shot type, action, camera move + 光影色调 + 画质约束
- Standing tips: one camera move per shot, no exact timestamps, externalize emotions, always append no-subtitle/watermark constraints
- Model capability reference table (resolution/duration ranges per model)

### Frontend state

Three new state objects mirroring `embedState`:

```js
const imageGenState = { client: 'codex', endpointId: '', model: '', prompt: '', aspectRatio: 'auto', imagePaths: [], result: null, loading: false, error: '' };
const videoGenState = { client: 'codex', endpointId: '', model: '', prompt: '', aspectRatio: '16:9', duration: 5, imagePaths: [], taskId: null, pollStatus: '', result: null, loading: false, error: '' };
const ttsGenState = { client: 'codex', endpointId: '', model: '', text: '', voice: 'zh_female_qingxin', encoding: 'mp3', speedRatio: 1.0, result: null, loading: false, error: '' };
```

## Part 4: Codex and Antigravity Image Skills

Two new skills, peers to `leo-grok-imagine` and `leo-huoshan-imagine`, but they call gateway media routes instead of connecting to upstream APIs directly. This lets them reuse the gateway's subscription-auth infrastructure.

### leo-codex-imagine

- Location: `lib/skills/leo-codex-imagine/`
- Script: `scripts/leo_codex_imagine.mjs`
- Capability: image generation (text-to-image, image edit)
- Gateway call: `POST http://127.0.0.1:8787/v1/media/image` with `endpoint_id` selecting a codex-subscription node
- Auth: gateway route auto-reads `~/.codex/auth.json`; skill script handles no credentials
- CLI params: `--prompt`, `--image`/`--images` (reference/edit images), `--aspect-ratio`, `--size`, `--quality`, `--output-dir`, `--filename`, `--dry-run`, `--endpoint-id`
- Output: `./images/codex_<slug>_<timestamp>.png`, returns markdown image link
- SKILL.md: same format as existing skills - usage triggers, LLM call constraints, script paths, CLI examples, output rules, return rules, error handling

### leo-antigravity-imagine

- Location: `lib/skills/leo-antigravity-imagine/`
- Script: `scripts/leo_antigravity_imagine.mjs`
- Capability: image generation (text-to-image, reference-image generation)
- Gateway call: `POST http://127.0.0.1:8787/v1/media/image` with `endpoint_id` selecting an antigravity node
- Auth: gateway route auto-reads `antigravity.secrets.json` (including OAuth token refresh); skill script handles no credentials
- CLI params: `--prompt`, `--images` (reference images, max 3), `--image-name`, `--aspect-ratio` (1:1/2:3/3:2/3:4/4:3/9:16/16:9), `--output-dir`, `--filename`, `--dry-run`, `--endpoint-id`
- Output: `./images/antigravity_<slug>_<timestamp>.png`, returns markdown image link
- SKILL.md: same format

### Relationship to existing skills

Existing `leo-grok-imagine` and `leo-huoshan-imagine` are not modified - they keep connecting to upstream APIs directly. The two new skills are thin clients: CLI parsing, gateway call, download/save, markdown output. Protocol adaptation and auth live in the gateway adapter layer. If multiple codex/antigravity nodes are configured, the skill selects via `--endpoint-id` or auto-selects the default node.

Trigger: "用 Codex 画一张图" / "用 Antigravity 生成图片" in conversation. The four image skills coexist; the user or agent picks the appropriate one.

## Out of scope

- LLM function-tool injection (Approach B) - deferred.
- Grok TTS - confirmed not available in grok-build (only STT).
- Codex video / TTS - not available from desktop subscription.
- Antigravity video / TTS - not available from desktop subscription.
- Modifying existing `leo-grok-imagine` / `leo-huoshan-imagine` skills.
