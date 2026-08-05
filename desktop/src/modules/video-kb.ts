/**
 * Video Knowledge Base module - TypeScript frontend for the video KB pipeline.
 *
 * Provides UI for:
 * - Importing videos (URL + yt-dlp download + Whisper transcription + vectorization)
 * - Viewing task progress (step-by-step)
 * - Semantic search across indexed videos
 * - Managing indexed video assets (view/delete)
 * - Cookie export tool (browser cookie -> Netscape cookies.txt)
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

interface BrowserInfo {
  id: string;
  name: string;
  cookieDbPath: string;
}

// State
let videoKbState = {
  whisperTools: [] as WhisperTool[],
  whisperModels: [] as WhisperModel[],
  embeddingEndpoints: [] as EmbeddingEndpoint[],
  currentTaskId: null as string | null,
  taskPollTimer: null as ReturnType<typeof setTimeout> | null,
  ytDlpInstalled: false,
  ffmpegInstalled: false,
  browsers: [] as BrowserInfo[],
};

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = String(str || "");
  return div.innerHTML;
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

/**
 * Render the video KB tool detail view.
 * Called from app.ts openTool('video-kb').
 */
export function renderVideoKbDetail(): void {
  const detail = document.getElementById("tools-detail");
  if (!detail) return;

  detail.innerHTML = `
    <div class="video-kb-container">
      <div class="section-header">
        <button class="btn" onclick="window.backToToolsCards()">← 返回</button>
        <h2>视频知识库</h2>
      </div>

      <div class="video-kb-tabs">
        <button class="video-kb-tab active" data-tab="import" onclick="window.videoKbSwitchTab('import')">导入</button>
        <button class="video-kb-tab" data-tab="search" onclick="window.videoKbSwitchTab('search')">检索</button>
        <button class="video-kb-tab" data-tab="assets" onclick="window.videoKbSwitchTab('assets')">素材管理</button>
        <button class="video-kb-tab" data-tab="cookie" onclick="window.videoKbSwitchTab('cookie')">Cookie 工具</button>
      </div>

      <div id="video-kb-panel-import" class="video-kb-panel">
        ${renderImportPanel()}
      </div>
      <div id="video-kb-panel-search" class="video-kb-panel" style="display:none">
        ${renderSearchPanel()}
      </div>
      <div id="video-kb-panel-assets" class="video-kb-panel" style="display:none">
        <div style="padding:1rem;color:var(--text-secondary)">加载中...</div>
      </div>
      <div id="video-kb-panel-cookie" class="video-kb-panel" style="display:none">
        ${renderCookiePanel()}
      </div>
    </div>
  `;

  // Load tool data
  loadToolsData();
  loadBrowsers();
}

