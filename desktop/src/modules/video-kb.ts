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

interface ChatEndpoint {
  id: string;
  name: string;
  base_url?: string;
  models?: string[];
  is_default?: boolean;
  enabled?: boolean;
}

function getChatEndpoints(client: string): ChatEndpoint[] {
  const config = getGatewayConfig();
  const eps = (config.clients?.[client]?.endpoints || []) as any[];
  return eps
    .filter((ep) => ep && ep.enabled !== false)
    .filter((ep) => !ep.purpose || ep.purpose === "chat")
    .map((ep) => ({
      id: ep.id,
      name: ep.name || ep.id,
      base_url: ep.base_url || "",
      models: Array.isArray(ep.models) ? ep.models : [],
      is_default: Boolean(ep.is_default),
      enabled: ep.enabled !== false,
    }));
}

function getChatClients(): string[] {
  const config = getGatewayConfig();
  return Object.keys(config.clients || {}).filter((c: string) => getChatEndpoints(c).length > 0);
}

function collectChatModels(endpoints: ChatEndpoint[]): string[] {
  const models: string[] = [];
  const seen = new Set<string>();
  for (const ep of endpoints) {
    for (const model of ep.models || []) {
      const id = String(model || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push(id);
    }
  }
  return models;
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
  source_title?: string;
  display_title?: string;
  chunk_count: number;
  duration_start: number;
  duration_end: number;
  duration?: number;
  language: string;
  summary_short?: string;
  summary_full?: string;
  key_points?: string[];
  topics?: string[];
  steps_done?: string[];
  created_at: number;
  updated_at?: number;
}

interface BrowserInfo {
  id: string;
  name: string;
  cookieDbPath: string;
}

interface PipelineNodeInfo {
  id: string;
  label: string;
  weight?: number;
  default_enabled?: boolean;
  requires?: string[];
}

const DEFAULT_PIPELINE_STEPS = [
  "fetch_info",
  "download_audio",
  "download_video",
  "transcribe",
  "summarize",
  "chunk",
  "vectorize",
];

const videoKbState = {
  whisperTools: [] as WhisperTool[],
  whisperModels: [] as WhisperModel[],
  embClient: "" as string,
  embEndpointId: "" as string,
  embModel: "" as string,
  searchEmbClient: "" as string,
  searchEmbEndpointId: "" as string,
  summaryClient: "" as string,
  summaryModel: "" as string,
  pipelineNodes: [] as PipelineNodeInfo[],
  selectedSteps: new Set<string>(DEFAULT_PIPELINE_STEPS),
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
  loadCookieFiles();
}

function importPanelHTML(): string {
  return `
    <div class="video-kb-card">
      <div class="video-kb-card-title">导入视频</div>
      <div class="form-group full" style="margin-bottom:16px">
        <label>视频 URL</label>
        <input type="text" id="vk-url" placeholder="https://www.youtube.com/watch?v=...">
      </div>
      <div class="form-group full" style="margin-bottom:16px">
        <label>显示标题（可选）</label>
        <input type="text" id="vk-display-title" placeholder="留空则使用源站标题">
      </div>
      <div class="form-group" style="margin-bottom:16px">
        <label>Cookie 文件</label>
        <select id="vk-cookie">
          <option value="">不需要 Cookie</option>
        </select>
      </div>
    </div>

    <div class="video-kb-card">
      <div class="video-kb-card-title">执行步骤</div>
      <div id="vk-steps-select" class="video-kb-step-select"></div>
      <div class="video-kb-status" style="margin-top:8px">可只下载素材，也可以完整转录/摘要/入库。取消不需要的步骤即可。</div>
    </div>

    <div class="video-kb-card">
      <div class="video-kb-card-title">Agent Reach 内容获取</div>
      <div id="vk-agent-reach-status"><div class="video-kb-empty">检测中...</div></div>
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
      <div class="video-kb-card-title">视频摘要</div>
      <div class="video-kb-form-grid">
        <div class="form-group">
          <label>Client</label>
          <select id="vk-summary-client" onchange="window.videoKbOnSummaryClientChange()">
            <option value="">加载中...</option>
          </select>
        </div>
        <div class="form-group">
          <label>摘要模型</label>
          <select id="vk-summary-model" onchange="window.videoKbOnSummaryModelChange()">
            <option value="">无</option>
          </select>
        </div>
      </div>
      <div class="video-kb-status" style="margin-top:8px">未选模型时，摘要步骤会使用规则摘要兜底。</div>
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
        <div class="video-kb-actions" style="margin-top:12px">
          <button class="btn btn-danger" id="vk-cancel-btn" onclick="window.videoKbCancelTask()" style="display:none">取消任务</button>
          <button class="btn" id="vk-retry-btn" onclick="window.videoKbRetryTask()" style="display:none">重新导入</button>
        </div>
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
  initSummaryCascade();
  await loadPipelineNodes();

  // Load Agent Reach status
  loadAgentReachStatus();

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


async function loadPipelineNodes(): Promise<void> {
  const data = await apiGet<{ nodes: PipelineNodeInfo[]; default_steps?: string[] }>("/v1/video-kb/pipeline/nodes");
  if (data?.nodes?.length) {
    videoKbState.pipelineNodes = data.nodes;
    if (videoKbState.selectedSteps.size === 0 || [...videoKbState.selectedSteps].every((s) => DEFAULT_PIPELINE_STEPS.includes(s))) {
      const defaults = data.default_steps?.length
        ? data.default_steps
        : data.nodes.filter((n) => n.default_enabled !== false).map((n) => n.id);
      videoKbState.selectedSteps = new Set(defaults);
    }
  } else if (!videoKbState.pipelineNodes.length) {
    videoKbState.pipelineNodes = [
      { id: "fetch_info", label: "获取视频信息", default_enabled: true },
      { id: "agent_reach_get", label: "Agent Reach 内容获取", default_enabled: false },
      { id: "download_audio", label: "下载音轨", default_enabled: true },
      { id: "download_video", label: "下载视频素材", default_enabled: true },
      { id: "transcribe", label: "语音转录", default_enabled: true },
      { id: "summarize", label: "生成摘要", default_enabled: true },
      { id: "chunk", label: "文本分块", default_enabled: true },
      { id: "vectorize", label: "向量化入库", default_enabled: true },
    ];
  }
  renderStepSelector();
}

function renderStepSelector(): void {
  const box = document.getElementById("vk-steps-select");
  if (!box) return;
  const nodes = videoKbState.pipelineNodes.length
    ? videoKbState.pipelineNodes
    : DEFAULT_PIPELINE_STEPS.map((id) => ({ id, label: id, default_enabled: true }));
  box.innerHTML = nodes.map((node) => {
    const checked = videoKbState.selectedSteps.has(node.id) ? "checked" : "";
    return `
      <label class="video-kb-step-option">
        <input type="checkbox" value="${esc(node.id)}" ${checked} onchange="window.videoKbToggleStep('${esc(node.id)}', this.checked)">
        <span>${esc(node.label)}</span>
      </label>
    `;
  }).join("");
}

function initSummaryCascade(): void {
  const clients = getChatClients();
  const clientOpts = clients.length === 0
    ? `<option value="">无可用 Client</option>`
    : clients.map((c) => `<option value="${c}">${esc(clientDisplayName(c))}</option>`).join("");
  const clientSel = document.getElementById("vk-summary-client") as HTMLSelectElement | null;
  if (!clientSel) return;
  clientSel.innerHTML = clientOpts;
  if (clients.length > 0 && !videoKbState.summaryClient) {
    // Prefer same client as embedding when available.
    videoKbState.summaryClient = clients.includes(videoKbState.embClient) ? videoKbState.embClient : clients[0];
  }
  if (videoKbState.summaryClient) clientSel.value = videoKbState.summaryClient;
  refreshSummaryModels(videoKbState.summaryClient);
}

function refreshSummaryModels(client: string): void {
  const modelSel = document.getElementById("vk-summary-model") as HTMLSelectElement | null;
  if (!modelSel) return;
  const endpoints = getChatEndpoints(client);
  const models = collectChatModels(endpoints);
  if (models.length === 0) {
    modelSel.innerHTML = `<option value="">无可用模型</option>`;
    modelSel.disabled = true;
    videoKbState.summaryModel = "";
    return;
  }
  modelSel.disabled = false;
  if (!videoKbState.summaryModel || !models.includes(videoKbState.summaryModel)) {
    videoKbState.summaryModel = models[0];
  }
  modelSel.innerHTML = models.map((m) =>
    `<option value="${esc(m)}" ${m === videoKbState.summaryModel ? "selected" : ""}>${esc(m)}</option>`
  ).join("");
}

(window as any).videoKbToggleStep = function (stepId: string, checked: boolean): void {
  if (checked) videoKbState.selectedSteps.add(stepId);
  else videoKbState.selectedSteps.delete(stepId);
};

(window as any).videoKbOnSummaryClientChange = function (): void {
  const sel = document.getElementById("vk-summary-client") as HTMLSelectElement | null;
  if (!sel) return;
  videoKbState.summaryClient = sel.value;
  videoKbState.summaryModel = "";
  refreshSummaryModels(sel.value);
};

(window as any).videoKbOnSummaryModelChange = function (): void {
  const sel = document.getElementById("vk-summary-model") as HTMLSelectElement | null;
  if (!sel) return;
  videoKbState.summaryModel = sel.value;
};

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

async function loadAgentReachStatus(force = false): Promise<void> {
  const container = document.getElementById("vk-agent-reach-status");
  if (!container) return;

  const pollToken = String(Date.now()) + Math.random().toString(16).slice(2);
  (window as any).__vkAgentReachPollToken = pollToken;

  const renderAgentReach = (data: any, opts: { refreshing?: boolean } = {}) => {
    if (!data.installed) {
      const hint = data.install_hint || {};
      container.innerHTML = `
        <div class="video-kb-banner err">Agent Reach 未安装</div>
        <div style="margin-top:12px;font-size:13px;color:var(--text-secondary);line-height:1.8">
          ${hint.steps ? hint.steps.map((s: string) => `<div>${esc(s)}</div>`).join("") : ""}
        </div>
        <div class="video-kb-actions" style="margin-top:12px">
          <button class="btn btn-primary" onclick="window.videoKbInstallAgentReach()">一键安装</button>
        </div>
      `;
      return;
    }

    const installedChannels = data.installed_channels || [];
    const channelsReady = data.channels_ready !== false;
    const channelsRefreshing = Boolean(opts.refreshing || data.channels_refreshing);
    let channelBadges = "<span class=\"video-kb-status\">无已安装渠道</span>";
    if (!channelsReady || channelsRefreshing) {
      channelBadges = "<span class=\"video-kb-status\">渠道状态刷新中...</span>";
    } else if (installedChannels.length > 0) {
      channelBadges = installedChannels.map((ch: string) => `<span class="badge">${esc(ch)}</span>`).join(" ");
    }

    const versionText = esc((data.version || "").replace(/^Agent\s*Reach\s*v?/i, "v"));
    container.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span class="video-kb-status ok">Agent Reach ${versionText} 已安装</span>
        ${channelsRefreshing ? "<span class=\"video-kb-status\">渠道检测中</span>" : ""}
      </div>
      <div style="margin-bottom:8px">
        <div class="video-kb-status" style="margin-bottom:4px">已安装渠道:</div>
        ${channelBadges}
      </div>
      <div class="video-kb-actions">
        <button class="btn btn-sm" onclick="window.videoKbRefreshAgentReach()">刷新</button>
        <button class="btn btn-sm" onclick="window.videoKbInstallChannels()">安装更多渠道</button>
      </div>
    `;
  };

  try {
    const resp = await fetch("/v1/video-kb/tools/agent-reach" + (force ? "?refresh=1" : ""));
    const data = await resp.json();
    if ((window as any).__vkAgentReachPollToken !== pollToken) return;
    renderAgentReach(data, { refreshing: Boolean(data.channels_refreshing) || data.channels_ready === false });

    if (data.installed && (data.channels_refreshing || data.channels_ready === false)) {
      let tries = 0;
      const poll = async () => {
        if ((window as any).__vkAgentReachPollToken !== pollToken) return;
        tries += 1;
        try {
          const pollResp = await fetch("/v1/video-kb/tools/agent-reach");
          const pollData = await pollResp.json();
          if ((window as any).__vkAgentReachPollToken !== pollToken) return;
          const stillRefreshing = Boolean(pollData.channels_refreshing) || pollData.channels_ready === false;
          renderAgentReach(pollData, { refreshing: stillRefreshing });
          if (stillRefreshing && tries < 30) setTimeout(poll, 1000);
        } catch {
          // keep installed state on transient poll errors
        }
      };
      setTimeout(poll, 800);
    }
  } catch {
    if ((window as any).__vkAgentReachPollToken !== pollToken) return;
    container.innerHTML = '<div class="video-kb-status err">检测失败</div>';
  }
}

