/**
 * Video Knowledge Base module.
 * Uses the project's CSS variable system and component classes.
 * All custom styling lives in panel.css under the "Video KB Module" section.
 */

interface WhisperTool {
  id: string;
  name: string;
  command: string;
  path: string;
  version: string;
  hint: string;
  install: string;
}

interface WhisperModel {
  id: string;
  name: string;
  sizeMB: number;
  speedHint: string;
  guide: string;
}

interface EmbeddingEndpoint {
  id: string;
  name: string;
  base_url: string;
  embedding_model?: string;
  models?: string[];
  dimensions?: number | null;
  purpose?: string;
  enabled?: boolean;
}

// Access the global config + helpers exposed by app.ts
function getGatewayConfig(): any { return (window as any).__gatewayConfig?.() || { clients: {} }; }
function getEmbeddingEndpoints(client: string): EmbeddingEndpoint[] {
  const fn = (window as any).__getEmbeddingEndpoints;
  return fn ? fn(client) : [];
}
function clientDisplayName(client: string): string {
  const fn = (window as any).__clientDisplayName;
  return fn ? fn(client) : client;
}
function getEmbeddingClients(): string[] {
  const config = getGatewayConfig();
  return Object.keys(config.clients || {}).filter(
    (c: string) => getEmbeddingEndpoints(c).length > 0
  );
}

interface TaskStep {
  id: string;
  label: string;
  status: "pending" | "running" | "done" | "failed";
  progress: number;
  message: string;
}

interface TaskInfo {
  id: string;
  type: string;
  status: string;
  progress: number;
  progress_message: string;
  steps: TaskStep[];
  current_step: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: number;
}

interface SearchResult {
  chunk_id: string;
  video_id: string;
  video_url: string;
  video_title: string;
  start_seconds: number;
  end_seconds: number;
  text: string;
  segment_ids: string[];
  score: number;
}

interface VideoInfo {
  video_id: string;
  video_url: string;
  video_title: string;
  chunk_count: number;
  duration_start: number;
  duration_end: number;
  language: string;
  created_at: number;
}

interface BrowserInfo {
  id: string;
  name: string;
  cookieDbPath: string;
}

const videoKbState = {
  whisperTools: [] as WhisperTool[],
  whisperModels: [] as WhisperModel[],
  embClient: "" as string,
  embEndpointId: "" as string,
  embModel: "" as string,
  searchEmbClient: "" as string,
  searchEmbEndpointId: "" as string,
  currentTaskId: null as string | null,
  taskPollTimer: null as ReturnType<typeof setTimeout> | null,
  browsers: [] as BrowserInfo[],
};

function esc(str: string): string {
  const d = document.createElement("div");
  d.textContent = String(str || "");
  return d.innerHTML;
}

async function apiGet<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (res.ok) return await res.json();
  } catch { /* ignore */ }
  return null;
}

async function apiPost<T>(url: string, body: Record<string, unknown>): Promise<T | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch { /* ignore */ }
  return null;
}

function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function renderVideoKbDetail(): void {
  const cards = document.getElementById("tools-cards");
  const detail = document.getElementById("tools-detail");
  if (!cards || !detail) return;
  cards.style.display = "none";

  detail.innerHTML = `
    <button class="tools-detail-back" onclick="window.backToToolsCards()">← 返回工具列表</button>
    <div class="video-kb-container">
      <div class="video-kb-tabs">
        <button class="video-kb-tab active" data-tab="import" onclick="window.videoKbSwitchTab('import')">导入</button>
        <button class="video-kb-tab" data-tab="search" onclick="window.videoKbSwitchTab('search')">检索</button>
        <button class="video-kb-tab" data-tab="assets" onclick="window.videoKbSwitchTab('assets')">素材管理</button>
        <button class="video-kb-tab" data-tab="cookie" onclick="window.videoKbSwitchTab('cookie')">Cookie 工具</button>
      </div>
      <div id="video-kb-panel-import" class="video-kb-panel">${importPanelHTML()}</div>
      <div id="video-kb-panel-search" class="video-kb-panel" style="display:none">${searchPanelHTML()}</div>
      <div id="video-kb-panel-assets" class="video-kb-panel" style="display:none">
        <div class="video-kb-empty">加载中...</div>
      </div>
      <div id="video-kb-panel-cookie" class="video-kb-panel" style="display:none">${cookiePanelHTML()}</div>
    </div>
  `;

  loadToolsData();
  loadBrowsers();
}

