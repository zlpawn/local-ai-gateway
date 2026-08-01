# Media Generation Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified media generation layer (image / video / TTS) to the gateway with four providers, mini-tool UI, history persistence, and two new subscription-based image skills.

**Architecture:** Provider-adapter pattern mirroring `lib/web-search/providers/` - each provider is a standalone module exporting a default adapter object; a registry dispatches by provider id. Gateway HTTP routes under `/v1/media/*` handle request/response and async video polling. Mini-tool UI follows the existing embedding tool pattern. Two new skills are thin clients calling gateway routes.

**Tech Stack:** Node.js ESM (zero runtime deps beyond Node builtins), `node:test` for tests, vanilla JS in `config-panel.html`.

## Global Constraints

- Test gateway on port 8788 (set `GATEWAY_TEST_PORT=8788` in test env).
- Open-closed principle: adding a new provider must not require editing existing adapter or route code - only adding a new file and one registry import line.
- Follow existing patterns: `lib/web-search/providers/registry.mjs` for provider dispatch, `gateway-config-store.mjs` for capability endpoint handling, `embedState` for frontend state.
- Zero new npm dependencies.
- All new files use `.mjs` extension (ESM).
- Secret files are never committed.
- Provider field on media endpoints (not `type`) - `type` stays reserved for chat protocol.

## File Structure

**New files:**
- `lib/media/storage.mjs` - download, filename, slugify
- `lib/media/history.mjs` - media-history.json CRUD + pruning
- `lib/media/providers/registry.mjs` - provider dispatch + endpoint selection
- `lib/media/providers/grok.mjs` - Grok image + video adapter
- `lib/media/providers/codex.mjs` - Codex image adapter
- `lib/media/providers/antigravity.mjs` - Antigravity image adapter
- `lib/media/providers/huoshan.mjs` - Huoshan image + video + TTS adapter
- `lib/media/index.mjs` - public API surface
- `lib/skills/leo-codex-imagine/SKILL.md` + `scripts/leo_codex_imagine.mjs`
- `lib/skills/leo-antigravity-imagine/SKILL.md` + `scripts/leo_antigravity_imagine.mjs`
- `tests/unit/media-storage.test.mjs`
- `tests/unit/media-history.test.mjs`
- `tests/unit/media-registry.test.mjs`
- `tests/integration/media-routes.test.mjs`

**Modified files:**
- `lib/config/gateway-config-store.mjs` - isCapabilityEndpoint, validateGatewayConfig, selectMediaEndpoints, selectDefaultMediaEndpoint
- `scripts/validate-config.mjs` - skip base_url for media endpoints
- `server.js` - add 6 media routes
- `desktop/config-panel.html` - add-node dropdown, 3 mini-tool cards + detail pages, prompt suggestions, history panel

---

## Task 1: Config store - media purposes and endpoint selection

**Files:** Modify `lib/config/gateway-config-store.mjs`, Test `tests/unit/gateway-config-store.test.mjs`

**Produces:** `isCapabilityEndpoint()` recognizes media purposes; `selectMediaEndpoints(endpoints, purpose)`, `selectDefaultMediaEndpoint(endpoints, purpose)` exported; `validateGatewayConfig()` validates media endpoints.

- [ ] **Step 1: Write failing tests** - add tests for isCapabilityEndpoint with media purposes, selectMediaEndpoints filtering, selectDefaultMediaEndpoint preferring is_default, validation rejecting unsupported provider, provider/purpose mismatch, multiple defaults. See spec Part 1 for test code.
- [ ] **Step 2: Run tests to verify they fail** - `node --test tests/unit/gateway-config-store.test.mjs`
- [ ] **Step 3: Implement isCapabilityEndpoint + selectMediaEndpoints** - add three media purposes to isCapabilityEndpoint; add selectMediaEndpoints/selectDefaultMediaEndpoint after selectDefaultEmbeddingEndpoint, following the same pattern.
- [ ] **Step 4: Implement media validation in validateGatewayConfig** - add MEDIA_PURPOSES set and MEDIA_PROVIDER_PURPOSES map; add validation block after web_search block checking provider exists, provider supports purpose, at most one default per purpose; add continue skip for media endpoints.
- [ ] **Step 5: Run tests to verify they pass** - `node --test tests/unit/gateway-config-store.test.mjs`
- [ ] **Step 6: Commit** - `git commit -m "feat(config): add media generation purposes to config store"`