(window as any).videoKbInstallAgentReach = async function (): Promise<void> {
  if (!confirm("将安装 Agent Reach CLI 和基础渠道，可能需要几分钟。继续?")) return;

  const container = document.getElementById("vk-agent-reach-status");
  if (container) container.innerHTML = '<div class="video-kb-empty">安装中...</div>';

  try {
    const resp = await fetch("/v1/video-kb/tools/agent-reach/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await resp.json();

    if (data.task_id) {
      // Poll task status
      const taskId = data.task_id;
      const pollInstall = async () => {
        const taskResp = await fetch(`/v1/tasks/${taskId}`);
        const task = await taskResp.json();
        if (container) {
          if (task.status === "running") {
            const pct = (task.progress * 100).toFixed(0);
            container.innerHTML = `<div class="video-kb-empty">安装中... ${pct}% ${esc(task.progress_message || "")}</div>`;
            setTimeout(pollInstall, 2000);
          } else if (task.status === "succeeded") {
            container.innerHTML = '<div class="video-kb-banner ok">安装成功!</div>';
            setTimeout(() => loadAgentReachStatus(true), 1000);
          } else {
            container.innerHTML = `<div class="video-kb-banner err">安装失败: ${esc(task.error || "")}</div>`;
          }
        }
      };
      setTimeout(pollInstall, 1000);
    }
  } catch (e) {
    if (container) container.innerHTML = '<div class="video-kb-banner err">安装请求失败</div>';
  }
};

(window as any).videoKbRefreshAgentReach = function (): void {
  loadAgentReachStatus(true);
};

(window as any).videoKbInstallChannels = async function (): Promise<void> {
  // Remove existing modal if any
  const existing = document.getElementById("vk-channel-modal");
  if (existing) existing.remove();

  // Fetch current channel status from agent-reach doctor
  let channels: Array<{name: string; status: string; display_name?: string; backend?: string; auth_required?: boolean}> = [];
  try {
    const resp = await fetch("/v1/video-kb/tools/agent-reach");
    const data = await resp.json();
    channels = (data.channels || []).filter((ch: any) => ch.status !== "ok");
  } catch { /* ignore */ }

  if (channels.length === 0) {
    const modal = document.createElement("div");
    modal.id = "vk-channel-modal";
    modal.className = "vk-modal-overlay";
    modal.innerHTML = `
      <div class="vk-modal">
        <div class="vk-modal-header">
          <h3>安装渠道</h3>
          <button class="vk-modal-close" onclick="document.getElementById('vk-channel-modal').remove()">\u00d7</button>
        </div>
        <div class="vk-modal-body">
          <div class="video-kb-empty">所有渠道均已安装或可用</div>
        </div>
        <div class="vk-modal-footer">
          <button class="btn btn-primary" onclick="document.getElementById('vk-channel-modal').remove()">关闭</button>
        </div>
      </div>
    `;
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
    return;
  }

  const modal = document.createElement("div");
  modal.id = "vk-channel-modal";
  modal.className = "vk-modal-overlay";
  modal.innerHTML = `
    <div class="vk-modal">
      <div class="vk-modal-header">
        <h3>安装渠道</h3>
        <button class="vk-modal-close" onclick="document.getElementById('vk-channel-modal').remove()">\u00d7</button>
      </div>
      <div class="vk-modal-body">
        <div class="vk-channel-list">
          ${channels.map((ch) => `
            <label class="vk-channel-item">
              <input type="checkbox" value="${esc(ch.name)}" class="vk-channel-checkbox">
              <div class="vk-channel-info">
                <div class="vk-channel-name">${esc(ch.display_name || ch.name)}</div>
                <div class="vk-channel-desc">${esc(ch.backend || "")}${ch.status === "warn" ? " (需配置)" : ""}</div>
                ${ch.auth_required ? '<span class="vk-channel-tag">需登录</span>' : '<span class="vk-channel-tag ok">免登录</span>'}
              </div>
            </label>
          `).join("")}
        </div>
      </div>
      <div class="vk-modal-footer">
        <button class="btn" onclick="document.getElementById('vk-channel-modal').remove()">取消</button>
        <button class="btn btn-primary" onclick="window.videoKbConfirmInstallChannels()">安装选中</button>
      </div>
    </div>
  `;
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });
  document.body.appendChild(modal);
};