function importPanelHTML(): string {
  return `
    <div class="video-kb-card">
      <div class="video-kb-card-title">导入视频</div>
      <div class="form-group full" style="margin-bottom:16px">
        <label>视频 URL</label>
        <input type="text" id="vk-url" placeholder="https://www.youtube.com/watch?v=...">
      </div>
      <div class="form-group" style="margin-bottom:16px">
        <label>Cookie 文件</label>
        <select id="vk-cookie">
          <option value="">不需要 Cookie</option>
        </select>
      </div>
    </div>

    <div class="video-kb-card">
      <div class="video-kb-card-title">Whisper 转录</div>
      <div class="video-kb-form-grid">
        <div class="form-group">
          <label>Whisper 工具</label>
          <select id="vk-whisper-tool">
            <option value="">加载中...</option>
          </select>
          <div id="vk-whisper-hint" class="video-kb-status"></div>
        </div>
        <div class="form-group">
          <label>模型大小</label>
          <select id="vk-whisper-model">
            <option value="">加载中...</option>
          </select>
          <div id="vk-model-guide" class="video-kb-status"></div>
        </div>
        <div class="form-group">
          <label>语言</label>
          <select id="vk-language">
            <option value="auto">自动检测</option>
            <option value="zh">中文</option>
            <option value="en">English</option>
            <option value="ja">日本語</option>
            <option value="ko">한국어</option>
          </select>
        </div>
      </div>
    </div>

    <div class="video-kb-card">
      <div class="video-kb-card-title">向量化</div>
      <div class="video-kb-form-grid">
        <div class="form-group">
          <label>Client</label>
          <select id="vk-emb-client" onchange="window.videoKbOnEmbClientChange()">
            <option value="">加载中...</option>
          </select>
        </div>
        <div class="form-group">
          <label>Embedding 节点</label>
          <select id="vk-emb-endpoint" onchange="window.videoKbOnEmbEndpointChange()">
            <option value="">无可用节点</option>
          </select>
        </div>
        <div class="form-group">
          <label>模型</label>
          <select id="vk-emb-model">
            <option value="">无</option>
          </select>
        </div>
        <div class="form-group">
          <label>分块策略</label>
          <select id="vk-chunk-strategy">
            <option value="time-window">时间窗口（快）</option>
            <option value="semantic">语义切分（高质量）</option>
          </select>
        </div>
      </div>
    </div>

    <div class="video-kb-card">
      <div class="video-kb-card-title">素材保留</div>
      <div class="video-kb-form-grid">
        <div class="form-group">
          <label>保留视频素材</label>
          <select id="vk-keep-video">
            <option value="true">保留视频和音频</option>
            <option value="false">仅保留音频</option>
          </select>
        </div>
      </div>
      <div class="video-kb-actions">
        <button class="btn btn-primary" id="vk-ingest-btn" onclick="window.videoKbIngest()">开始导入</button>
        <span id="vk-ytdlp-status" class="video-kb-status"></span>
      </div>
    </div>

    <div id="vk-task-progress" style="display:none">
      <div class="video-kb-card">
        <div class="video-kb-card-title">任务进度</div>
        <div id="vk-steps-list" class="video-kb-steps"></div>
        <div class="video-kb-progress-track">
          <div id="vk-progress-fill" class="video-kb-progress-fill" style="width:0%"></div>
        </div>
        <div id="vk-progress-label" class="video-kb-progress-label"></div>
      </div>
    </div>
  `;
}