## Task 2: validate-config.mjs - skip base_url for media endpoints

**Files:** Modify `scripts/validate-config.mjs`

- [ ] **Step 1: Update validateEndpoint** - after `if (endpoint.purpose === "web_search") return;`, add early return for image_generation, video_generation, audio_tts.
- [ ] **Step 2: Run check** - `npm run check`
- [ ] **Step 3: Commit** - `git commit -m "feat(config): skip base_url validation for media endpoints"`

## Task 3: Media storage module

**Files:** Create `lib/media/storage.mjs`, Test `tests/unit/media-storage.test.mjs`

**Produces:** `downloadMediaFile(url, targetPath)`, `slugifyPrompt(prompt, maxLength)`, `generateSemanticFilename(prompt, ext, providerPrefix, explicitFilename)`, `ensureOutputDir(type, baseDir)`, `formatDateYYYYMMDDHHmmss(date)`.

- [ ] **Step 1: Write failing tests** - slugifyPrompt (lowercase, non-word replace, Chinese preserved, empty returns "media", max length), generateSemanticFilename (provider prefix + timestamp, explicit override), ensureOutputDir (creates images/videos/audios).
- [ ] **Step 2: Run tests to verify they fail**
- [ ] **Step 3: Implement storage.mjs** - downloadMediaFile (fetch + curl fallback), slugifyPrompt, formatDateYYYYMMDDHHmmss, generateSemanticFilename, ensureOutputDir. See spec Part 2.
- [ ] **Step 4: Run tests to verify they pass**
- [ ] **Step 5: Commit** - `git commit -m "feat(media): add storage module for download, filename, slugify"`

## Task 4: Media history module

**Files:** Create `lib/media/history.mjs`, Test `tests/unit/media-history.test.mjs`

**Produces:** `loadHistory(dataDir)`, `addHistoryEntry(dataDir, entry)`, `deleteHistoryEntry(dataDir, id)`, `listHistory(dataDir, mediaType)`.

- [ ] **Step 1: Write failing tests** - load returns empty for missing file, add persists with id, list filters by media_type, delete removes, prune at 200.
- [ ] **Step 2: Run tests to verify they fail**
- [ ] **Step 3: Implement history.mjs** - atomic write (temp+rename, 0o600), 200-entry cap, crypto.randomUUID. See spec Part 2.
- [ ] **Step 4: Run tests to verify they pass**
- [ ] **Step 5: Commit** - `git commit -m "feat(media): add history module with 200-entry cap and atomic writes"`

## Task 5: Media provider registry + Grok adapter

**Files:** Create `lib/media/providers/registry.mjs`, `grok.mjs`, `codex.mjs` (stub), `antigravity.mjs` (stub), `huoshan.mjs` (stub), `lib/media/index.mjs`, Test `tests/unit/media-registry.test.mjs`

**Produces:** `MEDIA_PROVIDERS` map, `getMediaProvider(providerId)`, `listMediaProviderIds()`, `selectMediaEndpointForRequest(endpoints, purpose, endpointId)`.

- [ ] **Step 1: Write failing tests** - listMediaProviderIds returns all four, getMediaProvider returns adapter with correct id, null for unknown.
- [ ] **Step 2: Run tests to verify they fail**
- [ ] **Step 3: Implement registry.mjs** - import four adapters, expose map + functions. Follow web-search registry pattern. Create index.mjs re-exports.
- [ ] **Step 4: Implement grok.mjs** - grokAdapter with generateImage, createVideoTask, pollVideoTask. Auth reads ~/.grok/auth.json. See spec Part 2.
- [ ] **Step 5: Create stub adapters** - codex/antigravity/huoshan export { id } only.
- [ ] **Step 6: Run tests to verify they pass**
- [ ] **Step 7: Commit** - `git commit -m "feat(media): add provider registry with grok adapter + stubs"`