(window as any).videoKbConfirmInstallChannels = function (): void {
  const checked = document.querySelectorAll<HTMLInputElement>(".vk-channel-checkbox:checked");
  const channelList = Array.from(checked).map((cb) => cb.value);
  if (channelList.length === 0) return;

  const modal = document.getElementById("vk-channel-modal");
  if (modal) modal.remove();

  const container = document.getElementById("vk-agent-reach-status");
  if (container) container.innerHTML = `<div class="video-kb-empty">渠道安装中...</div>`;

  fetch("/v1/video-kb/tools/agent-reach/channels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channels: channelList }),
  }).then(async (resp) => {
    const data = await resp.json();
    if (data.task_id) {
      const pollChannels = async () => {
        const taskResp = await fetch(`/v1/tasks/${data.task_id}`);
        const task = await taskResp.json();
        if (container) {
          if (task.status === "running") {
            container.innerHTML = `<div class="video-kb-empty">渠道安装中... ${esc(task.progress_message || "")}</div>`;
            setTimeout(pollChannels, 2000);
          } else if (task.status === "succeeded") {
            container.innerHTML = '<div class="video-kb-banner ok">渠道安装成功!</div>';
            setTimeout(() => loadAgentReachStatus(true), 1000);
          } else {
            container.innerHTML = `<div class="video-kb-banner err">渠道安装失败: ${esc(task.error || "")}</div>`;
          }
        }
      };
      setTimeout(pollChannels, 1000);
    }
  });
};