function searchPanelHTML(): string {
  return `
    <div class="video-kb-card">
      <div class="video-kb-card-title">语义检索</div>
      <div class="form-group full" style="margin-bottom:16px">
        <label>搜索内容</label>
        <input type="text" id="vk-search-query" placeholder="输入要检索的内容..." onkeydown="if(event.key==='Enter')window.videoKbSearch()">
      </div>
      <div class="video-kb-form-grid">
        <div class="form-group">
          <label>Client</label>
          <select id="vk-search-emb-client" onchange="window.videoKbOnSearchEmbClientChange()">
            <option value="">加载中...</option>
          </select>
        </div>
        <div class="form-group">
          <label>Embedding 节点</label>
          <select id="vk-search-emb-endpoint">
            <option value="">无可用节点</option>
          </select>
        </div>
        <div class="form-group">
          <label>返回数量 (Top K)</label>
          <input type="number" id="vk-search-topk" value="5" min="1" max="50">
        </div>
      </div>
      <div class="video-kb-actions">
        <button class="btn btn-primary" onclick="window.videoKbSearch()">搜索</button>
      </div>
    </div>
    <div id="vk-search-results"></div>
  `;
}

function cookiePanelHTML(): string {
  return `
    <div class="video-kb-card">
      <div class="video-kb-card-title">Cookie 导出工具</div>
      <div id="vk-cookie-extension-section" style="margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid var(--border-color)">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px">通过浏览器插件导出（推荐，Chrome 开启时可用）</div>
        <div class="form-group" style="margin-bottom:8px">
          <label>域名</label>
          <input type="text" id="vk-ext-cookie-domain" placeholder="如 bilibili.com">
        </div>
        <div class="video-kb-actions">
          <button class="btn btn-primary" onclick="window.videoKbExportViaExtension()">用浏览器插件导出</button>
        </div>
        <div id="vk-ext-cookie-result"></div>
      </div>
      <div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--text-secondary)">本地文件导出（备用，需关闭浏览器）</div>
      <div class="form-group" style="margin-bottom:16px">
        <label>选择浏览器</label>
        <select id="vk-cookie-browser" onchange="window.videoKbLoadDomains()">
          <option value="">加载中...</option>
        </select>
      </div>
      <div class="form-group" style="margin-bottom:16px">
        <label>域名筛选（可选，留空导出全部）</label>
        <input type="text" id="vk-cookie-domain" placeholder="如 youtube.com">
      </div>
      <div class="video-kb-actions">
        <button class="btn btn-secondary" onclick="window.videoKbExportCookies()">导出 cookies.txt</button>
      </div>
    </div>
    <div id="vk-cookie-result"></div>
  `;
}

// --- Data loading ---

async function loadToolsData(): Promise<void> {
  const whisperData = await apiGet<{ tools: WhisperTool[] }>("/v1/video-kb/tools/whisper");
  if (whisperData) {
    videoKbState.whisperTools = whisperData.tools;
    const sel = document.getElementById("vk-whisper-tool") as HTMLSelectElement | null;
    if (sel) {
      sel.innerHTML = whisperData.tools.length === 0
        ? `<option value="">未检测到 Whisper 工具</option>`
        : whisperData.tools.map((t, i) =>
            `<option value="${t.id}" ${i === 0 ? "selected" : ""}>${esc(t.name)} - ${esc(t.hint)}</option>`
          ).join("");
      updateWhisperHint();
    }
  }

  const modelData = await apiGet<{ models: WhisperModel[] }>("/v1/video-kb/tools/whisper/models");
  if (modelData) {
    videoKbState.whisperModels = modelData.models;
    const sel = document.getElementById("vk-whisper-model") as HTMLSelectElement | null;
    if (sel) {
      sel.innerHTML = modelData.models.map((m) =>
        `<option value="${m.id}">${esc(m.name)} (${m.sizeMB}MB, ${esc(m.speedHint)})</option>`
      ).join("");
      sel.value = "small";
      updateModelGuide();
    }
  }

  // Initialize embedding cascade from gateway config
  initEmbeddingCascade();

  const ytdlpData = await apiGet<{ yt_dlp: { version: string } | null; ffmpeg: { path: string } | null; install_hint: { commands: string[] } }>("/v1/video-kb/tools/yt-dlp");
  if (ytdlpData) {
    const status = document.getElementById("vk-ytdlp-status");
    if (status) {
      if (ytdlpData.yt_dlp) {
        status.textContent = `yt-dlp ${ytdlpData.yt_dlp.version}${ytdlpData.ffmpeg ? " + ffmpeg" : " (缺 ffmpeg)"}`;
        status.className = "video-kb-status " + (ytdlpData.ffmpeg ? "ok" : "warn");
      } else {
        status.innerHTML = `未安装: <code>${esc(ytdlpData.install_hint?.commands?.[0] || "pip install yt-dlp")}</code>`;
        status.className = "video-kb-status err";
      }
    }
  }
}