## Task 6: Codex adapter

**Files:** Modify `lib/media/providers/codex.mjs`

- [ ] **Step 1: Implement codex.mjs** - POST to chatgpt.com/backend-api/codex/images/generations with Bearer token + OpenAI-Beta header. Returns { b64Json, revisedPrompt }. See spec Part 2.
- [ ] **Step 2: Run check + registry tests**
- [ ] **Step 3: Commit** - `git commit -m "feat(media): implement codex image adapter"`

## Task 7: Antigravity adapter

**Files:** Modify `lib/media/providers/antigravity.mjs`

- [ ] **Step 1: Implement antigravity.mjs** - POST streamGenerateContent with gemini-3.1-flash-image, parse SSE for inline_data.data. See spec Part 2.
- [ ] **Step 2: Run check + registry tests**
- [ ] **Step 3: Commit** - `git commit -m "feat(media): implement antigravity image adapter"`

## Task 8: Huoshan adapter

**Files:** Modify `lib/media/providers/huoshan.mjs`

- [ ] **Step 1: Implement huoshan.mjs** - Seedream image, Seedance video (async), Seed TTS (openspeech host + X-Api-Resource-Id). See spec Part 2.
- [ ] **Step 2: Run check + all media tests**
- [ ] **Step 3: Commit** - `git commit -m "feat(media): implement huoshan adapter for image, video, and TTS"`

## Task 9: Gateway media HTTP routes

**Files:** Modify `server.js`, Test `tests/integration/media-routes.test.mjs`

- [ ] **Step 1: Create integration test scaffolding** - skipped tests for each route + basic 404 test.
- [ ] **Step 2: Add media imports to server.js** - selectMediaEndpointForRequest, getMediaProvider, storage + history functions.
- [ ] **Step 3: Add resolveMediaApiKey helper** - dispatches by provider: grok reads ~/.grok/auth.json, codex reuses getOfficialCodexAuth, antigravity uses token-store loadSecrets, huoshan uses getEndpointApiKey.
- [ ] **Step 4: Add 6 route handlers** - POST /v1/media/image (sync), POST /v1/media/video (async), GET /v1/media/tasks/:id (poll), POST /v1/media/tts (sync), GET /v1/media/history, DELETE /v1/media/history/:id.
- [ ] **Step 5: Run check** - `npm run check`
- [ ] **Step 6: Run all unit tests**
- [ ] **Step 7: Commit** - `git commit -m "feat(media): add /v1/media/* routes for image, video, TTS, history"`

## Task 10: Config panel - add-node dropdown for media endpoints

**Files:** Modify `desktop/config-panel.html`

- [ ] **Step 1: Add media node types to add-node dropdown** - three buttons: 图片生成节点, 视频生成节点, TTS 节点.
- [ ] **Step 2: Add addMediaEndpoint JS function** - creates endpoint with provider "grok-subscription", models [], is_default false.
- [ ] **Step 3: Add media endpoint form rendering** - provider select with four options; subscription providers show read-only base_url + hide API Key; huoshan shows editable base_url + API Key.
- [ ] **Step 4: Run check + commit** - `git commit -m "feat(ui): add media endpoint types to add-node dropdown"`

## Task 11: Config panel - image generation mini-tool

**Files:** Modify `desktop/config-panel.html`

- [ ] **Step 1: Add image-gen card to renderToolsCards**
- [ ] **Step 2: Add imageGenState + openTool dispatch** - state { client, endpointId, model, prompt, aspectRatio, imagePaths, result, loading, error }
- [ ] **Step 3: Implement renderImageGenDetail** - node/model selectors via getMediaEndpoints(client, 'image_generation'), prompt textarea, aspect ratio select, reference image input, generate button, result panel (inline preview + copy path), history panel.
- [ ] **Step 4: Implement generate function** - POST /v1/media/image with X-Gateway-Client header.
- [ ] **Step 5: Add prompt suggestions** - 8 use-case quick tags, structure template (主体/风格/构图/光影/约束), standing tips.
- [ ] **Step 6: Run check + commit** - `git commit -m "feat(ui): add image generation mini-tool with prompt suggestions"`