function renderImportPanel(): string {
  return `
    <div class="video-kb-import">
      <div class="form-group">
        <label>视频 URL</label>
        <input type="text" id="vk-url" class="form-input" placeholder="https://www.youtube.com/watch?v=..." style="width:100%;padding:0.5rem;background:var(--input-bg);border:1px solid var(--border-color);border-radius:var(--radius-md);color:var(--text-primary)">
      </div>

      <div class="form-row" style="display:flex;gap:1rem;flex-wrap:wrap">
        <div class="form-group" style="flex:1;min-width:200px">
          <label>Cookie 文件</label>
          <select id="vk-cookie" class="form-input" style="width:100%;padding:0.5rem;background:var(--input-bg);border:1px solid var(--border-color);border-radius:var(--radius-md);color:var(--text-primary)">
            <option value="">不需要 Cookie</option>
          </select>
        </div>

        <div class="form-group" style="flex:1;min-width:200px">
          <label>Embedding 节点</label>
          <select id="vk-embedding" class="form-input" style="width:100%;padding:0.5rem;background:var(--input-bg);border:1px solid var(--border-color);border-radius:var(--radius-md);color:var(--text-primary)">
            <option value="">加载中...</option>
          </select>
        </div>
      </div>

      <div class="form-row" style="display:flex;gap:1rem;flex-wrap:wrap">
        <div class="form-group" style="flex:1;min-width:200px">
          <label>Whisper 工具</label>
          <select id="vk-whisper-tool" class="form-input" style="width:100%;padding:0.5rem;background:var(--input-bg);border:1px solid var(--border-color);border-radius:var(--radius-md);color:var(--text-primary)">
            <option value="">加载中...</option>
          </select>
          <div id="vk-whisper-hint" style="margin-top:0.25rem;font-size:0.8rem;color:var(--text-secondary)"></div>
        </div>

        <div class="form-group" style="flex:1;min-width:200px">
          <label>模型大小</label>
          <select id="vk-whisper-model" class="form-input" style="width:100%;padding:0.5rem;background:var(--input-bg);border:1px solid var(--border-color);border-radius:var(--radius-md);color:var(--text-primary)">
            <option value="">加载中...</option>
          </select>
          <div id="vk-model-guide" style="margin-top:0.25rem;font-size:0.8rem;color:var(--text-secondary)"></div>
        </div>
      </div>

      <div class="form-row" style="display:flex;gap:1rem;flex-wrap:wrap">
        <div class="form-group" style="flex:1;min-width:150px">
          <label>语言</label>
          <select id="vk-language" class="form-input" style="width:100%;padding:0.5rem;background:var(--input-bg);border:1px solid var(--border-color);border-radius:var(--radius-md);color:var(--text-primary)">
            <option value="auto">自动检测</option>
            <option value="zh">中文</option>
            <option value="en">English</option>
            <option value="ja">日本語</option>
            <option value="ko">한국어</option>
          </select>
        </div>

        <div class="form-group" style="flex:1;min-width:150px">
          <label>分块策略</label>
          <select id="vk-chunk-strategy" class="form-input" style="width:100%;padding:0.5rem;background:var(--input-bg);border:1px solid var(--border-color);border-radius:var(--radius-md);color:var(--text-primary)">
            <option value="time-window">时间窗口（快）</option>
            <option value="semantic">语义切分（高质量）</option>
          </select>
        </div>

        <div class="form-group" style="flex:1;min-width:150px">
          <label>保留视频</label>
          <select id="vk-keep-video" class="form-input" style="width:100%;padding:0.5rem;background:var(--input-bg);border:1px solid var(--border-color);border-radius:var(--radius-md);color:var(--text-primary)">
            <option value="true">保留（推荐）</option>
            <option value="false">仅音频</option>
          </select>
        </div>
      </div>

      <div style="margin:1rem 0">
        <button class="btn btn-primary" id="vk-ingest-btn" onclick="window.videoKbIngest()">开始导入</button>
        <span id="vk-ytdlp-status" style="margin-left:1rem;font-size:0.85rem;color:var(--text-secondary)"></span>
      </div>

      <div id="vk-task-progress" style="display:none">
        <div style="margin-bottom:0.5rem;font-weight:600">任务进度</div>
        <div id="vk-steps-list"></div>
        <div id="vk-overall-progress" style="margin-top:0.5rem"></div>
      </div>
    </div>
  `;
}

function renderSearchPanel(): string {
  return `
    <div class="video-kb-search">
      <div class="form-group">
        <label>搜索内容</label>
        <input type="text" id="vk-search-query" class="form-input" placeholder="输入要检索的内容..." style="width:100%;padding:0.5rem;background:var(--input-bg);border:1px solid var(--border-color);border-radius:var(--radius-md);color:var(--text-primary)" onkeydown="if(event.key==='Enter')window.videoKbSearch()">
      </div>
      <div class="form-row" style="display:flex;gap:1rem;flex-wrap:wrap;align-items:end">
        <div class="form-group" style="flex:1;min-width:200px">
          <label>Embedding 节点</label>
          <select id="vk-search-embedding" class="form-input" style="width:100%;padding:0.5rem;background:var(--input-bg);border:1px solid var(--border-color);border-radius:var(--radius-md);color:var(--text-primary)">
            <option value="">默认</option>
          </select>
        </div>
        <div class="form-group" style="min-width:100px">
          <label>Top K</label>
          <input type="number" id="vk-search-topk" value="5" min="1" max="50" style="width:80px;padding:0.5rem;background:var(--input-bg);border:1px solid var(--border-color);border-radius:var(--radius-md);color:var(--text-primary)">
        </div>
        <div class="form-group">
          <button class="btn btn-primary" onclick="window.videoKbSearch()">搜索</button>
        </div>
      </div>
      <div id="vk-search-results" style="margin-top:1rem"></div>
    </div>
  `;
}