function initEmbeddingCascade(): void {
  const clients = getEmbeddingClients();
  const clientOpts = clients.length === 0
    ? `<option value="">无可用 Client</option>`
    : clients.map((c) => `<option value="${c}">${esc(clientDisplayName(c))}</option>`).join("");

  // Import panel
  const importClientSel = document.getElementById("vk-emb-client") as HTMLSelectElement | null;
  if (importClientSel) {
    importClientSel.innerHTML = clientOpts;
    if (clients.length > 0 && !videoKbState.embClient) {
      videoKbState.embClient = clients[0];
      importClientSel.value = clients[0];
    } else if (videoKbState.embClient) {
      importClientSel.value = videoKbState.embClient;
    }
    refreshEmbeddingEndpoints(videoKbState.embClient, "vk-emb-endpoint", "vk-emb-model", true);
  }

  // Search panel
  const searchClientSel = document.getElementById("vk-search-emb-client") as HTMLSelectElement | null;
  if (searchClientSel) {
    searchClientSel.innerHTML = clientOpts;
    if (clients.length > 0 && !videoKbState.searchEmbClient) {
      videoKbState.searchEmbClient = clients[0];
      searchClientSel.value = clients[0];
    } else if (videoKbState.searchEmbClient) {
      searchClientSel.value = videoKbState.searchEmbClient;
    }
    refreshEmbeddingEndpoints(videoKbState.searchEmbClient, "vk-search-emb-endpoint", null, false);
  }
}

function refreshEmbeddingEndpoints(
  client: string,
  endpointSelId: string,
  modelSelId: string | null,
  isImport: boolean
): void {
  const eps = getEmbeddingEndpoints(client);
  const sel = document.getElementById(endpointSelId) as HTMLSelectElement | null;
  if (!sel) return;

  if (eps.length === 0) {
    sel.innerHTML = `<option value="">无可用节点</option>`;
    sel.disabled = true;
  } else {
    sel.disabled = false;
    sel.innerHTML = eps.map((ep, i) => {
      const dim = ep.dimensions != null ? `${ep.dimensions}维` : "默认";
      const model = ep.embedding_model || (ep.models?.[0] || "未设置");
      return `<option value="${ep.id}" ${i === 0 ? "selected" : ""}>${esc(ep.name)} - ${esc(model)} - ${dim}</option>`;
    }).join("");
  }

  // Auto-select first endpoint
  if (eps.length > 0) {
    if (isImport) {
      videoKbState.embEndpointId = eps[0].id;
    } else {
      videoKbState.searchEmbEndpointId = eps[0].id;
    }
    refreshEmbeddingModels(eps[0], modelSelId, isImport);
  } else if (modelSelId) {
    const modelSel = document.getElementById(modelSelId) as HTMLSelectElement | null;
    if (modelSel) {
      modelSel.innerHTML = `<option value="">无</option>`;
      modelSel.disabled = true;
    }
  }
}

function refreshEmbeddingModels(
  ep: EmbeddingEndpoint | null,
  modelSelId: string | null,
  isImport: boolean
): void {
  if (!modelSelId) return;
  const modelSel = document.getElementById(modelSelId) as HTMLSelectElement | null;
  if (!modelSel) return;
  const models = ep?.models || [];
  if (models.length === 0) {
    const fallbackModel = ep?.embedding_model || "";
    modelSel.innerHTML = fallbackModel
      ? `<option value="${esc(fallbackModel)}" selected>${esc(fallbackModel)}</option>`
      : `<option value="">无</option>`;
    modelSel.disabled = !fallbackModel;
    if (isImport) videoKbState.embModel = fallbackModel;
  } else {
    modelSel.disabled = false;
    modelSel.innerHTML = models.map((m, i) =>
      `<option value="${esc(m)}" ${i === 0 ? 'selected' : ''}>${esc(m)}</option>`
    ).join("");
    if (isImport) videoKbState.embModel = models[0];
  }
}