async function loadCookieFiles(): Promise<void> {
  const sel = document.getElementById("vk-cookie") as HTMLSelectElement | null;
  if (!sel) return;
  const data = await apiGet<{ files: Array<{ file_path: string; filename: string; domain: string; size: number; modified: number }> }>("/v1/cookies/files");
  if (!data || !data.files || data.files.length === 0) {
    sel.innerHTML = `<option value="">不需要 Cookie</option>`;
    return;
  }
  sel.innerHTML = `<option value="">不需要 Cookie</option>` +
    data.files.map((f) => `<option value="${esc(f.file_path)}">${esc(f.domain)} (${esc(f.filename)})</option>`).join("");
}

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
  const summaryClient = (document.getElementById("vk-summary-client") as HTMLSelectElement)?.value || videoKbState.summaryClient;
  const summaryModel = (document.getElementById("vk-summary-model") as HTMLSelectElement)?.value || videoKbState.summaryModel;
  const selectedSteps = [...videoKbState.selectedSteps];

  if (selectedSteps.length === 0) { alert("请至少选择一个执行步骤"); return; }
  if (selectedSteps.includes("transcribe") && !whisperTool) { alert("已勾选语音转录，请先安装/选择 Whisper 工具"); return; }
  if (selectedSteps.includes("vectorize") && !embeddingEndpointId) { alert("已勾选向量化入库，请配置 Embedding 节点"); return; }

  const displayTitle = (document.getElementById("vk-display-title") as HTMLInputElement)?.value?.trim() || "";

  const result = await apiPost<{ task_id: string; error?: { message?: string } }>("/v1/video-kb/ingest", {
    url,
    display_title: displayTitle || null,
    cookie_file: cookieFile || null,
    whisper_tool: whisperTool || null,
    whisper_model: whisperModel || null,
    language,
    embedding_endpoint_id: embeddingEndpointId || null,
    summary_client: summaryClient || null,
    summary_model: summaryModel || null,
    chunk_strategy: chunkStrategy,
    keep_video: keepVideo,
    steps: selectedSteps,
  });

  if (result?.task_id) {
    videoKbState.currentTaskId = result.task_id;
    document.getElementById("vk-task-progress")!.style.display = "block";
    pollTaskProgress();
  } else {
    alert((result as any)?.error?.message || "提交失败");
  }
};