function renderCookiePanel(): string {
  return `
    <div class="video-kb-cookie">
      <div class="form-group">
        <label>选择浏览器</label>
        <select id="vk-cookie-browser" class="form-input" style="width:100%;padding:0.5rem;background:var(--input-bg);border:1px solid var(--border-color);border-radius:var(--radius-md);color:var(--text-primary)" onchange="window.videoKbLoadDomains()">
          <option value="">加载中...</option>
        </select>
      </div>
      <div class="form-group">
        <label>域名筛选（可选，留空导出全部）</label>
        <input type="text" id="vk-cookie-domain" class="form-input" placeholder="如 youtube.com" style="width:100%;padding:0.5rem;background:var(--input-bg);border:1px solid var(--border-color);border-radius:var(--radius-md);color:var(--text-primary)">
      </div>
      <button class="btn btn-primary" onclick="window.videoKbExportCookies()">导出 cookies.txt</button>
      <div id="vk-cookie-result" style="margin-top:1rem"></div>
    </div>
  `;
}

// --- Data loading ---

async function loadToolsData(): Promise<void> {
  // Load whisper tools
  const whisperData = await apiGet<{ tools: WhisperTool[] }>("/v1/video-kb/tools/whisper");
  if (whisperData) {
    videoKbState.whisperTools = whisperData.tools;
    const select = document.getElementById("vk-whisper-tool") as HTMLSelectElement | null;
    if (select) {
      if (whisperData.tools.length === 0) {
        select.innerHTML = `<option value="">未检测到 Whisper 工具</option>`;
      } else {
        select.innerHTML = whisperData.tools.map((t, i) =>
          `<option value="${t.id}" ${i === 0 ? "selected" : ""}>${escapeHtml(t.name)} - ${escapeHtml(t.hint)}</option>`
        ).join("");
      }
      updateWhisperHint();
    }
  }

  // Load whisper models
  const modelData = await apiGet<{ models: WhisperModel[] }>("/v1/video-kb/tools/whisper/models");
  if (modelData) {
    videoKbState.whisperModels = modelData.models;
    const select = document.getElementById("vk-whisper-model") as HTMLSelectElement | null;
    if (select) {
      select.innerHTML = modelData.models.map((m) =>
        `<option value="${m.id}">${escapeHtml(m.name)} (${m.sizeMB}MB, ${escapeHtml(m.speedHint)})</option>`
      ).join("");
      // Default to "small"
      select.value = "small";
      updateModelGuide();
    }
  }

  // Load embedding endpoints
  const embData = await apiGet<{ endpoints: EmbeddingEndpoint[] }>("/v1/video-kb/tools/embedding-endpoints");
  if (embData) {
    videoKbState.embeddingEndpoints = embData.endpoints;
    const select = document.getElementById("vk-embedding") as HTMLSelectElement | null;
    const searchSelect = document.getElementById("vk-search-embedding") as HTMLSelectElement | null;
    const opts = embData.endpoints.length === 0
      ? `<option value="">未配置 Embedding 节点</option>`
      : embData.endpoints.map((e, i) =>
          `<option value="${e.id}" ${i === 0 ? "selected" : ""}>${escapeHtml(e.name)} (${escapeHtml(e.embedding_model || e.models?.[0] || "")})</option>`
        ).join("");
    if (select) select.innerHTML = opts;
    if (searchSelect) searchSelect.innerHTML = opts;
  }

  // Load yt-dlp status
  const ytdlpData = await apiGet<{ yt_dlp: { path: string; version: string } | null, ffmpeg: { path: string } | null, install_hint: { commands: string[] } }>("/v1/video-kb/tools/yt-dlp");
  if (ytdlpData) {
    videoKbState.ytDlpInstalled = !!ytdlpData.yt_dlp;
    videoKbState.ffmpegInstalled = !!ytdlpData.ffmpeg;
    const status = document.getElementById("vk-ytdlp-status");
    if (status) {
      if (ytdlpData.yt_dlp) {
        status.textContent = `yt-dlp ${ytdlpData.yt_dlp.version}${ytdlpData.ffmpeg ? " + ffmpeg ✓" : " (缺 ffmpeg)"}`;
        status.style.color = ytdlpData.ffmpeg ? "var(--brand-primary)" : "#e8a838";
      } else {
        status.innerHTML = `未安装 yt-dlp: <code>${escapeHtml(ytdlpData.install_hint?.commands?.[0] || "pip install yt-dlp")}</code>`;
        status.style.color = "#e85a5a";
      }
    }
  }
}