(window as any).videoKbOnEmbClientChange = function (): void {
  const sel = document.getElementById("vk-emb-client") as HTMLSelectElement | null;
  if (!sel) return;
  videoKbState.embClient = sel.value;
  videoKbState.embEndpointId = "";
  videoKbState.embModel = "";
  refreshEmbeddingEndpoints(sel.value, "vk-emb-endpoint", "vk-emb-model", true);
};

(window as any).videoKbOnEmbEndpointChange = function (): void {
  const sel = document.getElementById("vk-emb-endpoint") as HTMLSelectElement | null;
  if (!sel) return;
  videoKbState.embEndpointId = sel.value;
  const eps = getEmbeddingEndpoints(videoKbState.embClient);
  const ep = eps.find((e) => e.id === sel.value) || null;
  refreshEmbeddingModels(ep, "vk-emb-model", true);
};

(window as any).videoKbOnSearchEmbClientChange = function (): void {
  const sel = document.getElementById("vk-search-emb-client") as HTMLSelectElement | null;
  if (!sel) return;
  videoKbState.searchEmbClient = sel.value;
  videoKbState.searchEmbEndpointId = "";
  refreshEmbeddingEndpoints(sel.value, "vk-search-emb-endpoint", null, false);
};

async function loadBrowsers(): Promise<void> {
  const data = await apiGet<{ browsers: BrowserInfo[] }>("/v1/cookies/browsers");
  if (data) {
    videoKbState.browsers = data.browsers;
    const sel = document.getElementById("vk-cookie-browser") as HTMLSelectElement | null;
    if (sel) {
      sel.innerHTML = data.browsers.length === 0
        ? `<option value="">未检测到浏览器</option>`
        : data.browsers.map((b, i) =>
            `<option value="${b.id}" ${i === 0 ? "selected" : ""}>${esc(b.name)}</option>`
          ).join("");
    }
  }
}

function updateWhisperHint(): void {
  const sel = document.getElementById("vk-whisper-tool") as HTMLSelectElement | null;
  const hint = document.getElementById("vk-whisper-hint");
  if (!sel || !hint) return;
  const tool = videoKbState.whisperTools.find((t) => t.id === sel.value);
  if (tool) {
    hint.textContent = tool.hint;
  } else if (videoKbState.whisperTools.length === 0) {
    hint.innerHTML = `安装: <code>uv tool install mlx-whisper</code> 或 <code>uv tool install whisper-ctranslate2</code>`;
  }
}

function updateModelGuide(): void {
  const sel = document.getElementById("vk-whisper-model") as HTMLSelectElement | null;
  const guide = document.getElementById("vk-model-guide");
  if (!sel || !guide) return;
  const model = videoKbState.whisperModels.find((m) => m.id === sel.value);
  if (model) guide.textContent = model.guide;
}

// --- Actions ---