async function pollTaskProgress(): Promise<void> {
  if (!videoKbState.currentTaskId) return;
  const task = await apiGet<TaskInfo>(`/v1/tasks/${videoKbState.currentTaskId}`);
  if (!task) return;

  renderTaskSteps(task);
  updateTaskButtons(task);

  if (["succeeded", "failed", "cancelled"].includes(task.status)) {
    renderTaskComplete(task);
    return;
  }
  videoKbState.taskPollTimer = setTimeout(() => pollTaskProgress(), 1000);
}

function updateTaskButtons(task: TaskInfo): void {
  const cancelBtn = document.getElementById("vk-cancel-btn");
  const retryBtn = document.getElementById("vk-retry-btn");
  const ingestBtn = document.getElementById("vk-ingest-btn");
  const isTerminal = ["succeeded", "failed", "cancelled"].includes(task.status);
  if (cancelBtn) cancelBtn.style.display = isTerminal ? "none" : "";
  if (retryBtn) retryBtn.style.display = (task.status === "failed" || task.status === "cancelled") ? "" : "none";
  if (ingestBtn) {
    ingestBtn.disabled = !isTerminal;
    ingestBtn.textContent = isTerminal ? "开始导入" : "导入中...";
  }
}

(window as any).videoKbCancelTask = async function (): Promise<void> {
  if (!videoKbState.currentTaskId) return;
  const cancelBtn = document.getElementById("vk-cancel-btn");
  if (cancelBtn) { cancelBtn.setAttribute("disabled", "disabled"); cancelBtn.textContent = "取消中..."; }
  try {
    await fetch(`/v1/tasks/${videoKbState.currentTaskId}/cancel`, { method: "POST" });
  } catch { /* ignore */ }
  if (cancelBtn) { cancelBtn.textContent = "取消任务"; cancelBtn.removeAttribute("disabled"); }
  // Poll will pick up the cancelled status on next tick
  pollTaskProgress();
};