## Task 12: Config panel - video generation mini-tool

**Files:** Modify `desktop/config-panel.html`

- [ ] **Step 1: Add video-gen card + state + dispatch** - state includes duration, taskId, pollStatus.
- [ ] **Step 2: Implement renderVideoGenDetail** - node selector, prompt, aspect ratio, duration, reference images, shot-sequence prompt template from Seedance guide.
- [ ] **Step 3: Implement generate + polling** - POST /v1/media/video returns task_id, poll GET /v1/media/tasks/:id every 4s with progress bar, on success show video player.
- [ ] **Step 4: Run check + commit** - `git commit -m "feat(ui): add video generation mini-tool with async polling"`

## Task 13: Config panel - TTS mini-tool

**Files:** Modify `desktop/config-panel.html`

- [ ] **Step 1: Add tts-gen card + state + dispatch** - state includes text, voice, encoding, speedRatio.
- [ ] **Step 2: Implement renderTtsGenDetail** - node selector, text textarea, voice select (huoshan only), encoding select, speed ratio range, voice description reference, generate button, audio player result.
- [ ] **Step 3: Implement generate function** - POST /v1/media/tts.
- [ ] **Step 4: Run check + commit** - `git commit -m "feat(ui): add TTS mini-tool with voice and speed controls"`

## Task 14: leo-codex-imagine skill

**Files:** Create `lib/skills/leo-codex-imagine/SKILL.md`, `scripts/leo_codex_imagine.mjs`, Test `tests/unit/leo-codex-imagine-skill.test.mjs`

- [ ] **Step 1: Write skill test** - SKILL.md exists with name leo-codex-imagine and references /v1/media/image; script exists as valid ESM.
- [ ] **Step 2: Create SKILL.md** - follow leo-grok-imagine format. Triggers: "用 Codex 画一张图". Script calls gateway POST /v1/media/image, no credentials.
- [ ] **Step 3: Create the script** - parse CLI args (--prompt, --image/--images, --aspect-ratio, --size, --quality, --output-dir, --filename, --dry-run, --endpoint-id), read reference images as base64, call gateway, write to ./images/codex_<slug>_<timestamp>.png, output markdown.
- [ ] **Step 4: Run tests + commit** - `git commit -m "feat(skills): add leo-codex-imagine thin-client skill"`

## Task 15: leo-antigravity-imagine skill

**Files:** Create `lib/skills/leo-antigravity-imagine/SKILL.md`, `scripts/leo_antigravity_imagine.mjs`, Test `tests/unit/leo-antigravity-imagine-skill.test.mjs`

- [ ] **Step 1: Write skill test** - same pattern as Task 14.
- [ ] **Step 2: Create SKILL.md** - triggers: "用 Antigravity 生成图片". Script calls gateway POST /v1/media/image with endpoint_id.
- [ ] **Step 3: Create the script** - CLI args (--prompt, --images max 3, --image-name, --aspect-ratio, --output-dir, --filename, --dry-run, --endpoint-id). Output: ./images/antigravity_<slug>_<timestamp>.png.
- [ ] **Step 4: Run tests + commit** - `git commit -m "feat(skills): add leo-antigravity-imagine thin-client skill"`

## Task 16: Full test suite + manual integration test

- [ ] **Step 1: Run full test suite** - `npm run check && npm run test:codex:unit && node --test tests/unit/media-*.test.mjs tests/unit/gateway-config-store.test.mjs`
- [ ] **Step 2: Manual integration test on port 8788** - start gateway, test each route with curl: POST /v1/media/image, POST /v1/media/video + poll, POST /v1/media/tts, GET /v1/media/history, DELETE /v1/media/history/:id.
- [ ] **Step 3: Final commit** - `git commit -m "test(media): verify full media layer integration on port 8788"`