(window as any).videoKbIngest = async function (): Promise<void> {
  const url = (document.getElementById("vk-url") as HTMLInputElement)?.value?.trim();
  if (!url) { alert("请输入视频 URL"); return; }

  const cookieFile = (document.getElementById("vk-cookie") as HTMLSelectElement)?.value;
  const embeddingEndpointId = (document.getElementById("vk-emb-endpoint") as HTMLSelectElement)?.value;
  const whisperTool = (document.getElementById("vk-whisper-tool") as HTMLSelectElement)?.value;
  const whisperModel = (document.getElementById("vk-whisper-model") as HTMLSelectElement)?.value;
  const language = (document.getElementById("vk-language") as HTMLSelectElement)?.value;
  const chunkStrategy = (document.getElementById("vk-chunk-strategy") as HTMLSelectElement)?.value;
  const keepVideo = (document.getElementById("vk-keep-video") as HTMLSelectElement)?.value === "true";

  if (!whisperTool) { alert("请先安装 Whisper 工具"); return; }
  if (!embeddingEndpointId) { alert("请配置 Embedding 节点"); return; }

  const result = await apiPost<{ task_id: string }>("/v1/video-kb/ingest", {
    url, cookie_file: cookieFile || null, whisper_tool: whisperTool,
    whisper_model: whisperModel, language, embedding_endpoint_id: embeddingEndpointId,
    chunk_strategy: chunkStrategy, keep_video: keepVideo,
  });

  if (result?.task_id) {
    videoKbState.currentTaskId = result.task_id;
    document.getElementById("vk-task-progress")!.style.display = "block";
    pollTaskProgress();
  } else {
    alert("提交失败");
  }
};

async function pollTaskProgress(): Promise<void> {
  if (!videoKbState.currentTaskId) return;
  const task = await apiGet<TaskInfo>(`/v1/tasks/${videoKbState.currentTaskId}`);
  if (!task) return;

  renderTaskSteps(task);

  if (["succeeded", "failed", "cancelled"].includes(task.status)) {
    renderTaskComplete(task);
    return;
  }
  videoKbState.taskPollTimer = setTimeout(() => pollTaskProgress(), 1000);
}

function renderTaskSteps(task: TaskInfo): void {
  const container = document.getElementById("vk-steps-list");
  if (container) {
    const icons: Record<string, string> = { pending: "○", running: "◉", done: "✓", failed: "✗" };
    container.innerHTML = (task.steps || []).map((step) => `
      <div class="video-kb-step ${step.status}">
        <span class="video-kb-step-icon">${icons[step.status] || "○"}</span>
        <span class="video-kb-step-label">${esc(step.label)}</span>
        ${step.status === "running" && step.message ? `<span class="video-kb-step-msg">${esc(step.message)}</span>` : ""}
        ${step.status === "running" && step.progress > 0 ? `<span class="video-kb-step-pct">${(step.progress * 100).toFixed(0)}%</span>` : ""}
      </div>
    `).join("");
  }

  const fill = document.getElementById("vk-progress-fill");
  const label = document.getElementById("vk-progress-label");
  const pct = (task.progress * 100).toFixed(1);
  if (fill) fill.style.width = `${pct}%`;
  if (label) label.textContent = `${pct}% - ${esc(task.progress_message || "")}`;
}

function renderTaskComplete(task: TaskInfo): void {
  const label = document.getElementById("vk-progress-label");
  if (label) {
    if (task.status === "succeeded" && task.result) {
      const r = task.result as Record<string, string | number | null>;
      label.innerHTML = `<span class="video-kb-banner ok">导入完成: ${esc(String(r.title || ""))} | ${r.chunk_count} 个分块 | 语言: ${esc(String(r.detected_language || ""))}</span>`;
    } else if (task.status === "failed") {
      label.innerHTML = `<span class="video-kb-banner err">失败: ${esc(task.error || "")}</span>`;
    } else {
      label.innerHTML = `<span class="video-kb-status">已取消</span>`;
    }
  }
}