(window as any).videoKbRetryTask = function (): void {
  videoKbState.currentTaskId = null;
  if (videoKbState.taskPollTimer) { clearTimeout(videoKbState.taskPollTimer); videoKbState.taskPollTimer = null; }
  document.getElementById("vk-task-progress")!.style.display = "none";
  const cancelBtn = document.getElementById("vk-cancel-btn");
  const retryBtn = document.getElementById("vk-retry-btn");
  if (cancelBtn) cancelBtn.style.display = "none";
  if (retryBtn) retryBtn.style.display = "none";
  const ingestBtn = document.getElementById("vk-ingest-btn") as HTMLButtonElement | null;
  if (ingestBtn) { ingestBtn.disabled = false; ingestBtn.textContent = "开始导入"; }
  (window as any).videoKbIngest();
};

function findFailedStep(task: TaskInfo): TaskStep | null {
  const steps = task.steps || [];
  return steps.find((s) => s.status === "failed") || null;
}

function renderTaskSteps(task: TaskInfo): void {
  const container = document.getElementById("vk-steps-list");
  if (container) {
    const icons: Record<string, string> = { pending: "○", running: "◉", done: "✓", failed: "✗" };
    container.innerHTML = (task.steps || []).map((step) => `
      <div class="video-kb-step ${step.status}">
        <span class="video-kb-step-icon">${icons[step.status] || "○"}</span>
        <span class="video-kb-step-label">${esc(step.label)}</span>
        ${(step.status === "running" || step.status === "failed") && step.message ? `<span class="video-kb-step-msg">${esc(step.message)}</span>` : ""}
        ${step.status === "running" && step.progress > 0 ? `<span class="video-kb-step-pct">${(step.progress * 100).toFixed(0)}%</span>` : ""}
      </div>
    `).join("");
  }

  const fill = document.getElementById("vk-progress-fill");
  const label = document.getElementById("vk-progress-label");
  const pct = (task.progress * 100).toFixed(1);
  if (fill) fill.style.width = `${pct}%`;
  if (label && task.status !== "failed" && task.status !== "succeeded" && task.status !== "cancelled") {
    label.textContent = `${pct}% - ${esc(task.progress_message || "")}`;
  }
}