async function loadBrowsers(): Promise<void> {
  const data = await apiGet<{ browsers: BrowserInfo[] }>("/v1/cookies/browsers");
  if (data) {
    videoKbState.browsers = data.browsers;
    const select = document.getElementById("vk-cookie-browser") as HTMLSelectElement | null;
    if (select) {
      if (data.browsers.length === 0) {
        select.innerHTML = `<option value="">未检测到浏览器</option>`;
      } else {
        select.innerHTML = data.browsers.map((b, i) =>
          `<option value="${b.id}" ${i === 0 ? "selected" : ""}>${escapeHtml(b.name)}</option>`
        ).join("");
      }
    }
  }
}

function updateWhisperHint(): void {
  const select = document.getElementById("vk-whisper-tool") as HTMLSelectElement | null;
  const hint = document.getElementById("vk-whisper-hint");
  if (!select || !hint) return;
  const tool = videoKbState.whisperTools.find((t) => t.id === select.value);
  if (tool) {
    hint.textContent = tool.hint;
  } else if (videoKbState.whisperTools.length === 0) {
    hint.innerHTML = `未检测到 Whisper 工具。安装: <code>uv tool install mlx-whisper</code> (macOS) 或 <code>uv tool install whisper-ctranslate2</code>`;
  }
}

function updateModelGuide(): void {
  const select = document.getElementById("vk-whisper-model") as HTMLSelectElement | null;
  const guide = document.getElementById("vk-model-guide");
  if (!select || !guide) return;
  const model = videoKbState.whisperModels.find((m) => m.id === select.value);
  if (model) {
    guide.textContent = model.guide;
  }
}

// --- Actions ---