(window as any).videoKbSearch = async function (): Promise<void> {
  const query = (document.getElementById("vk-search-query") as HTMLInputElement)?.value?.trim();
  if (!query) return;

  const embeddingEndpointId = (document.getElementById("vk-search-emb-endpoint") as HTMLSelectElement)?.value;
  const topK = parseInt((document.getElementById("vk-search-topk") as HTMLInputElement)?.value || "5");

  const resultsDiv = document.getElementById("vk-search-results");
  if (resultsDiv) resultsDiv.innerHTML = `<div class="video-kb-empty">搜索中...</div>`;

  const result = await apiPost<{ results: SearchResult[] }>("/v1/video-kb/search", {
    query, embedding_endpoint_id: embeddingEndpointId, top_k: topK,
  });

  if (!result || !result.results) {
    if (resultsDiv) resultsDiv.innerHTML = `<div class="video-kb-empty">搜索失败</div>`;
    return;
  }
  if (result.results.length === 0) {
    if (resultsDiv) resultsDiv.innerHTML = `<div class="video-kb-empty">无结果</div>`;
    return;
  }

  if (resultsDiv) {
    resultsDiv.innerHTML = `<div class="video-kb-result">` + result.results.map((r) => `
      <div class="video-kb-result-card">
        <div class="video-kb-result-header">
          <span class="video-kb-result-title">${esc(r.video_title)}</span>
          <span class="video-kb-result-score">相似度 ${(r.score * 100).toFixed(1)}%</span>
        </div>
        <div class="video-kb-result-meta">${fmtTime(r.start_seconds)} - ${fmtTime(r.end_seconds)}</div>
        <div class="video-kb-result-text">${esc(r.text)}</div>
      </div>
    `).join("") + `</div>`;
  }
};

(window as any).videoKbSwitchTab = function (tab: string): void {
  document.querySelectorAll(".video-kb-tab").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll(".video-kb-panel").forEach((el) => (el as HTMLElement).style.display = "none");
  const tabBtn = document.querySelector(`.video-kb-tab[data-tab="${tab}"]`);
  const panel = document.getElementById(`video-kb-panel-${tab}`);
  if (tabBtn) tabBtn.classList.add("active");
  if (panel) panel.style.display = "flex";
  if (tab === "assets") loadVideoList();
};

async function loadVideoList(): Promise<void> {
  const panel = document.getElementById("video-kb-panel-assets");
  if (!panel) return;
  panel.innerHTML = `<div class="video-kb-empty">加载中...</div>`;

  const data = await apiGet<{ videos: VideoInfo[] }>("/v1/video-kb/videos");
  if (!data) return;

  if (data.videos.length === 0) {
    panel.innerHTML = `<div class="video-kb-empty">暂无已索引视频</div>`;
    return;
  }

  panel.innerHTML = data.videos.map((v) => `
    <div class="video-kb-asset-row">
      <div class="video-kb-asset-info">
        <div class="video-kb-asset-title">${esc(v.video_title)}</div>
        <div class="video-kb-asset-meta">
          ${v.chunk_count} 分块 | ${fmtTime(v.duration_start)}-${fmtTime(v.duration_end)} | ${esc(v.language)} | ${new Date(v.created_at).toLocaleDateString()}<br>
          <a href="${esc(v.video_url)}" target="_blank">${esc(v.video_url)}</a>
        </div>
      </div>
      <div class="video-kb-asset-actions">
        <button class="btn btn-sm" onclick="window.videoKbViewAsset('${v.video_id}','transcript')">转录</button>
        <button class="btn btn-sm" onclick="window.videoKbViewAsset('${v.video_id}','audio')">音频</button>
        <button class="btn btn-sm" onclick="window.videoKbViewAsset('${v.video_id}','video')">视频</button>
        <button class="btn btn-sm btn-danger" onclick="window.videoKbDeleteVideo('${v.video_id}')">删除</button>
      </div>
    </div>
  `).join("");
}

(window as any).videoKbViewAsset = function (videoId: string, type: string): void {
  window.open(`/v1/video-kb/assets/${videoId}/${type}`, "_blank");
};

(window as any).videoKbDeleteVideo = async function (videoId: string): Promise<void> {
  if (!confirm("确认删除该视频及其所有向量数据?")) return;
  await fetch(`/v1/video-kb/videos/${videoId}`, { method: "DELETE" });
  loadVideoList();
};

(window as any).videoKbLoadDomains = function (): void { /* free-text domain input, no preload needed */ };