function renderTaskComplete(task: TaskInfo): void {
  updateTaskButtons(task);
  const label = document.getElementById("vk-progress-label");
  if (!label) return;

  if (task.status === "succeeded" && task.result) {
    const r = task.result as Record<string, string | number | null>;
    const summary = r.summary_short ? ` | 摘要: ${esc(String(r.summary_short))}` : "";
    label.innerHTML = `<span class="video-kb-banner ok">导入完成: ${esc(String(r.title || ""))} | ${r.chunk_count || 0} 个分块 | 语言: ${esc(String(r.detected_language || ""))}${summary}</span>`;
    return;
  }

  if (task.status === "cancelled") {
    label.innerHTML = `<span class="video-kb-status">已取消</span>`;
    return;
  }

  // failed
  const failed = findFailedStep(task);
  const failedLabel = failed?.label || "未知步骤";
  const detail = failed?.message || task.error || "未知错误";
  label.innerHTML = `
    <div class="video-kb-banner err">失败环节：${esc(failedLabel)}</div>
    <div class="video-kb-error-detail">${esc(detail)}</div>
  `;
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

  panel.innerHTML = data.videos.map((v) => {
    const title = v.display_title || v.video_title || "untitled";
    const source = v.source_title && v.source_title !== title ? `<div class="video-kb-asset-source">原标题: ${esc(v.source_title)}</div>` : "";
    const summary = v.summary_short
      ? `<div class="video-kb-asset-summary">${esc(v.summary_short)}${v.summary_full && v.summary_full !== v.summary_short ? `<div class="video-kb-asset-summary-full">${esc(v.summary_full)}</div>` : ""}</div>`
      : `<div class="video-kb-asset-summary muted">暂无摘要</div>`;
    const durationLabel = Number(v.duration || 0) > 0
      ? fmtTime(Number(v.duration || 0))
      : `${fmtTime(v.duration_start)}-${fmtTime(v.duration_end)}`;
    return `
    <div class="video-kb-asset-row">
      <div class="video-kb-asset-info">
        <div class="video-kb-asset-title">${esc(title)}</div>
        ${source}
        ${summary}
        <div class="video-kb-asset-meta">
          ${v.chunk_count || 0} 分块 | ${durationLabel} | ${esc(v.language || "-")} | ${new Date(v.updated_at || v.created_at).toLocaleDateString()}<br>
          <a href="${esc(v.video_url)}" target="_blank">${esc(v.video_url)}</a>
        </div>
      </div>
      <div class="video-kb-asset-actions">
        <button class="btn btn-sm" onclick='window.videoKbRenameVideo(${JSON.stringify(v.video_id)}, ${JSON.stringify(title)})'>重命名</button>
        <button class="btn btn-sm" onclick='window.videoKbRegenerateSummary(${JSON.stringify(v.video_id)})'>重新生成摘要</button>
        <button class="btn btn-sm" onclick="window.videoKbViewAsset('${v.video_id}','transcript')">转录</button>
        <button class="btn btn-sm" onclick="window.videoKbViewAsset('${v.video_id}','audio')">音频</button>
        <button class="btn btn-sm" onclick="window.videoKbViewAsset('${v.video_id}','video')">视频</button>
        <button class="btn btn-sm btn-danger" onclick="window.videoKbDeleteVideo('${v.video_id}')">删除</button>
      </div>
    </div>`;
  }).join("");
}