window.videoKbIngest = async function (): Promise<void> {
  const url = (document.getElementById("vk-url") as HTMLInputElement)?.value?.trim();
  if (!url) { alert("请输入视频 URL"); return; }

  const cookieFile = (document.getElementById("vk-cookie") as HTMLSelectElement)?.value;
  const embeddingEndpointId = (document.getElementById("vk-embedding") as HTMLSelectElement)?.value;
  const whisperTool = (document.getElementById("vk-whisper-tool") as HTMLSelectElement)?.value;
  const whisperModel = (document.getElementById("vk-whisper-model") as HTMLSelectElement)?.value;
  const language = (document.getElementById("vk-language") as HTMLSelectElement)?.value;
  const chunkStrategy = (document.getElementById("vk-chunk-strategy") as HTMLSelectElement)?.value;
  const keepVideo = (document.getElementById("vk-keep-video") as HTMLSelectElement)?.value === "true";

  if (!whisperTool) { alert("请先安装 Whisper 工具"); return; }
  if (!embeddingEndpointId) { alert("请配置 Embedding 节点"); return; }

  const result = await apiPost<{ task_id: string }>("/v1/video-kb/ingest", {
    url,
    cookie_file: cookieFile || null,
    whisper_tool: whisperTool,
    whisper_model: whisperModel,
    language,
    embedding_endpoint_id: embeddingEndpointId,
    chunk_strategy: chunkStrategy,
    keep_video: keepVideo,
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
  if (!container) return;

  const statusIcons: Record<string, string> = {
    pending: "○",
    running: "◉",
    done: "✓",
    failed: "✗",
  };
  const statusColors: Record<string, string> = {
    pending: "var(--text-secondary)",
    running: "var(--brand-primary)",
    done: "#4caf50",
    failed: "#e85a5a",
  };

  container.innerHTML = (task.steps || []).map((step) => `
    <div style="display:flex;align-items:center;gap:0.5rem;padding:0.3rem 0;color:${statusColors[step.status] || "var(--text-primary)"}">
      <span style="font-size:1.1rem;width:1.5rem;text-align:center">${statusIcons[step.status] || "○"}</span>
      <span>${escapeHtml(step.label)}</span>
      ${step.status === "running" && step.message ? `<span style="font-size:0.8rem;color:var(--text-secondary)">- ${escapeHtml(step.message)}</span>` : ""}
      ${step.status === "running" && step.progress > 0 ? `<span style="font-size:0.8rem;color:var(--text-secondary)">(${(step.progress * 100).toFixed(0)}%)</span>` : ""}
    </div>
  `).join("");

  const overall = document.getElementById("vk-overall-progress");
  if (overall) {
    const pct = (task.progress * 100).toFixed(1);
    overall.innerHTML = `
      <div style="background:var(--input-bg);border-radius:var(--radius-md);height:6px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:var(--brand-primary);transition:width 0.3s"></div>
      </div>
      <div style="margin-top:0.25rem;font-size:0.85rem;color:var(--text-secondary)">${pct}% - ${escapeHtml(task.progress_message || "")}</div>
    `;
  }
}

function renderTaskComplete(task: TaskInfo): void {
  const overall = document.getElementById("vk-overall-progress");
  if (overall) {
    if (task.status === "succeeded" && task.result) {
      const r = task.result as Record<string, string | number | null>;
      overall.innerHTML = `
        <div style="padding:0.5rem;background:rgba(76,175,80,0.1);border-radius:var(--radius-md);color:#4caf50">
          ✓ 导入完成：${escapeHtml(String(r.title || ""))} | ${r.chunk_count} 个分块 | 语言: ${escapeHtml(String(r.detected_language || ""))}
        </div>
      `;
    } else if (task.status === "failed") {
      overall.innerHTML = `<div style="padding:0.5rem;color:#e85a5a">✗ 失败: ${escapeHtml(task.error || "")}</div>`;
    } else {
      overall.innerHTML = `<div style="padding:0.5rem;color:var(--text-secondary)">已取消</div>`;
    }
  }
}

window.videoKbSearch = async function (): Promise<void> {
  const query = (document.getElementById("vk-search-query") as HTMLInputElement)?.value?.trim();
  if (!query) return;

  const embeddingEndpointId = (document.getElementById("vk-search-embedding") as HTMLSelectElement)?.value;
  const topK = parseInt((document.getElementById("vk-search-topk") as HTMLInputElement)?.value || "5");

  const resultsDiv = document.getElementById("vk-search-results");
  if (resultsDiv) resultsDiv.innerHTML = '<div style="padding:1rem;color:var(--text-secondary)">搜索中...</div>';

  const result = await apiPost<{ results: SearchResult[] }>("/v1/video-kb/search", {
    query,
    embedding_endpoint_id: embeddingEndpointId,
    top_k: topK,
  });

  if (!result || !result.results) {
    if (resultsDiv) resultsDiv.innerHTML = '<div style="padding:1rem;color:var(--text-secondary)">搜索失败</div>';
    return;
  }

  if (result.results.length === 0) {
    if (resultsDiv) resultsDiv.innerHTML = '<div style="padding:1rem;color:var(--text-secondary)">无结果</div>';
    return;
  }

  if (resultsDiv) {
    resultsDiv.innerHTML = result.results.map((r) => `
      <div style="padding:0.75rem;margin-bottom:0.5rem;background:var(--surface);border:1px solid var(--border-color);border-radius:var(--radius-md)">
        <div style="display:flex;justify-content:space-between;margin-bottom:0.25rem">
          <span style="font-weight:600">${escapeHtml(r.video_title)}</span>
          <span style="color:var(--text-secondary);font-size:0.85rem">相似度: ${(r.score * 100).toFixed(1)}%</span>
        </div>
        <div style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:0.3rem">
          ${formatTimestamp(r.start_seconds)} - ${formatTimestamp(r.end_seconds)}
        </div>
        <div style="font-size:0.9rem;line-height:1.5">${escapeHtml(r.text)}</div>
      </div>
    `).join("");
  }
};

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

window.videoKbSwitchTab = function (tab: string): void {
  document.querySelectorAll(".video-kb-tab").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll(".video-kb-panel").forEach((el) => (el as HTMLElement).style.display = "none");
  const tabBtn = document.querySelector(`.video-kb-tab[data-tab="${tab}"]`);
  const panel = document.getElementById(`video-kb-panel-${tab}`);
  if (tabBtn) tabBtn.classList.add("active");
  if (panel) panel.style.display = "block";
  if (tab === "assets") loadVideoList();
};

async function loadVideoList(): Promise<void> {
  const panel = document.getElementById("video-kb-panel-assets");
  if (!panel) return;
  panel.innerHTML = '<div style="padding:1rem;color:var(--text-secondary)">加载中...</div>';

  const data = await apiGet<{ videos: VideoInfo[] }>("/v1/video-kb/videos");
  if (!data) return;

  if (data.videos.length === 0) {
    panel.innerHTML = '<div style="padding:1rem;color:var(--text-secondary)">暂无已索引视频</div>';
    return;
  }

  panel.innerHTML = data.videos.map((v) => `
    <div style="padding:0.75rem;margin-bottom:0.5rem;background:var(--surface);border:1px solid var(--border-color);border-radius:var(--radius-md)">
      <div style="display:flex;justify-content:space-between;align-items:start">
        <div style="flex:1">
          <div style="font-weight:600;margin-bottom:0.25rem">${escapeHtml(v.video_title)}</div>
          <div style="font-size:0.8rem;color:var(--text-secondary)">
            ${v.chunk_count} 分块 | ${formatTimestamp(v.duration_start)}-${formatTimestamp(v.duration_end)} | ${escapeHtml(v.language)} | ${new Date(v.created_at).toLocaleDateString()}
          </div>
          <div style="font-size:0.8rem;color:var(--text-secondary);margin-top:0.25rem">
            <a href="${escapeHtml(v.video_url)}" target="_blank" style="color:var(--brand-primary)">${escapeHtml(v.video_url)}</a>
          </div>
        </div>
        <div style="display:flex;gap:0.5rem">
          <button class="btn" onclick="window.videoKbViewAsset('${v.video_id}','transcript')">转录</button>
          <button class="btn" onclick="window.videoKbViewAsset('${v.video_id}','audio')">音频</button>
          <button class="btn" onclick="window.videoKbViewAsset('${v.video_id}','video')">视频</button>
          <button class="btn" style="color:#e85a5a" onclick="window.videoKbDeleteVideo('${v.video_id}')">删除</button>
        </div>
      </div>
    </div>
  `).join("");
}

window.videoKbViewAsset = function (videoId: string, type: string): void {
  window.open(`/v1/video-kb/assets/${videoId}/${type}`, "_blank");
};

window.videoKbDeleteVideo = async function (videoId: string): Promise<void> {
  if (!confirm("确认删除该视频及其所有向量数据?")) return;
  await fetch(`/v1/video-kb/videos/${videoId}`, { method: "DELETE" });
  loadVideoList();
};

window.videoKbLoadDomains = async function (): Promise<void> {
  const browser = (document.getElementById("vk-cookie-browser") as HTMLSelectElement)?.value;
  if (!browser) return;
  // Could load domains here for autocomplete, but keeping it simple with free-text input
};

window.videoKbExportCookies = async function (): Promise<void> {
  const browser = (document.getElementById("vk-cookie-browser") as HTMLSelectElement)?.value;
  if (!browser) { alert("请选择浏览器"); return; }
  const domain = (document.getElementById("vk-cookie-domain") as HTMLInputElement)?.value?.trim();

  const result = await apiPost<{ file_path: string; count: number; domains: string[] }>("/v1/cookies/export", {
    browser,
    domain: domain || undefined,
  });

  const resultDiv = document.getElementById("vk-cookie-result");
  if (resultDiv) {
    if (result?.file_path) {
      resultDiv.innerHTML = `
        <div style="padding:0.75rem;background:rgba(76,175,80,0.1);border-radius:var(--radius-md);color:#4caf50">
          ✓ 导出成功: ${result.count} 条 cookie<br>
          文件: <code>${escapeHtml(result.file_path)}</code><br>
          域名: ${escapeHtml(result.domains.join(", "))}
        </div>
      `;
      // Also update the import panel's cookie dropdown
      const cookieSelect = document.getElementById("vk-cookie") as HTMLSelectElement | null;
      if (cookieSelect) {
        cookieSelect.innerHTML = `<option value="">不需要 Cookie</option><option value="${escapeHtml(result.file_path)}" selected>cookies.txt (${result.count} 条)</option>`;
      }
    } else {
      resultDiv.innerHTML = `<div style="padding:0.75rem;color:#e85a5a">导出失败</div>`;
    }
  }
};