(window as any).videoKbExportViaExtension = async function (): Promise<void> {
    const domain = (document.getElementById("vk-ext-cookie-domain") as HTMLInputElement)?.value?.trim();
    const resultDiv = document.getElementById("vk-ext-cookie-result");
    if (!domain) {
        if (resultDiv) resultDiv.innerHTML = '<div class="video-kb-banner err">请输入域名</div>';
        return;
    }
    if (resultDiv) resultDiv.innerHTML = '<div class="video-kb-banner info">正在通过浏览器插件获取 cookie...</div>';
    try {
        const listResp = await fetch("/v1/extensions/list");
        const listData = await listResp.json();
        const ext = (listData.extensions || []).find((e: any) => e.online && (e.capabilities || []).includes("cookies"));
        if (!ext) {
            if (resultDiv) resultDiv.innerHTML = '<div class="video-kb-banner err">未找到在线的浏览器插件。请先安装「Leo cookie.txt Locally」扩展，详见「浏览器插件」面板。</div>';
            return;
        }
        if (typeof (window as any).chrome === "undefined" || !(window as any).chrome?.runtime?.sendMessage) {
            if (resultDiv) resultDiv.innerHTML = '<div class="video-kb-banner err">请使用 Chrome/Edge 打开本页面，并安装 Leo cookie.txt Locally 扩展。</div>';
            return;
        }
        const cookies = await new Promise<any>((resolve, reject) => {
            (window as any).chrome.runtime.sendMessage(ext.id, { action: "getCookies", domain }, (response: any) => {
                if ((window as any).chrome.runtime.lastError || !response) {
                    reject(new Error((window as any).chrome.runtime.lastError?.message || "扩展通信失败"));
                } else if (response.error) {
                    reject(new Error(response.error));
                } else {
                    resolve(response.cookies || []);
                }
            });
        });
        if (cookies.length === 0) {
            if (resultDiv) resultDiv.innerHTML = '<div class="video-kb-banner err">未找到该域名的 cookie</div>';
            return;
        }
        const importResp = await fetch("/v1/cookies/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                domain,
                cookies: cookies.map((c: any) => ({
                    domain: c.domain, path: c.path, name: c.name, value: c.value,
                    secure: c.secure, httponly: c.httpOnly, expires: c.expirationDate || 0,
                })),
            }),
        });
        const result = await importResp.json();
        if (importResp.ok) {
            if (resultDiv) resultDiv.innerHTML = `<div class="video-kb-banner ok">导出成功: ${result.count} 条 cookie<br>文件: <code>${esc(result.file_path)}</code></div>`;
            const cookieSelect = document.getElementById("vk-cookie") as HTMLSelectElement | null;
            if (cookieSelect) {
                cookieSelect.innerHTML = `<option value="">不需要 Cookie</option><option value="${esc(result.file_path)}" selected>cookies.txt (${result.count} 条)</option>`;
            }
        } else {
            if (resultDiv) resultDiv.innerHTML = `<div class="video-kb-banner err">导出失败: ${result.error?.message || "未知错误"}</div>`;
        }
    } catch (e: any) {
        if (resultDiv) resultDiv.innerHTML = `<div class="video-kb-banner err">${esc(e.message || "导出失败")}</div>`;
    }
};

(window as any).videoKbExportCookies = async function (): Promise<void> {
  const browser = (document.getElementById("vk-cookie-browser") as HTMLSelectElement)?.value;
  if (!browser) { alert("请选择浏览器"); return; }
  const domain = (document.getElementById("vk-cookie-domain") as HTMLInputElement)?.value?.trim();

  const result = await apiPost<{ file_path: string; count: number; domains: string[] }>("/v1/cookies/export", {
    browser, domain: domain || undefined,
  });

  const resultDiv = document.getElementById("vk-cookie-result");
  if (resultDiv) {
    if (result?.file_path) {
      resultDiv.innerHTML = `<div class="video-kb-banner ok">导出成功: ${result.count} 条 cookie<br>文件: <code>${esc(result.file_path)}</code><br>域名: ${esc(result.domains.join(", "))}</div>`;
      const cookieSelect = document.getElementById("vk-cookie") as HTMLSelectElement | null;
      if (cookieSelect) {
        cookieSelect.innerHTML = `<option value="">不需要 Cookie</option><option value="${esc(result.file_path)}" selected>cookies.txt (${result.count} 条)</option>`;
      }
    } else {
      resultDiv.innerHTML = `<div class="video-kb-banner err">导出失败</div>`;
    }
  }
};