(window as any).videoKbRenameVideo = async function (videoId: string, currentTitle: string): Promise<void> {
  const next = prompt("输入新的显示标题", currentTitle || "");
  if (next == null) return;
  const title = String(next).trim();
  if (!title) {
    alert("标题不能为空");
    return;
  }
  try {
    const resp = await fetch(`/v1/video-kb/videos/${encodeURIComponent(videoId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_title: title }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      alert(data?.error?.message || "重命名失败");
      return;
    }
    loadVideoList();
  } catch {
    alert("重命名失败");
  }
};

(window as any).videoKbRegenerateSummary = async function (videoId: string): Promise<void> {
  // Prefer current import-panel summary selection if available.
  const summaryClient = (document.getElementById("vk-summary-client") as HTMLSelectElement)?.value
    || videoKbState.summaryClient
    || "";
  const summaryModel = (document.getElementById("vk-summary-model") as HTMLSelectElement)?.value
    || videoKbState.summaryModel
    || "";

  if (!summaryClient) {
    // Ensure cascade is initialized if user only opened assets tab.
    initSummaryCascade();
  }
  const client = (document.getElementById("vk-summary-client") as HTMLSelectElement)?.value
    || videoKbState.summaryClient
    || getChatClients()[0]
    || "code";
  const model = (document.getElementById("vk-summary-model") as HTMLSelectElement)?.value
    || videoKbState.summaryModel
    || collectChatModels(getChatEndpoints(client))[0]
    || "";

  if (!confirm(`重新生成摘要？\nClient: ${client}\n模型: ${model || "规则摘要兜底"}`)) return;

  try {
    const resp = await fetch(`/v1/video-kb/videos/${encodeURIComponent(videoId)}/summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary_client: client,
        summary_model: model || null,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      alert(data?.error?.message || "重新生成摘要失败");
      return;
    }
    alert(`摘要已更新\n${data?.video?.summary_short || data?.summary?.summary_short || ""}`);
    loadVideoList();
  } catch {
    alert("重新生成摘要失败");
  }
};

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
            await loadCookieFiles();
            const cookieSelect = document.getElementById("vk-cookie") as HTMLSelectElement | null;
            if (cookieSelect) cookieSelect.value = result.file_path;
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
      await loadCookieFiles();
      const cookieSelect = document.getElementById("vk-cookie") as HTMLSelectElement | null;
      if (cookieSelect) cookieSelect.value = result.file_path;
    } else {
      resultDiv.innerHTML = `<div class="video-kb-banner err">导出失败</div>`;
    }
  }
};
