import { escapeHtml } from "./core/dom";
import { showToast } from "./core/ui";
import { getConfig, loadSyncStatus, fetchJson } from "./core/api";

let config = {
    server: { host: "127.0.0.1", port: 8787 },
    clients: { code: { endpoints: [], model_slots: {} }, desktop: { endpoints: [] }, codex: { endpoints: [] }, deeptutor: { endpoints: [] } }
};
let codexModelCatalogPath = "~/.codex/gateway-model-catalog.json";

// Craft-style navigation: null = card list, {client,index} = detail editor
let selectedEndpoint = null;
let activeClient = 'code';
let toolsView = 'cards'; // 'cards' | 'embedding' | 'classification-metrics' | 'antigravity-subscribe' | 'codex-subscribe'
let codexAuthState = {
    loading: false,
    busyAction: '',
    error: '',
    message: '',
    status: null,
};
let antigravityAuthState = {
    loading: false,
    busyAction: '',
    error: '',
    message: '',
    showManual: false,
    clientId: '',
    clientSecret: '',
    status: null,
    authUrl: '',
    sessionId: '',
    loginPollTimer: null,
    loginStartedAt: 0,
};
const metricsState = {
    scenario: 'spam',
    inputMode: 'guided',
    tp: 40,
    fp: 10,
    fn: 20,
    tn: 130,
    guided: {
        total: 200,
        selected: 50,
        selectedWrong: 10,
        missedActual: 20,
    },
};
const metricsScenarios = {
    spam: {
        id: 'spam',
        title: '垃圾邮件拦截',
        summary: '拦垃圾邮件时，误伤正常邮件和漏拦垃圾邮件都很常见。',
        lesson: '精准率低=正常邮件被误伤；召回率低=垃圾邮件漏进来。',
        counts: { tp: 40, fp: 10, fn: 20, tn: 130 },
    },
    disease: {
        id: 'disease',
        title: '疾病筛查',
        summary: '筛查场景通常更害怕漏诊，所以会更关注召回率。',
        lesson: '召回高但精准低，意味着少漏诊，但会有更多人被误报。',
        counts: { tp: 18, fp: 30, fn: 2, tn: 150 },
    },
    imbalance: {
        id: 'imbalance',
        title: '类别不平衡陷阱',
        summary: '正例很少时，全预测成负例也可能得到很高准确率。',
        lesson: '准确率 99% 也可能完全没用，因为真实正例一个都没抓到。',
        counts: { tp: 0, fp: 0, fn: 10, tn: 990 },
    },
};
const embedState = {
    client: 'codex',
    endpointId: '',
    model: '',
    customDims: false,
    dimensions: '',
    mode: 'single', // 'single' | 'similarity'
    textA: '',
    textB: '',
    result: null,
    loading: false,
    error: ''
};
// Media-type state stays isolated so video/TTS can share only the generic helpers below.
const imageGenState = {
    client: 'codex',
    endpointId: '',
    model: '',
    prompt: '',
    aspectRatio: 'auto',
    imagePaths: '',
    result: null,
    loading: false,
    error: '',
    history: [],
    historyLoading: false,
    historyLoaded: false,
    referenceNotice: ''
};
const videoGenState = {
    client: 'codex',
    endpointId: '',
    model: '',
    prompt: '',
    aspectRatio: '16:9',
    duration: 5,
    imagePaths: '',
    taskId: null,
    pollStatus: '',
    pollProgress: null,
    result: null,
    loading: false,
    error: '',
    history: [],
    historyLoading: false,
    historyLoaded: false,
    referenceNotice: ''
};
const ttsGenState = {
    client: 'codex',
    endpointId: '',
    model: '',
    text: '',
    voice: 'zh_female_qingxin',
    encoding: 'mp3',
    speedRatio: 1.0,
    result: null,
    loading: false,
    error: '',
    history: [],
    historyLoading: false,
    historyLoaded: false
};
const MEDIA_HISTORY_PATHS = {
    image: '/v1/media/history?media_type=image',
    video: '/v1/media/history?media_type=video',
    tts: '/v1/media/history?media_type=tts'
};
// Tools register their own state/render pair, so history actions stay media-type neutral.
const MEDIA_HISTORY_TOOL_REGISTRY = new Map();
function registerMediaHistoryTool(mediaType, toolId, state, render) {
    MEDIA_HISTORY_TOOL_REGISTRY.set(mediaType, { toolId, state, render });
}
let lastLoadedSyncTargets = { antigravity: true, claude: true, codex: true };

const ENDPOINT_TYPES = [
    { value: "anthropic", label: "Anthropic Messages 协议" },
    { value: "openai-chat", label: "OpenAI Chat 补全格式" },
    { value: "openai-responses", label: "OpenAI Responses (实验性)" },
    { value: "grok", label: "Grok 订阅" },
    { value: "antigravity", label: "Antigravity（Google 订阅）" },
    { value: "codex-subscription", label: "Codex 订阅（ChatGPT）" }
];
const CODEX_ENDPOINT_TYPE_VALUES = ['anthropic', 'openai-responses', 'openai-chat', 'grok', 'antigravity'];

// Media endpoints use purpose + provider; `type` remains exclusive to chat protocols.
const MEDIA_ENDPOINT_PURPOSES = [
    { purpose: 'image_generation', title: '图片生成节点', groupTitle: '图片生成', description: '配置图片生成服务商', icon: '<rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="m21 15-5-5L5 21"></path>' },
    { purpose: 'video_generation', title: '视频生成节点', groupTitle: '视频生成', description: '配置视频生成服务商', icon: '<rect x="3" y="5" width="14" height="14" rx="2"></rect><path d="m17 10 4-2v8l-4-2z"></path>' },
    { purpose: 'audio_tts', title: 'TTS 节点', groupTitle: 'TTS 语音合成', description: '配置文本转语音服务商', icon: '<path d="M11 5 6 9H2v6h4l5 4z"></path><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M19 5a10 10 0 0 1 0 14"></path>' },
];
const MEDIA_PROVIDERS = [
    { value: 'grok-subscription', label: 'Grok 订阅', baseUrl: 'https://cli-chat-proxy.grok.com/v1', subscription: true },
    { value: 'codex-subscription', label: 'Codex 订阅（ChatGPT）', baseUrl: 'https://chatgpt.com/backend-api/codex', subscription: true },
    { value: 'antigravity', label: 'Antigravity（Google 订阅）', baseUrl: 'https://daily-cloudcode-pa.googleapis.com', subscription: true },
    { value: 'huoshan-agentplan', label: '火山 AgentPlan', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', subscription: false },
];
const MEDIA_PRESET_MODELS = {
    'grok-subscription': {
        image_generation: ['grok-imagine-image-quality'],
        video_generation: ['grok-imagine-video-1.5-preview'],
        audio_tts: []
    },
    'codex-subscription': {
        image_generation: ['gpt-image-2'],
        video_generation: [],
        audio_tts: []
    },
    'antigravity': {
        image_generation: ['gemini-3.1-flash-image'],
        video_generation: [],
        audio_tts: []
    },
    'huoshan-agentplan': {
        image_generation: ['doubao-seedream-5-0-lite-260128'],
        video_generation: ['doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-mini-260615'],
        audio_tts: ['doubao-seed-tts-2.0']
    }
};
function mediaPresetModels(provider, purpose) {
    return MEDIA_PRESET_MODELS[provider]?.[purpose] || [];
}

function mediaPurposeDefinition(purpose) {
    return MEDIA_ENDPOINT_PURPOSES.find(item => item.purpose === purpose);
}

function isMediaEndpoint(endpoint) {
    return Boolean(mediaPurposeDefinition(endpoint?.purpose));
}

function isCapabilityEndpointPurpose(purpose) {
    return ['vision_fallback', 'web_search', 'embedding'].includes(purpose)
        || Boolean(mediaPurposeDefinition(purpose));
}

function mediaProviderDefinition(provider) {
    return MEDIA_PROVIDERS.find(item => item.value === provider) || MEDIA_PROVIDERS[0];
}

function mediaProviderBaseUrl(endpoint) {
    const provider = mediaProviderDefinition(endpoint?.provider);
    return provider.subscription ? provider.baseUrl : (endpoint?.base_url || provider.baseUrl);
}

// The four shipped agent-node groups; the sidebar lists them first and they cannot be removed.
const BUILTIN_CLIENTS = ['code', 'desktop', 'codex', 'deeptutor'];
const CLIENT_DISPLAY_NAMES = {
    code: 'Claude Code',
    desktop: 'Claude Desktop',
    codex: 'Codex',
    deeptutor: 'DeepTutor',
};

// Custom agent-node groups come from config.clients minus the built-ins.
function customClientNames() {
    const all = Object.keys(config.clients || {});
    return all.filter(name => !BUILTIN_CLIENTS.includes(name));
}

function isCustomClient(name) {
    return Boolean(name) && !BUILTIN_CLIENTS.includes(name) && Boolean(config.clients?.[name]);
}

function clientDisplayName(client) {
    const key = String(client || '').trim();
    if (!key) return '';
    return CLIENT_DISPLAY_NAMES[key] || key;
}

const endpointModelDiscoveryState = new Map();
const BUILTIN_CLAUDE_OFFICIAL_MODELS = [
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-5',
    'claude-haiku-4-5',
    'claude-haiku-4-0',
];

function getClaudeModelCatalogConfig() {
    config.tools = config.tools || {};
    config.tools.claude_model_catalog = config.tools.claude_model_catalog || { user_models: [], disabled_builtin_models: [] };
    const cat = config.tools.claude_model_catalog;
    if (!Array.isArray(cat.user_models)) cat.user_models = [];
    if (!Array.isArray(cat.disabled_builtin_models)) cat.disabled_builtin_models = [];
    return cat;
}

function mergeClaudeOfficialModelsLocal() {
    const cat = getClaudeModelCatalogConfig();
    const disabled = new Set(cat.disabled_builtin_models || []);
    const out = [];
    const seen = new Set();
    for (const id of [...BUILTIN_CLAUDE_OFFICIAL_MODELS, ...cat.user_models]) {
        const model = String(id || '').trim();
        if (!model || seen.has(model)) continue;
        if (disabled.has(model) && BUILTIN_CLAUDE_OFFICIAL_MODELS.includes(model) && !cat.user_models.includes(model)) continue;
        seen.add(model);
        out.push(model);
    }
    return out;
}

function getUsedClaudeDesktopMappingSources() {
    const used = new Set();
    const endpoints = config.clients?.desktop?.endpoints || [];
    for (const endpoint of endpoints) {
        const purpose = endpoint?.purpose;
        if (purpose && purpose !== 'chat') continue;
        for (const source of Object.keys(endpoint?.model_mapping || {})) {
            const id = String(source || '').trim();
            if (id) used.add(id);
        }
    }
    return used;
}

function availableClaudeDesktopMappingSources(query = '') {
    const q = String(query || '').trim().toLowerCase();
    const used = getUsedClaudeDesktopMappingSources();
    return mergeClaudeOfficialModelsLocal()
        .filter((id) => !used.has(id))
        .filter((id) => !q || id.toLowerCase().includes(q));
}

function discoveryKey(client, endpointId) {
    return `${client}::${endpointId}`;
}

function getDiscoveryState(client, endpointId) {
    const key = discoveryKey(client, endpointId);
    if (!endpointModelDiscoveryState.has(key)) {
        endpointModelDiscoveryState.set(key, {
            loading: false,
            error: '',
            notice: '',
            models: [],
            fetchedAt: '',
            source: '',
            strategy: '',
            requestId: 0,
        });
    }
    return endpointModelDiscoveryState.get(key);
}

async function fetchEndpointModels(client, endpointId, { refresh = false } = {}) {
    const state = getDiscoveryState(client, endpointId);
    const requestId = ++state.requestId;
    state.loading = true;
    state.error = '';
    updateDiscoveryMeta(client, endpointId);
    try {
        const qs = new URLSearchParams({ client: client || '', refresh: refresh ? '1' : '0' });
        const res = await fetch(`/v1/config/endpoints/${encodeURIComponent(endpointId)}/models?${qs.toString()}`, {
            headers: { 'X-Gateway-Config-Client': client || '' },
        });
        const json = await res.json().catch(() => ({}));
        if (requestId !== state.requestId) return state;
        if (!res.ok) throw new Error(json?.error?.message || `发现失败 (${res.status})`);
        state.models = Array.isArray(json.models) ? json.models : [];
        state.fetchedAt = json.fetched_at || '';
        state.source = json.source || '';
        state.strategy = json.strategy || '';
        state.error = json.error?.message || '';
        state.notice = json.notice || '';
    } catch (err) {
        if (requestId !== state.requestId) return state;
        state.error = err.message || String(err);
    } finally {
        if (requestId === state.requestId) {
            state.loading = false;
            updateDiscoveryMeta(client, endpointId);
            renderDiscoverySuggestions(client, endpointId);
        }
    }
    return state;
}

function updateDiscoveryMeta(client, endpointId) {
    const meta = document.getElementById(`model-discovery-meta-${client}-${endpointId}`);
    if (!meta) return;
    const state = getDiscoveryState(client, endpointId);
    if (state.loading) {
        meta.className = 'model-suggest-meta';
        meta.textContent = '正在获取上游模型列表...';
        return;
    }
    if (state.error && !state.models.length) {
        meta.className = 'model-suggest-meta is-error';
        meta.textContent = state.error;
        return;
    }
    meta.className = 'model-suggest-meta';
    if (!state.models.length) {
        meta.textContent = '暂无上游模型，可手动输入';
        return;
    }
    const notice = state.notice || (state.error && state.models.length ? state.error : '');
    meta.textContent = `已发现 ${state.models.length} 个模型`
      + (state.strategy ? ` · ${state.strategy}` : '')
      + (notice ? ` · ${notice}` : '');
}

function renderDiscoverySuggestions(client, endpointId) {
    const list = document.getElementById(`model-discovery-list-${client}-${endpointId}`);
    if (!list) return;
    const state = getDiscoveryState(client, endpointId);
    const q = String(document.getElementById(`input-models-${client}-${getEndpointIndex(client, endpointId)}`)?.value || '').trim().toLowerCase();
    const models = state.models.filter((m) => !q || String(m.id || '').toLowerCase().includes(q) || String(m.name || '').toLowerCase().includes(q) || String(m.domain || '').toLowerCase().includes(q));
    if (!models.length) {
        list.innerHTML = `<div class="ui-select-empty">${state.loading ? '加载中...' : '无匹配模型'}</div>`;
        return;
    }
    list.innerHTML = models.slice(0, 80).map((m) => {
        const id = escapeHtml(m.id || m.name || '');
        const name = escapeHtml(m.name || '');
        const displayText = (name && name !== id)
            ? `${id} <span style="opacity:0.65;font-size:11px">(${name})</span>`
            : id;
        const domainBadge = m.domain
            ? `<span class="model-domain-badge">${escapeHtml(m.domain)}</span>`
            : '';
        return `<button type="button" class="model-suggest-item" title="${id}" onclick="addDiscoveredUpstreamModel('${client}', '${escapeHtml(endpointId)}', ${JSON.stringify(String(m.id || ''))})"><span>${displayText}</span>${domainBadge}</button>`;
    }).join('');
}

function getEndpointIndex(client, endpointId) {
    const eps = config.clients?.[client]?.endpoints || [];
    return eps.findIndex((ep) => ep.id === endpointId);
}

window.refreshEndpointModels = function(client, endpointId) {
    fetchEndpointModels(client, endpointId, { refresh: true });
};

window.addDiscoveredUpstreamModel = function(client, endpointId, modelId) {
    const index = getEndpointIndex(client, endpointId);
    if (index < 0 || !modelId) return;
    const ep = config.clients[client].endpoints[index];
    ep.models = Array.isArray(ep.models) ? ep.models : [];
    if (!ep.models.includes(modelId)) ep.models.push(modelId);
    render();
    // reopen detail
    setTimeout(() => {
        const card = document.getElementById(`ep-${client}-${index}`);
        if (card) openEndpointDetail(client, index);
    }, 0);
};

window.openModelSuggest = function(client, endpointId, which) {
    document.querySelectorAll('.model-suggest-wrap.is-open').forEach((el) => el.classList.remove('is-open'));
    const wrap = document.getElementById(`model-suggest-${which}-${client}-${endpointId}`);
    if (wrap) wrap.classList.add('is-open');
    // Auto-discover when user focuses upstream model or mapping target fields.
    if ((which === 'upstream' || which === 'map-target') && endpointId) {
        const state = getDiscoveryState(client, endpointId);
        if (!state.loading && (!state.models.length || !state.fetchedAt)) {
            fetchEndpointModels(client, endpointId, { refresh: false }).then(() => {
                if (which === 'upstream') renderDiscoverySuggestions(client, endpointId);
                if (which === 'map-target') renderMappingTargetSuggestions(client, endpointId);
            });
        }
    }
    if (which === 'upstream') renderDiscoverySuggestions(client, endpointId);
    if (which === 'map-target') renderMappingTargetSuggestions(client, endpointId);
    if (which === 'map-source') renderMappingSourceSuggestions(client, endpointId);
};

function renderMappingTargetSuggestions(client, endpointId) {
    const list = document.getElementById(`map-target-list-${client}-${endpointId}`);
    if (!list) return;
    const state = getDiscoveryState(client, endpointId);
    const index = getEndpointIndex(client, endpointId);
    const q = String(document.getElementById(`input-mapping-up-${client}-${index}`)?.value || '').trim().toLowerCase();
    const models = (state.models || []).filter((m) => !q || String(m.id || '').toLowerCase().includes(q) || String(m.name || '').toLowerCase().includes(q) || String(m.domain || '').toLowerCase().includes(q));
    list.innerHTML = models.length
        ? models.slice(0, 80).map((m) => {
            const id = escapeHtml(m.id || m.name || '');
            const name = escapeHtml(m.name || '');
            const displayText = (name && name !== id)
                ? `${id} <span style="opacity:0.65;font-size:11px">(${name})</span>`
                : id;
            const domainBadge = m.domain
                ? `<span class="model-domain-badge">${escapeHtml(m.domain)}</span>`
                : '';
            return `<button type="button" class="model-suggest-item" title="${id}" onclick="fillMappingField('${client}', ${index}, 'up', ${JSON.stringify(String(m.id || ''))})"><span>${displayText}</span>${domainBadge}</button>`;
        }).join('')
        : `<div class="ui-select-empty">${state.loading ? '加载中...' : '无匹配上游模型'}</div>`;
}

function renderMappingSourceSuggestions(client, endpointId) {
    const list = document.getElementById(`map-source-list-${client}-${endpointId}`);
    if (!list) return;
    const index = getEndpointIndex(client, endpointId);
    const q = String(document.getElementById(`input-mapping-req-${client}-${index}`)?.value || '').trim();
    // Desktop source suggestions are global across all Claude Desktop chat nodes.
    const models = client === 'desktop'
        ? availableClaudeDesktopMappingSources(q)
        : mergeClaudeOfficialModelsLocal().filter((id) => !q || id.toLowerCase().includes(q.toLowerCase()));
    list.innerHTML = models.length
        ? models.map((id) => `<button type="button" class="model-suggest-item" onclick="fillMappingField('${client}', ${index}, 'req', ${JSON.stringify(id)})">${escapeHtml(id)}</button>`).join('')
        : `<div class="ui-select-empty">${client === 'desktop' ? '没有剩余可映射的 Claude 官方模型' : '无匹配 Claude 模型'}</div>`;
}

window.fillMappingField = function(client, index, side, value) {
    const id = side === 'req' ? `input-mapping-req-${client}-${index}` : `input-mapping-up-${client}-${index}`;
    const input = document.getElementById(id);
    if (input) input.value = value;
    document.querySelectorAll('.model-suggest-wrap.is-open').forEach((el) => el.classList.remove('is-open'));
};


function protocolLabel(protocol) {
    return protocol === 'openai' ? 'OpenAI 兼容' : 'Anthropic Messages';
}

// Update a custom agent-node group's protocol and persist it.
window.setCustomClientProtocol = async function(client, protocol) {
    if (!isCustomClient(client)) return;
    const previous = config.clients[client]?.protocol || 'anthropic';
    if (config.clients[client]) config.clients[client].protocol = protocol;
    render();
    const saved = await saveConfig({ client, scope: 'node' });
    if (!saved && config.clients[client]) config.clients[client].protocol = previous;
    render();
};

// Normalize a user-supplied agent-node name into a stable, filesystem-safe key.
// Mirrors server.js slugifyClientName so both sides agree on the canonical form.
function slugifyClientName(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
}

let clientCreateOpen = false;

window.openClientCreateModal = function(event) {
    event?.preventDefault?.();
    clientCreateOpen = true;
    const overlay = document.getElementById('client-create-modal');
    overlay.classList.add('open');
    const nameInput = document.getElementById('client-create-name');
    nameInput.value = '';
    // Pre-select empty mode and refresh the source dropdown.
    setClientCreateMode('empty');
    refreshClientCreateSources();
    // Reset the radio explicitly in case the DOM retained a prior selection.
    const emptyRadio = document.querySelector('input[name="client-create-mode"][value="empty"]');
    if (emptyRadio) emptyRadio.checked = true;
    // Default protocol follows the copy source when one is selected.
    syncClientCreateProtocol();
    setTimeout(() => nameInput.focus(), 0);
};

// Keep the protocol picker in sync with the chosen source: codex/deeptutor
// imply OpenAI-compatible, everything else Anthropic.
function clientProtocolFor(clientName) {
    if (clientName === 'codex' || clientName === 'deeptutor') return 'openai';
    const configured = config.clients?.[clientName]?.protocol;
    return configured === 'openai' ? 'openai' : 'anthropic';
}

function syncClientCreateProtocol() {
    const select = document.getElementById('client-create-protocol');
    if (!select) return;
    const modeRadio = document.querySelector('input[name="client-create-mode"]:checked');
    const useCopy = modeRadio && modeRadio.value === 'copy';
    const source = document.getElementById('client-create-source')?.value || '';
    select.value = useCopy ? clientProtocolFor(source) : 'anthropic';
}

window.closeClientCreateModal = function() {
    clientCreateOpen = false;
    const overlay = document.getElementById('client-create-modal');
    overlay.classList.remove('open');
};

function setClientCreateMode(mode) {
    const emptyOpt = document.getElementById('client-create-mode-empty');
    const copyOpt = document.getElementById('client-create-mode-copy');
    const copyConfig = document.getElementById('client-create-copy-config');
    if (!emptyOpt || !copyOpt || !copyConfig) return;
    emptyOpt.classList.toggle('is-selected', mode === 'empty');
    copyOpt.classList.toggle('is-selected', mode === 'copy');
    copyConfig.classList.toggle('is-visible', mode === 'copy');
}

// Radio change handler (wired in init via addEventListener for reliability).
function onClientCreateModeChange(event) {
    setClientCreateMode(event.target.value);
}

function refreshClientCreateSources() {
    const select = document.getElementById('client-create-source');
    if (!select) return;
    const names = Object.keys(config.clients || {});
    select.innerHTML = names.map(name =>
        `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`
    ).join('');
}

window.submitCreateClient = async function() {
    const nameInput = document.getElementById('client-create-name');
    const rawName = nameInput ? nameInput.value : '';
    const client = slugifyClientName(rawName);
    if (!client) { showToast('请填写有效的节点标识（字母、数字、连字符）', 'error'); return; }
    const modeRadio = document.querySelector('input[name="client-create-mode"]:checked');
    const useCopy = modeRadio && modeRadio.value === 'copy';
    const copyFrom = useCopy ? (document.getElementById('client-create-source')?.value || '') : '';
    if (useCopy && !copyFrom) { showToast('请选择复制来源', 'error'); return; }
    if (useCopy && copyFrom === client) { showToast('复制来源不能和节点标识相同', 'error'); return; }

    const okBtn = document.getElementById('client-create-ok');
    const original = okBtn ? okBtn.innerHTML : '';
    if (okBtn) { okBtn.disabled = true; okBtn.innerHTML = '创建中...'; }
    try {
        const protocol = document.getElementById('client-create-protocol')?.value || 'anthropic';
    const body = useCopy
            ? { client, copyFrom, mode: 'replace', protocol }
            : { client, protocol };
        const res = await fetch('/v1/config/add-client', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            showToast(data.error || '创建代理节点失败', 'error');
            return;
        }
        await loadConfig();
        window.closeClientCreateModal();
        switchTab('custom-clients');
        showToast(`已创建代理节点「${client}」`, 'success');
    } catch (e) {
        showToast('创建代理节点失败：网络错误', 'error');
    } finally {
        if (okBtn) { okBtn.disabled = false; okBtn.innerHTML = original; }
    }
};

window.removeCustomClient = async function(client) {
    if (!isCustomClient(client)) return;
    if (!confirm(`确定删除代理节点「${client}」吗？

该代理组下的所有节点配置和密钥都会被移除，此操作不可撤销。`)) return;
    try {
        const res = await fetch('/v1/config/remove-client', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            showToast(data.error || '删除代理节点失败', 'error');
            return;
        }
        if (activeClient === client) {
            activeClient = 'custom-clients';
        }
        await loadConfig();
        render();
        showToast(`已删除代理节点「${client}」`, 'success');
    } catch (e) {
        showToast('删除代理节点失败：网络错误', 'error');
    }
};

// Render the sidebar nav items for custom agent-node groups.
function renderCustomClientNav() {
    const container = document.getElementById('nav-custom-clients');
    if (!container) return;
    const names = customClientNames();
    if (!names.length) { container.innerHTML = ''; return; }
    container.innerHTML = names.map(name => `
        <a href="#${escapeHtml(name)}" class="nav-item nav-item-custom" onclick="switchTab('${escapeHtml(name)}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 8px; flex-shrink: 0;"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
            <span class="nav-item-name">${escapeHtml(name)}</span>
            <span class="nav-item-badge">自定义</span>
        </a>
    `).join('');
}

// Render the body of the custom-clients section: each custom group uses the
// same section-header + endpoints-grid layout as the built-in agents, so the
// visual treatment stays consistent across built-in and custom nodes.
function renderCustomClientSections() {
    const container = document.getElementById('custom-clients-container');
    if (!container) return;
    const names = customClientNames();
    const inDetail = selectedEndpoint && isCustomClient(selectedEndpoint.client);

    if (!names.length) {
        container.innerHTML = `
            <div class="empty-state">
                <p>还没有自定义代理节点。</p>
                <button class="btn" onclick="openClientCreateModal(event)">新建代理节点</button>
            </div>
        `;
        return;
    }

    container.innerHTML = names.map(client => {
        const eps = config.clients[client].endpoints || [];
        const protocol = config.clients[client].protocol || 'anthropic';
        const detailForThis = inDetail && selectedEndpoint.client === client;
        const header = `
            <div class="section-header custom-client-section-header" id="custom-client-block-${escapeHtml(client)}">
                <div>
                    <h2>${escapeHtml(client)} 代理</h2>
                    <p>接入协议：${escapeHtml(protocolLabel(protocol))} · 路由前缀 <code>/${escapeHtml(client)}/</code></p>
                </div>
                <div class="section-header-actions">
                    <select class="custom-client-protocol-select" title="切换接入协议" onchange="setCustomClientProtocol('${escapeHtml(client)}', this.value)">
                        <option value="anthropic" ${protocol !== 'openai' ? 'selected' : ''}>Anthropic</option>
                        <option value="openai" ${protocol === 'openai' ? 'selected' : ''}>OpenAI 兼容</option>
                    </select>
                    <div class="add-node-dropdown" id="add-node-dropdown-${escapeHtml(client)}">
                        <button type="button" class="btn add-node-trigger" aria-expanded="false" aria-haspopup="menu" onclick="toggleAddNodeMenu('${escapeHtml(client)}', event)">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                            添加节点
                            <svg class="add-node-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                        </button>
                        <div class="add-node-popover" role="menu" data-client="${escapeHtml(client)}"></div>
                    </div>
                    <button class="btn btn-sm btn-danger" title="删除此代理节点" onclick="removeCustomClient('${escapeHtml(client)}')" aria-label="删除此代理节点">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                        删除代理节点
                    </button>
                </div>
            </div>
        `;
        // Connection guide mirrors the built-in agents: show the base_url with
        // a copy button. Only render it in list view (hidden in detail mode).
        // Show a separate embedding base_url when the group has an embedding node.
        const showGuide = !detailForThis;
        const hasEmbedding = eps.some(ep => ep.purpose === 'embedding');
        const copyIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
        const copyBtn = `<button type="button" class="code-snippet-copy" title="复制" onclick="copyCodeSnippet(this)" aria-label="复制">${copyIcon}</button>`;
        const preAttr = 'style="margin: 0; color: inherit; font-family: inherit; font-size: inherit; background: transparent; padding: 0; overflow-x: auto;"';
        const chatSnippet = `
            <div class="code-snippet">
                ${copyBtn}
                <pre ${preAttr}>大语言模型 base_url：http://<span class="cfg-host">127.0.0.1</span>:<span class="cfg-port">8787</span>/${escapeHtml(client)}/</pre>
            </div>`;
        const embeddingSnippet = hasEmbedding ? `
            <div class="code-snippet">
                ${copyBtn}
                <pre ${preAttr}>向量模型 base_url：http://<span class="cfg-host">127.0.0.1</span>:<span class="cfg-port">8787</span>/${escapeHtml(client)}/emb/embeddings</pre>
            </div>` : '';
        const guide = showGuide ? `
            <div class="usage-guide">
                <h3>🚀 如何连接此网关？</h3>
                <p>${escapeHtml(client)} 走 ${escapeHtml(protocolLabel(protocol))} 协议。把下面的地址填入客户端作为 API 入口：</p>
                <div style="display:flex; flex-direction:column; gap:8px; margin-top: 10px;">
                    ${chatSnippet}
                    ${embeddingSnippet}
                </div>
                <p style="font-size: 12px; margin-top: 8px; margin-bottom: 0; color: var(--text-secondary);">保存节点配置后即时生效。客户端若已连接，重启或重载后可见。${hasEmbedding ? '' : '尚未配置向量节点，向量模型路径暂不展示。'}</p>
            </div>
        ` : '';
        let body;
        const gridId = `${client}-endpoints`;
        if (detailForThis) {
            const ep = eps[selectedEndpoint.index];
            body = `<div id="${gridId}" class="node-groups">${ep ? createEndpointDetailHTML(client, selectedEndpoint.index, ep) : ''}</div>`;
        } else if (!eps.length) {
            body = guide + `
                <div id="${gridId}" class="node-groups">
                    <div class="empty-state">
                        <p>${escapeHtml(client)} 尚未配置任何节点。</p>
                        <button class="btn" onclick="addEndpoint('${escapeHtml(client)}')">创建第一个节点</button>
                    </div>
                </div>
            `;
        } else {
            body = guide + `<div id="${gridId}" class="node-groups">${createEndpointGroupsHTML(client, eps)}</div>`;
        }
        return header + body;
    }).join('');

    // Populate add-node popovers for the freshly rendered custom blocks.
    renderAddNodeMenus();
}

const ADD_NODE_OPTIONS = [
    {
        purpose: 'chat',
        title: '聊天模型',
        description: '配置普通对话与推理模型',
        icon: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"></path>',
    },
    {
        purpose: 'vision_fallback',
        title: '视觉兜底',
        description: '为不支持图片的模型补充视觉理解',
        icon: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"></path><circle cx="12" cy="12" r="3"></circle>',
    },
    {
        purpose: 'web_search',
        title: '联网搜索',
        description: '接入实时搜索提供商',
        icon: '<circle cx="11" cy="11" r="7"></circle><line x1="20" y1="20" x2="16.65" y2="16.65"></line>',
    },
    {
        purpose: 'embedding',
        title: '向量模型',
        description: '配置 OpenAI 兼容 Embeddings 接口',
        icon: '<circle cx="5" cy="12" r="2"></circle><circle cx="12" cy="5" r="2"></circle><circle cx="19" cy="12" r="2"></circle><circle cx="12" cy="19" r="2"></circle><path d="M6.5 10.5l4-4M13.5 6.5l4 4M17.5 13.5l-4 4M10.5 17.5l-4-4"></path>',
    },
    ...MEDIA_ENDPOINT_PURPOSES,
];

function createAddNodeOptionsHTML(client) {
    return ADD_NODE_OPTIONS.map(option => `
        <button type="button" class="add-node-option" role="menuitem"
            onclick="addNodeByPurpose('${client}', '${option.purpose}')">
            <span class="add-node-option-icon" aria-hidden="true">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    ${option.icon}
                </svg>
            </span>
            <span class="add-node-option-copy">
                <span class="add-node-option-title">${option.title}</span>
                <span class="add-node-option-description">${option.description}</span>
            </span>
        </button>
    `).join('');
}

function renderAddNodeMenus() {
    document.querySelectorAll('.add-node-popover[data-client]').forEach(popover => {
        popover.innerHTML = createAddNodeOptionsHTML(popover.dataset.client);
    });
}

function currentProxyFormValue() {
    return {
        enabled: Boolean(document.getElementById('proxy-enabled')?.checked),
        protocol: document.getElementById('proxy-protocol')?.value || 'http',
        host: document.getElementById('proxy-host')?.value.trim() || '127.0.0.1',
        port: Number(document.getElementById('proxy-port')?.value) || 7897,
        username: document.getElementById('proxy-username')?.value || '',
        password: document.getElementById('proxy-password')?.value || '',
    };
}

window.loadProxyConfig = async function() {
    try {
        const res = await fetch('/v1/config/proxy');
        const proxy = await res.json();
        if (!res.ok) throw new Error(proxy?.error?.message || `加载失败 (${res.status})`);
        document.getElementById('proxy-enabled').checked = proxy.enabled !== false;
        document.getElementById('proxy-protocol').value = proxy.protocol || 'http';
        document.getElementById('proxy-host').value = proxy.host || '127.0.0.1';
        document.getElementById('proxy-port').value = Number(proxy.port) || 7897;
        document.getElementById('proxy-username').value = proxy.username || '';
        document.getElementById('proxy-password').value = proxy.password || '';
        config.server ||= {};
        config.server.proxy = proxy;
        renderProxyEndpointsList();
    } catch (error) {
        showToast(`加载代理配置失败：${error.message || error}`, 'error');
    }
};

window.saveProxyConfig = async function(event) {
    event?.preventDefault();
    const submit = event?.submitter || document.querySelector('#proxy-config-form button[type="submit"]');
    const original = submit?.textContent || '';
    if (submit) {
        submit.disabled = true;
        submit.textContent = '保存中...';
    }
    try {
        const res = await fetch('/v1/config/proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(currentProxyFormValue()),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.success === false) {
            throw new Error(data?.error?.message || data?.error || `保存失败 (${res.status})`);
        }
        config.server ||= {};
        config.server.proxy = data.proxy;
        renderProxyEndpointsList();
        showToast('代理配置已保存并即时生效', 'success');
    } catch (error) {
        showToast(`保存代理配置失败：${error.message || error}`, 'error');
    } finally {
        if (submit) {
            submit.disabled = false;
            submit.textContent = original;
        }
    }
};

window.testProxyConnection = async function() {
    const resultCard = document.getElementById('proxy-test-result');
    const content = document.getElementById('proxy-test-content');
    if (resultCard) resultCard.style.display = 'block';
    if (content) content.innerHTML = '<span style="color:var(--text-secondary)">正在通过当前表单代理测试 https://api.openai.com ...</span>';
    try {
        const res = await fetch('/v1/config/proxy/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                proxy: currentProxyFormValue(),
                target_url: 'https://api.openai.com',
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error(data?.error?.message || data?.error || '代理连接失败');
        }
        if (content) {
            content.innerHTML = `<span style="color:#10b981;font-weight:600">连接成功</span>
                <span style="margin-left:12px;color:var(--text-secondary)">HTTP ${Number(data.status) || 0} · ${Number(data.latency_ms) || 0} ms</span>`;
        }
    } catch (error) {
        if (content) content.innerHTML = `<span style="color:#ef4444;font-weight:600">连接失败：</span>${escapeHtml(error.message || String(error))}`;
    }
};

window.renderProxyEndpointsList = function() {
    const container = document.getElementById('proxy-endpoints-list');
    if (!container) return;
    const globalProxy = config.server?.proxy || currentProxyFormValue();
    const globalEnabled = globalProxy.enabled !== false;
    const globalLabel = globalEnabled
        ? `${String(globalProxy.protocol || 'http').toUpperCase()}://${globalProxy.host || '127.0.0.1'}:${globalProxy.port || 7897}`
        : '已关闭';
    const items = Object.entries(config.clients || {}).flatMap(([client, body]) =>
        (body?.endpoints || []).map(endpoint => {
            const mode = String(endpoint.proxy_mode || 'global');
            const legacyProxy = typeof endpoint.proxy === 'string' ? endpoint.proxy : '';
            const isDirect = mode === 'disabled' || endpoint.proxy === '';
            const isCustom = (mode === 'custom' && endpoint.proxy_url) || Boolean(legacyProxy);
            const effectiveType = isDirect ? 'direct'
                : isCustom ? 'custom'
                : (globalEnabled ? 'global' : 'direct');
            const effectiveText = effectiveType === 'direct' ? '直连'
                : effectiveType === 'custom' ? `自定义 · ${endpoint.proxy_url || legacyProxy}`
                : '全局代理';
            let host = '';
            try { host = endpoint.base_url ? new URL(endpoint.base_url).host : (endpoint.type === 'codex-subscription' ? 'chatgpt.com' : endpoint.type === 'antigravity' ? 'cloudcode-pa.googleapis.com' : '—'); } catch { host = endpoint.base_url || '—'; }
            const action = (effectiveType === 'direct')
                ? `<button class="btn btn-xs" data-proxy-client="${client}" data-proxy-index="${(body.endpoints.indexOf(endpoint))}" onclick="setEndpointProxyMode(this, 'global')">恢复全局</button>`
                : `<button class="btn btn-xs btn-danger" data-proxy-client="${client}" data-proxy-index="${(body.endpoints.indexOf(endpoint))}" onclick="setEndpointProxyMode(this, 'disabled')">直连</button>`;
            return {
                effectiveType,
                html: `<tr>
                <td style="padding:9px 10px;border-bottom:1px solid var(--border-color)">${escapeHtml(client)}</td>
                <td style="padding:9px 10px;border-bottom:1px solid var(--border-color)">${escapeHtml(endpoint.name || endpoint.id || '未命名节点')}</td>
                <td style="padding:9px 10px;border-bottom:1px solid var(--border-color);font-family:var(--font-mono);font-size:12px;color:var(--text-secondary)">${escapeHtml(host)}</td>
                <td style="padding:9px 10px;border-bottom:1px solid var(--border-color);font-size:12px">${escapeHtml(effectiveText)}</td>
                <td style="padding:9px 10px;border-bottom:1px solid var(--border-color)">${action}</td>
            </tr>`
            };
        }),
    );
    const globalCount = items.filter(i => i.effectiveType === 'global').length;
    const directCount = items.filter(i => i.effectiveType === 'direct').length;
    const customCount = items.filter(i => i.effectiveType === 'custom').length;
    const summaryParts = [
        `${globalCount} 个走全局`,
        customCount > 0 ? `${customCount} 个自定义` : null,
        `${directCount} 个直连`
    ].filter(Boolean).join('、');
    container.innerHTML = items.length
        ? `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">全局代理：${escapeHtml(globalLabel)} · 共 ${items.length} 个节点（${summaryParts}）</div><div style="overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead><tr><th style="text-align:left;padding:8px 10px">客户端</th><th style="text-align:left;padding:8px 10px">节点</th><th style="text-align:left;padding:8px 10px">上游域名</th><th style="text-align:left;padding:8px 10px">生效方式</th><th style="text-align:left;padding:8px 10px">操作</th></tr></thead>
            <tbody>${items.map(i => i.html).join('')}</tbody>
          </table></div>`
        : '<div style="color:var(--text-secondary);font-size:13px">暂无节点</div>';
};

window.setEndpointProxyMode = async function(btn, mode) {
    const client = btn.dataset.proxyClient;
    const index = Number(btn.dataset.proxyIndex);
    const ep = config.clients?.[client]?.endpoints?.[index];
    if (!ep) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '...';
    try {
        if (mode === 'disabled') {
            ep.proxy_mode = 'disabled';
            delete ep.proxy_url;
        } else {
            delete ep.proxy_mode;
            delete ep.proxy_url;
        }
        const saved = await saveConfig({ button: btn, client, scope: 'node' });
        if (!saved) {
            btn.textContent = original;
            btn.disabled = false;
            return;
        }
        renderProxyEndpointsList();
        showToast(mode === 'disabled' ? '该节点已切换为直连' : '该节点已恢复全局代理', 'success');
    } catch (e) {
        showToast('切换代理模式失败：' + (e.message || e), 'error');
        btn.textContent = original;
        btn.disabled = false;
    }
};

function formatUsageNumber(value) {
    return new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
}

function renderAnalyticsChart(points) {
    const container = document.getElementById('analytics-chart-container');
    if (!container) return;
    if (!Array.isArray(points) || points.length === 0) {
        container.innerHTML = '<div style="color:var(--text-secondary);font-size:13px">暂无 Token 数据</div>';
        return;
    }
    const width = 960;
    const height = 240;
    const padding = { left: 54, right: 18, top: 18, bottom: 42 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;
    const maxValue = Math.max(1, ...points.map(point => Number(point.total_tokens) || 0));
    const step = chartWidth / Math.max(1, points.length);
    const barWidth = Math.max(3, Math.min(28, step * 0.64));
    const bars = points.map((point, index) => {
        const value = Number(point.total_tokens) || 0;
        const barHeight = value / maxValue * chartHeight;
        const x = padding.left + index * step + (step - barWidth) / 2;
        const y = padding.top + chartHeight - barHeight;
        return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="3" fill="#3b82f6">
            <title>${escapeHtml(point.time_key)} · ${formatUsageNumber(value)} Token</title>
        </rect>`;
    }).join('');
    const labelEvery = Math.max(1, Math.ceil(points.length / 8));
    const labels = points.map((point, index) => {
        if (index % labelEvery !== 0 && index !== points.length - 1) return '';
        const x = padding.left + index * step + step / 2;
        const label = String(point.time_key || '').replace(/^\d{4}-/, '');
        return `<text x="${x.toFixed(1)}" y="${height - 14}" text-anchor="middle" fill="currentColor" opacity=".62" font-size="10">${escapeHtml(label)}</text>`;
    }).join('');
    container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Token 消耗趋势图" style="width:100%;height:auto;min-height:220px">
        <line x1="${padding.left}" y1="${padding.top + chartHeight}" x2="${width - padding.right}" y2="${padding.top + chartHeight}" stroke="currentColor" opacity=".16"/>
        <text x="8" y="${padding.top + 10}" fill="currentColor" opacity=".62" font-size="11">${formatUsageNumber(maxValue)}</text>
        ${bars}${labels}
    </svg>`;
}

const ANALYTICS_PURPOSE_LABELS = {
    chat: '聊天',
    embedding: '向量',
    image_generation: '图像生成',
    video_generation: '视频生成',
    audio_tts: '语音',
    tts: '语音',
    vision_fallback: '视觉兜底',
    web_search: '联网搜索',
};

function renderAnalyticsBreakdownTable(containerId, rows, nameKey, nameLabel, purposeCol = false) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!Array.isArray(rows) || rows.length === 0) {
        container.innerHTML = '<div style="color:var(--text-secondary);font-size:13px">暂无数据</div>';
        return;
    }
    const heads = purposeCol
        ? `<th style="text-align:left;padding:8px 10px">${escapeHtml(nameLabel)}</th><th style="text-align:left;padding:8px 10px">类型</th><th style="text-align:right;padding:8px 10px">请求数</th><th style="text-align:right;padding:8px 10px">输入</th><th style="text-align:right;padding:8px 10px">输出</th><th style="text-align:right;padding:8px 10px">Token</th><th style="text-align:right;padding:8px 10px">花费</th>`
        : `<th style="text-align:left;padding:8px 10px">${escapeHtml(nameLabel)}</th><th style="text-align:right;padding:8px 10px">请求数</th><th style="text-align:right;padding:8px 10px">输入</th><th style="text-align:right;padding:8px 10px">输出</th><th style="text-align:right;padding:8px 10px">Token</th><th style="text-align:right;padding:8px 10px">花费</th>`;
    const body = rows.map(row => {
        const rawName = row[nameKey] || '其他';
        const name = escapeHtml(nameKey === 'purpose' ? (ANALYTICS_PURPOSE_LABELS[rawName] || rawName) : rawName);
        const purposeCell = purposeCol
            ? `<td style="padding:9px 10px;border-top:1px solid var(--border-color)">${escapeHtml(ANALYTICS_PURPOSE_LABELS[row.purpose] || row.purpose || '-')}</td>`
            : '';
        return `<tr>
            <td style="padding:9px 10px;border-top:1px solid var(--border-color)">${name}</td>
            ${purposeCell}
            <td style="padding:9px 10px;border-top:1px solid var(--border-color);text-align:right">${formatUsageNumber(row.requests)}</td>
            <td style="padding:9px 10px;border-top:1px solid var(--border-color);text-align:right">${formatUsageNumber(row.prompt_tokens)}</td>
            <td style="padding:9px 10px;border-top:1px solid var(--border-color);text-align:right">${formatUsageNumber(row.completion_tokens)}</td>
            <td style="padding:9px 10px;border-top:1px solid var(--border-color);text-align:right">${formatUsageNumber(row.total_tokens)}</td>
        <td style="padding:9px 10px;border-top:1px solid var(--border-color);text-align:right">${row.cost_usd ? `${Number(row.cost_usd).toFixed(4)}` : '-'}</td>
        </tr>`;
    }).join('');
    container.innerHTML = `<div style="overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr>${heads}</tr></thead>
        <tbody>${body}</tbody>
    </table></div>`;
}

function renderAnalyticsBreakdown(rows) {
    renderAnalyticsBreakdownTable('analytics-breakdown-container', rows, 'purpose', '节点类型');
}

function renderAnalyticsClientBreakdown(rows) {
    renderAnalyticsBreakdownTable('analytics-client-breakdown-container', rows, 'client', '客户端');
}

function renderAnalyticsEndpointBreakdown(rows) {
    renderAnalyticsBreakdownTable('analytics-endpoint-breakdown-container', rows, 'endpoint_name', '节点', true);
}

function renderAnalyticsModelBreakdown(rows) {
    renderAnalyticsBreakdownTable('analytics-model-breakdown-container', rows, 'model', '模型', true);
}

function renderAnalyticsDetailBreakdown(rows) {
    const container = document.getElementById('analytics-detail-breakdown-container');
    if (!container) return;
    if (!Array.isArray(rows) || rows.length === 0) {
        container.innerHTML = '<div style="color:var(--text-secondary);font-size:13px">暂无数据</div>';
        return;
    }
    const heads = '<th style="text-align:left;padding:8px 10px">客户端</th>'
        + '<th style="text-align:left;padding:8px 10px">节点</th>'
        + '<th style="text-align:left;padding:8px 10px">类型</th>'
        + '<th style="text-align:left;padding:8px 10px">模型</th>'
        + '<th style="text-align:right;padding:8px 10px">请求数</th>'
        + '<th style="text-align:right;padding:8px 10px">输入</th>'
        + '<th style="text-align:right;padding:8px 10px">输出</th>'
        + '<th style="text-align:right;padding:8px 10px">Token</th>' + '<th style="text-align:right;padding:8px 10px">花费</th>'
    const body = rows.map(row => `<tr>
        <td style="padding:9px 10px;border-top:1px solid var(--border-color)">${escapeHtml(row.client || '-')}</td>
        <td style="padding:9px 10px;border-top:1px solid var(--border-color)">${escapeHtml(row.endpoint_name || '-')}</td>
        <td style="padding:9px 10px;border-top:1px solid var(--border-color)">${escapeHtml(ANALYTICS_PURPOSE_LABELS[row.purpose] || row.purpose || '-')}</td>
        <td style="padding:9px 10px;border-top:1px solid var(--border-color)">${escapeHtml(row.model || '-')}</td>
        <td style="padding:9px 10px;border-top:1px solid var(--border-color);text-align:right">${formatUsageNumber(row.requests)}</td>
        <td style="padding:9px 10px;border-top:1px solid var(--border-color);text-align:right">${formatUsageNumber(row.prompt_tokens)}</td>
        <td style="padding:9px 10px;border-top:1px solid var(--border-color);text-align:right">${formatUsageNumber(row.completion_tokens)}</td>
        <td style="padding:9px 10px;border-top:1px solid var(--border-color);text-align:right">${formatUsageNumber(row.total_tokens)}</td>
        ${row.cost_usd ? `<td style="padding:9px 10px;border-top:1px solid var(--border-color);text-align:right">${row.native_currency === 'cny' ? 'Y' : '$'}${Number(row.cost_usd).toFixed(4)}</td>` : '<td style="padding:9px 10px;border-top:1px solid var(--border-color);text-align:right;color:var(--text-secondary)">-</td>'}
    </tr>`).join('');
    container.innerHTML = `<div style="overflow:auto;max-height:420px"><table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr>${heads}</tr></thead>
        <tbody>${body}</tbody>
    </table></div>`;
}

function updateAnalyticsClientOptions(rows, selectedValue) {
    const sel = document.getElementById('analytics-client');
    if (!sel) return;
    const known = Object.keys(config?.clients || {});
    const seen = new Set(rows.map(r => r.client).filter(Boolean));
    const clients = Array.from(new Set([...known, ...seen])).sort();
    const cur = selectedValue || sel.value || 'all';
    sel.innerHTML = '<option value="all"' + (cur === 'all' ? ' selected' : '') + '>全部客户端</option>'
        + clients.map(c => `<option value="${escapeHtml(c)}"${cur === c ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('');
}

window.loadAnalyticsData = async function() {
    const params = new URLSearchParams({
        granularity: document.getElementById('analytics-granularity')?.value || 'hour',
        range: document.getElementById('analytics-range')?.value || '24h',
        purpose: document.getElementById('analytics-purpose')?.value || 'all',
        client: document.getElementById('analytics-client')?.value || 'all',
    });
    try {
        const res = await fetch(`/v1/analytics/token-usage?${params.toString()}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error?.message || `加载失败 (${res.status})`);
        const summary = data.summary || {};
        document.getElementById('stat-total-tokens').textContent = formatUsageNumber(summary.total_tokens);
        document.getElementById('stat-prompt-tokens').textContent = formatUsageNumber(summary.prompt_tokens);
        document.getElementById('stat-completion-tokens').textContent = formatUsageNumber(summary.completion_tokens);
        document.getElementById('stat-total-requests').textContent = formatUsageNumber(summary.total_requests);
        document.getElementById('stat-cost-usd').textContent = '$' + Number(summary.cost_usd || 0).toFixed(4);
        document.getElementById('stat-cost-cny').textContent = 'Y' + Number(summary.cost_cny_equivalent || 0).toFixed(2);
        const fxInfo = data.fx || {};
        const fxSub = fxInfo.source === 'api' ? `Rate $${fxInfo.usd_to_cny?.toFixed(2)} - updated ${new Date(fxInfo.updated_at || 0).toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'})}` : (fxInfo.source === 'cached' ? `Rate $${fxInfo.usd_to_cny?.toFixed(2)} (cached)` : 'Rate 7.25 (default)');
        const usdSub = document.getElementById('stat-cost-usd-sub');
        const cnySub = document.getElementById('stat-cost-cny-sub');
        if (usdSub) usdSub.textContent = fxSub;
        if (cnySub) cnySub.textContent = fxSub;
        renderAnalyticsChart(data.timeline || []);
        renderAnalyticsBreakdown(data.purpose_breakdown || []);
        renderAnalyticsClientBreakdown(data.client_breakdown || []);
        renderAnalyticsEndpointBreakdown(data.endpoint_breakdown || []);
        renderAnalyticsModelBreakdown(data.model_breakdown || []);
        renderAnalyticsDetailBreakdown(data.detail_breakdown || []);
        updateAnalyticsClientOptions(data.client_breakdown || [], params.get('client'));
    } catch (error) {
        renderAnalyticsChart([]);
        renderAnalyticsBreakdown([]);
        renderAnalyticsClientBreakdown([]);
        renderAnalyticsEndpointBreakdown([]);
        renderAnalyticsModelBreakdown([]);
        renderAnalyticsDetailBreakdown([]);
        showToast(`加载用量统计失败：${error.message || error}`, 'error');
    }
};;

// --- Analytics tab switching ---
window.switchAnalyticsTab = function(tabId, btn) {
    document.querySelectorAll('.analytics-tab-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    document.querySelectorAll('.analytics-tab-panel').forEach(p => {
        p.style.display = 'none';
        p.classList.remove('active');
    });
    const panelMap = {
        'breakdown': 'analytics-breakdown-container',
        'client': 'analytics-client-breakdown-container',
        'endpoint': 'analytics-endpoint-breakdown-container',
        'model': 'analytics-model-breakdown-container',
        'detail': 'analytics-detail-breakdown-container',
    };
    const panelId = panelMap[tabId] || ('analytics-' + tabId + '-breakdown-container');
    const panel = document.getElementById(panelId);
    if (panel) {
        panel.style.display = 'block';
        panel.classList.add('active');
    }
};

// --- Pricing table ---
window.togglePricingTable = function() {
    const container = document.getElementById('pricing-table-container');
    const icon = document.getElementById('pricing-toggle-icon');
    if (!container) return;
    if (container.style.display === 'none') {
        container.style.display = 'block';
        if (icon) icon.textContent = '收起 ▲';
        loadPricingTable();
    } else {
        container.style.display = 'none';
        if (icon) icon.textContent = '展开 ▼';
    }
};

async function loadPricingTable() {
    try {
        const res = await fetch('/v1/analytics/pricing?configured_only=1');
        if (!res.ok) throw new Error('Failed to load pricing');
        const data = await res.json();
        const models = data.models || [];
        if (models.length === 0) {
            document.getElementById('pricing-table-container').innerHTML = '<div style="color:var(--text-secondary);font-size:13px;padding:8px">暂无价格数据</div>';
            return;
        }
        const rows = models.map(m => {
            const cur = m.currency === 'cny' ? 'Y' : (m.currency === 'usd' ? '$' : '');
            const sourceLabel = { custom: '自定义', vendored: '内置CN', litellm: 'litellm', default: '默认' }[m.source] || m.source;
            return '<tr>' +
                '<td>' + escapeHtml(m.model) + '</td>' +
                '<td>' + escapeHtml(m.vendor || '-') + '</td>' +
                '<td>' + cur + m.prompt.toFixed(2) + '</td>' +
                '<td>' + cur + m.completion.toFixed(2) + '</td>' +
                (m.cache_creation > 0 ? '<td>' + cur + m.cache_creation.toFixed(2) + '</td>' : '<td style="color:var(--text-secondary)">-</td>') +
                (m.cache_read > 0 ? '<td>' + cur + m.cache_read.toFixed(2) + '</td>' : '<td style="color:var(--text-secondary)">-</td>') +
                '<td>' + escapeHtml(m.currency || '?') + '</td>' +
                '<td style="color:var(--text-secondary)">' + sourceLabel + '</td>' +
                '</tr>';
        }).join('');
        document.getElementById('pricing-table-container').innerHTML =
            '<div style="overflow:auto"><table>' +
            '<thead><tr><th>模型</th><th>厂商</th><th>输入/1M</th><th>输出/1M</th><th>缓存写入/1M</th><th>缓存读取/1M</th><th>币种</th><th>来源</th></tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
            '</table></div>' +
            (data.stale ? '<div style="font-size:11px;color:var(--text-secondary);margin-top:8px">⚠ 价格缓存已过期（>7天），正在尝试刷新</div>' : '') +
            (data.vendored_version ? '<div style="font-size:11px;color:var(--text-secondary);margin-top:4px">内置CN价格表版本: ' + data.vendored_version + '</div>' : '');
    } catch (e) {
        document.getElementById('pricing-table-container').innerHTML = '<div style="color:var(--text-secondary);font-size:13px;padding:8px">加载价格表失败: ' + escapeHtml(e.message) + '</div>';
    }
}


async function loadDefaultTemplate() {
    if (!confirm('这会覆盖你当前的所有配置，确定要恢复默认模板吗？')) return;
    const previousConfig = config;
    const createTemplateEndpoint = () => ({
        id: `ep_${crypto.randomUUID()}`,
        name: "volcengine-anthropic",
        type: "anthropic",
        base_url: "https://ark.cn-beijing.volces.com/api/plan/v1",
        api_key: "env:ARK_API_KEY",
        model_mapping: {
            "glm-5.2": "glm-5.2",
            "minimax-m3": "minimax-m3",
            "deepseek-v4-pro": "deepseek-v4-pro",
            "claude-opus-4-8": "glm-5.2",
            "claude-fable": "glm-5.2",
            "fable": "glm-5.2",
            "claude-haiku-4-0": "glm-5.2",
            "claude-haiku": "glm-5.2",
            "haiku": "glm-5.2",
            "claude-opus-4-7": "minimax-m3",
            "claude-opus": "minimax-m3",
            "opus": "minimax-m3",
            "claude-sonnet-4-5": "deepseek-v4-pro",
            "claude-sonnet": "deepseek-v4-pro",
            "sonnet": "deepseek-v4-pro"
        }
    });
    const codeEndpoint = createTemplateEndpoint();
    const desktopEndpoint = {
        ...createTemplateEndpoint(),
        is_default: true,
        expose_models: true
    };
    config = {
        server: { host: "127.0.0.1", port: 8787 },
        clients: {
            code: {
                endpoints: [{ ...codeEndpoint, is_default: true }],
                model_slots: {
                    opus: "minimax-m3",
                    sonnet: "glm-5.2",
                    haiku: "deepseek-v4-pro",
                    fable: "deepseek-v4-pro"
                }
            },
            desktop: { endpoints: [desktopEndpoint] },
            codex: { endpoints: [] },
            deeptutor: { endpoints: [] }
        }
    };
    render();
    const saved = await saveConfig({ scope: 'template' });
    if (!saved) {
        config = previousConfig;
        render();
    }
}

// Merge fetched clients onto the local model, preserving the four built-in
// groups and any custom agent-node groups the user created.
function mergeFetchedClients(data) {
    const fetched = (data && data.clients) ? data.clients : {};
    const merged = {
        code: fetched.code || { endpoints: [], model_slots: {} },
        desktop: fetched.desktop || { endpoints: [] },
        codex: fetched.codex || { endpoints: [] },
        deeptutor: fetched.deeptutor || { endpoints: [] },
    };
    for (const [name, body] of Object.entries(fetched)) {
        if (!BUILTIN_CLIENTS.includes(name)) merged[name] = body || { endpoints: [] };
    }
    return merged;
}

// Reload the public config from the gateway and re-render.
async function loadConfig() {
    try {
        const res = await fetch('/v1/config');
        if (res.ok) {
            const data = await res.json();
            if (data && data.clients) {
                config = {
                    ...config,
                    ...data,
                    clients: mergeFetchedClients(data),
                };
                if (data?.codex_model_catalog?.path_posix) {
                    codexModelCatalogPath = data.codex_model_catalog.path_posix;
                } else if (data?.codex_model_catalog?.path) {
                    codexModelCatalogPath = String(data.codex_model_catalog.path).replaceAll('\\', '/');
                }
            }
        }
    } catch (e) {
        console.warn('加载配置失败。');
    }
    render();
}

async function init() {
    try {
        const res = await fetch('/v1/config');
        if (res.ok) {
            const data = await res.json();
            if (data && data.clients) {
                config = {
                    ...config,
                    ...data,
                    clients: mergeFetchedClients(data),
                };
            }
            if (data?.codex_model_catalog?.path_posix) {
                codexModelCatalogPath = data.codex_model_catalog.path_posix;
            } else if (data?.codex_model_catalog?.path) {
                codexModelCatalogPath = String(data.codex_model_catalog.path).replaceAll('\\', '/');
            }
        }
    } catch (e) {
        console.warn('加载初始配置失败，使用默认配置。');
    }
    await loadSyncStatus();
    render();
}

function setDatePreset(preset) {
    const startInput = document.getElementById('sync-start-date');
    const endInput = document.getElementById('sync-end-date');
    const now = new Date();
    const formatDate = (d) => d.toISOString().slice(0, 10);

    if (preset === 'today') {
        startInput.value = formatDate(now);
        endInput.value = formatDate(now);
    } else if (preset === '7days') {
        const d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        startInput.value = formatDate(d);
        endInput.value = formatDate(now);
    } else if (preset === '30days') {
        const d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        startInput.value = formatDate(d);
        endInput.value = formatDate(now);
    } else if (preset === 'all') {
        startInput.value = '';
        endInput.value = '';
    }
}

function setSummaryMode(mode) {
    const hiddenVal = document.getElementById('sync-summary-mode-val');
    if (hiddenVal) hiddenVal.value = mode;

    const ruleCard = document.getElementById('card-mode-rule');
    const llmCard = document.getElementById('card-mode-llm');
    const container = document.getElementById('summary-model-container');

    if (mode === 'llm') {
        if (ruleCard) ruleCard.classList.remove('active');
        if (llmCard) llmCard.classList.add('active');
        if (container) container.style.display = 'block';
    } else {
        if (ruleCard) ruleCard.classList.add('active');
        if (llmCard) llmCard.classList.remove('active');
        if (container) container.style.display = 'none';
    }
}


// ---- Skills library state ----
// ===== Skills: nav collapsible =====
window.toggleNavGroup = function(groupId, event) {
    if (event) event.stopPropagation();
    const g = document.getElementById(groupId);
    if (g) g.classList.toggle('open');
};

// ===== Skills: unify to central =====
window.unifySkillToCentral = async function(skillName) {
    const name = String(skillName || '').trim();
    if (!name) return false;
    const call = (overwrite) => fetch('/v1/skills/unify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skill: name, overwrite })
    }).then(r => r.json());
    let data = await call(false);
    if (data.needsConfirm) {
        const ok = await showSkillConfirmModal(
            '统一到中央目录',
            '中央目录已存在「' + name + '」。确认用其他目录的内容<strong>覆盖</strong>中央目录，并把其他目录软链到中央？'
        );
        if (!ok) return false;
        data = await call(true);
    }
    if (!data.success) { showToast('统一失败: ' + (data.error || ''), 'danger'); return false; }
    await refreshSkillsLibrary(true);
    showToast('已统一 ' + name + ' 到中央目录', 'success');
    return true;
};

window.unifyAllSkills = async function() {
    const ok = await showSkillConfirmModal(
        '一键统一',
        '把所有"未统一到中央"的 skill 复制到中央目录 <code>~/.agents/skills/</code>，并把其他目录软链到中央？仅处理中央目录缺失的 skill。'
    );
    if (!ok) return;
    try {
        const res = await fetch('/v1/skills/unify-all', { method: 'POST' });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || '失败');
        const done = (data.results || []).filter(r => r.unified).length;
        const failed = (data.results || []).filter(r => r.error).length;
        await refreshSkillsLibrary(true);
        showToast('统一完成：成功 ' + done + (failed ? (' / 失败 ' + failed) : ''), failed ? 'danger' : 'success');
    } catch (err) {
        showToast('一键统一失败: ' + err.message, 'danger');
    }
};

// ===== Skills: install history (gateway-driven installs) =====
let xtermTerm = null;
let xtermFit = null;
let currentInstallWs = null;

async function refreshInstallHistory() {
    try {
        const res = await fetch('/v1/skills/install-history');
        const data = await res.json();
        if (!data.success) throw new Error(data.error || '失败');
        const fp = document.getElementById('install-history-filepath');
        if (fp) fp.textContent = data.filePath || '';
        renderInstallHistoryList(data.records || []);
    } catch (err) {
        showToast('加载安装记录失败: ' + err.message, 'danger');
    }
}

function fmtInstallDate(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }); } catch (e) { return iso; }
}

function renderInstallHistoryList(records) {
    const host = document.getElementById('install-history-list');
    if (!host) return;
    if (!records.length) { host.innerHTML = '<div class="skill-detail-empty">暂无安装记录</div>'; return; }
    host.innerHTML = records.map(function(r) {
        const statusLabel = r.status === 'success' ? '成功' : (r.status === 'failed' ? '失败' : '运行中');
        const meta = fmtInstallDate(r.startedAt) + (r.finishedAt ? (' -> ' + fmtInstallDate(r.finishedAt)) : '') + (r.exitCode !== null ? (' · 退出 ' + r.exitCode) : '');
        return '<div class="install-record">' +
            '<div class="install-record-head">' +
            '<div style="min-width:0;flex:1;">' +
            '<div class="install-record-skill">' + escapeHtml(r.skillName || '(未关联 skill)') + ' <span class="skill-pill status-' + r.status + '">' + statusLabel + '</span></div>' +
            '<div class="install-record-cmd">$ ' + escapeHtml(r.command) + '</div>' +
            '<div class="install-record-meta">' + escapeHtml(meta) + '</div>' +
            '</div>' +
            '<div class="install-record-actions">' +
            '<button class="btn" style="padding:4px 10px;font-size:12px;" onclick="reinstallRecord(\'' + r.id + '\')">重新安装</button>' +
            '<button class="btn" style="padding:4px 10px;font-size:12px;" onclick="deleteInstallRecord(\'' + r.id + '\')">删除</button>' +
            '</div>' +
            '</div></div>';
    }).join('');
}

function openInstallTerminal() {
    const wrap = document.getElementById('install-terminal-wrap');
    wrap.classList.add('open');
    if (!xtermTerm) {
        xtermTerm = new Terminal({ cols: 100, rows: 24, fontFamily: 'Consolas, monospace', fontSize: 13, theme: { background: '#0c0c0c' } });
        xtermFit = new FitAddon.FitAddon();
        xtermTerm.loadAddon(xtermFit);
        xtermTerm.open(document.getElementById('xterm-container'));
        // Wheel boundary passthrough: let xterm scroll its own buffer, but when the
        // viewport is at the top/bottom of the scrollback, release the wheel to the
        // page so the browser scrolls instead of fighting the terminal.
        const xtermHost = document.getElementById('xterm-container');
        xtermHost.addEventListener('wheel', function(e) {
            const buf = xtermTerm.buffer.active;
            const atTop = buf.viewportY <= 0;
            const atBottom = buf.viewportY >= buf.baseY;
            if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom)) e.stopImmediatePropagation();
        }, { capture: true, passive: true });
        xtermTerm.onData(function(d) {
            if (currentInstallWs && currentInstallWs.readyState === 1) currentInstallWs.send(d);
        });
        xtermTerm.onResize(function(size) {
            if (currentInstallWs && currentInstallWs.readyState === 1) {
                currentInstallWs.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
            }
        });
    }
    xtermTerm.reset();
    try { xtermFit.fit(); } catch (e) {}
    xtermTerm.focus();
}

function closeInstallTerminal() {
    const wrap = document.getElementById('install-terminal-wrap');
    wrap.classList.remove('open');
    if (currentInstallWs) { try { currentInstallWs.close(); } catch (e) {} currentInstallWs = null; }
}
window.closeInstallTerminal = closeInstallTerminal;

async function startInstallWithCommand(command, skillName) {
    const cmd = String(command || '').trim();
    if (!cmd) { showToast('请填写安装命令', 'danger'); return false; }
    let record;
    try {
        const res = await fetch('/v1/skills/install', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: cmd, skillName: skillName || '' })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || '失败');
        record = data.record;
    } catch (err) { showToast('启动安装失败: ' + err.message, 'danger'); return false; }

    openInstallTerminal();
    const title = document.getElementById('install-terminal-title');
    if (title) title.textContent = '安装终端 · ' + record.id;
    xtermTerm.writeln('$ ' + cmd);

    const wsUrl = 'ws://' + location.host + '/v1/skills/pty?recordId=' + record.id
        + '&cols=' + xtermTerm.cols + '&rows=' + xtermTerm.rows;
    const ws = new WebSocket(wsUrl);
    currentInstallWs = ws;
    const hint = document.getElementById('install-terminal-hint');
    if (hint) hint.textContent = '运行中 · 如出现 Ok to proceed? (y) 请输入 y 并回车';
    ws.onopen = function() {
        xtermTerm.focus();
        try { xtermFit.fit(); } catch (e) {}
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: xtermTerm.cols, rows: xtermTerm.rows }));
    };
    ws.onmessage = function(e) {
        let parsed = null;
        if (typeof e.data === 'string') { try { parsed = JSON.parse(e.data); } catch (err) {} }
        if (parsed && parsed.type === 'exit') {
            if (hint) hint.textContent = '';
            xtermTerm.writeln('\r\n[进程退出 code=' + parsed.exitCode + ']' + (parsed.skillName ? (' 关联 skill: ' + parsed.skillName) : ''));
            refreshInstallHistory();
        } else {
            xtermTerm.write(typeof e.data === 'string' ? e.data : '');
        }
    };
    ws.onclose = function() { if (hint) hint.textContent = ''; refreshInstallHistory(); };
    ws.onerror = function() { xtermTerm.writeln('\r\n[连接错误]'); };
    return true;
}

window.startInstallFromForm = async function() {
    const cmd = document.getElementById('install-cmd').value;
    const skillName = document.getElementById('install-skill-name').value;
    const ok = await startInstallWithCommand(cmd, skillName);
    if (ok) { document.getElementById('install-cmd').value = ''; document.getElementById('install-skill-name').value = ''; }
};

window.reinstallRecord = async function(id) {
    const res = await fetch('/v1/skills/install-history');
    const data = await res.json();
    const rec = (data.records || []).find(function(r) { return r.id === id; });
    if (!rec) { showToast('记录不存在', 'danger'); return; }
    const ok = await showSkillConfirmModal('重新安装', '用当时的命令重新执行？<br><code>' + escapeHtml(rec.command) + '</code>' + (rec.skillName ? ('<br>skill: ' + escapeHtml(rec.skillName)) : ''));
    if (!ok) return;
    await startInstallWithCommand(rec.command, rec.skillName || '');
};

window.deleteInstallRecord = async function(id) {
    const ok = await showSkillConfirmModal('删除记录', '确认删除这条安装记录？');
    if (!ok) return;
    try {
        const res = await fetch('/v1/skills/install-history?id=' + encodeURIComponent(id), { method: 'DELETE' });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || '失败');
        renderInstallHistoryList(data.records || []);
        showToast('已删除', 'success');
    } catch (err) { showToast('删除失败: ' + err.message, 'danger'); }
};
// ===== Preset CLI: discovery + install history (mirrors skills) =====
let cliLibraryState = { loaded: false, loading: false, query: "", view: "recommended", items: [], stats: { total: 0, installed: 0, recommended: 0, other: 0, shown: 0, view: "recommended" } };
let cliSearchTimer = null;
let cliIgnoredState = [];
let cliFavoriteState = [];

async function loadCliIgnored() {
    try {
        const res = await fetch('/v1/cli/ignore');
        const data = await res.json();
        if (data.success) cliIgnoredState = data.ignored || [];
    } catch {}
}

async function loadCliFavorites() {
    try {
        const res = await fetch('/v1/cli/favorite');
        const data = await res.json();
        if (data.success) cliFavoriteState = data.favorites || [];
    } catch {}
}

async function toggleCliIgnore(name) {
    const isIgnored = cliIgnoredState.includes(name);
    try {
        const method = isIgnored ? 'DELETE' : 'POST';
        const url = isIgnored ? '/v1/cli/ignore?name=' + encodeURIComponent(name) : '/v1/cli/ignore';
        const body = isIgnored ? null : JSON.stringify({ name: name });
        const res = await fetch(url, { method: method, headers: isIgnored ? {} : { 'Content-Type': 'application/json' }, body: body });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || '失败');
        cliIgnoredState = data.ignored || [];
        cliLibraryState.loaded = false;
        refreshCliLibrary(false);
        showToast(isIgnored ? '已取消忽略 ' + name : '已忽略 ' + name + '，后续不再扫描', 'success');
    } catch (err) {
        showToast('操作失败: ' + err.message, 'danger');
    }
}

async function toggleCliFavorite(name) {
    const isFavorite = cliFavoriteState.includes(name);
    try {
        const method = isFavorite ? 'DELETE' : 'POST';
        const url = isFavorite ? '/v1/cli/favorite?name=' + encodeURIComponent(name) : '/v1/cli/favorite';
        const body = isFavorite ? null : JSON.stringify({ name: name });
        const res = await fetch(url, { method: method, headers: isFavorite ? {} : { 'Content-Type': 'application/json' }, body: body });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || '失败');
        cliFavoriteState = data.favorites || [];
        cliLibraryState.loaded = false;
        refreshCliLibrary(false);
        showToast(isFavorite ? '已取消常用 ' + name : '已将 ' + name + ' 设为常用', 'success');
    } catch (err) {
        showToast('操作失败: ' + err.message, 'danger');
    }
}

async function refreshCliLibrary(force) {
    if (cliLibraryState.loading) return;
    if (cliLibraryState.loaded && !force) { renderCliLibrary(); return; }
    cliLibraryState.loading = true;
    try {
        if (force) await loadCliIgnored();
        // Favorites affect recommended view; keep them fresh on every reload.
        await loadCliFavorites();
        const probeParam = force ? '&probe=1' : '';
        const viewParam = '&view=' + encodeURIComponent(cliLibraryState.view || 'recommended');
        const res = await fetch('/v1/cli/discover?q=' + encodeURIComponent(cliLibraryState.query || '') + probeParam + viewParam);
        const data = await res.json();
        if (!data.success) throw new Error(data.error || '失败');
        cliLibraryState.items = data.items || [];
        cliLibraryState.stats = data.stats || { total: 0, installed: 0, recommended: 0, other: 0, shown: cliLibraryState.items.length, view: cliLibraryState.view };
        if (cliLibraryState.stats.view) cliLibraryState.view = cliLibraryState.stats.view;
        cliLibraryState.loaded = true;
        renderCliLibrary();
    } catch (err) {
        showToast('加载 CLI 列表失败: ' + err.message, 'danger');
    } finally {
        cliLibraryState.loading = false;
    }
}

function setCliView(view) {
    const next = view === 'all' ? 'all' : 'recommended';
    if (cliLibraryState.view === next && cliLibraryState.loaded) {
        renderCliLibrary();
        return;
    }
    cliLibraryState.view = next;
    cliLibraryState.loaded = false;
    refreshCliLibrary(false);
}

function onCliSearchInput(value) {
    cliLibraryState.query = value || '';
    clearTimeout(cliSearchTimer);
    cliSearchTimer = setTimeout(() => { cliLibraryState.loaded = false; refreshCliLibrary(false); }, 250);
}

function renderCliLibrary() {
    const host = document.getElementById('cli-list');
    if (!host) return;
    const chip = document.getElementById('cli-stats-chip');
    const stats = cliLibraryState.stats || {};
    const recommended = stats.recommended != null ? stats.recommended : 0;
    const total = stats.total != null ? stats.total : 0;
    const shown = stats.shown != null ? stats.shown : (cliLibraryState.items || []).length;
    if (chip) {
        if ((cliLibraryState.view || 'recommended') === 'all') {
            chip.textContent = '显示 ' + shown + ' / 全部 ' + total + '（推荐 ' + recommended + '）';
        } else {
            chip.textContent = '推荐 ' + recommended + ' / 全部 ' + total;
        }
    }
    document.querySelectorAll('#cli-view-toggle .cli-view-btn').forEach(function(btn) {
        const active = btn.getAttribute('data-view') === (cliLibraryState.view || 'recommended');
        btn.classList.toggle('is-active', active);
    });
    const items = cliLibraryState.items || [];
    if (!items.length) {
        const emptyHint = (cliLibraryState.view || 'recommended') === 'recommended'
            ? '当前没有匹配的推荐 CLI。可切换到「全部」查看扫描结果，或调整搜索词。'
            : '没有匹配的 CLI。';
        host.innerHTML = '<div class="skill-detail-empty">' + emptyHint + '</div>';
        return;
    }
    host.innerHTML = items.map(function(item) {
        const version = item.version ? escapeHtml(item.version) : '<span style=\"color:var(--text-secondary);\">-</span>';
        const pathLine = item.path ? escapeHtml(item.path) : '<span style=\"color:var(--text-secondary);\">未在 PATH 中找到</span>';
        const ignored = cliIgnoredState.indexOf(item.name) >= 0;
        const favorite = item.favorite || cliFavoriteState.indexOf(item.name) >= 0;
        const tier = item.tier === 'recommended' ? '推荐' : '其他';
        const tierStyle = item.tier === 'recommended'
            ? 'background:rgba(16,185,129,0.12);color:#059669;'
            : 'background:var(--input-bg);color:var(--text-secondary);';
        const favoritePill = favorite
            ? ' <span class=\"skill-pill\" style=\"background:rgba(245,158,11,0.14);color:#d97706;\">常用</span>'
            : '';
        // Pin button:
        // - recommended view: only show for already-pinned items ("取消常用")
        // - all view: show "设为常用" / "取消常用"
        // Auto-recommended items already in 推荐 do not need a redundant pin action.
        const showFavoriteBtn = favorite || (cliLibraryState.view || 'recommended') === 'all';
        const favoriteBtn = !showFavoriteBtn ? '' : (
            '<button class=\"btn\" style=\"padding:4px 10px;font-size:12px;' + (favorite ? 'color:#d97706;' : '') + '" title="' + (favorite ? '取消常用，恢复自动推荐规则' : '设为常用，固定进入推荐列表') + '" onclick="toggleCliFavorite(' + String.fromCharCode(39) + escapeHtml(item.name) + String.fromCharCode(39) + ')">' + (favorite ? '取消常用' : '设为常用') + '</button>'
        );
        return '<div class=\"install-record\">' +
            '<div class=\"install-record-head\">' +
            '<div style=\"min-width:0;flex:1;\">' +
            '<div class=\"install-record-skill\">' + escapeHtml(item.name) +
            ' <span class=\"skill-pill\" style=\"' + tierStyle + '\">' + tier + '</span>' +
            favoritePill +
            (item.source ? ' <span class=\"skill-pill\" style=\"background:var(--input-bg);color:var(--text-secondary);\">' + escapeHtml(item.source) + '</span>' : '') + '</div>' +
            '<div class=\"install-record-cmd\">$ ' + escapeHtml(item.command) + ' --version</div>' +
            '<div class=\"install-record-meta\">版本: ' + version + '</div>' +
            '<div class=\"install-record-meta\">' + pathLine + '</div>' +
            '</div>' +
            '<div class=\"install-record-actions\">' +
            favoriteBtn +
            '<button class=\"btn\" style=\"padding:4px 10px;font-size:12px;' + (ignored ? 'color:var(--text-secondary);' : '') + '" title="' + (ignored ? '取消忽略，恢复扫描' : '忽略此 CLI，以后不再扫描') + '" onclick="toggleCliIgnore(' + String.fromCharCode(39) + escapeHtml(item.name) + String.fromCharCode(39) + ')">' + (ignored ? '已忽略' : '忽略') + '</button>' +
            '</div>' +
            '</div></div>';
    }).join('');
}

// ===== CLI Scan Sources management =====
let cliSourcesState = { loaded: false, loading: false, sources: [] };

async function refreshCliSources() {
    cliSourcesState.loading = true;
    try {
        const res = await fetch('/v1/cli/sources');
        const data = await res.json();
        if (!data.success) throw new Error(data.error || '失败');
        cliSourcesState.sources = data.sources || [];
        cliSourcesState.loaded = true;
        renderCliSources();
    } catch (err) {
        showToast('加载扫描来源失败: ' + err.message, 'danger');
    } finally {
        cliSourcesState.loading = false;
    }
}

function renderCliSources() {
    const host = document.getElementById('cli-sources-list');
    if (!host) return;
    const sources = cliSourcesState.sources || [];
    if (!sources.length) {
        host.innerHTML = '<div class="skill-detail-empty">暂无来源，点击「新增来源」添加。</div>';
        return;
    }
    host.innerHTML = sources.map(function(src, i) {
        const enabled = src.enabled !== false;
        const dirs = (src.dirs || []).join('; ');
        return '<div class="install-record" data-source-index="' + i + '">' +
            '<div class="install-record-head">' +
            '<div style="min-width:0;flex:1;display:flex;flex-direction:column;gap:6px;">' +
            '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
            '<input class="cli-source-name" value="' + escapeHtml(src.name || '') + '" placeholder="名称" style="width:120px;font-weight:600;" />' +
            '<input class="cli-source-label" value="' + escapeHtml(src.label || '') + '" placeholder="标签" style="width:160px;" />' +
            '<label class="node-card-switch" title="+'+(enabled ? '已启用' : '已禁用')+'">' +
            '<input type="checkbox" class="cli-source-enabled"' + (enabled ? ' checked' : '') + ' />' +
            '<span class="node-card-switch-track" aria-hidden="true"></span>' +
            '</label>' +
            '<button class="btn" style="padding:2px 8px;font-size:12px;" onclick="moveCliSource(' + i + ', -1)">↑</button>' +
            '<button class="btn" style="padding:2px 8px;font-size:12px;" onclick="moveCliSource(' + i + ', 1)">↓</button>' +
            '<button class="btn" style="padding:2px 8px;font-size:12px;color:#e53e3e;" onclick="removeCliSource(' + i + ')">删除</button>' +
            '</div>' +
            '<input class="cli-source-dirs" value="' + escapeHtml(dirs) + '" placeholder="目录，多个用分号分隔" style="width:100%;font-size:12px;" />' +
            '</div>' +
            '</div></div>';
    }).join('');
}

function addCliSourceRow() {
    const name = (document.getElementById('cli-source-new-name').value || '').trim();
    const label = (document.getElementById('cli-source-new-label').value || '').trim();
    const dirsRaw = (document.getElementById('cli-source-new-dirs').value || '').trim();
    if (!name) { showToast('请填写来源名称', 'danger'); return; }
    const dirs = dirsRaw ? dirsRaw.split(';').map(function(d) { return d.trim(); }).filter(Boolean) : [];
    cliSourcesState.sources.push({ name: name, label: label || name, enabled: true, dirs: dirs });
    document.getElementById('cli-source-new-name').value = '';
    document.getElementById('cli-source-new-label').value = '';
    document.getElementById('cli-source-new-dirs').value = '';
    renderCliSources();
}

function moveCliSource(index, delta) {
    const arr = cliSourcesState.sources;
    const ni = index + delta;
    if (ni < 0 || ni >= arr.length) return;
    const tmp = arr[index]; arr[index] = arr[ni]; arr[ni] = tmp;
    renderCliSources();
}

function removeCliSource(index) {
    cliSourcesState.sources.splice(index, 1);
    renderCliSources();
}

function collectCliSourcesFromDom() {
    const rows = document.querySelectorAll('#cli-sources-list .install-record');
    return Array.from(rows).map(function(row, i) {
        const old = cliSourcesState.sources[i] || {};
        return {
            id: old.id || undefined,
            name: (row.querySelector('.cli-source-name').value || '').trim(),
            label: (row.querySelector('.cli-source-label').value || '').trim(),
            enabled: row.querySelector('.cli-source-enabled').checked,
            dirs: (row.querySelector('.cli-source-dirs').value || '').split(';').map(function(d) { return d.trim(); }).filter(Boolean),
        };
    });
}

async function saveCliSources() {
    const sources = collectCliSourcesFromDom();
    try {
        const res = await fetch('/v1/cli/sources', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sources: sources }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || '保存失败');
        cliSourcesState.sources = data.sources || [];
        renderCliSources();
        showToast('扫描来源已保存', 'success');
        if (cliLibraryState.loaded) refreshCliLibrary(true);
    } catch (err) {
        showToast('保存失败: ' + err.message, 'danger');
    }
}

async function resetCliSources() {
    const ok = await showSkillConfirmModal('恢复默认', '确定恢复为系统默认来源？当前自定义来源将丢失。');
    if (!ok) return;
    try {
        const res = await fetch('/v1/cli/sources/reset', { method: 'POST' });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || '失败');
        cliSourcesState.sources = data.sources || [];
        renderCliSources();
        showToast('已恢复默认来源', 'success');
        if (cliLibraryState.loaded) refreshCliLibrary(true);
    } catch (err) {
        showToast('恢复失败: ' + err.message, 'danger');
    }
}

function installCliByName(name, command) {
    // Prefill the install form in the install-history tab and switch to it.
    switchTab('cli-install-history');
    const cmdInput = document.getElementById('cli-install-cmd');
    const nameInput = document.getElementById('cli-install-name');
    if (cmdInput) cmdInput.value = 'npm install -g ' + command;
    if (nameInput) nameInput.value = name;
    if (cmdInput) cmdInput.focus();
}

// CLI install terminal + history (parallel to the skills install flow)
let cliXterm = null;
let cliXtermFit = null;
let currentCliInstallWs = null;

async function refreshCliInstallHistory() {
    try {
        const res = await fetch('/v1/cli/install-history');
        const data = await res.json();
        if (!data.success) throw new Error(data.error || '失败');
        const fp = document.getElementById('cli-install-history-filepath');
        if (fp) fp.textContent = data.filePath || '';
        renderCliInstallHistoryList(data.records || []);
    } catch (err) {
        showToast('加载安装记录失败: ' + err.message, 'danger');
    }
}

function renderCliInstallHistoryList(records) {
    const host = document.getElementById('cli-install-history-list');
    if (!host) return;
    if (!records.length) { host.innerHTML = '<div class="skill-detail-empty">暂无安装记录</div>'; return; }
    host.innerHTML = records.map(function(r) {
        const statusLabel = r.status === 'success' ? '成功' : (r.status === 'failed' ? '失败' : '运行中');
        const meta = fmtInstallDate(r.startedAt) + (r.finishedAt ? (' -> ' + fmtInstallDate(r.finishedAt)) : '') + (r.exitCode !== null ? (' · 退出 ' + r.exitCode) : '');
        return '<div class="install-record">' +
            '<div class="install-record-head">' +
            '<div style="min-width:0;flex:1;">' +
            '<div class="install-record-skill">' + escapeHtml(r.cliName || '(未关联 CLI)') + ' <span class="skill-pill status-' + r.status + '">' + statusLabel + '</span></div>' +
            '<div class="install-record-cmd">$ ' + escapeHtml(r.command) + '</div>' +
            '<div class="install-record-meta">' + escapeHtml(meta) + '</div>' +
            '</div>' +
            '<div class="install-record-actions">' +
            '<button class="btn" style="padding:4px 10px;font-size:12px;" onclick="reinstallCliRecord(\'' + r.id + '\')">重新安装</button>' +
            '<button class="btn" style="padding:4px 10px;font-size:12px;" onclick="deleteCliInstallRecord(\'' + r.id + '\')">删除</button>' +
            '</div>' +
            '</div></div>';
    }).join('');
}

function openCliInstallTerminal() {
    const wrap = document.getElementById('cli-install-terminal-wrap');
    wrap.classList.add('open');
    if (!cliXterm) {
        cliXterm = new Terminal({ cols: 100, rows: 24, fontFamily: 'Consolas, monospace', fontSize: 13, theme: { background: '#0c0c0c' } });
        cliXtermFit = new FitAddon.FitAddon();
        cliXterm.loadAddon(cliXtermFit);
        cliXterm.open(document.getElementById('cli-xterm-container'));
        const xtermHost = document.getElementById('cli-xterm-container');
        xtermHost.addEventListener('wheel', function(e) {
            const buf = cliXterm.buffer.active;
            const atTop = buf.viewportY <= 0;
            const atBottom = buf.viewportY >= buf.baseY;
            if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom)) e.stopImmediatePropagation();
        }, { capture: true, passive: true });
        cliXterm.onData(function(d) {
            if (currentCliInstallWs && currentCliInstallWs.readyState === 1) currentCliInstallWs.send(d);
        });
        cliXterm.onResize(function(size) {
            if (currentCliInstallWs && currentCliInstallWs.readyState === 1) {
                currentCliInstallWs.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
            }
        });
    }
    cliXterm.reset();
    try { cliXtermFit.fit(); } catch (e) {}
    cliXterm.focus();
}

function closeCliInstallTerminal() {
    const wrap = document.getElementById('cli-install-terminal-wrap');
    wrap.classList.remove('open');
    if (currentCliInstallWs) { try { currentCliInstallWs.close(); } catch (e) {} currentCliInstallWs = null; }
}
window.closeCliInstallTerminal = closeCliInstallTerminal;

async function startCliInstallWithCommand(command, cliName) {
    const cmd = String(command || '').trim();
    if (!cmd) { showToast('请填写安装命令', 'danger'); return false; }
    let record;
    try {
        const res = await fetch('/v1/cli/install', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: cmd, cliName: cliName || '' })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || '失败');
        record = data.record;
    } catch (err) { showToast('启动安装失败: ' + err.message, 'danger'); return false; }

    openCliInstallTerminal();
    const title = document.getElementById('cli-install-terminal-title');
    if (title) title.textContent = '安装终端 · ' + record.id;
    cliXterm.writeln('$ ' + cmd);

    const wsUrl = 'ws://' + location.host + '/v1/cli/pty?recordId=' + record.id
        + '&cols=' + cliXterm.cols + '&rows=' + cliXterm.rows;
    const ws = new WebSocket(wsUrl);
    currentCliInstallWs = ws;
    const hint = document.getElementById('cli-install-terminal-hint');
    if (hint) hint.textContent = '运行中 · 如出现 Ok to proceed? (y) 请输入 y 并回车';
    ws.onopen = function() {
        cliXterm.focus();
        try { cliXtermFit.fit(); } catch (e) {}
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: cliXterm.cols, rows: cliXterm.rows }));
    };
    ws.onmessage = function(e) {
        let parsed = null;
        if (typeof e.data === 'string') { try { parsed = JSON.parse(e.data); } catch (err) {} }
        if (parsed && parsed.type === 'exit') {
            if (hint) hint.textContent = '';
            cliXterm.writeln('\r\n[进程退出 code=' + parsed.exitCode + ']' + (parsed.cliName ? (' 关联 CLI: ' + parsed.cliName) : ''));
            refreshCliInstallHistory();
            if (cliLibraryState.loaded) refreshCliLibrary(true);
        } else {
            cliXterm.write(typeof e.data === 'string' ? e.data : '');
        }
    };
    ws.onclose = function() { if (hint) hint.textContent = ''; refreshCliInstallHistory(); };
    ws.onerror = function() { cliXterm.writeln('\r\n[连接错误]'); };
    return true;
}

window.startCliInstallFromForm = async function() {
    const cmd = document.getElementById('cli-install-cmd').value;
    const cliName = document.getElementById('cli-install-name').value;
    const ok = await startCliInstallWithCommand(cmd, cliName);
    if (ok) { document.getElementById('cli-install-cmd').value = ''; document.getElementById('cli-install-name').value = ''; }
};

window.reinstallCliRecord = async function(id) {
    const res = await fetch('/v1/cli/install-history');
    const data = await res.json();
    const rec = (data.records || []).find(function(r) { return r.id === id; });
    if (!rec) { showToast('记录不存在', 'danger'); return; }
    const ok = await showSkillConfirmModal('重新安装', '用当时的命令重新执行？<br><code>' + escapeHtml(rec.command) + '</code>' + (rec.cliName ? ('<br>CLI: ' + escapeHtml(rec.cliName)) : ''));
    if (!ok) return;
    await startCliInstallWithCommand(rec.command, rec.cliName || '');
};

window.deleteCliInstallRecord = async function(id) {
    const ok = await showSkillConfirmModal('删除记录', '确认删除这条安装记录？');
    if (!ok) return;
    try {
        const res = await fetch('/v1/cli/install-history?id=' + encodeURIComponent(id), { method: 'DELETE' });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || '失败');
        renderCliInstallHistoryList(data.records || []);
        showToast('已删除', 'success');
    } catch (err) { showToast('删除失败: ' + err.message, 'danger'); }
};

let skillsLibraryState = {
    loaded: false,
    loading: false,
    query: "",
    category: "all",
    scope: "all",
    selectedSkill: "leo-grok-imagine",
    stats: { total: 0, installed: 0, managed: 0, local: 0, missing: 0, filtered: 0 },
    categories: [],
    skills: [],
    allSkills: [],
    tools: {},
    root: "",
    managedRoot: "",
};
let skillsSearchTimer = null;

function getSkillByName(name) {
    return (skillsLibraryState.allSkills || skillsLibraryState.skills || [])
        .find((item) => item.name === name) || null;
}

function updateSkillsScopeChips() {
    const s = skillsLibraryState.stats || {};
    const labels = {
        all: `全部 ${s.total || 0}`,
        installed: `已安装 ${s.installed || s.mounted || 0}`,
        managed: `网关托管 ${s.managed || 0}`,
        local: `本地发现 ${s.local || 0}`,
        missing: `未安装托管 ${s.missing || 0}`,
        'unified-missing': `未统一到中央 ${s.unifiedMissing || 0}`,
    };
    document.querySelectorAll('.skills-filter-chip[data-scope]').forEach((el) => {
        const scope = el.getAttribute('data-scope');
        el.classList.toggle('active', scope === skillsLibraryState.scope);
        if (labels[scope]) el.textContent = labels[scope];
    });
    const unifyBtn = document.getElementById('unify-all-btn');
    if (unifyBtn) {
        const n = s.unifiedMissing || 0;
        const show = n > 0 && skillsLibraryState.scope === 'unified-missing';
        unifyBtn.style.display = show ? '' : 'none';
        if (show) unifyBtn.textContent = '一键统一 (' + n + ')';
    }
}

function renderSkillsCategories() {
    const host = document.getElementById('skills-category-filters');
    if (!host) return;
    const cats = skillsLibraryState.categories || [];
    const chips = [
        { id: 'all', label: '全部分类', count: skillsLibraryState.stats?.total || 0 },
        ...cats,
    ];
    host.innerHTML = chips.map((cat) => `
        <button class="skills-filter-chip ${skillsLibraryState.category === cat.id ? 'active' : ''}"
                onclick="setSkillsCategory('${cat.id}')">
            ${escapeHtml(cat.label || cat.id)}${typeof cat.count === 'number' ? ` (${cat.count})` : ''}
        </button>
    `).join('');
}

function renderSkillsList() {
    const host = document.getElementById('skills-list');
    if (!host) return;
    const skills = skillsLibraryState.skills || [];
    if (!skills.length) {
        host.innerHTML = `<div class="skills-empty">没有匹配的技能。试试清空搜索，或切换到“全部 / 已安装 / 本地发现”。</div>`;
        return;
    }
    host.innerHTML = skills.map((skill) => {
        const active = skill.name === skillsLibraryState.selectedSkill;
        return `
            <article class="skill-card ${active ? 'active' : ''}" onclick="selectSkill('${escapeHtml(skill.name)}')">
                <div class="skill-card-top">
                    <div class="skill-card-title">
                        <div class="skill-card-icon">${escapeHtml(skill.icon || '🧩')}</div>
                        <div class="skill-card-title-row">
                            <span class="skill-card-name">${escapeHtml(skill.title || skill.name)}</span>
                            <span class="skill-card-id">${escapeHtml(skill.name)}</span>
                        </div>
                    </div>
                </div>
                <div class="skill-card-summary">${escapeHtml(skill.summary || skill.description || '')}</div>
                <div class="skill-card-meta">
                    <span class="skill-pill">${escapeHtml(skill.categoryLabel || skill.category || '其他')}</span>
                    ${skill.managed ? '<span class="skill-pill managed">网关托管</span>' : '<span class="skill-pill">本地发现</span>'}
                    <span class="skill-pill ${skill.installed ? 'installed' : 'missing'}">${skill.installed ? '已安装' : '未安装'}</span>
                </div>
            </article>
        `;
    }).join('');
}

function renderSkillDetail() {
    const host = document.getElementById('skills-detail');
    if (!host) return;
    const skill = getSkillByName(skillsLibraryState.selectedSkill);
    if (!skill) {
        host.innerHTML = `<div class="skill-detail-empty">从左侧选择一个技能，查看安装状态与说明。</div>`;
        return;
    }

    const tools = skill.tools || skillsLibraryState.tools || {};
    const presentIn = skill.presentIn || {};
    const rootByClient = { antigravity: 'antigravity', claude: 'claude', claudeDesktop3p: 'claudeDesktop3p', codex: 'central' };
    const clientRows = Object.entries(tools).map(([tool, meta]) => {
        const rootId = rootByClient[tool];
        const present = rootId ? Boolean(presentIn[rootId]) : Boolean(skill.installed);
        const isCentral = tool === 'codex';
        const action = present ? 'unlink' : 'link';
        const isCopy = meta.mode === 'copy';
        const actionLabel = present ? (isCopy ? '移除' : '取消链接') : (isCopy ? '复制' : '链接');
        const modeKind = isCopy ? 'copy' : 'link';
        const linkBtn = isCentral ? '' : `<button class="btn" style="padding:4px 10px;font-size:12px;flex:0 0 auto;" onclick="linkSkillClient('${escapeHtml(skill.name)}','${tool}','${action}','${modeKind}')">${actionLabel}</button>`;
        return `
        <div class="skill-mount-row">
            <div class="skill-mount-main">
                <div style="width:28px;height:28px;border-radius:8px;background:var(--input-bg);border:1px solid var(--border-color);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;flex:0 0 auto;color:${escapeHtml(meta.color || 'var(--text-primary)')};">
                    ${escapeHtml(meta.short || tool.slice(0,1).toUpperCase())}
                </div>
                <div class="skill-mount-copy">
                    <div style="font-size:13px;font-weight:600;color:var(--text-primary);">${escapeHtml(meta.label || tool)}</div>
                    <code class="path-pill skill-path-wrap">${escapeHtml(meta.path || '')}</code>
                </div>
            </div>
            ${linkBtn}
            <span class="skill-pill skill-status-pill ${present ? 'installed' : 'missing'}">${present ? '可用' : '未安装'}</span>
        </div>
        `;
    }).join('');

    const actions = [];
    if (skill.managed && !skill.installed) {
        actions.push(`<button class="btn btn-primary" onclick="installManagedSkill('${escapeHtml(skill.name)}')">安装到中央目录</button>`);
    }
    if (skill.canPromote || (skill.installed && !skill.managed)) {
        actions.push(`<button class="btn" onclick="promoteLocalSkillToManaged('${escapeHtml(skill.name)}')">转为网关托管</button>`);
    }
    if (!skill.centralReal && skill.installed) {
        actions.push(`<button class="btn btn-primary" onclick="unifySkillToCentral('${escapeHtml(skill.name)}')">统一到中央目录</button>`);
    }

    host.innerHTML = `
        <div class="skill-detail-header">
            <div class="skill-card-icon" style="width:42px;height:42px;font-size:20px;flex:0 0 auto;">${escapeHtml(skill.icon || '🧩')}</div>
            <div class="skill-detail-header-main">
                <h3>${escapeHtml(skill.title || skill.name)}</h3>
                <div class="skill-card-id">${escapeHtml(skill.name)}</div>
            </div>
            ${actions.length ? `<div class="skill-detail-header-actions">${actions.join('')}</div>` : ''}
        </div>
        <div class="skill-detail-summary">${escapeHtml(skill.summary || skill.description || '')}</div>
        <div class="skill-card-meta" style="margin-bottom:14px;">
            <span class="skill-pill">${escapeHtml(skill.categoryLabel || '其他')}</span>
            ${skill.managed ? '<span class="skill-pill managed">网关托管</span>' : '<span class="skill-pill">本地发现</span>'}
            <span class="skill-pill ${skill.installed ? 'installed' : 'missing'}">${skill.installed ? '已安装' : '未安装'}</span>
            ${skill.hasScripts ? '<span class="skill-pill">含 scripts</span>' : ''}
        </div>
        <div class="usage-guide" style="margin-bottom:12px;">
            <p>该 skill 的实际读取目录（按 central &gt; antigravity &gt; claude 优先）：</p>
            <p><code class="path-pill skill-path-wrap">${escapeHtml(skill.path || skill.skillDir || '')}</code></p>
            ${skill.managed ? `<p style="margin-top:8px;">项目托管源目录：</p><p><code class="path-pill skill-path-wrap">${escapeHtml(skill.projectSourceDir || (skillsLibraryState.managedRoot ? `${skillsLibraryState.managedRoot}/${skill.name}` : `lib/skills/${skill.name}`))}</code></p>` : ''}
        </div>
        <div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px;">客户端读取路径（参考）</div>
        <div class="skill-mount-list">${clientRows || '<div class="skill-detail-empty">暂无路径信息</div>'}</div>
    `;
}

function renderSkillsLibrary() {
    updateSkillsScopeChips();
    renderSkillsCategories();
    renderSkillsList();
    renderSkillDetail();
}

async function refreshSkillsLibrary(force = false) {
    if (skillsLibraryState.loading) return;
    if (skillsLibraryState.loaded && !force) {
        renderSkillsLibrary();
        return;
    }
    skillsLibraryState.loading = true;
    try {
        const params = new URLSearchParams({
            q: skillsLibraryState.query || '',
            category: skillsLibraryState.category || 'all',
            scope: skillsLibraryState.scope || 'all',
        });
        const res = await fetch(`/v1/skills/library?${params.toString()}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error || '加载失败');

        skillsLibraryState.loaded = true;
        skillsLibraryState.stats = data.stats || {};
        skillsLibraryState.categories = data.categories || [];
        skillsLibraryState.skills = data.skills || [];
        skillsLibraryState.allSkills = data.allSkills || data.skills || [];
        skillsLibraryState.tools = data.tools || {};
        skillsLibraryState.root = data.root || '';
        skillsLibraryState.managedRoot = data.managedRoot || '';

        if (!getSkillByName(skillsLibraryState.selectedSkill)) {
            skillsLibraryState.selectedSkill = skillsLibraryState.skills[0]?.name || skillsLibraryState.allSkills[0]?.name || '';
        }
        renderSkillsLibrary();
    } catch (err) {
        console.warn('加载技能库失败', err);
        showToast('加载技能库失败: ' + err.message, 'danger');
    } finally {
        skillsLibraryState.loading = false;
    }
}

function onSkillsSearchInput(value) {
    skillsLibraryState.query = value || '';
    if (skillsSearchTimer) clearTimeout(skillsSearchTimer);
    skillsSearchTimer = setTimeout(() => {
        refreshSkillsLibrary(true);
    }, 200);
}

window.setSkillsScope = function(scope) {
    skillsLibraryState.scope = scope || 'all';
    refreshSkillsLibrary(true);
};

window.setSkillsCategory = function(category) {
    skillsLibraryState.category = category || 'all';
    refreshSkillsLibrary(true);
};

window.selectSkill = function(name) {
    skillsLibraryState.selectedSkill = name;
    renderSkillsList();
    renderSkillDetail();
};

window.installManagedSkill = async function(skillName) {
    try {
        const res = await fetch('/v1/skills/mount', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                skill: skillName,
                targets: { antigravity: false, claude: false, codex: true },
            }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || '安装失败');
        await refreshSkillsLibrary(true);
        showToast(`已安装 ${skillName}`, 'success');
        return true;
    } catch (err) {
        showToast(`安装失败: ${err.message}`, 'danger');
        await refreshSkillsLibrary(true);
        return false;
    }
};

let skillConfirmResolver = null;
function showSkillConfirmModal(title, bodyHtml) {
    return new Promise((resolve) => {
        document.getElementById('skill-confirm-title').textContent = title;
        document.getElementById('skill-confirm-body').innerHTML = bodyHtml;
        const overlay = document.getElementById('skill-confirm-modal');
        overlay.classList.add('open');
        skillConfirmResolver = resolve;
    });
}
window.closeSkillConfirmModal = function(ok) {
    const overlay = document.getElementById('skill-confirm-modal');
    overlay.classList.remove('open');
    const resolver = skillConfirmResolver;
    skillConfirmResolver = null;
    if (resolver) resolver(ok);
};

let skillPromoteResolver = null;
let skillPromoteOriginalName = '';

window.promoteLocalSkillToManaged = async function(skillName) {
    const name = String(skillName || '').trim();
    if (!name) return false;
    skillPromoteOriginalName = name;
    document.getElementById('skill-promote-name').value = name;
    document.getElementById('skill-promote-title').value = '';
    document.getElementById('skill-promote-summary').value = '';
    document.getElementById('skill-promote-category').value = '';
    updateLeoBtnState();
    const overlay = document.getElementById('skill-promote-modal');
    overlay.classList.add('open');
    setTimeout(() => document.getElementById('skill-promote-name').focus(), 100);
    return new Promise((resolve) => { skillPromoteResolver = resolve; });
};

function updateLeoBtnState() {
    const input = document.getElementById('skill-promote-name');
    const btn = document.getElementById('skill-promote-leo-btn');
    const val = String(input.value || '').trim();
    if (val.startsWith('leo-')) {
        btn.textContent = 'leo- ✓';
        btn.classList.add('btn-primary');
    } else {
        btn.textContent = '+ leo-';
        btn.classList.remove('btn-primary');
    }
}

window.toggleLeoPrefix = function() {
    const input = document.getElementById('skill-promote-name');
    let val = String(input.value || '').trim();
    if (val.startsWith('leo-')) {
        val = val.slice(4);
    } else {
        val = 'leo-' + val;
    }
    input.value = val;
    updateLeoBtnState();
};

window.closeSkillPromoteModal = function() {
    const overlay = document.getElementById('skill-promote-modal');
    overlay.classList.remove('open');
    const resolver = skillPromoteResolver;
    skillPromoteResolver = null;
    if (resolver) resolver(false);
};

window.submitSkillPromote = async function() {
    const managedName = String(document.getElementById('skill-promote-name').value || '').trim();
    if (!managedName) { showToast('请填写托管名称', 'danger'); return; }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(managedName)) {
        showToast('名称仅限字母、数字、连字符、点、下划线', 'danger');
        return;
    }
    const title = document.getElementById('skill-promote-title').value.trim();
    const summary = document.getElementById('skill-promote-summary').value.trim();
    const category = document.getElementById('skill-promote-category').value;
    const isRename = managedName !== skillPromoteOriginalName;

    const overlay = document.getElementById('skill-promote-modal');
    overlay.classList.remove('open');

    try {
        const res = await fetch('/v1/skills/promote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                skill: skillPromoteOriginalName,
                managedName,
                title: title || undefined,
                summary: summary || undefined,
                category: category || undefined,
            }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || '转换失败');
        skillsLibraryState.selectedSkill = managedName;
        await refreshSkillsLibrary(true);
        showToast(isRename
            ? `已将 ${skillPromoteOriginalName} 转为网关托管（${managedName}）`
            : `已将 ${managedName} 转为网关托管`, 'success');
        const resolver = skillPromoteResolver;
        skillPromoteResolver = null;
        if (resolver) resolver(true);
    } catch (err) {
        showToast(`转换失败: ${err.message}`, 'danger');
        await refreshSkillsLibrary(true);
        const resolver = skillPromoteResolver;
        skillPromoteResolver = null;
        if (resolver) resolver(false);
    }
};

window.linkSkillClient = async function(skillName, client, action, modeKind) {
    try {
        const res = await fetch('/v1/skills/link', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ skill: skillName, client, action }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || '操作失败');
        await refreshSkillsLibrary(true);
        const isCopy = modeKind === 'copy';
        const msg = action === 'unlink'
            ? (isCopy ? `已从 ${client} 移除 ${skillName}` : `已从 ${client} 取消链接 ${skillName}`)
            : (isCopy ? `已复制 ${skillName} 到 ${client}` : `已链接 ${skillName} 到 ${client}`);
        showToast(msg, 'success');
        return true;
    } catch (err) {
        showToast(`操作失败: ${err.message}`, 'danger');
        await refreshSkillsLibrary(true);
        return false;
    }
};


async function loadSyncStatus() {
    try {
        const res = await fetch('/v1/sync/status');
        if (res.ok) {
            const data = await res.json();
            if (data.success) {
                const enableToggle = document.getElementById('sync-enable-toggle');
                const agTarget = document.getElementById('sync-target-antigravity');
                const claudeTarget = document.getElementById('sync-target-claude');
                const codexTarget = document.getElementById('sync-target-codex');
                const startDateInput = document.getElementById('sync-start-date');
                const endDateInput = document.getElementById('sync-end-date');
                const badge = document.getElementById('daemon-status-badge');
                const modelSelect = document.getElementById('sync-summary-model');

                if (enableToggle) enableToggle.checked = Boolean(data.enabled);
                if (data.targets) {
                    lastLoadedSyncTargets = {
                        antigravity: Boolean(data.targets.antigravity),
                        claude: Boolean(data.targets.claude),
                        codex: Boolean(data.targets.codex)
                    };
                }
                if (agTarget) agTarget.checked = Boolean(data.targets?.antigravity ?? data.symlinks?.antigravity);
                if (claudeTarget) claudeTarget.checked = Boolean(data.targets?.claude ?? data.symlinks?.claude);
                if (codexTarget) codexTarget.checked = Boolean(data.targets?.codex ?? data.symlinks?.codex);

                const grokAgTarget = document.getElementById('grok-target-antigravity');
                const grokClaudeTarget = document.getElementById('grok-target-claude');
                const grokCodexTarget = document.getElementById('grok-target-codex');

                if (grokAgTarget) grokAgTarget.checked = Boolean(data.grokImagineTargets?.antigravity ?? data.grokImagineSymlinks?.antigravity);
                if (grokClaudeTarget) grokClaudeTarget.checked = Boolean(data.grokImagineTargets?.claude ?? data.grokImagineSymlinks?.claude);
                if (grokCodexTarget) grokCodexTarget.checked = Boolean(data.grokImagineTargets?.codex ?? data.grokImagineSymlinks?.codex);

                if (startDateInput && data.dateRange?.startDate) startDateInput.value = data.dateRange.startDate;
                if (endDateInput && data.dateRange?.endDate) endDateInput.value = data.dateRange.endDate;

                setSummaryMode(data.summaryMode || 'rule');

                // Populate model dropdown with optgroups
                if (modelSelect) {
                    modelSelect.innerHTML = '';
                    const grouped = data.groupedModels || {};
                    let hasAnyModel = false;

                    for (const [key, group] of Object.entries(grouped)) {
                        if (group.models && group.models.length > 0) {
                            hasAnyModel = true;
                            const optGroup = document.createElement('optgroup');
                            optGroup.label = group.label;
                            group.models.forEach(m => {
                                const opt = document.createElement('option');
                                opt.value = m;
                                opt.textContent = m;
                                if (m === data.summaryModel) opt.selected = true;
                                optGroup.appendChild(opt);
                            });
                            modelSelect.appendChild(optGroup);
                        }
                    }

                    if (!hasAnyModel) {
                        const models = data.availableModels || [];
                        if (models.length === 0) {
                            const opt = document.createElement('option');
                            opt.value = 'claude-haiku-4-5';
                            opt.textContent = 'claude-haiku-4-5';
                            modelSelect.appendChild(opt);
                        } else {
                            models.forEach(m => {
                                const opt = document.createElement('option');
                                opt.value = m;
                                opt.textContent = m;
                                if (m === data.summaryModel) opt.selected = true;
                                modelSelect.appendChild(opt);
                            });
                        }
                    }
                }

                if (badge) {
                    if (data.daemonStatus?.isRunning || data.enabled) {
                        badge.textContent = '🟢 运行中';
                        badge.style.color = 'var(--success)';
                    } else {
                        badge.textContent = '⚪ 已关闭';
                        badge.style.color = 'var(--text-secondary)';
                    }
                }
            }
        }
    } catch (e) {
        console.warn('加载会话同步状态失败。');
    }
}

async function saveSyncConfig(source = 'sync') {
    const enabled = document.getElementById('sync-enable-toggle').checked;
    const targets = {
        antigravity: document.getElementById('sync-target-antigravity') ? document.getElementById('sync-target-antigravity').checked : Boolean(lastLoadedSyncTargets?.antigravity ?? true),
        claude: document.getElementById('sync-target-claude') ? document.getElementById('sync-target-claude').checked : Boolean(lastLoadedSyncTargets?.claude ?? true),
        codex: document.getElementById('sync-target-codex') ? document.getElementById('sync-target-codex').checked : Boolean(lastLoadedSyncTargets?.codex ?? true)
    };
    const grokImagineTargets = {
        antigravity: Boolean(document.getElementById('grok-target-antigravity')?.checked),
        claude: Boolean(document.getElementById('grok-target-claude')?.checked),
        codex: Boolean(document.getElementById('grok-target-codex')?.checked)
    };
    const startDate = document.getElementById('sync-start-date').value || null;
    const endDate = document.getElementById('sync-end-date').value || null;
    const dateRange = (startDate || endDate) ? { startDate, endDate } : null;
    const summaryModeInput = document.getElementById('sync-summary-mode-val');
    const summaryMode = summaryModeInput ? summaryModeInput.value : 'rule';
    const summaryModel = document.getElementById('sync-summary-model').value || '';

    try {
        const res = await fetch('/v1/sync/configure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled, targets, grokImagineTargets, dateRange, summaryMode, summaryModel })
        });
        const data = await res.json();
        if (data.success) {
            const badge = document.getElementById('daemon-status-badge');
            if (badge) {
                if (enabled) {
                    badge.textContent = '🟢 运行中';
                    badge.style.color = 'var(--success)';
                } else {
                    badge.textContent = '⚪ 已关闭';
                    badge.style.color = 'var(--text-secondary)';
                }
            }
            if (source === 'skills') {
                showToast('🎨 预置技能 (Agent Skills) 挂载设置已成功保存并同步！', 'success');
            } else {
                showToast('🔄 会话同步设置、时间范围与摘要模式已成功保存并应用！', 'success');
            }
            // Keep skills library mount state aligned with session-sync settings.
            skillsLibraryState.loaded = false;
            if (activeClient === 'skills') {
                refreshSkillsLibrary(true);
            }
        } else {
            showToast('保存设置失败: ' + (data.error || '未知错误'), 'danger');
        }
    } catch (e) {
        showToast('网络请求失败: ' + e.message, 'danger');
    }
}

function formatModelMapping(mapping) {
    if (!mapping) return "";
    return Object.entries(mapping).map(([k, v]) => `${k}=${v}`).join(', ');
}

/* escapeHtml moved to dom.ts */

function typeLabel(type) {
    return ENDPOINT_TYPES.find(t => t.value === type)?.label || type || '未设置类型';
}

function shortUrl(url) {
    if (!url) return '未设置接口地址';
    try {
        const u = new URL(url);
        return u.host + (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, ''));
    } catch {
        return url;
    }
}

function createEndpointSummaryHTML(client, index, ep) {
    const isVisionFallback = ep.purpose === 'vision_fallback';
    const isWebSearch = ep.purpose === 'web_search';
    const isEmbedding = ep.purpose === 'embedding';
    const isMedia = isMediaEndpoint(ep);
    const mediaPurpose = mediaPurposeDefinition(ep.purpose);
    const mediaProvider = mediaProviderDefinition(ep.provider);
    const isCapabilityNode = isVisionFallback || isWebSearch || isEmbedding || isMedia;
    const isDisabled = ep.enabled === false;
    const name = escapeHtml(ep.name || `节点 ${index + 1}`);
    const type = escapeHtml(isEmbedding ? 'OpenAI Embeddings 协议' : (isMedia ? `${mediaPurpose?.groupTitle || '媒体'} · ${mediaProvider.label}` : typeLabel(ep.type)));
    const url = escapeHtml(isMedia ? shortUrl(mediaProviderBaseUrl(ep)) : (ep.type === 'antigravity' ? 'Google v1internal gRPC · OAuth' : (ep.type === 'codex-subscription' ? 'ChatGPT Codex · 本地订阅' : shortUrl(ep.base_url))));
    const models = Array.isArray(ep.models) ? ep.models : [];
    const mappingCount = Object.keys(ep.model_mapping || {}).length;
    const previewModels = models.slice(0, 3).map(m =>
        `<span class="tag">${escapeHtml(m)}</span>`
    ).join('');
    const moreModels = models.length > 3
        ? `<span class="badge">+${models.length - 3}</span>`
        : '';
    const defaultTitle = ep.is_default ? '当前默认节点' : '设为默认节点';
    const defaultClass = ep.is_default ? 'node-card-action is-default' : 'node-card-action';

    return `
        <div class="node-card ${isDisabled ? 'is-disabled' : ''}" id="ep-${client}-${index}" role="button" tabindex="0"
             onclick="openEndpoint('${client}', ${index})"
             onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openEndpoint('${client}', ${index});}">
            <div class="node-card-top">
                <div class="node-card-title">${name}</div>
                <div class="node-card-actions" onclick="event.stopPropagation()">
                    ${isCapabilityNode ? `<label class="node-card-switch" title="${(!isDisabled) ? '禁用此节点' : '启用此节点'}">
                        <input type="checkbox" ${!isDisabled ? 'checked' : ''}
                            onchange="toggleEndpointEnabled(event, '${client}', ${index}, this)">
                        <span class="node-card-switch-track" aria-hidden="true"></span>
                    </label>` : `<label class="node-card-switch" title="${ep.expose_models ? '从模型列表隐藏此节点' : '在模型列表展示此节点'}">
                        <input type="checkbox" ${ep.expose_models ? 'checked' : ''}
                            onchange="toggleEndpointExposure(event, '${client}', ${index}, this)">
                        <span class="node-card-switch-track" aria-hidden="true"></span>
                    </label>`}
                    ${isCapabilityNode ? (isWebSearch ? `<button type="button" class="${defaultClass}" title="${ep.is_default ? '当前默认联网搜索节点' : '设为默认联网搜索节点'}"
                        onclick="event.stopPropagation(); setAsDefaultWebSearch('${client}', ${index})">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="${ep.is_default ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                        </svg>
                    </button>` : (isEmbedding ? `<button type="button" class="${defaultClass}" title="${ep.is_default ? '当前默认向量模型节点' : '设为默认向量模型节点'}"
                        onclick="event.stopPropagation(); setAsDefaultEmbedding('${client}', ${index})">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="${ep.is_default ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                        </svg>
                    </button>` : '')) : `<button type="button" class="${defaultClass}" title="${defaultTitle}"
                        onclick="event.stopPropagation(); setAsDefault('${client}', ${index})">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="${ep.is_default ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                        </svg>
                    </button>`}
                    <button type="button" class="node-card-action danger" title="删除节点"
                        onclick="event.stopPropagation(); removeEndpoint('${client}', ${index})">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                    </button>
                </div>
            </div>
            <div class="node-card-meta">
                <div class="node-card-row">
                    <span class="badge">${type}</span>
                    ${isVisionFallback ? '<span class="badge badge-default">视觉兜底</span>' : ''}
                    ${isWebSearch ? '<span class="badge badge-default">联网搜索</span>' : ''}
                    ${isEmbedding ? '<span class="badge badge-default">向量模型</span>' : ''}
                    ${isMedia ? `<span class="badge badge-default">${escapeHtml(mediaPurpose?.groupTitle || '媒体')}</span>` : ''}
                    ${ep.is_default ? '<span class="badge badge-default">默认</span>' : ''}
                    ${isDisabled ? '<span class="badge" style="background: var(--input-bg); color: var(--text-secondary);">已禁用</span>' : ''}
                </div>
                <div class="node-card-row">
                    <span class="mono" title="${escapeHtml(isWebSearch ? (ep.provider || 'tavily') : (isMedia ? mediaProviderBaseUrl(ep) : (ep.base_url || '')))}">${isWebSearch ? escapeHtml(ep.provider || 'tavily') : url}</span>
                </div>
                <div class="node-card-models">
                    ${isWebSearch
                        ? `<span class="badge">${escapeHtml(ep.options?.search_depth || 'basic')}</span><span class="badge">top ${escapeHtml(String(ep.options?.max_results ?? 5))}</span>`
                        : (isEmbedding
                            ? `<span class="badge">${escapeHtml(ep.embedding_model || '向量模型')}</span>${ep.dimensions ? `<span class="badge">${ep.dimensions}维</span>` : ''}`
                            : (previewModels || '<span class="badge">暂无上游模型</span>'))}
                    ${(isWebSearch || isEmbedding) ? '' : moreModels}
                </div>
            </div>
            <div class="node-card-footer">
                <span>${isCapabilityNode
                    ? `${escapeHtml(isWebSearch ? (ep.provider || 'tavily') : (isEmbedding ? (ep.embedding_model || '向量模型') : (isMedia ? mediaProvider.label : (ep.vision_model || '视觉兜底'))))}${isDisabled ? ' · 已禁用' : ' · 已启用'}`
                    : `${models.length} 模型 · ${mappingCount} 映射`}</span>
                <span class="node-card-cta">打开配置 →</span>
            </div>
        </div>
    `;
}

function createEndpointDetailHTML(client, index, ep) {
    const isVisionFallback = ep.purpose === 'vision_fallback';
    const isWebSearch = ep.purpose === 'web_search';
    const isEmbedding = ep.purpose === 'embedding';
    const isMedia = isMediaEndpoint(ep);
    const mediaPurpose = mediaPurposeDefinition(ep.purpose);
    const mediaProvider = mediaProviderDefinition(ep.provider);
    const isMediaSubscription = isMedia && mediaProvider.subscription;
    const isCapabilityNode = isVisionFallback || isWebSearch || isEmbedding || isMedia;
    const availableTypes = isEmbedding
        ? [{ value: 'openai-chat', label: 'OpenAI Embeddings 协议' }]
        : (client === 'code' || client === 'desktop')
        ? ENDPOINT_TYPES.filter(t => ['anthropic', 'openai-chat', 'grok', 'codex-subscription'].includes(t.value))
        : ENDPOINT_TYPES.filter(t => [...CODEX_ENDPOINT_TYPE_VALUES, 'codex-subscription'].includes(t.value));

    const typeOptions = availableTypes.map(t =>
        `<option value="${t.value}" ${ep.type === t.value ? 'selected' : ''}>${t.label}</option>`
    ).join('');
    const webSearchProviders = [
        { value: 'tavily', label: 'Tavily' },
    ];
    const webSearchProviderOptions = webSearchProviders.map(p =>
        `<option value="${p.value}" ${(ep.provider || 'tavily') === p.value ? 'selected' : ''}>${p.label}</option>`
    ).join('');
    const mediaProviderOptions = MEDIA_PROVIDERS.map(provider =>
        `<option value="${provider.value}" ${mediaProvider.value === provider.value ? 'selected' : ''}>${provider.label}</option>`
    ).join('');

    const title = escapeHtml(ep.name || `节点 ${index + 1}`);

    return `
        <div class="detail-view">
            <div class="detail-toolbar">
                <div class="detail-toolbar-left">
                    <button class="btn btn-sm" onclick="closeEndpointDetail()" title="返回节点列表">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
                        返回
                    </button>
                    <div>
                        <div class="detail-title">${title}</div>
                        <div class="detail-subtitle">节点 ${index + 1} · 完整配置</div>
                    </div>
                </div>
                <div class="detail-actions">
                    <button
                        class="btn btn-sm btn-primary"
                        id="save-node-${client}-${index}"
                        onclick="saveNode('${client}', ${index})">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
                        保存节点
                    </button>
                    ${isCapabilityNode ? (isWebSearch ? `<label class="btn btn-sm detail-default-action ${ep.is_default ? 'is-active' : ''}">
                        <input class="detail-default-input" type="radio" name="default-search-${client}" ${ep.is_default ? 'checked' : ''} onchange="setAsDefaultWebSearch('${client}', ${index})">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="${ep.is_default ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
                        ${ep.is_default ? '默认搜索' : '设为默认搜索'}
                    </label>` : (isEmbedding ? `<label class="btn btn-sm detail-default-action ${ep.is_default ? 'is-active' : ''}">
                        <input class="detail-default-input" type="radio" name="default-embedding-${client}" ${ep.is_default ? 'checked' : ''} onchange="setAsDefaultEmbedding('${client}', ${index})">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="${ep.is_default ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
                        ${ep.is_default ? '默认向量节点' : '设为默认向量节点'}
                    </label>` : '')) : `<label class="btn btn-sm detail-default-action ${ep.is_default ? 'is-active' : ''}">
                        <input class="detail-default-input" type="radio" name="default-${client}" ${ep.is_default ? 'checked' : ''} onchange="setAsDefault('${client}', ${index})">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="${ep.is_default ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
                        ${ep.is_default ? '默认节点' : '设为默认'}
                    </label>`}
                    <button class="btn btn-sm btn-danger" onclick="removeEndpoint('${client}', ${index})">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>删除</button>
                </div>
            </div>
            <div class="card" id="ep-${client}-${index}">
                <div class="form-grid">
                    <div class="form-group full">
                        <label>节点 ID（密钥索引，只读）</label>
                        <input class="mono endpoint-id" type="text" value="${escapeHtml(ep.id || '')}" readonly>
                    </div>
                    <div class="form-group">
                        <label>名称</label>
                        <input type="text" id="input-name-${client}-${index}" value="${escapeHtml(ep.name || '')}" placeholder="例如：OpenRouter" onchange="updateEndpoint('${client}', ${index}, 'name', this.value)">
                    </div>
                    ${isWebSearch ? `
                    <div class="form-group">
                        <label>搜索提供商</label>
                        <select onchange="updateEndpoint('${client}', ${index}, 'provider', this.value)">
                            ${webSearchProviderOptions}
                        </select>
                    </div>
                    <div class="form-group">
                        <label>启用状态</label>
                        <select onchange="updateEndpoint('${client}', ${index}, 'enabled', this.value === 'true')">
                            <option value="true" ${ep.enabled !== false ? 'selected' : ''}>已启用</option>
                            <option value="false" ${ep.enabled === false ? 'selected' : ''}>已关闭</option>
                        </select>
                    </div>
                    ` : isMedia ? `
                    <div class="form-group">
                        <label>媒体类型</label>
                        <input type="text" value="${escapeHtml(mediaPurpose?.groupTitle || '媒体')}" readonly>
                    </div>
                    <div class="form-group">
                        <label>提供商</label>
                        <select onchange="updateMediaProvider('${client}', ${index}, this.value)">
                            ${mediaProviderOptions}
                        </select>
                    </div>
                    <div class="form-group">
                        <label>启用状态</label>
                        <select onchange="updateEndpoint('${client}', ${index}, 'enabled', this.value === 'true')">
                            <option value="true" ${ep.enabled !== false ? 'selected' : ''}>已启用</option>
                            <option value="false" ${ep.enabled === false ? 'selected' : ''}>已关闭</option>
                        </select>
                    </div>
                    <div class="form-group full">
                        <label>接口地址 (Base URL)</label>
                        <input class="mono" type="text" value="${escapeHtml(mediaProviderBaseUrl(ep))}" ${isMediaSubscription ? 'readonly' : ''} onchange="updateEndpoint('${client}', ${index}, 'base_url', this.value)">
                    </div>
                    ` : `
                    <div class="form-group">
                        <label>类型</label>
                        <select ${isEmbedding ? 'disabled' : ''} onchange="updateEndpoint('${client}', ${index}, 'type', this.value)">
                            ${typeOptions}
                        </select>
                    </div>
                    ${(ep.type === 'antigravity' || ep.type === 'codex-subscription') ? `
                    <div class="form-group full">
                        <label>上游协议</label>
                        <div class="usage-guide" style="margin:0;">
                            <p style="margin:0;">${ep.type === 'codex-subscription' ? 'Codex 订阅走 chatgpt.com backend-api/codex/responses，读取本机 ~/.codex/auth.json，不需要 Base URL 或 API Key。请到迷你工具「接入 Codex 订阅」确认登录态。' : 'Antigravity 走 Google Cloud Code v1internal gRPC，使用本地 OAuth 订阅鉴权，不需要 Base URL 或 API Key。请到迷你工具「接入 Antigravity 订阅」完成登录。'}</p>
                        </div>
                    </div>
                    ` : `
                    <div class="form-group full">
                        <label>接口地址 (Base URL)</label>
                        <input class="mono" type="text" value="${escapeHtml(ep.base_url || '')}" placeholder="https://api.openai.com/v1" onchange="updateEndpoint('${client}', ${index}, 'base_url', this.value)">
                    </div>
                    <div class="form-group full">
                        <label>鉴权方式</label>
                        <select onchange="updateEndpoint('${client}', ${index}, 'auth', this.value)">
                            <option value="bearer" ${(ep.auth || 'bearer') === 'bearer' ? 'selected' : ''}>Bearer Token</option>
                            <option value="x-api-key" ${ep.auth === 'x-api-key' ? 'selected' : ''}>x-api-key</option>
                            <option value="none" ${ep.auth === 'none' ? 'selected' : ''}>不发送密钥</option>
                        </select>
                    </div>
                    `}
                    `}
                    ${(isWebSearch || (isMedia ? !isMediaSubscription : (ep.type !== 'antigravity' && ep.type !== 'codex-subscription'))) ? `
                    <div class="form-group full">
                        <label>${isWebSearch ? 'Tavily API Key' : '密钥 (API Key)'} ${ep.has_api_key ? '· 已配置' : '· 未配置'}</label>
                        <div class="password-input-wrapper">
                            <input class="mono" type="password" id="api-key-${client}-${index}" value="" placeholder="${ep.has_api_key ? '留空表示保留现有密钥' : (isWebSearch ? 'tvly-... 或 env:TAVILY_API_KEY' : '输入密钥或 env:变量名')}" onchange="updateEndpoint('${client}', ${index}, 'api_key', this.value)">
                            <button type="button" class="password-toggle-btn" onclick="togglePasswordVisibility('${client}', ${index}, 'api-key-${client}-${index}')" title="${ep.has_api_key ? '查看已保存密钥' : '显示/隐藏密钥'}">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                                    <circle cx="12" cy="12" r="3"></circle>
                                </svg>
                            </button>
                        </div>
                    </div>
                    ` : ''}
                    ${(client === 'codex' || client === 'deeptutor') && !isCapabilityNode ? `
                    <div class="form-group full">
                        <label>Codex 能力</label>
                        <div class="capability-options">
                            <label class="capability-option">
                                <input
                                    class="capability-checkbox"
                                    id="capabilities-input-image-${client}-${index}"
                                    type="checkbox"
                                    ${ep.capabilities?.input_modalities?.includes('image') ? 'checked' : ''}
                                    onchange="updateCodexCapability('${client}', ${index}, 'image', this.checked)">
                                <span>图片输入</span>
                            </label>
                            <label class="capability-option">
                                <input
                                    class="capability-checkbox"
                                    id="capabilities-reasoning-${client}-${index}"
                                    type="checkbox"
                                    ${ep.capabilities?.reasoning ? 'checked' : ''}
                                    onchange="updateCodexCapability('${client}', ${index}, 'reasoning', this.checked)">
                                <span>Reasoning 摘要</span>
                            </label>
                            <label class="capability-option">
                                <input
                                    class="capability-checkbox"
                                    id="capabilities-tools-${client}-${index}"
                                    type="checkbox"
                                    ${ep.capabilities?.tools !== false ? 'checked' : ''}
                                    onchange="updateCodexCapability('${client}', ${index}, 'tools', this.checked)">
                                <span>工具调用</span>
                            </label>
                        </div>
                    </div>
                    ` : ''}
                    ${isVisionFallback ? `
                    <div class="form-group">
                        <label>视觉兜底</label>
                        <select onchange="updateEndpoint('${client}', ${index}, 'vision_fallback_enabled', this.value === 'true')">
                            <option value="true" ${ep.vision_fallback_enabled !== false ? 'selected' : ''}>已启用</option>
                            <option value="false" ${ep.vision_fallback_enabled === false ? 'selected' : ''}>已关闭</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>视觉兜底模型</label>
                        <select onchange="updateEndpoint('${client}', ${index}, 'vision_model', this.value)">
                            <option value="">请选择模型</option>
                            ${(ep.models || []).map(model => `<option value="${escapeHtml(model)}" ${ep.vision_model === model ? 'selected' : ''}>${escapeHtml(model)}</option>`).join('')}
                        </select>
                    </div>
                    ` : ''}
                    ${isWebSearch ? `
                    <div class="form-group">
                        <label>search_depth</label>
                        <select onchange="updateWebSearchOption('${client}', ${index}, 'search_depth', this.value)">
                            ${['basic','advanced','fast','ultra-fast'].map(v => `<option value="${v}" ${(ep.options?.search_depth || 'basic') === v ? 'selected' : ''}>${v}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label>max_results</label>
                        <input type="number" min="1" max="20" value="${escapeHtml(String(ep.options?.max_results ?? 5))}" onchange="updateWebSearchOption('${client}', ${index}, 'max_results', Number(this.value) || 5)">
                    </div>
                    <div class="form-group">
                        <label>topic</label>
                        <select onchange="updateWebSearchOption('${client}', ${index}, 'topic', this.value)">
                            ${['general','news','finance'].map(v => `<option value="${v}" ${(ep.options?.topic || 'general') === v ? 'selected' : ''}>${v}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label>country（中文可填 china）</label>
                        <input type="text" value="${escapeHtml(ep.options?.country || 'china')}" placeholder="china" onchange="updateWebSearchOption('${client}', ${index}, 'country', this.value)">
                    </div>
                    <div class="form-group full">
                        <label>说明</label>
                        <div class="usage-guide" style="margin:0;">
                            <p style="margin:0;">联网搜索节点不会出现在模型列表里。第三方模型在需要时会调用网关注入的 <code>web_search</code> 工具，由这里配置的 Tavily 执行。</p>
                        </div>
                    </div>
                    ` : ''}
                    ${isEmbedding ? `
                    <div class="form-group">
                        <label>默认向量模型</label>
                        <select onchange="updateEndpoint('${client}', ${index}, 'embedding_model', this.value)">
                            <option value="">请选择模型</option>
                            ${(ep.models || []).map(model => `<option value="${escapeHtml(model)}" ${ep.embedding_model === model ? 'selected' : ''}>${escapeHtml(model)}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label>输出维度（可选，留空使用模型默认值）</label>
                        <input type="number" min="1" placeholder="例如: 1536" value="${ep.dimensions != null ? escapeHtml(String(ep.dimensions)) : ''}" onchange="updateEndpoint('${client}', ${index}, 'dimensions', this.value ? Number(this.value) : null)">
                    </div>
                    <div class="form-group full">
                        <label>说明</label>
                        <div class="usage-guide" style="margin:0;">
                            <p style="margin:0;">向量模型节点专为 <code>/v1/embeddings</code> 接口及 Gateway 内部组件（如会话同步、Skill 关联）提供文本向量化服务，不作为普通聊天模型展示在下拉列表中。</p>
                        </div>
                    </div>
                    ` : ''}
                    ${isWebSearch ? '' : `<div class="form-group full">
                        ${(ep.models && ep.models.length > 0) ? `
                        <div class="tags-list">
                            ${ep.models.map((m, i) => `
                                <span class="tag model-capability-tag">
                                    ${escapeHtml(m)}
                                    ${!isVisionFallback ? `
                                    <span class="model-capability-actions">
                                        ${(() => {
    const _img = ep.model_capabilities?.[m]?.image;
    const _visionState = _img === true ? 'supported' : _img === false ? 'unsupported' : 'auto';
    const _visionLabel = _visionState === 'supported' ? '支持视觉' : _visionState === 'unsupported' ? '不支持视觉' : '视觉自动';
    const _visionOpts = [
{ value: 'auto', label: '视觉自动', desc: '默认按支持视觉处理' },
{ value: 'supported', label: '支持视觉', desc: '明确标记为支持' },
{ value: 'unsupported', label: '不支持视觉', desc: '明确标记为不支持' },
    ];
    const _optsHtml = _visionOpts.map(o => {
const _active = o.value === _visionState;
return `<button type="button" class="ctx-window-option${_active ? ' is-active' : ''}"
    onclick="updateModelImageCapability('${client}', ${index}, ${i}, '${o.value}')">
    <span>${o.label}</span>
    <span class="ctx-window-check">${_active ? '\u2713' : ''}</span>
</button>`;
    }).join('');
    return `<div class="ctx-window-dropdown vision-dropdown" id="ctx-vision-${client}-${index}-${i}">
<button type="button" class="ctx-window-trigger ${_visionState === 'supported' ? 'is-supported' : _visionState === 'unsupported' ? 'is-unsupported' : ''}"
    onclick="toggleCtxVisionMenu('${client}', ${index}, ${i}, event)"
    title="视觉能力（再次点击可恢复默认）">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.7"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"></path><circle cx="12" cy="12" r="3"></circle></svg>
    <span>${_visionLabel}</span>
    <svg class="ctx-window-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
</button>
<div class="ctx-window-popover" role="menu">${_optsHtml}</div>
    </div>`;
})()}
                                    </span>
${(() => {
    const _cw = ep.model_capabilities?.[m]?.context_window;
    const _ctxOpts = [{"value":1000000,"label":"1M"},{"value":500000,"label":"500K"},{"value":256000,"label":"256K"},{"value":128000,"label":"128K"},{"value":64000,"label":"64K"}];
    const _current = _ctxOpts.find(o => o.value === _cw) || _ctxOpts[0];
    const _optsHtml = _ctxOpts.map(o => {
const _active = o.value === _current.value;
return `<button type="button" class="ctx-window-option${_active ? ' is-active' : ''}"
    onclick="updateModelContextWindow('${client}', ${index}, ${i}, '${o.value}')">
    <span>${o.label}</span>
    <span class="ctx-window-check">${_active ? '\u2713' : ''}</span>
</button>`;
    }).join('');
    return `<div class="ctx-window-dropdown" id="ctx-win-${client}-${index}-${i}">
<button type="button" class="ctx-window-trigger"
    onclick="toggleCtxWindowMenu('${client}', ${index}, ${i}, event)"
    title="上下文窗口大小（1M 为默认，不写入配置）">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.7"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="9" y1="9" x2="15" y2="9"></line><line x1="9" y1="13" x2="15" y2="13"></line><line x1="9" y1="17" x2="13" y2="17"></line></svg>
    <span>${_current.label}</span>
    <svg class="ctx-window-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
</button>
<div class="ctx-window-popover" role="menu">${_optsHtml}</div>
    </div>`;
})()}
                                    ` : ''}
                                    <button type="button" onclick="removeTag('${client}', ${index}, 'models', ${i})" title="移除模型">×</button>
                                </span>
                            `).join('')}
                        </div>
                        ` : ''}
                        <div class="model-field-head">
                            <label style="margin:0">上游模型列表 (输入模型名称后按回车添加)</label>
                            ${!isCapabilityNode ? `<button type="button" class="btn btn-xs" onclick="refreshEndpointModels('${client}', '${ep.id || ''}')">刷新模型</button>` : ''}
                        </div>
                        <div class="model-suggest-wrap" id="model-suggest-upstream-${client}-${ep.id || index}">
                        <input type="text" id="input-models-${client}-${index}" class="mono" placeholder="添加新模型并按回车 (例如: glm-5.2)..." list="media-model-suggestions-${client}-${index}" onkeydown="handleTagInput(event, '${client}', ${index}, 'models')" onfocus="${!isCapabilityNode ? `openModelSuggest('${client}', '${ep.id || ''}', 'upstream')` : ''}" oninput="${!isCapabilityNode ? `renderDiscoverySuggestions('${client}', '${ep.id || ''}')` : ''}">${isMedia ? `<datalist id="media-model-suggestions-${client}-${index}">${mediaPresetModels(mediaProvider.value, ep.purpose).map(function(m) { return '<option value="' + escapeHtml(m) + '">'; }).join('')}</datalist>` : ''}
                        ${!isCapabilityNode ? `<div class="model-suggest-popover" id="model-discovery-list-${client}-${ep.id || ''}"></div>` : ''}
                        </div>
                        ${!isCapabilityNode ? `<div class="model-suggest-meta" id="model-discovery-meta-${client}-${ep.id || ''}"></div>` : ''}
                    </div>
                    <div class="form-group full">
                        <label>模型映射关系 (输入 原模型 → 映射模型，按回车添加)</label>
                        ${Object.keys(ep.model_mapping || {}).length > 0 ? `
                        <div class="tags-list">
                            ${Object.entries(ep.model_mapping).map(([k, v]) => `
                                <span class="tag">${escapeHtml(k)} <span style="color: var(--text-secondary); margin: 0 4px;">→</span> ${escapeHtml(v)} <button type="button" onclick='removeMapping(${JSON.stringify(client)}, ${index}, ${JSON.stringify(k)})' title="移除映射">×</button></span>
                            `).join('')}
                        </div>
                        ` : ''}
                        <div class="add-mapping-row">
                            <div class="model-suggest-wrap" id="model-suggest-map-source-${client}-${ep.id || index}" style="flex:1">
                              <input type="text" id="input-mapping-req-${client}-${index}" class="mono" placeholder="${client === 'desktop' ? '原模型 (Claude 官方名)' : '原模型 (如 claude-opus)'}" onkeydown="handleMappingInput(event, '${client}', ${index}, true)" onfocus="${client === 'desktop' ? `openModelSuggest('${client}', '${ep.id || ''}', 'map-source')` : ''}" oninput="${client === 'desktop' ? `renderMappingSourceSuggestions('${client}', '${ep.id || ''}')` : ''}">
                              ${client === 'desktop' ? `<div class="model-suggest-popover" id="map-source-list-${client}-${ep.id || ''}"></div>` : ''}
                            </div>
                            <span class="mapping-arrow">→</span>
                            <div class="model-suggest-wrap" id="model-suggest-map-target-${client}-${ep.id || index}" style="flex:1">
                              <input type="text" id="input-mapping-up-${client}-${index}" class="mono" placeholder="映射模型 (如 glm-5.2) + 回车" onkeydown="handleMappingInput(event, '${client}', ${index}, false)" onfocus="openModelSuggest('${client}', '${ep.id || ''}', 'map-target')" oninput="renderMappingTargetSuggestions('${client}', '${ep.id || ''}')">
                              <div class="model-suggest-popover" id="map-target-list-${client}-${ep.id || ''}"></div>
                            </div>
                        </div>
                    </div>
                    `}
                </div>
            </div>
        </div>
    `;
}

function setSectionChrome(client, detailMode) {
    const section = document.getElementById(`section-${client}`);
    if (!section) return;
    const guide = section.querySelector('.usage-guide');
    const addMenu = section.querySelector('.section-header .add-node-dropdown');
    if (guide) guide.style.display = detailMode ? 'none' : '';
    if (addMenu) addMenu.style.display = detailMode ? 'none' : '';
}

function createEndpointGroupsHTML(client, endpoints) {
    const groups = [
        {
            title: '聊天模型',
            matches: endpoint => !isCapabilityEndpointPurpose(endpoint.purpose),
        },
        {
            title: '视觉兜底',
            matches: endpoint => endpoint.purpose === 'vision_fallback',
        },
        {
            title: '联网搜索',
            matches: endpoint => endpoint.purpose === 'web_search',
        },
        {
            title: '向量模型',
            matches: endpoint => endpoint.purpose === 'embedding',
        },
        ...MEDIA_ENDPOINT_PURPOSES.map(item => ({
            title: item.groupTitle,
            matches: endpoint => endpoint.purpose === item.purpose,
        })),
    ];

    return groups.map(group => {
        const items = endpoints
            .map((endpoint, index) => ({ endpoint, index }))
            .filter(({ endpoint }) => group.matches(endpoint));
        if (!items.length) return '';

        return `
            <section class="node-group">
                <div class="node-group-header">
                    <span class="node-group-title">${group.title}</span>
                    <span class="node-group-count">${items.length} 个节点</span>
                </div>
                <div class="endpoints-grid">
                    ${items.map(({ endpoint, index }) =>
                        createEndpointSummaryHTML(client, index, endpoint)
                    ).join('')}
                </div>
            </section>
        `;
    }).join('');
}

function render() {
    const host = config.server?.host || "127.0.0.1";
    const port = config.server?.port || 8787;
    document.querySelectorAll('.cfg-host').forEach(el => el.textContent = host === '0.0.0.0' ? '127.0.0.1' : host);
    document.querySelectorAll('.cfg-port').forEach(el => el.textContent = port);
    document.querySelectorAll('.cfg-catalog-path').forEach(el => {
        el.textContent = codexModelCatalogPath || '~/.codex/gateway-model-catalog.json';
    });
    renderClaudeCodeModelSlots();

    // Keep selection valid after delete/reorder
    if (selectedEndpoint) {
        const eps = config.clients[selectedEndpoint.client]?.endpoints || [];
        if (selectedEndpoint.index < 0 || selectedEndpoint.index >= eps.length) {
            selectedEndpoint = null;
        }
    }

    ['code', 'desktop', 'codex', 'deeptutor'].forEach(client => {
        const container = document.getElementById(`${client}-endpoints`);
        const eps = config.clients[client].endpoints || [];
        const inDetail = selectedEndpoint && selectedEndpoint.client === client;

        setSectionChrome(client, !!inDetail);

        if (inDetail) {
            const ep = eps[selectedEndpoint.index];
            container.classList.remove('endpoints-grid');
            container.classList.remove('node-groups');
            container.innerHTML = createEndpointDetailHTML(client, selectedEndpoint.index, ep);
            return;
        }

        container.classList.remove('endpoints-grid');
        container.classList.add('node-groups');
        if (eps.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <p>${client} 尚未配置任何节点。</p>
                    <button class="btn" onclick="addEndpoint('${client}')">创建第一个节点</button>
                </div>
            `;
        } else {
            container.innerHTML = createEndpointGroupsHTML(client, eps);
        }
    });

    if (activeClient === 'proxy') renderProxyEndpointsList();
    // Custom agent-node groups render into the shared custom-clients section.
    renderCustomClientNav();
    if (activeClient === 'custom-clients' || isCustomClient(activeClient) || (selectedEndpoint && isCustomClient(selectedEndpoint.client))) {
        renderCustomClientSections();
    }
}

function getClaudeCodeDefaultEndpoint() {
    const endpoints = (config.clients?.code?.endpoints || [])
        .filter(endpoint => !isCapabilityEndpointPurpose(endpoint.purpose));
    return endpoints.find(endpoint => endpoint.is_default === true)
        || (endpoints.length === 1 ? endpoints[0] : null);
}

function getEndpointPublicModels(endpoint) {
    if (!endpoint) return [];
    return [...new Set([
        ...(endpoint.models || []),
        ...Object.keys(endpoint.model_mapping || {})
    ].filter(Boolean))];
}

function renderClaudeCodeModelSlots() {
    const endpoint = getClaudeCodeDefaultEndpoint();
    const models = getEndpointPublicModels(endpoint);
    const slots = config.clients?.code?.model_slots || {};
    const help = document.getElementById('claude-code-model-slots-help');
    if (help) {
        help.textContent = endpoint
            ? `当前默认节点：${endpoint.name || endpoint.id}。保存配置后会同步到 ~/.claude/settings.json。`
            : '请先设置一个默认节点，再选择四个快捷模型。';
    }
    for (const slot of ['opus', 'sonnet', 'haiku', 'fable']) {
        const select = document.getElementById(`claude-code-slot-${slot}`);
        if (!select) continue;
        select.disabled = !endpoint;
        select.innerHTML = [
            '<option value="">不设置</option>',
            ...models.map(model =>
                `<option value="${escapeHtml(model)}" ${slots[slot] === model ? 'selected' : ''}>${escapeHtml(model)}</option>`
            )
        ].join('');
    }
}

window.updateClaudeCodeModelSlot = function(slot, model) {
    config.clients.code.model_slots ||= {};
    if (model) {
        config.clients.code.model_slots[slot] = model;
    } else {
        delete config.clients.code.model_slots[slot];
    }
};

function pruneClaudeCodeModelSlots() {
    const endpoint = getClaudeCodeDefaultEndpoint();
    const available = new Set(getEndpointPublicModels(endpoint));
    const slots = config.clients?.code?.model_slots || {};
    for (const slot of ['opus', 'sonnet', 'haiku', 'fable']) {
        if (slots[slot] && !available.has(slots[slot])) delete slots[slot];
    }
}

window.openEndpoint = function(client, index) {
    selectedEndpoint = { client, index };
    render();
    document.querySelector('.content-area')?.scrollTo?.({ top: 0 });
};

window.closeEndpointDetail = function() {
    selectedEndpoint = null;
    render();
};

window.switchTab = function(tabId) {
    // Custom agent-node names share one section; route them there but remember
    // which custom client is focused so render() can show its detail view.
    const sectionId = isCustomClient(tabId) ? 'custom-clients' : tabId;
    activeClient = tabId;
    // Leaving a tab exits detail view (custom clients keep detail only when re-selected)
    if (selectedEndpoint && selectedEndpoint.client !== tabId) {
        selectedEndpoint = null;
    }

    // Update nav items
    document.querySelectorAll('.nav-item').forEach(el => {
        el.classList.remove('active');
    });
    const navItem = document.querySelector(`.nav-item[href="#${tabId}"]`);
    if (navItem) {
        navItem.classList.add('active');
    }

    // Update sections
    document.querySelectorAll('.tab-section').forEach(el => {
        el.style.display = 'none';
        el.classList.remove('active');
    });
    const activeSection = document.getElementById(`section-${sectionId}`);
    if (activeSection) {
        activeSection.style.display = 'block';
        activeSection.classList.add('active');
    }

    render();

    if (tabId === 'analytics') {
        loadAnalyticsData();
    }
    if (tabId === 'proxy') {
        loadProxyConfig();
    }
    if (tabId === 'skills') {
        refreshSkillsLibrary(false);
    }
    if (tabId === 'install-history') {
        refreshInstallHistory();
    }
    if (tabId === 'skills' || tabId === 'install-history') {
        const g = document.getElementById('nav-skills-group');
        if (g) g.classList.add('open');
    }
    if (tabId === 'tools') {
        toolsView = 'cards';
        renderToolsCards();
    }
    if (tabId === 'cli') {
        refreshCliLibrary(false);
    }
    if (tabId === 'cli-install-history') {
        refreshCliInstallHistory();
    }
    if (tabId === 'cli-sources') {
        refreshCliSources();
    }
    if (tabId === 'cli' || tabId === 'cli-install-history' || tabId === 'cli-sources') {
        const g = document.getElementById('nav-cli-group');
        if (g) g.classList.add('open');
    }

    // Scroll to top
    document.querySelector('.content-area').scrollTop = 0;
}

const toolGroupConfigs = [
    { title: '媒体生成', tools: ['image-gen', 'video-gen', 'tts-gen'] },
    { title: '向量化', tools: ['embedding'] },
    { title: '订阅接入', tools: ['antigravity-subscribe', 'codex-subscribe'] },
    { title: '模型配置', tools: ['claude-model-catalog'] },
    { title: '其他', tools: ['classification-metrics'] },
];

function toolDefs() {
    return {
        'image-gen': { name: '图片生成', desc: '使用已配置的图片生成节点，编写提示词、选择画面比例，并查看本地生成历史。', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="m21 15-5-5L5 21"></path></svg>' },
        'video-gen': { name: '视频生成', desc: '使用已配置的视频生成节点，编写分镜提示词，提交异步任务并轮询结果，查看本地生成历史。', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="14" height="16" rx="2"></rect><path d="m22 8-6 4 6 4V8z"></path></svg>' },
        'tts-gen': { name: 'TTS 语音合成', desc: '使用已配置的 TTS 节点，选择音色、调节语速，将文本转为语音并查看本地生成历史。', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"></path><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M19 5a10 10 0 0 1 0 14"></path></svg>' },
        'embedding': { name: '文本向量化', desc: '选择已配置的向量模型,对文本生成向量或计算两段文本的余弦相似度。', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path></svg>' },
        'antigravity-subscribe': { name: '接入 Antigravity 订阅', desc: '从本机提取 OAuth 凭据，登录 Google 订阅账号，让网关使用 Antigravity 的 Gemini 模型。', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><path d="M9 12l2 2 4-4"></path></svg>' },
        'codex-subscribe': { name: '接入 Codex 订阅', desc: '读取本机 Codex/ChatGPT 登录态，把官方模型做成可给 Claude Desktop / DeepTutor 使用的节点。', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M8 12h8"></path><path d="M12 8v8"></path></svg>' },
        'claude-model-catalog': { name: 'Claude 模型列表', desc: '维护 Claude Desktop 映射原模型候选项：内置官方名 + 用户自定义。', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"></path><rect x="4" y="8" width="16" height="12" rx="2"></rect><path d="M2 14h2"></path><path d="M20 14h2"></path><path d="M15 13v2"></path><path d="M9 13v2"></path></svg>' },
        'classification-metrics': { name: '分类评估实验室', desc: '讲清 TP/FP/FN/TN，以及准确率、精准率、召回率，并用你的数据现场计算。', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>' },
    };
}

function toolCardHTML(id, def) {
    return `<div class="tools-card" id="${id}" onclick="openTool('${id}')">
        <div class="tools-card-icon">${def.icon}</div>
        <div class="tools-card-name">${escapeHtml(def.name)}</div>
        <div class="tools-card-desc">${escapeHtml(def.desc)}</div>
    </div>`;
}

function renderToolGroups(groups, defs) {
    return groups.map(group => {
        const cardsHtml = group.tools
            .filter(id => defs[id])
            .map(id => toolCardHTML(id, defs[id]))
            .join("");
        return `<div class="tools-group">
            <div class="tools-group-title">${escapeHtml(group.title)}</div>
            <div class="tools-cards">${cardsHtml}</div>
        </div>`;
    }).join("");
}

window.renderToolsCards = function() {
    const cards = document.getElementById('tools-cards');
    const detail = document.getElementById('tools-detail');
    if (!cards || !detail) return;
    detail.innerHTML = '';
    cards.style.display = '';
    cards.innerHTML = renderToolGroups(toolGroupConfigs, toolDefs());
};
window.openTool = function(toolId) {
    toolsView = toolId;
    if (toolId === 'image-gen') renderImageGenDetail();
    else if (toolId === 'video-gen') renderVideoGenDetail();
    else if (toolId === 'tts-gen') renderTtsGenDetail();
    else if (toolId === 'claude-model-catalog') renderClaudeModelCatalogDetail();
    else if (toolId === 'classification-metrics') renderClassificationMetricsDetail();
    else if (toolId === 'antigravity-subscribe') renderAntigravitySubscribeDetail();
    else if (toolId === 'codex-subscribe') renderCodexSubscribeDetail();
    else renderToolsDetail();
};

window.backToToolsCards = function() {
    if (typeof cancelAntigravityLoginWait === 'function' && antigravityAuthState?.busyAction === 'login-wait') {
        // Stop UI polling when leaving the tool; backend session can still finish.
        if (antigravityAuthState.loginPollTimer) {
            clearTimeout(antigravityAuthState.loginPollTimer);
            antigravityAuthState.loginPollTimer = null;
        }
        antigravityAuthState.busyAction = '';
    }
    toolsView = 'cards';
    const cards = document.getElementById('tools-cards');
    const detail = document.getElementById('tools-detail');
    if (cards) cards.style.display = '';
    if (detail) detail.innerHTML = '';
    renderToolsCards();
};

function subauthBadgeClass(state) {
    if (state === 'logged_in' || state === 'ready') return 'is-ok';
    if (
        state === 'expiring_soon' ||
        state === 'ready_to_login' ||
        state === 'token_expired' ||
        state === 'loading' ||
        state === 'unknown'
    ) return 'is-warn';
    return 'is-bad';
}

function formatExpiresIn(seconds) {
    if (seconds == null || !Number.isFinite(Number(seconds))) return '未知';
    const s = Math.floor(Number(seconds));
    if (s <= 0) return '已过期';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return h + ' 小时 ' + m + ' 分';
    if (m > 0) return m + ' 分';
    return s + ' 秒';
}

async function loadAntigravityAuthStatus() {
    antigravityAuthState.loading = true;
    antigravityAuthState.error = '';
    renderAntigravitySubscribeDetail(false);
    try {
        const res = await fetch('/v1/subscription-auth/antigravity/status');
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error?.message || '加载状态失败');
        antigravityAuthState.status = json;
        if (!antigravityAuthState.clientId && json?.client?.client_id) {
            antigravityAuthState.clientId = json.client.client_id;
        }
    } catch (err) {
        antigravityAuthState.error = err.message || String(err);
    } finally {
        antigravityAuthState.loading = false;
        renderAntigravitySubscribeDetail(false);
    }
}


async function loadCodexAuthStatus() {
    codexAuthState.loading = true;
    codexAuthState.error = '';
    renderCodexSubscribeDetail(false);
    try {
        const res = await fetch('/v1/subscription-auth/codex/status');
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error?.message || '加载状态失败');
        codexAuthState.status = json;
    } catch (err) {
        codexAuthState.error = err.message || String(err);
    } finally {
        codexAuthState.loading = false;
        renderCodexSubscribeDetail(false);
    }
}

window.renderCodexSubscribeDetail = function(autoLoad = true) {
    const cards = document.getElementById('tools-cards');
    const detail = document.getElementById('tools-detail');
    if (!cards || !detail) return;
    cards.style.display = 'none';
    toolsView = 'codex-subscribe';

    if (autoLoad && !codexAuthState.status && !codexAuthState.loading && !codexAuthState.error) {
        loadCodexAuthStatus();
    }

    const s = codexAuthState.status;
    const busy = Boolean(codexAuthState.busyAction);
    const state = s?.state || (codexAuthState.loading ? 'loading' : 'unknown');
    const stateLabel = s?.state_label || (codexAuthState.loading ? '加载中' : '未知');
    const badgeClass = subauthBadgeClass(state);
    const nextSteps = (s?.next_steps || []).map((step) => '<li>' + escapeHtml(step) + '</li>').join('')
        || '<li>打开工具后会自动检查本机 Codex 登录态。</li>';
    const nodeHint = s?.nodes?.configured
        ? ('已检测到 ' + s.nodes.count + ' 个 Codex 订阅节点。')
        : '尚未配置 type=codex-subscription 的节点。确认登录后，请到 Claude Desktop / DeepTutor / Codex 节点页手动添加。';
    const tokenHint = s?.token?.access_token_configured
        ? (s.token.access_token_masked || '已配置')
        : '未配置';
    const refreshHint = s?.token?.refresh_token_configured
        ? (s.token.refresh_token_masked || '已配置')
        : '未配置';

    detail.innerHTML = [
        '<button class="tools-detail-back" onclick="backToToolsCards()">返回工具列表</button>',
        '<div class="subauth-layout">',
        '  <div class="subauth-panel">',
        '    <h3>接入 Codex 订阅</h3>',
        '    <div class="subauth-status-grid">',
        '      <div class="subauth-stat"><div class="subauth-stat-label">当前状态</div><div class="subauth-stat-value"><span class="subauth-badge ' + badgeClass + '">' + escapeHtml(stateLabel) + '</span></div></div>',
        '      <div class="subauth-stat"><div class="subauth-stat-label">账号</div><div class="subauth-stat-value">' + escapeHtml(s?.token?.account_id || '未登录') + '</div></div>',
        '      <div class="subauth-stat"><div class="subauth-stat-label">Token 剩余</div><div class="subauth-stat-value">' + escapeHtml(formatExpiresIn(s?.token?.expires_in_seconds)) + '</div></div>',
        '      <div class="subauth-stat"><div class="subauth-stat-label">登录模式</div><div class="subauth-stat-value">' + escapeHtml(s?.token?.auth_mode || '未知') + '</div></div>',
        '    </div>',
        codexAuthState.error ? ('    <div class="subauth-error">' + escapeHtml(codexAuthState.error) + '</div>') : '',
        codexAuthState.message ? ('    <div class="subauth-success">' + escapeHtml(codexAuthState.message) + '</div>') : '',
        '    <div class="subauth-help">',
        '      <div>Auth 文件：<span class="subauth-path">' + escapeHtml(s?.auth_path || '~/.codex/auth.json') + '</span></div>',
        '      <div style="margin-top:6px;">access_token：' + escapeHtml(tokenHint) + '</div>',
        '      <div style="margin-top:6px;">refresh_token：' + escapeHtml(refreshHint) + '</div>',
        '      <div style="margin-top:6px;">expires_at：' + escapeHtml(s?.token?.expires_at || '未知') + '</div>',
        '      <div style="margin-top:6px;">节点配置：' + escapeHtml(nodeHint) + '</div>',
        '    </div>',
        '    <div class="subauth-actions">',
        '      <button class="btn" onclick="loadCodexAuthStatus()" ' + (busy ? 'disabled' : '') + '>刷新状态</button>',
        '      <button class="btn btn-primary" onclick="discoverCodexAuth()" ' + (busy ? 'disabled' : '') + '>' + (codexAuthState.busyAction === 'discover' ? '检测中...' : '检测本机登录态') + '</button>',
        '      <button class="btn" onclick="refreshCodexAuthToken()" ' + (busy ? 'disabled' : '') + '>' + (codexAuthState.busyAction === 'refresh' ? '刷新中...' : '尝试刷新 Token') + '</button>',
        '    </div>',
        '  </div>',
        '  <div class="subauth-panel">',
        '    <h3>接下来做什么</h3>',
        '    <ol class="subauth-steps">' + nextSteps + '</ol>',
        '    <div class="subauth-help">',
        '      <div><strong>真实上游协议</strong></div>',
        '      <div class="subauth-muted" style="margin-top:6px;">' + escapeHtml((s?.notes && s.notes[0]) || 'Codex 订阅节点真实上游是 chatgpt.com backend-api/codex/responses，读取本机 ~/.codex/auth.json，不需要 API Key。') + '</div>',
        '      <div style="margin-top:12px;"><strong>怎么给其他客户端用</strong></div>',
        '      <div class="subauth-muted" style="margin-top:6px;">到 Claude Desktop / DeepTutor / Codex 节点页新增节点，类型选「Codex 订阅（ChatGPT）」，填入当前账号可用的官方模型 ID（如 gpt-5.4）。</div>',
        '      <div style="margin-top:12px;"><strong>等价 CLI</strong></div>',
        '      <div class="subauth-muted" style="margin-top:6px;">',
        '        <div><code>' + escapeHtml(s?.commands?.discover || 'shrimp upstream codex-oauth discover') + '</code></div>',
        '        <div><code>' + escapeHtml(s?.commands?.status || 'shrimp upstream codex-oauth status') + '</code></div>',
        '        <div><code>shrimp upstream codex-oauth refresh</code></div>',
        '      </div>',
        '    </div>',
        '  </div>',
        '</div>'
    ].join('');
};

window.discoverCodexAuth = async function() {
    codexAuthState.busyAction = 'discover';
    codexAuthState.error = '';
    codexAuthState.message = '';
    renderCodexSubscribeDetail(false);
    try {
        const res = await fetch('/v1/subscription-auth/codex/discover', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        const json = await res.json();
        if (!res.ok || json.success === false) {
            throw new Error(json?.error?.message || json?.message || '检测失败');
        }
        codexAuthState.status = json.status || codexAuthState.status;
        codexAuthState.message = json.message || '已检测本机 Codex 登录态';
    } catch (err) {
        codexAuthState.error = err.message || String(err);
    } finally {
        codexAuthState.busyAction = '';
        renderCodexSubscribeDetail(false);
    }
};

window.refreshCodexAuthToken = async function() {
    codexAuthState.busyAction = 'refresh';
    codexAuthState.error = '';
    codexAuthState.message = '';
    renderCodexSubscribeDetail(false);
    try {
        const res = await fetch('/v1/subscription-auth/codex/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        const json = await res.json();
        if (!res.ok || json.success === false) {
            throw new Error(json?.error?.message || json?.message || '刷新失败');
        }
        codexAuthState.status = json.status || codexAuthState.status;
        codexAuthState.message = json.message || 'Token 状态已更新';
    } catch (err) {
        codexAuthState.error = err.message || String(err);
    } finally {
        codexAuthState.busyAction = '';
        renderCodexSubscribeDetail(false);
    }
};


window.renderAntigravitySubscribeDetail = function(autoLoad = true) {
    const cards = document.getElementById('tools-cards');
    const detail = document.getElementById('tools-detail');
    if (!cards || !detail) return;
    cards.style.display = 'none';
    toolsView = 'antigravity-subscribe';

    if (autoLoad && !antigravityAuthState.status && !antigravityAuthState.loading && !antigravityAuthState.error) {
        loadAntigravityAuthStatus();
    }

    const s = antigravityAuthState.status;
    const busy = Boolean(antigravityAuthState.busyAction);
    const state = s?.state || (antigravityAuthState.loading ? 'loading' : 'unknown');
    const stateLabel = s?.state_label || (antigravityAuthState.loading ? '加载中' : '未知');
    const badgeClass = subauthBadgeClass(state);
    const nextSteps = (s?.next_steps || []).map(step => '<li>' + escapeHtml(step) + '</li>').join('')
        || '<li>打开工具后会自动检查本机凭据与登录状态。</li>';
    const nodeHint = s?.nodes?.configured
        ? ('已检测到 ' + s.nodes.count + ' 个 Antigravity 节点：' + s.nodes.endpoints.map(ep => (ep.client + '/' + (ep.endpoint_name || ep.endpoint_id || 'node'))).join('、'))
        : '尚未配置 type=antigravity 的节点。登录成功后，请到 Codex / DeepTutor 节点页手动添加。';
    const installHint = s?.install?.detected
        ? ('已检测到：' + (s.install.install_root || ''))
        : '未检测到本机 Antigravity 安装，可手动填写 client_id / client_secret。';

    detail.innerHTML = [
        '<button class="tools-detail-back" onclick="backToToolsCards()">返回工具列表</button>',
        '<div class="subauth-layout">',
        '  <div class="subauth-panel">',
        '    <h3>接入 Antigravity 订阅</h3>',
        '    <div class="subauth-status-grid">',
        '      <div class="subauth-stat"><div class="subauth-stat-label">当前状态</div><div class="subauth-stat-value"><span class="subauth-badge ' + badgeClass + '">' + escapeHtml(stateLabel) + '</span></div></div>',
        '      <div class="subauth-stat"><div class="subauth-stat-label">账号</div><div class="subauth-stat-value">' + escapeHtml(s?.token?.account_id || '未登录') + '</div></div>',
        '      <div class="subauth-stat"><div class="subauth-stat-label">Token 剩余</div><div class="subauth-stat-value">' + escapeHtml(formatExpiresIn(s?.token?.expires_in_seconds)) + '</div></div>',
        '      <div class="subauth-stat"><div class="subauth-stat-label">Client 凭据</div><div class="subauth-stat-value">' + (s?.client?.configured ? escapeHtml(s.client.client_id_masked || '已配置') : '未配置') + '</div></div>',
        '    </div>',
        '    <div class="subauth-actions">',
        '      <button class="btn" onclick="loadAntigravityAuthStatus()" ' + (busy ? 'disabled' : '') + '>刷新状态</button>',
        '      <button class="btn btn-primary" onclick="discoverAntigravityClient()" ' + (busy ? 'disabled' : '') + '>' + (antigravityAuthState.busyAction === 'discover' ? '提取中...' : '从本机提取') + '</button>',
        '      <button class="btn btn-primary" onclick="loginAntigravitySubscription()" ' + (busy ? 'disabled' : '') + '>' + (antigravityAuthState.busyAction === 'login-start' ? '启动中...' : (antigravityAuthState.busyAction === 'login-wait' ? '等待授权中' : '一键登录')) + '</button>',
        (antigravityAuthState.busyAction === 'login-wait' ? '<button class="btn" onclick="cancelAntigravityLoginWait()">取消等待</button>' : ''),
        '      <button class="btn" onclick="toggleAntigravityManualForm()" ' + (busy ? 'disabled' : '') + '>手动填写</button>',
        '    </div>',
        antigravityAuthState.showManual ? (
          '<div class="subauth-form-row">' +
          '<input id="ag-client-id" class="subauth-input" placeholder="client_id（*.apps.googleuser.test）" value="' + escapeHtml(antigravityAuthState.clientId || '') + '" oninput="antigravityAuthState.clientId=this.value">' +
          '<input id="ag-client-secret" class="subauth-input" placeholder="client_secret（FAKESEC-...）" value="' + escapeHtml(antigravityAuthState.clientSecret || '') + '" oninput="antigravityAuthState.clientSecret=this.value">' +
          '<div class="subauth-actions" style="margin-top:0;"><button class="btn btn-primary" onclick="saveAntigravityClientCredentials()" ' + (busy ? 'disabled' : '') + '>' + (antigravityAuthState.busyAction === 'save-client' ? '保存中...' : '保存 client 凭据') + '</button></div>' +
          '</div>'
        ) : '',
        antigravityAuthState.error ? ('<div class="subauth-error">' + escapeHtml(antigravityAuthState.error) + '</div>') : '',
        antigravityAuthState.message ? ('<div class="subauth-success">' + escapeHtml(antigravityAuthState.message) + '</div>') : '',
        '    <div class="subauth-help">',
        '      <div>Secrets 文件：<span class="subauth-path">' + escapeHtml(s?.secrets_path || 'antigravity.secrets.json') + '</span></div>',
        '      <div style="margin-top:6px;">本机安装：' + escapeHtml(installHint) + '</div>',
        '      <div style="margin-top:6px;">节点配置：' + escapeHtml(nodeHint) + '</div>',
        (antigravityAuthState.authUrl ? ('      <div style="margin-top:10px;"><strong>完整授权链接</strong><div class="subauth-path" style="margin-top:4px;user-select:all;">' + escapeHtml(antigravityAuthState.authUrl) + '</div><div class="subauth-muted" style="margin-top:4px;">必须整段复制。若默认账号不对，打开后点“使用其他账号”。</div><button class="btn" style="margin-top:8px;" onclick="navigator.clipboard.writeText(antigravityAuthState.authUrl||&quot;&quot;)">复制完整链接</button><button class="btn" style="margin-top:8px;margin-left:8px;" onclick="if(antigravityAuthState.authUrl){window.open(antigravityAuthState.authUrl,&quot;_blank&quot;,&quot;noopener,noreferrer&quot;)}">重新打开链接</button></div>') : ''),
        '    </div>',
        '  </div>',
        '  <div class="subauth-panel">',
        '    <h3>接下来做什么</h3>',
        '    <ol class="subauth-steps">' + nextSteps + '</ol>',
        '    <div class="subauth-help">',
        '      <div><strong>真实上游协议</strong></div>',
        '      <div class="subauth-muted" style="margin-top:6px;">' + escapeHtml(s?.protocol_note || 'Antigravity 节点真实上游是 Google v1internal gRPC，不是 Anthropic Messages。') + '</div>',
        '      <div style="margin-top:12px;"><strong>等价 CLI</strong></div>',
        '      <div class="subauth-muted" style="margin-top:6px;">',
        '        <div><code>' + escapeHtml(s?.cli?.discover || 'shrimp upstream google-oauth discover') + '</code></div>',
        '        <div><code>' + escapeHtml(s?.cli?.login || 'shrimp upstream google-oauth login') + '</code></div>',
        '        <div><code>' + escapeHtml(s?.cli?.status || 'shrimp upstream google-oauth status') + '</code></div>',
        '      </div>',
        '    </div>',
        '  </div>',
        '</div>'
    ].join('');
};

window.toggleAntigravityManualForm = function() {
    antigravityAuthState.showManual = !antigravityAuthState.showManual;
    antigravityAuthState.error = '';
    antigravityAuthState.message = '';
    renderAntigravitySubscribeDetail(false);
};

window.discoverAntigravityClient = async function() {
    antigravityAuthState.busyAction = 'discover';
    antigravityAuthState.error = '';
    antigravityAuthState.message = '';
    renderAntigravitySubscribeDetail(false);
    try {
        const res = await fetch('/v1/subscription-auth/antigravity/discover', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ save: true }),
        });
        const json = await res.json();
        if (!res.ok || json.success === false) {
            throw new Error(json?.error?.message || json?.message || '提取失败');
        }
        antigravityAuthState.status = json.status || antigravityAuthState.status;
        antigravityAuthState.message = json.message || '已提取并保存 client 凭据';
        if (json.client_id) antigravityAuthState.clientId = json.client_id;
    } catch (err) {
        antigravityAuthState.error = err.message || String(err);
        antigravityAuthState.showManual = true;
    } finally {
        antigravityAuthState.busyAction = '';
        renderAntigravitySubscribeDetail(false);
    }
};

window.saveAntigravityClientCredentials = async function() {
    antigravityAuthState.busyAction = 'save-client';
    antigravityAuthState.error = '';
    antigravityAuthState.message = '';
    renderAntigravitySubscribeDetail(false);
    try {
        const res = await fetch('/v1/subscription-auth/antigravity/save-client', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: antigravityAuthState.clientId,
                client_secret: antigravityAuthState.clientSecret,
            }),
        });
        const json = await res.json();
        if (!res.ok || json.success === false) {
            throw new Error(json?.error?.message || '保存失败');
        }
        antigravityAuthState.status = json.state || json;
        antigravityAuthState.message = 'client 凭据已保存';
        antigravityAuthState.clientSecret = '';
        antigravityAuthState.showManual = false;
    } catch (err) {
        antigravityAuthState.error = err.message || String(err);
    } finally {
        antigravityAuthState.busyAction = '';
        renderAntigravitySubscribeDetail(false);
    }
};

window.loginAntigravitySubscription = async function() {
    // Cancel any previous poll loop first.
    if (antigravityAuthState.loginPollTimer) {
        clearTimeout(antigravityAuthState.loginPollTimer);
        antigravityAuthState.loginPollTimer = null;
    }

    antigravityAuthState.busyAction = 'login-start';
    antigravityAuthState.error = '';
    antigravityAuthState.message = '正在启动登录...';
    antigravityAuthState.authUrl = '';
    antigravityAuthState.sessionId = '';
    antigravityAuthState.loginStartedAt = Date.now();
    renderAntigravitySubscribeDetail(false);

    try {
        const res = await fetch('/v1/subscription-auth/antigravity/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ force: true }),
        });
        const json = await res.json();
        if (!res.ok || json.success === false) {
            throw new Error(json?.error?.message || '启动登录失败');
        }

        const authUrl = json.auth_url || '';
        antigravityAuthState.authUrl = authUrl;
        antigravityAuthState.sessionId = json.session_id || '';
        antigravityAuthState.message = json.message || '请在浏览器完成授权';
        antigravityAuthState.busyAction = 'login-wait';

        // Open from the browser page itself so Windows never truncates the URL.
        if (authUrl) {
            try { window.open(authUrl, '_blank', 'noopener,noreferrer'); } catch {}
        }
        renderAntigravitySubscribeDetail(false);

        if (!json.session_id) {
            throw new Error('登录会话未返回 session_id');
        }

        const sessionId = json.session_id;
        const deadline = Date.now() + 5 * 60 * 1000;

        const pollOnce = async () => {
            if (antigravityAuthState.sessionId !== sessionId) return; // cancelled/replaced
            if (Date.now() > deadline) {
                antigravityAuthState.busyAction = '';
                antigravityAuthState.error = '登录超时：请确认浏览器完成授权后重试';
                antigravityAuthState.loginPollTimer = null;
                renderAntigravitySubscribeDetail(false);
                return;
            }
            try {
                const pollRes = await fetch('/v1/subscription-auth/antigravity/login-session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session_id: sessionId }),
                });
                const poll = await pollRes.json();
                if (antigravityAuthState.sessionId !== sessionId) return;
                if (!pollRes.ok && poll?.error?.type === 'login_session_not_found') {
                    throw new Error(poll.error.message || '登录会话已失效');
                }
                if (poll.phase === 'done') {
                    antigravityAuthState.status = poll.status || antigravityAuthState.status;
                    antigravityAuthState.message = '登录成功：' + (poll.account_id || antigravityAuthState.status?.token?.account_id || '');
                    antigravityAuthState.error = '';
                    antigravityAuthState.busyAction = '';
                    antigravityAuthState.loginPollTimer = null;
                    renderAntigravitySubscribeDetail(false);
                    return;
                }
                if (poll.phase === 'error') {
                    throw new Error(poll.error?.message || '登录失败');
                }
                antigravityAuthState.message = '等待 Google 授权中... 可点“取消等待”继续使用其他功能。若账号不对，复制完整链接并选择正确账号。';
                antigravityAuthState.busyAction = 'login-wait';
                renderAntigravitySubscribeDetail(false);
                antigravityAuthState.loginPollTimer = setTimeout(pollOnce, 1500);
            } catch (err) {
                if (antigravityAuthState.sessionId !== sessionId) return;
                antigravityAuthState.error = err.message || String(err);
                antigravityAuthState.busyAction = '';
                antigravityAuthState.loginPollTimer = null;
                renderAntigravitySubscribeDetail(false);
            }
        };
        antigravityAuthState.loginPollTimer = setTimeout(pollOnce, 1200);
    } catch (err) {
        antigravityAuthState.error = err.message || String(err);
        antigravityAuthState.busyAction = '';
        antigravityAuthState.loginPollTimer = null;
        renderAntigravitySubscribeDetail(false);
    }
};

window.cancelAntigravityLoginWait = function() {
    if (antigravityAuthState.loginPollTimer) {
        clearTimeout(antigravityAuthState.loginPollTimer);
        antigravityAuthState.loginPollTimer = null;
    }
    antigravityAuthState.sessionId = '';
    antigravityAuthState.busyAction = '';
    antigravityAuthState.message = '已取消等待。若浏览器稍后完成授权，可点“刷新状态”查看结果。';
    renderAntigravitySubscribeDetail(false);
};;


function metricsToCount(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.floor(n);
}

function metricsRatio(numerator, denominator) {
    if (denominator === 0) return { value: null, unavailable: true };
    return { value: numerator / denominator, unavailable: false };
}

function guidedFromCounts(counts) {
    const tp = metricsToCount(counts.tp) ?? 0;
    const fp = metricsToCount(counts.fp) ?? 0;
    const fn = metricsToCount(counts.fn) ?? 0;
    const tn = metricsToCount(counts.tn) ?? 0;
    const selected = tp + fp;
    const total = tp + fp + fn + tn;
    return {
        total,
        selected,
        selectedWrong: fp,
        missedActual: fn,
    };
}

function syncGuidedFromCounts() {
    metricsState.guided = guidedFromCounts({
        tp: metricsState.tp,
        fp: metricsState.fp,
        fn: metricsState.fn,
        tn: metricsState.tn,
    });
}

function applyGuidedToCounts() {
    const total = metricsToCount(metricsState.guided.total);
    const selected = metricsToCount(metricsState.guided.selected);
    const selectedWrong = metricsToCount(metricsState.guided.selectedWrong);
    const missedActual = metricsToCount(metricsState.guided.missedActual);
    if ([total, selected, selectedWrong, missedActual].some((v) => v == null)) {
        return { error: '业务填写项都必须是大于等于 0 的整数。' };
    }
    if (selected > total) {
        return { error: '“判成目标”的数量不能超过总样本数。' };
    }
    if (selectedWrong > selected) {
        return { error: '“判成目标里的错误数”不能超过“判成目标”的数量。' };
    }
    const notSelected = total - selected;
    if (missedActual > notSelected) {
        return { error: '“漏掉的真实目标”不能超过“没判成目标”的数量。' };
    }
    const tp = selected - selectedWrong;
    const fp = selectedWrong;
    const fn = missedActual;
    const tn = notSelected - missedActual;
    metricsState.tp = tp;
    metricsState.fp = fp;
    metricsState.fn = fn;
    metricsState.tn = tn;
    return {
        guided: {
            total,
            selected,
            notSelected,
            selectedCorrect: tp,
            selectedWrong,
            missedActual,
        },
        counts: { tp, fp, fn, tn },
    };
}

function computeMetricsFromState() {
    let guidedMeta = null;
    if (metricsState.inputMode === 'guided') {
        const guidedResult = applyGuidedToCounts();
        if (guidedResult.error) return guidedResult;
        guidedMeta = guidedResult.guided;
    }
    const tp = metricsToCount(metricsState.tp);
    const fp = metricsToCount(metricsState.fp);
    const fn = metricsToCount(metricsState.fn);
    const tn = metricsToCount(metricsState.tn);
    if ([tp, fp, fn, tn].some((v) => v == null)) {
        return { error: 'TP / FP / FN / TN 都必须是大于等于 0 的整数。' };
    }
    const total = tp + fp + fn + tn;
    const actualPos = tp + fn;
    const actualNeg = fp + tn;
    const predictedPos = tp + fp;
    const accuracy = metricsRatio(tp + tn, total);
    const precision = metricsRatio(tp, predictedPos);
    const recall = metricsRatio(tp, actualPos);
    const f1 = (precision.value == null || recall.value == null)
        ? { value: null, unavailable: true }
        : metricsRatio(2 * precision.value * recall.value, precision.value + recall.value);
    if (!guidedMeta) {
        guidedMeta = {
            total,
            selected: predictedPos,
            notSelected: total - predictedPos,
            selectedCorrect: tp,
            selectedWrong: fp,
            missedActual: fn,
        };
    }
    return {
        counts: { tp, fp, fn, tn },
        guided: guidedMeta,
        totals: {
            total,
            actualPos,
            actualNeg,
            predictedPos,
        },
        metrics: { accuracy, precision, recall, f1 },
    };
}

function formatMetricPercent(metric) {
    if (!metric || metric.value == null) return 'N/A';
    return (metric.value * 100).toFixed(1) + '%';
}

function buildMetricsStory(result) {
    if (result.error) return [result.error];
    const { counts, totals, metrics } = result;
    const lines = [];
    lines.push('一共 ' + totals.total + ' 条样本：实际正例 ' + totals.actualPos + '，实际负例 ' + totals.actualNeg + '。');
    lines.push('模型报出 ' + totals.predictedPos + ' 个正例：其中 TP ' + counts.tp + ' 个真对，FP ' + counts.fp + ' 个误报。');
    lines.push('真实正例里抓回 ' + counts.tp + ' 个，漏掉 ' + counts.fn + ' 个（FN）。');
    if (metrics.precision.value == null) lines.push('精准率无法计算：模型没有预测出任何正例。');
    else lines.push('精准率 ' + formatMetricPercent(metrics.precision) + '：你报出来的正例里，大约 ' + formatMetricPercent(metrics.precision) + ' 是真的。');
    if (metrics.recall.value == null) lines.push('召回率无法计算：数据里没有真实正例。');
    else lines.push('召回率 ' + formatMetricPercent(metrics.recall) + '：真实正例里，大约 ' + formatMetricPercent(metrics.recall) + ' 被找回来了。');
    if (metrics.accuracy.value != null) {
        lines.push('准确率 ' + formatMetricPercent(metrics.accuracy) + '：所有判断里，对了 ' + formatMetricPercent(metrics.accuracy) + '。');
    }
    if (
        totals.total > 0
        && totals.actualPos > 0
        && totals.actualPos / totals.total <= 0.1
        && metrics.accuracy.value != null
        && metrics.accuracy.value >= 0.9
        && (metrics.recall.value == null || metrics.recall.value < 0.5)
    ) {
        lines.push('注意：正例很少时，准确率容易虚高。即使漏掉大量正例，准确率也可能看起来不错。');
    } else if (metrics.precision.value != null && metrics.recall.value != null) {
        if (metrics.precision.value - metrics.recall.value >= 0.15) {
            lines.push('当前更偏“报得准，但抓得不全”：误报少，漏报更多。');
        } else if (metrics.recall.value - metrics.precision.value >= 0.15) {
            lines.push('当前更偏“抓得全，但水分更大”：漏报少，误报更多。');
        } else {
            lines.push('当前精准率和召回率比较接近，没有明显偏向某一侧。');
        }
    }
    return lines;
}

function metricsMetricCardHtml(label, metric, hint, tone = '') {
    const toneClass = tone ? (' ' + tone) : '';
    return '<div class="metrics-metric-card' + toneClass + '">'
        + '<div class="label">' + label + '</div>'
        + '<div class="value">' + escapeHtml(formatMetricPercent(metric)) + '</div>'
        + '<div class="hint">' + hint + '</div>'
        + '</div>';
}

function buildMetricsBridgeHtml(result) {
    if (result.error) {
        return '<div class="metrics-status-slot" id="metrics-status-slot"><div class="metrics-hint-error">' + escapeHtml(result.error) + '</div></div>';
    }
    return '<div class="metrics-status-slot" id="metrics-status-slot">'
        + '<div class="metrics-bridge" id="metrics-bridge">'
        + '<h4>系统已翻译成专家口径</h4>'
        + '<div class="metrics-bridge-grid">'
        + '<div class="metrics-bridge-item tp"><strong id="metrics-bridge-tp">TP 真正例 = ' + escapeHtml(String(result.counts?.tp ?? 0)) + '</strong><span>判成目标，而且判对了</span></div>'
        + '<div class="metrics-bridge-item fp"><strong id="metrics-bridge-fp">FP 假正例 = ' + escapeHtml(String(result.counts?.fp ?? 0)) + '</strong><span>判成目标，但其实错了（误报）</span></div>'
        + '<div class="metrics-bridge-item fn"><strong id="metrics-bridge-fn">FN 假负例 = ' + escapeHtml(String(result.counts?.fn ?? 0)) + '</strong><span>没判成目标，但其实是目标（漏报）</span></div>'
        + '<div class="metrics-bridge-item tn"><strong id="metrics-bridge-tn">TN 真负例 = ' + escapeHtml(String(result.counts?.tn ?? 0)) + '</strong><span>没判成目标，而且本来也不是</span></div>'
        + '</div>'
        + '<p class="metrics-bridge-note" id="metrics-bridge-note">没判成目标 = ' + escapeHtml(String(result.guided?.notSelected ?? 0)) + '；判对的目标 = ' + escapeHtml(String(result.guided?.selectedCorrect ?? 0)) + '。切换到“直接填 TP/FP/FN/TN”时会沿用这组数。</p>'
        + '</div></div>';
}

function buildMetricsInputBodyHtml(result) {
    if (metricsState.inputMode === 'guided') {
        return '<p>先按业务场景填写，系统会自动翻译成 TP / FP / FN / TN，帮你慢慢对齐专家口径。</p>'
            + '<div class="metrics-grid-inputs">'
            + '<div class="metrics-input-card guided-total"><label>一共有多少样本</label><input type="number" min="0" step="1" data-metrics-field="total" value="' + escapeHtml(String(metricsState.guided.total)) + '" oninput="onMetricsGuidedInput(\'total\', this.value)" /></div>'
            + '<div class="metrics-input-card guided-selected"><label>其中有多少被判成目标</label><input type="number" min="0" step="1" data-metrics-field="selected" value="' + escapeHtml(String(metricsState.guided.selected)) + '" oninput="onMetricsGuidedInput(\'selected\', this.value)" /></div>'
            + '<div class="metrics-input-card guided-wrong"><label>判成目标里，有多少其实是错的</label><input type="number" min="0" step="1" data-metrics-field="selectedWrong" value="' + escapeHtml(String(metricsState.guided.selectedWrong)) + '" oninput="onMetricsGuidedInput(\'selectedWrong\', this.value)" /></div>'
            + '<div class="metrics-input-card guided-missed"><label>没判成目标里，有多少其实本该是目标</label><input type="number" min="0" step="1" data-metrics-field="missedActual" value="' + escapeHtml(String(metricsState.guided.missedActual)) + '" oninput="onMetricsGuidedInput(\'missedActual\', this.value)" /></div>'
            + '</div>'
            + buildMetricsBridgeHtml(result);
    }
    return '<p>直接填写 TP / FP / FN / TN。也可先点上方示例，再改成你的数。</p>'
        + '<div class="metrics-grid-inputs">'
        + '<div class="metrics-input-card tp"><label>TP 真正例</label><input type="number" min="0" step="1" data-metrics-field="tp" value="' + escapeHtml(String(metricsState.tp)) + '" oninput="onMetricsCountInput(\'tp\', this.value)" /></div>'
        + '<div class="metrics-input-card fp"><label>FP 假正例（误报）</label><input type="number" min="0" step="1" data-metrics-field="fp" value="' + escapeHtml(String(metricsState.fp)) + '" oninput="onMetricsCountInput(\'fp\', this.value)" /></div>'
        + '<div class="metrics-input-card fn"><label>FN 假负例（漏报）</label><input type="number" min="0" step="1" data-metrics-field="fn" value="' + escapeHtml(String(metricsState.fn)) + '" oninput="onMetricsCountInput(\'fn\', this.value)" /></div>'
        + '<div class="metrics-input-card tn"><label>TN 真负例</label><input type="number" min="0" step="1" data-metrics-field="tn" value="' + escapeHtml(String(metricsState.tn)) + '" oninput="onMetricsCountInput(\'tn\', this.value)" /></div>'
        + '</div>';
}

function buildMetricsResultBodyHtml(result) {
    if (result.error) {
        return '<div class="embed-error">' + escapeHtml(result.error) + '</div>';
    }
    const story = buildMetricsStory(result);
    return '<div class="metrics-metric-grid">'
        + metricsMetricCardHtml('准确率 Accuracy', result.metrics.accuracy, '全部判断里对了多少', 'accuracy')
        + metricsMetricCardHtml('精准率 Precision', result.metrics.precision, '报出的正例里有多少真对', 'precision')
        + metricsMetricCardHtml('召回率 Recall', result.metrics.recall, '真实正例里抓回了多少', 'recall')
        + metricsMetricCardHtml('F1', result.metrics.f1, '精准率与召回率的调和平均', 'f1')
        + '</div>'
        + '<div style="margin-top:14px;">'
        + '<p style="margin-bottom:6px;"><strong style="color:var(--text-primary);">人话报告</strong></p>'
        + '<ul class="metrics-list">'
        + story.map((line) => '<li>' + escapeHtml(line) + '</li>').join('')
        + '</ul>'
        + '</div>';
}

function updateMetricsLiveView(options = {}) {
    const rebuildInput = options.rebuildInput === true;
    const result = computeMetricsFromState();
    const countOrState = (key) => String(result.counts ? result.counts[key] : metricsState[key]);
    ['tp', 'fp', 'fn', 'tn'].forEach((key) => {
        const el = document.getElementById('metrics-count-' + key);
        if (el) el.textContent = countOrState(key);
    });

    document.querySelectorAll('.metrics-pill[data-scenario-id]').forEach((btn) => {
        const id = btn.getAttribute('data-scenario-id');
        btn.classList.toggle('active', metricsState.scenario === id);
    });
    const summary = document.getElementById('metrics-scenario-summary');
    const lesson = document.getElementById('metrics-scenario-lesson');
    const scenario = metricsScenarios[metricsState.scenario] || metricsScenarios.spam;
    if (summary) summary.textContent = scenario.summary;
    if (lesson) lesson.innerHTML = '<strong style="color:var(--text-primary);">点题：</strong>' + escapeHtml(scenario.lesson);

    document.querySelectorAll('.metrics-mode-btn[data-metrics-mode]').forEach((btn) => {
        const mode = btn.getAttribute('data-metrics-mode');
        btn.classList.toggle('active', mode === metricsState.inputMode);
    });

    const inputBody = document.getElementById('metrics-input-body');
    if (inputBody && rebuildInput) {
        inputBody.innerHTML = buildMetricsInputBodyHtml(result);
    } else if (inputBody && metricsState.inputMode === 'guided') {
        const statusHtml = buildMetricsBridgeHtml(result);
        const statusSlot = document.getElementById('metrics-status-slot');
        if (statusSlot) statusSlot.outerHTML = statusHtml;
        else inputBody.insertAdjacentHTML('beforeend', statusHtml);
        const statusNodes = inputBody.querySelectorAll('#metrics-status-slot');
        statusNodes.forEach((node, idx) => { if (idx > 0) node.remove(); });
    }

    const resultBody = document.getElementById('metrics-result-body');
    if (resultBody) resultBody.innerHTML = buildMetricsResultBodyHtml(result);
    return result;
}

window.applyMetricsScenario = function(id) {
    const scenario = metricsScenarios[id] || metricsScenarios.spam;
    metricsState.scenario = scenario.id;
    metricsState.tp = scenario.counts.tp;
    metricsState.fp = scenario.counts.fp;
    metricsState.fn = scenario.counts.fn;
    metricsState.tn = scenario.counts.tn;
    syncGuidedFromCounts();
    if (document.getElementById('metrics-input-body')) {
        updateMetricsLiveView({ rebuildInput: true });
    } else {
        renderClassificationMetricsDetail();
    }
};

window.setMetricsInputMode = function(mode) {
    metricsState.inputMode = mode === 'expert' ? 'expert' : 'guided';
    if (metricsState.inputMode === 'guided') {
        syncGuidedFromCounts();
    } else {
        applyGuidedToCounts();
    }
    if (document.getElementById('metrics-input-body')) {
        updateMetricsLiveView({ rebuildInput: true });
    } else {
        renderClassificationMetricsDetail();
    }
};

window.onMetricsCountInput = function(field, value) {
    metricsState[field] = value;
    metricsState.scenario = 'custom';
    if (metricsState.inputMode === 'expert') {
        syncGuidedFromCounts();
    }
    updateMetricsLiveView();
};

window.onMetricsGuidedInput = function(field, value) {
    metricsState.guided[field] = value;
    metricsState.scenario = 'custom';
    updateMetricsLiveView();
};

window.resetMetricsExample = function() {
    applyMetricsScenario(metricsState.scenario === 'custom' ? 'spam' : metricsState.scenario);
};

window.renderClassificationMetricsDetail = function() {
    const cards = document.getElementById('tools-cards');
    const detail = document.getElementById('tools-detail');
    if (!cards || !detail) return;
    cards.style.display = 'none';
    const result = computeMetricsFromState();
    const scenario = metricsScenarios[metricsState.scenario] || metricsScenarios.spam;
    const countOrState = (key) => escapeHtml(String(result.counts ? result.counts[key] : metricsState[key]));
    detail.innerHTML = `
        <button class="tools-detail-back" onclick="backToToolsCards()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
            返回工具列表
        </button>

        <div class="metrics-section-head">
            <h2>教学区</h2>
            <p>先建立概念，再看例子。</p>
        </div>
        <div class="metrics-teach">
            <div class="metrics-stack">
                <div class="metrics-panel">
                    <h3>先认清四格</h3>
                    <p>所有分类指标，都先从混淆矩阵这四格开始。先有“实际”，再有“预测”。下方数字会跟随当前示例/输入变化，方便对照。</p>
                    <div class="metrics-matrix">
                        <div></div>
                        <div class="metrics-matrix-label">实际正例</div>
                        <div class="metrics-matrix-label">实际负例</div>
                        <div class="metrics-matrix-label">预测正例</div>
                        <div class="metrics-cell tp"><strong>TP 真正例</strong><span>预测是，实际也是</span><div class="metrics-count" id="metrics-count-tp">${countOrState('tp')}</div></div>
                        <div class="metrics-cell fp"><strong>FP 假正例</strong><span>预测是，实际不是（误报）</span><div class="metrics-count" id="metrics-count-fp">${countOrState('fp')}</div></div>
                        <div class="metrics-matrix-label">预测负例</div>
                        <div class="metrics-cell fn"><strong>FN 假负例</strong><span>预测不是，实际是（漏报）</span><div class="metrics-count" id="metrics-count-fn">${countOrState('fn')}</div></div>
                        <div class="metrics-cell tn"><strong>TN 真负例</strong><span>预测不是，实际也不是</span><div class="metrics-count" id="metrics-count-tn">${countOrState('tn')}</div></div>
                    </div>
                </div>

                <div class="metrics-panel">
                    <h3>用例子看懂</h3>
                    <p>点场景会加载一组教学数据，并同步到下方计算区。</p>
                    <div class="metrics-pills">
                        ${Object.values(metricsScenarios).map((item) => (
                            '<button class="metrics-pill ' + (metricsState.scenario === item.id ? 'active' : '') + '" data-scenario-id="' + item.id + '" onclick="applyMetricsScenario(\'' + item.id + '\')">' + escapeHtml(item.title) + '</button>'
                        )).join('')}
                    </div>
                    <p id="metrics-scenario-summary" style="margin-top:12px;">${escapeHtml(scenario.summary)}</p>
                    <p id="metrics-scenario-lesson" style="margin-top:8px;"><strong style="color:var(--text-primary);">点题：</strong>${escapeHtml(scenario.lesson)}</p>
                </div>
            </div>

            <div class="metrics-stack">
                <div class="metrics-panel">
                    <h3>三个主指标分别回答什么</h3>
                    <ul class="metrics-list">
                        <li><strong style="color:var(--text-primary);">Accuracy 准确率</strong>：我整体靠不靠谱？</li>
                        <li><strong style="color:var(--text-primary);">Precision 精准率</strong>：我报出来的结果水分大不大？</li>
                        <li><strong style="color:var(--text-primary);">Recall 召回率</strong>：我漏了多少该抓的？</li>
                    </ul>
                    <div style="margin-top:12px;">
                        <p>Accuracy = (TP + TN) / (TP + TN + FP + FN)</p>
                        <p>Precision = TP / (TP + FP)</p>
                        <p>Recall = TP / (TP + FN)</p>
                    </div>
                </div>

                <div class="metrics-panel">
                    <h3>易混概念</h3>
                    <div class="metrics-compare">
                        <div class="metrics-compare-item">
                            <strong>Accuracy vs Precision</strong>
                            <span>准确率看“整体对不对”；精准率只看“你报出来的正例里有多少是真的”。中文都常被叫准确率，但不是一回事。</span>
                        </div>
                        <div class="metrics-compare-item">
                            <strong>Precision vs Recall</strong>
                            <span>精准率怕误报，召回率怕漏报。一个问“报得准不准”，一个问“抓得全不全”。</span>
                        </div>
                        <div class="metrics-compare-item">
                            <strong>FP vs FN</strong>
                            <span>FP 是误报：不该抓却抓了。FN 是漏报：该抓却没抓。哪个更贵，取决于业务。</span>
                        </div>
                        <div class="metrics-compare-item">
                            <strong>Accuracy 为什么会骗人</strong>
                            <span>正例很少时，模型即使几乎全预测成负例，准确率也可能很高，但召回率可以是 0。</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <div class="metrics-calc-shell">
            <div class="metrics-section-head">
                <h2>计算区</h2>
                <p>改数字后立即重算，结果紧跟在右侧。</p>
            </div>
            <div class="metrics-calc-grid">
                <div class="metrics-panel">
                    <h3>动手计算</h3>
                    <div class="metrics-mode-switch">
                        <button class="metrics-mode-btn ${metricsState.inputMode === 'guided' ? 'active' : ''}" data-metrics-mode="guided" onclick="setMetricsInputMode('guided')">业务引导填写</button>
                        <button class="metrics-mode-btn ${metricsState.inputMode === 'expert' ? 'active' : ''}" data-metrics-mode="expert" onclick="setMetricsInputMode('expert')">直接填 TP/FP/FN/TN</button>
                    </div>
                    <div id="metrics-input-body">
                    ${buildMetricsInputBodyHtml(result)}
                    </div>
                    <div class="metrics-actions">
                        <button class="btn" onclick="resetMetricsExample()">恢复当前示例</button>
                        <button class="btn" onclick="applyMetricsScenario('imbalance')">加载不平衡陷阱</button>
                    </div>
                </div>

                <div class="metrics-panel">
                    <h3>结果与人话解释</h3>
                    <div id="metrics-result-body" class="metrics-result-body">
                    ${buildMetricsResultBodyHtml(result)}
                    </div>
                </div>
            </div>
        </div>
    `;
};

// Shared custom select for mini-tools. Mirrors the add-node popover styling so long labels stay readable.
const UI_SELECT_HANDLERS = new Map();

function renderUiSelectHtml({ id, value, options = [], disabled = false, placeholder = '请选择', onChange = null }) {
    if (typeof onChange === 'function') {
        UI_SELECT_HANDLERS.set(id, onChange);
    } else {
        UI_SELECT_HANDLERS.delete(id);
    }

    const items = Array.isArray(options) ? options : [];
    const selected = items.find(item => String(item.value) === String(value));
    const label = selected?.label || placeholder;
    const optionsHtml = items.length
        ? items.map(item => {
            const active = String(item.value) === String(value);
            const description = item.description
                ? '<span class="ui-select-option-description">' + escapeHtml(item.description) + '</span>'
                : '';
            return '<button type="button" class="ui-select-option' + (active ? ' is-active' : '') + '" role="option" data-value="' + escapeHtml(String(item.value)) + '"'
                + " onclick='chooseUiSelectOption(" + JSON.stringify(id) + ", " + JSON.stringify(String(item.value)) + ", event)'>"
                + '<span class="ui-select-option-copy">'
                + '<span class="ui-select-option-title">' + escapeHtml(item.label) + '</span>'
                + description
                + '</span>'
                + '<span class="ui-select-check" aria-hidden="true">' + (active ? '✓' : '') + '</span>'
                + '</button>';
        }).join('')
        : '<div class="ui-select-empty">' + escapeHtml(placeholder || '暂无选项') + '</div>';

    return '<div class="ui-select-dropdown' + (disabled ? ' is-disabled' : '') + '" id="ui-select-' + escapeHtml(id) + '" data-ui-select-id="' + escapeHtml(id) + '">'
        + '<button type="button" class="ui-select-trigger media-gen-form-control" ' + (disabled ? 'disabled' : '')
        + ' aria-expanded="false" aria-haspopup="listbox"'
        + " onclick='toggleUiSelect(" + JSON.stringify(id) + ", event)'>"
        + '<span class="ui-select-label">' + escapeHtml(label) + '</span>'
        + '<svg class="ui-select-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>'
        + '</button>'
        + '<div class="ui-select-popover" role="listbox">' + optionsHtml + '</div>'
        + '</div>';
}

window.closeUiSelects = function(exceptId = '') {
    document.querySelectorAll('.ui-select-dropdown.is-open').forEach(dropdown => {
        if (exceptId && dropdown.dataset.uiSelectId === exceptId) return;
        dropdown.classList.remove('is-open');
        dropdown.querySelector('.ui-select-trigger')?.setAttribute('aria-expanded', 'false');
    });
};

window.toggleUiSelect = function(id, event) {
    event?.stopPropagation();
    const dropdown = document.getElementById('ui-select-' + id);
    if (!dropdown || dropdown.classList.contains('is-disabled')) return;
    const trigger = dropdown.querySelector('.ui-select-trigger');
    if (trigger?.disabled) return;
    const shouldOpen = !dropdown.classList.contains('is-open');
    closeUiSelects(id);
    closeAddNodeMenus();
    closeAllCtxWindowMenus();
    closeAllCtxVisionMenus();
    dropdown.classList.toggle('is-open', shouldOpen);
    trigger?.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
    if (shouldOpen) {
        dropdown.querySelector('.ui-select-option.is-active, .ui-select-option')?.focus();
    }
};

window.chooseUiSelectOption = function(id, value, event) {
    event?.stopPropagation();
    const dropdown = document.getElementById('ui-select-' + id);
    if (dropdown) {
        const labelEl = dropdown.querySelector('.ui-select-label');
        dropdown.querySelectorAll('.ui-select-option').forEach(btn => {
            const active = btn.getAttribute('data-value') === String(value);
            btn.classList.toggle('is-active', active);
            const check = btn.querySelector('.ui-select-check');
            if (check) check.textContent = active ? '✓' : '';
            if (active && labelEl) {
                const title = btn.querySelector('.ui-select-option-title');
                if (title) labelEl.textContent = title.textContent;
            }
        });
    }
    closeUiSelects();
    const handler = UI_SELECT_HANDLERS.get(id);
    if (typeof handler === 'function') handler(value);
};

// Shared by image/video/TTS mini-tools. Capability type is selected by endpoint purpose, never protocol type.
function getMediaEndpoints(client, purpose) {
    return (config.clients[client]?.endpoints || []).filter(
        ep => ep.purpose === purpose && ep.enabled !== false
    );
}

function mediaHistoryPreviewUrl(historyId) {
    return historyId ? '/v1/media/files/' + encodeURIComponent(historyId) : '';
}

function parseImagePaths(value) {
    return String(value || '').split(/[\n,]/).map(item => item.trim()).filter(Boolean);
}

function getEmbeddingEndpoints(client) {
    const eps = (config.clients[client]?.endpoints || []).filter(
        ep => ep.purpose === 'embedding' && ep.enabled !== false
    );
    return eps;
}

function renderMediaHistoryHtml(entries, mediaType) {
    if (!entries.length) return '<div class="media-gen-tip">暂无本地生成历史。</div>';
    return '<div class="media-gen-history">' + entries.map(entry => {
        const path = String(entry.file_path || '');
        const previewUrl = mediaHistoryPreviewUrl(entry.id);
        const prompt = entry.prompt || '未记录提示词';
        const timestamp = entry.timestamp ? new Date(entry.timestamp).toLocaleString('zh-CN', { hour12: false }) : '';
        const preview = path
            ? '<img class="media-gen-history-thumb" src="' + escapeHtml(previewUrl) + '" alt="历史生成图片" onerror="this.style.visibility=\'hidden\'">'
            : '<div class="media-gen-history-thumb"></div>';
        return '<div class="media-gen-history-item">' + preview +
            '<div><div class="media-gen-history-prompt">' + escapeHtml(prompt) + '</div>' +
            '<div class="media-gen-history-meta">' + escapeHtml(timestamp + (entry.model ? ' · ' + entry.model : '') + (path ? ' · ' + path : '')) + '</div></div>' +
            '<button class="btn" style="padding:4px 8px;font-size:11px;" onclick="deleteMediaHistoryEntry(' + escapeHtml(JSON.stringify(mediaType)) + ', ' + escapeHtml(JSON.stringify(entry.id)) + ')">删除</button>' +
            '</div>';
    }).join('') + '</div>';
}

async function loadMediaHistory(mediaType) {
    const registry = MEDIA_HISTORY_TOOL_REGISTRY.get(mediaType);
    if (!registry) return;
    const { state } = registry;
    state.historyLoading = true;
    if (toolsView === registry.toolId) registry.render();
    try {
        const res = await fetch(MEDIA_HISTORY_PATHS[mediaType] || ('/v1/media/history?media_type=' + encodeURIComponent(mediaType)), {
            headers: { 'X-Gateway-Client': state.client }
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error?.message || '加载历史失败 (' + res.status + ')');
        state.history = Array.isArray(json.entries) ? json.entries : [];
        state.historyLoaded = true;
    } catch (err) {
        state.history = [];
        state.historyLoaded = true;
        state.error = state.error || (err.message || String(err));
    } finally {
        state.historyLoading = false;
        if (toolsView === registry.toolId) registry.render();
    }
}


window.renderClaudeModelCatalogDetail = function() {
    const cards = document.getElementById('tools-cards');
    const detail = document.getElementById('tools-detail');
    if (!cards || !detail) return;
    cards.style.display = 'none';
    toolsView = 'claude-model-catalog';
    const cat = getClaudeModelCatalogConfig();
    const builtin = BUILTIN_CLAUDE_OFFICIAL_MODELS.map((id) => `<span class="tag">${escapeHtml(id)}</span>`).join('');
    const user = (cat.user_models || []).map((id, i) => `<span class="tag">${escapeHtml(id)} <button type="button" onclick="removeClaudeUserModel(${i})" title="删除">×</button></span>`).join('');
    detail.innerHTML = `
        <button class="tools-detail-back" onclick="backToToolsCards()">返回工具列表</button>
        <div class="media-gen-panel">
            <h3>Claude 模型列表</h3>
            <p class="media-gen-tip">用于 Claude Desktop 节点「模型映射」左侧原模型候选项。内置列表始终保留；你可追加自定义模型名。</p>
            <div class="form-group full"><label>内置官方候选项</label><div class="tags-list">${builtin || '<span class="media-gen-tip">无</span>'}</div></div>
            <div class="form-group full"><label>用户自定义</label>
                <div class="tags-list">${user || '<span class="media-gen-tip">暂无自定义模型</span>'}</div>
                <div class="add-mapping-row" style="margin-top:10px">
                    <input type="text" id="claude-user-model-input" class="mono" placeholder="追加模型名，例如 claude-sonnet-4-6" onkeydown="if(event.key==='Enter'){event.preventDefault(); addClaudeUserModel();}">
                    <button type="button" class="btn btn-primary" onclick="addClaudeUserModel()">添加</button>
                </div>
            </div>
            <div class="form-group full"><label>当前合并结果预览</label>
                <div class="tags-list">${mergeClaudeOfficialModelsLocal().map((id) => `<span class="tag">${escapeHtml(id)}</span>`).join('')}</div>
            </div>
            <button class="btn btn-primary" onclick="saveClaudeModelCatalog()">保存到配置</button>
        </div>`;
};

window.addClaudeUserModel = function() {
    const input = document.getElementById('claude-user-model-input');
    const value = String(input?.value || '').trim();
    if (!value) return;
    const cat = getClaudeModelCatalogConfig();
    if (!cat.user_models.includes(value)) cat.user_models.push(value);
    if (input) input.value = '';
    renderClaudeModelCatalogDetail();
};

window.removeClaudeUserModel = function(index) {
    const cat = getClaudeModelCatalogConfig();
    cat.user_models.splice(index, 1);
    renderClaudeModelCatalogDetail();
};

window.saveClaudeModelCatalog = async function() {
    getClaudeModelCatalogConfig();
    const ok = await saveConfig({ client: activeClient, scope: 'global' });
    if (ok) showToast('Claude 模型列表已保存', 'success');
};

window.renderImageGenDetail = function() {
    const cards = document.getElementById('tools-cards');
    const detail = document.getElementById('tools-detail');
    if (!cards || !detail) return;
    cards.style.display = 'none';
    toolsView = 'image-gen';

    const endpoints = getMediaEndpoints(imageGenState.client, 'image_generation');
    const selectedEndpoint = endpoints.find(ep => ep.id === imageGenState.endpointId) || endpoints[0] || null;
    if (selectedEndpoint && imageGenState.endpointId !== selectedEndpoint.id) {
        imageGenState.endpointId = selectedEndpoint.id;
        imageGenState.model = selectedEndpoint.models?.[0] || '';
    }
    const models = selectedEndpoint?.models || [];
    if (models.length && !models.includes(imageGenState.model)) imageGenState.model = models[0];
    const clients = Object.keys(config.clients || {});
    const clientSelect = renderUiSelectHtml({
        id: 'image-gen-client',
        value: imageGenState.client,
        options: clients.map(client => ({ value: client, label: clientDisplayName(client) })),
        placeholder: '选择 Client',
        onChange: (value) => onImageGenClientChange(value),
    });
    const endpointSelect = renderUiSelectHtml({
        id: 'image-gen-endpoint',
        value: imageGenState.endpointId || '',
        options: endpoints.length
            ? endpoints.map(ep => ({ value: ep.id, label: ep.name || ep.id, description: ep.provider || '' }))
            : [{ value: '', label: '无可用节点' }],
        disabled: !endpoints.length,
        placeholder: '无可用节点',
        onChange: (value) => onImageGenEndpointChange(value),
    });
    const modelSelect = renderUiSelectHtml({
        id: 'image-gen-model',
        value: imageGenState.model || '',
        options: models.length
            ? models.map(model => ({ value: model, label: model }))
            : [{ value: '', label: '使用节点默认模型' }],
        disabled: !models.length,
        placeholder: '使用节点默认模型',
        onChange: (value) => { imageGenState.model = value; },
    });
    const aspectSelect = renderUiSelectHtml({
        id: 'image-gen-aspect',
        value: imageGenState.aspectRatio,
        options: ['1:1','16:9','9:16','3:2','2:3','auto'].map(ratio => ({ value: ratio, label: ratio })),
        onChange: (value) => { imageGenState.aspectRatio = value; },
    });
    const noNodeHint = endpoints.length === 0 ? '<div class="media-gen-error">该 client 没有已启用的图片生成节点。请到代理节点添加 purpose=image_generation 的节点。</div>' : '';
    const resultHtml = renderImageGenResult();
    const historyHtml = imageGenState.historyLoading ? '<div class="media-gen-tip">正在加载历史...</div>' : renderMediaHistoryHtml(imageGenState.history, 'image');

    detail.innerHTML = `
        <button class="tools-detail-back" onclick="backToToolsCards()">返回工具列表</button>
        <div class="media-gen-layout">
            <div class="media-gen-panel">
                <h3>图片生成</h3>
                ${noNodeHint}
                <div class="media-gen-form-group"><label>Client</label>
                    ${clientSelect}</div>
                <div class="media-gen-form-group"><label>图片生成节点</label>
                    ${endpointSelect}</div>
                <div class="media-gen-form-group"><label>模型</label>
                    ${modelSelect}</div>
                <div class="media-gen-form-group"><label>提示词</label>
                    <textarea id="image-gen-prompt" class="media-gen-form-control media-gen-textarea" placeholder="描述主体、风格、构图和你不希望出现的元素" oninput="imageGenState.prompt=this.value">${escapeHtml(imageGenState.prompt)}</textarea></div>
                <div class="media-gen-tags">
                    ${['产品海报','人物肖像','概念场景','品牌插画','图标贴纸','建筑空间','美食摄影','信息图'].map(tag => '<button type="button" class="media-gen-tag" onclick="applyImagePromptSuggestion(\'' + tag + '\')">' + tag + '</button>').join('')}
                </div>
                <div class="media-gen-tip"><strong>提示模板：</strong>主体/风格/构图/光影/约束。例：主体：玻璃杯中的柠檬气泡水；风格：高级商业摄影；构图：居中近景；光影：柔和侧逆光；约束：无文字、无水印。</div>
                <div class="media-gen-form-group"><label>画面比例</label>
                    ${aspectSelect}</div>
                <div class="media-gen-form-group"><label>参考图片路径（逗号或换行分隔）</label>
                    <textarea class="media-gen-form-control" rows="3" placeholder="C:\\images\\reference.png" oninput="imageGenState.imagePaths=this.value">${escapeHtml(imageGenState.imagePaths)}</textarea></div>
                <div class="media-gen-notice">参考图路径会按 <code>image_paths</code> 提交给本地网关读取。浏览器不会直接读取任意本地路径；请确认路径对运行网关的本机账户可访问。</div>
                ${imageGenState.referenceNotice ? '<div class="media-gen-notice">' + escapeHtml(imageGenState.referenceNotice) + '</div>' : ''}
                <button class="btn btn-primary" onclick="runImageGeneration()" ${imageGenState.loading || !endpoints.length ? 'disabled' : ''}>${imageGenState.loading ? '生成中...' : '生成图片'}</button>
            </div>
            <div class="media-gen-panel"><h3>结果</h3>${resultHtml}<h3 style="margin-top:18px;">本地历史</h3>${historyHtml}</div>
        </div>`;
    if (!imageGenState.historyLoading && !imageGenState.historyLoaded) loadMediaHistory('image');
};

window.onImageGenClientChange = function(client) {
    imageGenState.client = client;
    imageGenState.endpointId = '';
    imageGenState.model = '';
    imageGenState.result = null;
    imageGenState.error = '';
    imageGenState.history = [];
    imageGenState.historyLoaded = false;
    renderImageGenDetail();
};

window.onImageGenEndpointChange = function(endpointId) {
    imageGenState.endpointId = endpointId;
    const endpoint = getMediaEndpoints(imageGenState.client, 'image_generation').find(ep => ep.id === endpointId);
    imageGenState.model = endpoint?.models?.[0] || '';
    imageGenState.result = null;
    imageGenState.error = '';
    renderImageGenDetail();
};

window.applyImagePromptSuggestion = function(tag) {
    const suggestions = {
        '产品海报': '主体：一款极简科技产品；风格：高级广告海报；构图：留白充足的中心构图；光影：轮廓光；约束：无文字、无水印。',
        '人物肖像': '主体：自然神态的人物半身肖像；风格：编辑风时尚摄影；构图：眼平视角；光影：柔和窗光；约束：真实皮肤质感、无文字。',
        '概念场景': '主体：未来感概念场景；风格：电影级概念艺术；构图：广角远景；光影：戏剧化体积光；约束：画面叙事清晰。',
        '品牌插画': '主体：品牌故事中的核心角色；风格：统一扁平插画；构图：清晰视觉层级；光影：简洁色块；约束：预留文案空间、无文字。',
        '图标贴纸': '主体：可爱图标贴纸组；风格：干净矢量插画；构图：单个主体居中；光影：轻微投影；约束：白色背景、无文字。',
        '建筑空间': '主体：现代建筑室内空间；风格：建筑摄影；构图：对称广角；光影：清晨自然光；约束：材质真实、无人。',
        '美食摄影': '主体：精致餐盘与食物细节；风格：杂志美食摄影；构图：45 度近景；光影：温暖侧光；约束：无文字、食材新鲜。',
        '信息图': '主体：易懂的视觉化信息图；风格：现代编辑设计；构图：模块化网格；光影：平面色彩；约束：不生成可读文字，以图形符号表达。'
    };
    imageGenState.prompt = suggestions[tag] || imageGenState.prompt;
    renderImageGenDetail();
};

function renderImageGenResult() {
    if (imageGenState.loading) return '<div class="media-gen-tip">正在请求生成服务，请保持此页面打开。</div>';
    if (imageGenState.error) return '<div class="media-gen-error">' + escapeHtml(imageGenState.error) + '</div>';
    if (!imageGenState.result) return '<div class="media-gen-tip">生成完成后会显示本地文件预览和可复制路径。</div>';
    const path = imageGenState.result.file_path || imageGenState.result.filePath || '';
    const historyId = imageGenState.result.history_id || imageGenState.result.historyId || '';
    const url = mediaHistoryPreviewUrl(historyId);
    return (path ? '<img class="media-gen-preview" src="' + escapeHtml(url) + '" alt="生成的图片" onerror="this.insertAdjacentHTML(\'afterend\', \'<div class=&quot;media-gen-notice&quot;>本地文件无法由当前浏览器预览，但文件已保存，可复制路径后打开。</div>\')">' : '') +
        '<div class="media-gen-path">' + escapeHtml(path || '服务未返回 file_path') + '</div>' +
        '<div class="media-gen-actions">' + (path ? '<button class="btn" onclick="copyMediaPath(' + escapeHtml(JSON.stringify(path)) + ')">复制路径</button>' : '') +
        (historyId ? '<span class="media-gen-tip" style="margin:0;">历史 ID: ' + escapeHtml(historyId) + '</span>' : '') + '</div>';
}

window.runImageGeneration = async function() {
    const prompt = imageGenState.prompt.trim();
    if (!prompt) { imageGenState.error = '请输入提示词'; renderImageGenDetail(); return; }
    if (!imageGenState.endpointId) { imageGenState.error = '请选择图片生成节点'; renderImageGenDetail(); return; }
    const imagePaths = parseImagePaths(imageGenState.imagePaths);
    imageGenState.loading = true;
    imageGenState.error = '';
    imageGenState.result = null;
    imageGenState.referenceNotice = imagePaths.length ? '已提交 ' + imagePaths.length + ' 个参考图路径给本地网关读取。' : '';
    renderImageGenDetail();
    try {
        const res = await fetch('/v1/media/image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Gateway-Client': imageGenState.client },
            body: JSON.stringify({ endpoint_id: imageGenState.endpointId, model: imageGenState.model || undefined, prompt, aspectRatio: imageGenState.aspectRatio, image_paths: imagePaths })
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error?.message || '生成失败 (' + res.status + ')');
        if (!json.file_path && !json.filePath) throw new Error('服务返回成功但缺少 file_path');
        imageGenState.result = json;
        await loadMediaHistory('image');
    } catch (err) {
        imageGenState.error = err.message || String(err);
    } finally {
        imageGenState.loading = false;
        if (toolsView === 'image-gen') renderImageGenDetail();
    }
};

window.copyMediaPath = function(filePath) {
    navigator.clipboard.writeText(filePath).then(() => showToast('已复制文件路径', 'success'), () => showToast('复制失败', 'danger'));
};

window.deleteMediaHistoryEntry = async function(mediaType, historyId) {
    const registry = MEDIA_HISTORY_TOOL_REGISTRY.get(mediaType);
    if (!registry) return;
    try {
        const res = await fetch('/v1/media/history/' + encodeURIComponent(historyId), {
            method: 'DELETE', headers: { 'X-Gateway-Client': registry.state.client }
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error?.message || '删除失败 (' + res.status + ')');
        registry.state.history = registry.state.history.filter(entry => entry.id !== historyId);
        if (toolsView === registry.toolId) registry.render();
    } catch (err) { showToast('删除历史失败: ' + (err.message || err), 'danger'); }
};


window.renderVideoGenDetail = function() {
    const cards = document.getElementById('tools-cards');
    const detail = document.getElementById('tools-detail');
    if (!cards || !detail) return;
    cards.style.display = 'none';
    toolsView = 'video-gen';

    const endpoints = getMediaEndpoints(videoGenState.client, 'video_generation');
    const selectedEndpoint = endpoints.find(ep => ep.id === videoGenState.endpointId) || endpoints[0] || null;
    if (selectedEndpoint && videoGenState.endpointId !== selectedEndpoint.id) {
        videoGenState.endpointId = selectedEndpoint.id;
        videoGenState.model = selectedEndpoint.models?.[0] || '';
    }
    const models = selectedEndpoint?.models || [];
    if (models.length && !models.includes(videoGenState.model)) videoGenState.model = models[0];
    const clients = Object.keys(config.clients || {});
    const clientSelect = renderUiSelectHtml({
        id: 'video-gen-client',
        value: videoGenState.client,
        options: clients.map(client => ({ value: client, label: clientDisplayName(client) })),
        placeholder: '选择 Client',
        onChange: (value) => onVideoGenClientChange(value),
    });
    const endpointSelect = renderUiSelectHtml({
        id: 'video-gen-endpoint',
        value: videoGenState.endpointId || '',
        options: endpoints.length
            ? endpoints.map(ep => ({ value: ep.id, label: ep.name || ep.id, description: ep.provider || '' }))
            : [{ value: '', label: '无可用节点' }],
        disabled: !endpoints.length,
        placeholder: '无可用节点',
        onChange: (value) => onVideoGenEndpointChange(value),
    });
    const modelSelect = renderUiSelectHtml({
        id: 'video-gen-model',
        value: videoGenState.model || '',
        options: models.length
            ? models.map(model => ({ value: model, label: model }))
            : [{ value: '', label: '使用节点默认模型' }],
        disabled: !models.length,
        placeholder: '使用节点默认模型',
        onChange: (value) => { videoGenState.model = value; },
    });
    const aspectSelect = renderUiSelectHtml({
        id: 'video-gen-aspect',
        value: videoGenState.aspectRatio,
        options: ['16:9','9:16','1:1','4:3','3:4'].map(ratio => ({ value: ratio, label: ratio })),
        onChange: (value) => { videoGenState.aspectRatio = value; },
    });
    const noNodeHint = endpoints.length === 0 ? '<div class="media-gen-error">该 client 没有已启用的视频生成节点。请到代理节点添加 purpose=video_generation 的节点。</div>' : '';
    const resultHtml = renderVideoGenResult();
    const historyHtml = videoGenState.historyLoading ? '<div class="media-gen-tip">正在加载历史...</div>' : renderMediaHistoryHtml(videoGenState.history, 'video');

    detail.innerHTML = `
        <button class="tools-detail-back" onclick="backToToolsCards()">返回工具列表</button>
        <div class="media-gen-layout">
            <div class="media-gen-panel">
                <h3>视频生成</h3>
                ${noNodeHint}
                <div class="media-gen-form-group"><label>Client</label>
                    ${clientSelect}</div>
                <div class="media-gen-form-group"><label>视频生成节点</label>
                    ${endpointSelect}</div>
                <div class="media-gen-form-group"><label>模型</label>
                    ${modelSelect}</div>
                <div class="media-gen-form-group"><label>提示词</label>
                    <textarea id="video-gen-prompt" class="media-gen-form-control media-gen-textarea" placeholder="描述视频内容、镜头运动和风格" oninput="videoGenState.prompt=this.value">${escapeHtml(videoGenState.prompt)}</textarea></div>
                <div class="media-gen-tags">
                    ${['产品展示','自然风光','城市航拍','人物动态','抽象动画','故事片段'].map(tag => '<button type="button" class="media-gen-tag" onclick="applyVideoPromptSuggestion(\'' + tag + '\')">' + tag + '</button>').join('')}
                </div>
                <div class="media-gen-tip"><strong>分镜模板：</strong>镜头1/镜头2/镜头3，每个镜头含景别/动作/运镜，加上光影色调与画质约束。例：镜头1：近景，咖啡杯被端起，缓慢推近；镜头2：中景，窗边晨光，固定机位；镜头3：特写，蒸汽升起，微距。色调：温暖晨光。约束：无字幕、无水印。</div>
                <div class="media-gen-form-group"><label>画面比例</label>
                    ${aspectSelect}</div>
                <div class="media-gen-form-group"><label>时长（秒）</label>
                    <input type="number" class="media-gen-form-control" min="3" max="15" value="${videoGenState.duration}" onchange="videoGenState.duration=Number(this.value)"></div>
                <div class="media-gen-form-group"><label>参考图片路径（逗号或换行分隔，可选）</label>
                    <textarea class="media-gen-form-control" rows="3" placeholder="C:\\images\\first_frame.png" oninput="videoGenState.imagePaths=this.value">${escapeHtml(videoGenState.imagePaths)}</textarea></div>
                <div class="media-gen-notice">参考图路径会按 <code>image_paths</code> 提交给本地网关读取。浏览器不会直接读取任意本地路径；请确认路径对运行网关的本机账户可访问。</div>
                ${videoGenState.referenceNotice ? '<div class="media-gen-notice">' + escapeHtml(videoGenState.referenceNotice) + '</div>' : ''}
                <button class="btn btn-primary" onclick="runVideoGeneration()" ${videoGenState.loading || !endpoints.length ? 'disabled' : ''}>${videoGenState.loading ? '提交中...' : '生成视频'}</button>
            </div>
            <div class="media-gen-panel"><h3>结果</h3>${resultHtml}<h3 style="margin-top:18px;">本地历史</h3>${historyHtml}</div>
        </div>`;
    if (!videoGenState.historyLoading && !videoGenState.historyLoaded) loadMediaHistory('video');
};

window.onVideoGenClientChange = function(client) {
    videoGenState.client = client;
    videoGenState.endpointId = '';
    videoGenState.model = '';
    videoGenState.result = null;
    videoGenState.error = '';
    videoGenState.taskId = null;
    videoGenState.pollStatus = '';
    videoGenState.pollProgress = null;
    videoGenState.history = [];
    videoGenState.historyLoaded = false;
    renderVideoGenDetail();
};

window.onVideoGenEndpointChange = function(endpointId) {
    videoGenState.endpointId = endpointId;
    const endpoint = getMediaEndpoints(videoGenState.client, 'video_generation').find(ep => ep.id === endpointId);
    videoGenState.model = endpoint?.models?.[0] || '';
    videoGenState.result = null;
    videoGenState.error = '';
    renderVideoGenDetail();
};

window.applyVideoPromptSuggestion = function(tag) {
    const suggestions = {
        '产品展示': '镜头1：中景，产品放置于简洁台面，缓慢环绕运镜；镜头2：近景，材质与细节特写，推近；镜头3：全景，产品与场景关系，拉远。色调：明亮自然光。约束：无字幕、无水印。',
        '自然风光': '镜头1：广角，山峦全景，无人机前推；镜头2：中景，溪流特写，固定机位；镜头3：延时，云层流动，固定机位。色调：清晨冷色调转暖色。约束：无字幕、无水印。',
        '城市航拍': '镜头1：高空俯拍，城市夜景，无人机前推；镜头2：中低空，街道车流，侧向移动；镜头3：特写，霓虹灯牌，缓慢推近。色调：赛博朋克霓虹。约束：无字幕、无水印。',
        '人物动态': '镜头1：中景，人物行走，跟拍运镜；镜头2：近景，表情变化，固定机位；镜头3：全景，人物与环境互动，缓慢拉远。色调：电影感暖色调。约束：无字幕、无水印。',
        '抽象动画': '镜头1：粒子聚合，推近运镜；镜头2：色彩流动，固定机位；镜头3：几何变换，旋转运镜。色调：高饱和度。约束：无字幕、无水印。',
        '故事片段': '镜头1：近景，角色开门，推近；镜头2：中景，室内场景，固定机位；镜头3：特写，关键道具，微距。色调：悬疑低对比度。约束：无字幕、无水印。'
    };
    videoGenState.prompt = suggestions[tag] || videoGenState.prompt;
    renderVideoGenDetail();
};

function renderVideoGenResult() {
    if (videoGenState.loading) return '<div class="media-gen-tip">正在提交视频生成任务...</div>';
    if (videoGenState.error) return '<div class="media-gen-error">' + escapeHtml(videoGenState.error) + '</div>';
    if (videoGenState.taskId && videoGenState.pollStatus !== 'succeeded') {
        const progress = videoGenState.pollProgress != null ? videoGenState.pollProgress + '%' : '';
        const bar = videoGenState.pollProgress != null
            ? '<div class="media-gen-progress-bar"><div class="media-gen-progress-fill" style="width:' + videoGenState.pollProgress + '%"></div></div>'
            : '<div class="media-gen-tip">任务处理中...</div>';
        return '<div class="media-gen-tip">任务 ID: ' + escapeHtml(videoGenState.taskId) + (videoGenState.pollStatus ? ' · ' + escapeHtml(videoGenState.pollStatus) : '') + (progress ? ' · ' + progress : '') + '</div>' + bar;
    }
    if (!videoGenState.result) return '<div class="media-gen-tip">提交任务后，结果会在此显示视频播放器和可复制路径。</div>';
    const path = videoGenState.result.file_path || videoGenState.result.filePath || '';
    const historyId = videoGenState.result.history_id || videoGenState.result.historyId || '';
    const url = mediaHistoryPreviewUrl(historyId);
    return (path ? '<video class="media-gen-preview" controls src="' + escapeHtml(url) + '" onerror="this.insertAdjacentHTML(\'afterend\', \'<div class=&quot;media-gen-notice&quot;>本地文件无法由当前浏览器预览，但文件已保存，可复制路径后打开。</div>\')"></video>' : '') +
        '<div class="media-gen-path">' + escapeHtml(path || '服务未返回 file_path') + '</div>' +
        '<div class="media-gen-actions">' + (path ? '<button class="btn" onclick="copyMediaPath(' + escapeHtml(JSON.stringify(path)) + ')">复制路径</button>' : '') +
        (historyId ? '<span class="media-gen-tip" style="margin:0;">历史 ID: ' + escapeHtml(historyId) + '</span>' : '') + '</div>';
}

window.runVideoGeneration = async function() {
    const prompt = videoGenState.prompt.trim();
    if (!prompt) { videoGenState.error = '请输入提示词'; renderVideoGenDetail(); return; }
    if (!videoGenState.endpointId) { videoGenState.error = '请选择视频生成节点'; renderVideoGenDetail(); return; }
    const imagePaths = parseImagePaths(videoGenState.imagePaths);
    videoGenState.loading = true;
    videoGenState.error = '';
    videoGenState.result = null;
    videoGenState.taskId = null;
    videoGenState.pollStatus = '';
    videoGenState.pollProgress = null;
    videoGenState.referenceNotice = imagePaths.length ? '已提交 ' + imagePaths.length + ' 个参考图路径给本地网关读取。' : '';
    renderVideoGenDetail();
    try {
        const res = await fetch('/v1/media/video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Gateway-Client': videoGenState.client },
            body: JSON.stringify({ endpoint_id: videoGenState.endpointId, model: videoGenState.model || undefined, prompt, aspectRatio: videoGenState.aspectRatio, duration: videoGenState.duration, image_paths: imagePaths })
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error?.message || '提交失败 (' + res.status + ')');
        const taskId = json.task_id || json.taskId;
        if (!taskId) throw new Error('服务返回成功但缺少 task_id');
        videoGenState.taskId = taskId;
        videoGenState.pollStatus = json.status || 'processing';
        videoGenState.loading = false;
        renderVideoGenDetail();
        pollVideoTask(taskId);
    } catch (err) {
        videoGenState.error = err.message || String(err);
    } finally {
        videoGenState.loading = false;
        if (toolsView === 'video-gen') renderVideoGenDetail();
    }
};

async function pollVideoTask(taskId) {
    if (toolsView !== 'video-gen') return;
    if (videoGenState.taskId !== taskId) return;
    try {
        const res = await fetch('/v1/media/tasks/' + encodeURIComponent(taskId), {
            headers: { 'X-Gateway-Client': videoGenState.client }
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error?.message || '轮询失败 (' + res.status + ')');
        videoGenState.pollStatus = json.status || 'processing';
        videoGenState.pollProgress = json.progress ?? null;
        if (json.status === 'succeeded') {
            if (json.file_path || json.filePath) {
                videoGenState.result = json;
            }
            await loadMediaHistory('video');
            renderVideoGenDetail();
            return;
        }
        if (json.status === 'failed') {
            videoGenState.error = json.error || '视频生成失败';
            renderVideoGenDetail();
            return;
        }
        renderVideoGenDetail();
    } catch (err) {
        videoGenState.error = err.message || String(err);
        renderVideoGenDetail();
        return;
    }
    if (toolsView === 'video-gen' && videoGenState.taskId === taskId) {
        setTimeout(() => pollVideoTask(taskId), 4000);
    }
}

registerMediaHistoryTool('image', 'image-gen', imageGenState, () => renderImageGenDetail());

window.renderTtsGenDetail = function() {
    const cards = document.getElementById('tools-cards');
    const detail = document.getElementById('tools-detail');
    if (!cards || !detail) return;
    cards.style.display = 'none';
    toolsView = 'tts-gen';

    const endpoints = getMediaEndpoints(ttsGenState.client, 'audio_tts');
    const selectedEndpoint = endpoints.find(ep => ep.id === ttsGenState.endpointId) || endpoints[0] || null;
    if (selectedEndpoint && ttsGenState.endpointId !== selectedEndpoint.id) {
        ttsGenState.endpointId = selectedEndpoint.id;
        ttsGenState.model = selectedEndpoint.models?.[0] || '';
    }
    const models = selectedEndpoint?.models || [];
    if (models.length && !models.includes(ttsGenState.model)) ttsGenState.model = models[0];
    const clients = Object.keys(config.clients || {});
    const clientSelect = renderUiSelectHtml({
        id: 'tts-gen-client',
        value: ttsGenState.client,
        options: clients.map(client => ({ value: client, label: clientDisplayName(client) })),
        placeholder: '选择 Client',
        onChange: (value) => onTtsGenClientChange(value),
    });
    const endpointSelect = renderUiSelectHtml({
        id: 'tts-gen-endpoint',
        value: ttsGenState.endpointId || '',
        options: endpoints.length
            ? endpoints.map(ep => ({ value: ep.id, label: ep.name || ep.id, description: ep.provider || '' }))
            : [{ value: '', label: '无可用节点' }],
        disabled: !endpoints.length,
        placeholder: '无可用节点',
        onChange: (value) => onTtsGenEndpointChange(value),
    });
    const modelSelect = renderUiSelectHtml({
        id: 'tts-gen-model',
        value: ttsGenState.model || '',
        options: models.length
            ? models.map(model => ({ value: model, label: model }))
            : [{ value: '', label: '使用节点默认模型' }],
        disabled: !models.length,
        placeholder: '使用节点默认模型',
        onChange: (value) => { ttsGenState.model = value; },
    });
    const noNodeHint = endpoints.length === 0 ? '<div class="media-gen-error">该 client 没有已启用的 TTS 节点。请到代理节点添加 purpose=audio_tts 的节点。</div>' : '';
    const resultHtml = renderTtsGenResult();
    const historyHtml = ttsGenState.historyLoading ? '<div class="media-gen-tip">正在加载历史...</div>' : renderMediaHistoryHtml(ttsGenState.history, 'tts');

    const voices = [
        { value: 'zh_female_qingxin', label: '清新女声 (zh_female_qingxin)' },
        { value: 'zh_male_wennuanshizhong', label: '温暖男声 (zh_male_wennuanshizhong)' },
        { value: 'zh_female_wanwanxiaohe', label: '湾湾小何 (zh_female_wanwanxiaohe)' },
        { value: 'zh_female_shaoergushi', label: '少儿故事 (zh_female_shaoergushi)' },
        { value: 'zh_male_leidi', label: '雷迪 (zh_male_leidi)' },
        { value: 'en_male_rm_emo', label: '英文情感男声 (en_male_rm_emo)' },
        { value: 'en_female_rm_emo', label: '英文情感女声 (en_female_rm_emo)' }
    ];
    const voiceSelect = renderUiSelectHtml({
        id: 'tts-gen-voice',
        value: ttsGenState.voice,
        options: voices,
        onChange: (value) => { ttsGenState.voice = value; },
    });
    const encodings = ['mp3', 'wav', 'ogg_opus', 'pcm'];
    const encodingSelect = renderUiSelectHtml({
        id: 'tts-gen-encoding',
        value: ttsGenState.encoding,
        options: encodings.map(enc => ({ value: enc, label: enc })),
        onChange: (value) => { ttsGenState.encoding = value; },
    });

    detail.innerHTML = `
        <button class="tools-detail-back" onclick="backToToolsCards()">返回工具列表</button>
        <div class="media-gen-layout">
            <div class="media-gen-panel">
                <h3>TTS 语音合成</h3>
                ${noNodeHint}
                <div class="media-gen-form-group"><label>Client</label>
                    ${clientSelect}</div>
                <div class="media-gen-form-group"><label>TTS 节点</label>
                    ${endpointSelect}</div>
                <div class="media-gen-form-group"><label>模型</label>
                    ${modelSelect}</div>
                <div class="media-gen-form-group"><label>待合成文本</label>
                    <textarea id="tts-gen-text" class="media-gen-form-control media-gen-textarea" rows="5" placeholder="输入要转为语音的文本" oninput="ttsGenState.text=this.value">${escapeHtml(ttsGenState.text)}</textarea></div>
                <div class="media-gen-form-group"><label>音色</label>
                    ${voiceSelect}</div>
                <div class="media-gen-form-group"><label>音频格式</label>
                    ${encodingSelect}</div>
                <div class="media-gen-form-group"><label>语速倍率（0.5 - 2.0）</label>
                    <input type="range" class="media-gen-form-control" min="0.5" max="2.0" step="0.1" value="${ttsGenState.speedRatio}" onchange="ttsGenState.speedRatio=Number(this.value); document.getElementById('tts-speed-value').textContent=this.value+'x'" style="width:100%;">
                    <span class="media-gen-tip" id="tts-speed-value">${ttsGenState.speedRatio}x</span></div>
                <div class="media-gen-tip"><strong>音色说明：</strong>zh_female_qingxin 适合通用播报；zh_male_wennuanshizhong 适合叙事；zh_female_wanwanxiaohe 适合活泼内容；en_male_rm_emo / en_female_rm_emo 适合英文情感朗读。</div>
                <button class="btn btn-primary" onclick="runTtsGeneration()" ${ttsGenState.loading || !endpoints.length ? 'disabled' : ''}>${ttsGenState.loading ? '合成中...' : '合成语音'}</button>
            </div>
            <div class="media-gen-panel"><h3>结果</h3>${resultHtml}<h3 style="margin-top:18px;">本地历史</h3>${historyHtml}</div>
        </div>`;
    if (!ttsGenState.historyLoading && !ttsGenState.historyLoaded) loadMediaHistory('tts');
};

window.onTtsGenClientChange = function(client) {
    ttsGenState.client = client;
    ttsGenState.endpointId = '';
    ttsGenState.model = '';
    ttsGenState.result = null;
    ttsGenState.error = '';
    ttsGenState.history = [];
    ttsGenState.historyLoaded = false;
    renderTtsGenDetail();
};

window.onTtsGenEndpointChange = function(endpointId) {
    ttsGenState.endpointId = endpointId;
    const endpoint = getMediaEndpoints(ttsGenState.client, 'audio_tts').find(ep => ep.id === endpointId);
    ttsGenState.model = endpoint?.models?.[0] || '';
    ttsGenState.result = null;
    ttsGenState.error = '';
    renderTtsGenDetail();
};

function renderTtsGenResult() {
    if (ttsGenState.loading) return '<div class="media-gen-tip">正在请求语音合成服务...</div>';
    if (ttsGenState.error) return '<div class="media-gen-error">' + escapeHtml(ttsGenState.error) + '</div>';
    if (!ttsGenState.result) return '<div class="media-gen-tip">合成完成后会显示音频播放器和可复制路径。</div>';
    const path = ttsGenState.result.file_path || ttsGenState.result.filePath || '';
    const historyId = ttsGenState.result.history_id || ttsGenState.result.historyId || '';
    const url = mediaHistoryPreviewUrl(historyId);
    return (path ? '<audio class="media-gen-preview" controls src="' + escapeHtml(url) + '"></audio>' : '') +
        '<div class="media-gen-path">' + escapeHtml(path || '服务未返回 file_path') + '</div>' +
        '<div class="media-gen-actions">' + (path ? '<button class="btn" onclick="copyMediaPath(' + escapeHtml(JSON.stringify(path)) + ')">复制路径</button>' : '') +
        (historyId ? '<span class="media-gen-tip" style="margin:0;">历史 ID: ' + escapeHtml(historyId) + '</span>' : '') + '</div>';
}

window.runTtsGeneration = async function() {
    const text = ttsGenState.text.trim();
    if (!text) { ttsGenState.error = '请输入待合成文本'; renderTtsGenDetail(); return; }
    if (!ttsGenState.endpointId) { ttsGenState.error = '请选择 TTS 节点'; renderTtsGenDetail(); return; }
    ttsGenState.loading = true;
    ttsGenState.error = '';
    ttsGenState.result = null;
    renderTtsGenDetail();
    try {
        const res = await fetch('/v1/media/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Gateway-Client': ttsGenState.client },
            body: JSON.stringify({ endpoint_id: ttsGenState.endpointId, model: ttsGenState.model || undefined, text, voice: ttsGenState.voice, encoding: ttsGenState.encoding, speedRatio: ttsGenState.speedRatio })
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error?.message || '合成失败 (' + res.status + ')');
        if (!json.file_path && !json.filePath) throw new Error('服务返回成功但缺少 file_path');
        ttsGenState.result = json;
        await loadMediaHistory('tts');
    } catch (err) {
        ttsGenState.error = err.message || String(err);
    } finally {
        ttsGenState.loading = false;
        if (toolsView === 'tts-gen') renderTtsGenDetail();
    }
};

registerMediaHistoryTool('video', 'video-gen', videoGenState, () => renderVideoGenDetail());
registerMediaHistoryTool('tts', 'tts-gen', ttsGenState, () => renderTtsGenDetail());

window.renderToolsDetail = function() {
    if (toolsView === 'classification-metrics') {
        renderClassificationMetricsDetail();
        return;
    }
    if (toolsView === 'antigravity-subscribe') {
        renderAntigravitySubscribeDetail();
        return;
    if (toolsView === 'codex-subscribe') {
        renderCodexSubscribeDetail();
        return;
    }
    }
    const cards = document.getElementById('tools-cards');
    const detail = document.getElementById('tools-detail');
    if (!cards || !detail) return;
    cards.style.display = 'none';

    const eps = getEmbeddingEndpoints(embedState.client);
    const nodeOptions = eps.map(ep => {
        const dim = ep.dimensions != null ? ep.dimensions + '维' : '默认';
        const model = ep.embedding_model || (ep.models[0] || '未设置');
        const sel = ep.id === embedState.endpointId ? 'selected' : '';
        return '<option value="' + escapeHtml(ep.id) + '" ' + sel + '>' + escapeHtml(ep.name) + ' · ' + escapeHtml(model) + ' · ' + dim + '</option>';
    }).join('');

    const selectedNode = eps.find(ep => ep.id === embedState.endpointId) || eps[0] || null;
    if (selectedNode && !embedState.endpointId) embedState.endpointId = selectedNode.id;
    const models = selectedNode?.models || [];
    const modelOptions = models.map(m => '<option value="' + escapeHtml(m) + '" ' + (m === embedState.model ? 'selected' : '') + '>' + escapeHtml(m) + '</option>').join('');
    const nodeDims = selectedNode?.dimensions != null ? String(selectedNode.dimensions) : '默认';

    const noNodeHint = eps.length === 0
        ? '<div class="embed-error" style="margin-bottom:12px;">该 client 未配置向量节点,请到代理节点 tab 添加 purpose=embedding 的节点。</div>'
        : '';

    detail.innerHTML = `
        <button class="tools-detail-back" onclick="backToToolsCards()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
            返回工具列表
        </button>
        <div class="embed-layout">
            <div class="embed-panel">
                <h3>输入</h3>
                ${noNodeHint}
                <div class="embed-form-group">
                    <label>Client</label>
                    <select id="embed-client-select" class="embed-form-select" onchange="onEmbedClientChange(this.value)">
                        <option value="codex" ${embedState.client==='codex'?'selected':''}>codex</option>
                        <option value="code" ${embedState.client==='code'?'selected':''}>code</option>
                        <option value="desktop" ${embedState.client==='desktop'?'selected':''}>desktop</option>
                    </select>
                </div>
                <div class="embed-form-group">
                    <label>向量节点</label>
                    <select id="embed-node-select" class="embed-form-select" onchange="onEmbedNodeChange(this.value)" ${eps.length===0?'disabled':''}>
                        ${nodeOptions || '<option value="">无可用节点</option>'}
                    </select>
                </div>
                <div class="embed-form-group">
                    <label>模型</label>
                    <select id="embed-model-select" class="embed-form-select" onchange="embedState.model=this.value; renderToolsDetail();" ${models.length===0?'disabled':''}>
                        ${modelOptions || '<option value="' + escapeHtml(selectedNode?.embedding_model||'') + '">' + escapeHtml(selectedNode?.embedding_model||'无') + '</option>'}
                    </select>
                </div>
                <div class="embed-form-group">
                    <label>维度</label>
                    <div class="embed-dims-row">
                        <span>节点维度: <strong class="embed-dims-value">${escapeHtml(nodeDims)}</strong></span>
                        <button type="button" class="embed-dims-pill ${embedState.customDims?'active':''}" onclick="onEmbedCustomDimsToggle(!embedState.customDims)" title="覆盖节点默认维度">自定义</button>
                        ${embedState.customDims ? '<input type="number" class="embed-dims-input" id="embed-dims-input" min="1" placeholder="如 1024" value="' + escapeHtml(String(embedState.dimensions)) + '" onchange="embedState.dimensions=this.value; renderToolsDetail();" />' : ''}
                    </div>
                </div>
                <div class="embed-mode-switch">
                    <button class="embed-mode-btn ${embedState.mode==='single'?'active':''}" id="embed-mode-single" onclick="setEmbedMode('single')">单段文本</button>
                    <button class="embed-mode-btn ${embedState.mode==='similarity'?'active':''}" id="embed-mode-similarity" onclick="setEmbedMode('similarity')">两段文本(相似度)</button>
                </div>
                <div class="embed-form-group">
                    <label>文本 A</label>
                    <textarea id="embed-text-a" class="embed-textarea" placeholder="输入要向量化的文本" oninput="embedState.textA=this.value">${escapeHtml(embedState.textA)}</textarea>
                </div>
                ${embedState.mode === 'similarity' ? `
                <div class="embed-form-group">
                    <label>文本 B</label>
                    <textarea id="embed-text-b" class="embed-textarea" placeholder="输入第二段文本" oninput="embedState.textB=this.value">${escapeHtml(embedState.textB)}</textarea>
                </div>` : ''}
                <button class="btn btn-primary" id="embed-run-btn" onclick="runEmbedding()" ${embedState.loading?'disabled':''}>
                    ${embedState.loading ? '计算中...' : '向量化'}
                </button>
            </div>
            <div class="embed-panel" id="embed-result-panel">
                ${renderEmbedResult()}
            </div>
        </div>
    `;
};

window.onEmbedClientChange = function(client) {
    embedState.client = client;
    embedState.endpointId = '';
    embedState.model = '';
    embedState.result = null;
    embedState.error = '';
    renderToolsDetail();
};

window.onEmbedNodeChange = function(endpointId) {
    embedState.endpointId = endpointId;
    const ep = getEmbeddingEndpoints(embedState.client).find(e => e.id === endpointId);
    embedState.model = ep?.models?.[0] || ep?.embedding_model || '';
    embedState.result = null;
    embedState.error = '';
    renderToolsDetail();
};

window.onEmbedCustomDimsToggle = function(checked) {
    embedState.customDims = checked;
    if (!checked) embedState.dimensions = '';
    embedState.result = null;
    renderToolsDetail();
};

window.setEmbedMode = function(mode) {
    embedState.mode = mode;
    embedState.result = null;
    embedState.error = '';
    renderToolsDetail();
};

function cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return null; // 零向量无法计算
    return dot / denom;
}

async function callEmbedding(text) {
    const params = new URLSearchParams();
    if (embedState.endpointId) params.set('endpoint_id', embedState.endpointId);
    const body = { input: text };
    if (embedState.model) body.model = embedState.model;
    if (embedState.customDims && embedState.dimensions) {
        body.dimensions = Number(embedState.dimensions);
    }
    const res = await fetch('/v1/embeddings?' + params.toString(), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Gateway-Client': embedState.client,
        },
        body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) {
        throw new Error(json?.error?.message || '请求失败 (' + res.status + ')');
    }
    const vec = json?.data?.[0]?.embedding;
    if (!Array.isArray(vec)) throw new Error('返回数据格式异常,未找到向量');
    return {
        vector: vec,
        model: json.model || embedState.model,
        dimensions: vec.length,
        tokens: json?.usage?.prompt_tokens ?? null,
    };
}

window.runEmbedding = async function() {
    if (!embedState.textA.trim()) {
        embedState.error = '请输入文本 A';
        renderToolsDetail();
        return;
    }
    if (embedState.mode === 'similarity' && !embedState.textB.trim()) {
        embedState.error = '请输入文本 B';
        renderToolsDetail();
        return;
    }
    embedState.loading = true;
    embedState.error = '';
    embedState.result = null;
    renderToolsDetail();
    try {
        const t0 = performance.now();
        const a = await callEmbedding(embedState.textA);
        const t1 = performance.now();
        if (embedState.mode === 'single') {
            embedState.result = { mode: 'single', a, elapsedMs: t1 - t0 };
        } else {
            const b = await callEmbedding(embedState.textB);
            const t2 = performance.now();
            const sim = cosineSimilarity(a.vector, b.vector);
            embedState.result = { mode: 'similarity', a, b, similarity: sim, elapsedMsA: t1 - t0, elapsedMsB: t2 - t1 };
        }
    } catch (err) {
        embedState.error = err.message || String(err);
    } finally {
        embedState.loading = false;
        renderToolsDetail();
    }
};

function renderEmbedResult() {
    if (embedState.loading) return '<div class="embed-result-empty">计算中...</div>';
    if (embedState.error) return '<div class="embed-error">' + escapeHtml(embedState.error) + '</div>';
    if (!embedState.result) return '<div class="embed-result-empty">输入文本后点击「向量化」查看结果。</div>';

    const r = embedState.result;
    const vectorHtml = (label, info) => {
        const fullVec = '[' + info.vector.map(v => v.toFixed(6)).join(', ') + ']';
        const elapsed = r.mode === 'single' ? r.elapsedMs : (label === 'A' ? r.elapsedMsA : r.elapsedMsB);
        return `
            <div style="margin-top:8px;">
                <div class="embed-vector-head">
                    <span class="embed-vector-label">${label} 向量 (${info.dimensions} 维)</span>
                    <div class="embed-vector-actions">
                        <button class="embed-vector-btn" onclick="toggleEmbedVector('${label}')">收起</button>
                        <button class="embed-vector-btn" onclick="copyEmbedVector('${label}')">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                            复制
                        </button>
                    </div>
                </div>
                <div class="embed-vector" id="embed-vec-${label}">${escapeHtml(fullVec)}</div>
                <div class="embed-meta" style="margin-top:4px;">
                    <span>模型: ${escapeHtml(info.model)}</span>
                    <span>维度: ${info.dimensions}</span>
                    ${info.tokens != null ? '<span>tokens: ' + info.tokens + '</span>' : ''}
                    <span>耗时: ${elapsed.toFixed(0)}ms</span>
                </div>
            </div>`;
    };

    if (r.mode === 'single') {
        return `
            <h3>结果</h3>
            ${vectorHtml('A', r.a)}
        `;
    }
    const score = r.similarity === null ? '无法计算(向量模长为 0)' : r.similarity.toFixed(4);
    return `
        <h3>相似度</h3>
        <div class="embed-similarity-score">${escapeHtml(String(score))}</div>
        <div class="embed-formula">余弦相似度 = (A·B) / (‖A‖ × ‖B‖)</div>
        <div class="embed-formula-note">对两段文本分别向量化后计算两个向量的余弦值,范围 -1 到 1,越接近 1 越相似。</div>
        ${vectorHtml('A', r.a)}
        ${vectorHtml('B', r.b)}
    `;
}

window.toggleEmbedVector = function(label) {
    const el = document.getElementById('embed-vec-' + label);
    if (!el) return;
    const hidden = el.style.display === 'none';
    el.style.display = hidden ? 'block' : 'none';
    const btn = el.previousElementSibling?.querySelector('button');
    if (btn) btn.textContent = hidden ? '收起' : '展开';
};

window.copyEmbedVector = function(label) {
    const el = document.getElementById('embed-vec-' + label);
    if (!el) return;
    const text = el.textContent;
    navigator.clipboard.writeText(text).then(
        () => showToast('已复制 ' + label + ' 向量(' + text.length + ' 字符)', 'success'),
        () => showToast('复制失败', 'danger')
    );
};

window.addEventListener('load', () => {
    const hash = window.location.hash.replace('#', '');
    if (hash === 'code' || hash === 'desktop' || hash === 'codex' || hash === 'sync' || hash === 'skills' || hash === 'install-history' || hash === 'tools') {
        switchTab(hash);
    }
});

window.addEndpoint = function(client) {
    config.clients[client].endpoints = config.clients[client].endpoints || [];
    const type = client === 'codex' ? 'openai-responses' : 'anthropic';
    config.clients[client].endpoints.unshift({
        id: `ep_${crypto.randomUUID()}`,
        name: "新服务商",
        type,
        base_url: "",
        auth: 'bearer',
        api_key: "",
        models: [],
        model_mapping: {}
    });
    selectedEndpoint = { client, index: 0 };
    render();
    setTimeout(() => {
        const nameInput = document.getElementById(`input-name-${client}-0`);
        if (nameInput) {
            nameInput.focus();
            nameInput.select();
        }
    }, 0);
}

window.addVisionFallbackEndpoint = function(client) {
    config.clients[client].endpoints = config.clients[client].endpoints || [];
    const existingIndex = config.clients[client].endpoints.findIndex(
        endpoint => endpoint.purpose === 'vision_fallback'
    );
    if (existingIndex >= 0) {
        selectedEndpoint = { client, index: existingIndex };
        render();
        return;
    }
    const type = client === 'codex' ? 'openai-responses' : 'anthropic';
    config.clients[client].endpoints.unshift({
        id: `ep_${crypto.randomUUID()}`,
        name: "视觉兜底节点",
        purpose: 'vision_fallback',
        vision_fallback_enabled: true,
        vision_model: "",
        type,
        base_url: "",
        auth: 'bearer',
        api_key: "",
        models: [],
        model_mapping: {}
    });
    selectedEndpoint = { client, index: 0 };
    render();
}

window.addNodeByPurpose = function(client, purpose) {
    if (!purpose) return;
    closeAddNodeMenus();
    if (purpose === 'vision_fallback') {
        addVisionFallbackEndpoint(client);
    } else if (purpose === 'web_search') {
        addWebSearchEndpoint(client);
    } else if (purpose === 'embedding') {
        addEmbeddingEndpoint(client);
    } else if (mediaPurposeDefinition(purpose)) {
        addMediaEndpoint(client, purpose);
    } else {
        addEndpoint(client);
    }
}

window.closeAddNodeMenus = function(exceptClient = '') {
    document.querySelectorAll('.add-node-dropdown').forEach(dropdown => {
        if (exceptClient && dropdown.id === `add-node-dropdown-${exceptClient}`) return;
        dropdown.classList.remove('is-open');
        dropdown.querySelector('.add-node-trigger')?.setAttribute('aria-expanded', 'false');
    });
}

window.toggleAddNodeMenu = function(client, event) {
    event?.stopPropagation();
    const dropdown = document.getElementById(`add-node-dropdown-${client}`);
    if (!dropdown) return;
    const shouldOpen = !dropdown.classList.contains('is-open');
    closeAddNodeMenus(client);
    closeUiSelects();
    dropdown.classList.toggle('is-open', shouldOpen);
    dropdown.querySelector('.add-node-trigger')
        ?.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
    if (shouldOpen) {
        dropdown.querySelector('.add-node-option')?.focus();
    }
}

window.addEmbeddingEndpoint = function(client) {
    config.clients[client].endpoints = config.clients[client].endpoints || [];
    const hasDefaultEmbedding = config.clients[client].endpoints.some(
        endpoint => endpoint.purpose === 'embedding' && endpoint.is_default === true
    );
    config.clients[client].endpoints.unshift({
        id: `ep_${crypto.randomUUID()}`,
        name: "向量模型节点",
        purpose: 'embedding',
        type: 'openai-chat',
        base_url: "",
        api_key: "",
        enabled: true,
        is_default: !hasDefaultEmbedding,
        models: [],
        model_mapping: {},
        embedding_model: ""
    });
    selectedEndpoint = { client, index: 0 };
    render();
}

window.addMediaEndpoint = function(client, purpose) {
    const mediaPurpose = mediaPurposeDefinition(purpose);
    if (!mediaPurpose) return;
    const defaultProvider = 'grok-subscription';
    config.clients[client].endpoints = config.clients[client].endpoints || [];
    config.clients[client].endpoints.unshift({
        id: `ep_${crypto.randomUUID()}`,
        name: mediaPurpose.title,
        purpose,
        provider: defaultProvider,
        base_url: mediaProviderDefinition(defaultProvider).baseUrl,
        api_key: '',
        enabled: true,
        is_default: false,
        models: mediaPresetModels(defaultProvider, purpose),
        model_mapping: {}
    });
    selectedEndpoint = { client, index: 0 };
    render();
}

window.updateMediaProvider = function(client, index, provider) {
    const endpoint = config.clients[client]?.endpoints?.[index];
    const nextProvider = mediaProviderDefinition(provider);
    if (!endpoint || !isMediaEndpoint(endpoint)) return;
    endpoint.provider = nextProvider.value;
    endpoint.base_url = nextProvider.baseUrl;
    endpoint.models = mediaPresetModels(nextProvider.value, endpoint.purpose);
    render();
}

window.updateMediaModels = function(client, index, text) {
    const endpoint = config.clients[client]?.endpoints?.[index];
    if (!endpoint) return;
    endpoint.models = text.split('\n').map(function(s) { return s.trim(); }).filter(Boolean);
};

window.setMediaModel = function(client, index, newModel) {
    const endpoint = config.clients[client]?.endpoints?.[index];
    if (!endpoint) return;
    if (!endpoint.models) endpoint.models = [];
    if (!endpoint.models.includes(newModel)) endpoint.models.push(newModel);
    render();
};

window.setAsDefaultEmbedding = async function(client, index) {
    const endpoint = config.clients[client].endpoints[index];
    if (endpoint?.purpose !== 'embedding') return;
    const previous = config.clients[client].endpoints.map(ep => ({
        purpose: ep.purpose,
        is_default: ep.is_default === true,
    }));
    config.clients[client].endpoints.forEach((ep, i) => {
        if (ep.purpose === 'embedding') ep.is_default = (i === index);
    });
    render();
    const saved = await saveConfig({ client, scope: 'default-embedding' });
    if (!saved) {
        config.clients[client].endpoints.forEach((ep, i) => {
            if (previous[i]?.purpose === 'embedding') ep.is_default = previous[i].is_default;
        });
        render();
    }
}

window.addWebSearchEndpoint = function(client) {
    config.clients[client].endpoints = config.clients[client].endpoints || [];
    const hasDefaultSearch = config.clients[client].endpoints.some(
        endpoint => endpoint.purpose === 'web_search' && endpoint.is_default === true
    );
    config.clients[client].endpoints.unshift({
        id: `ep_${crypto.randomUUID()}`,
        name: "联网搜索节点",
        purpose: 'web_search',
        provider: 'tavily',
        enabled: true,
        is_default: !hasDefaultSearch,
        auth: 'bearer',
        api_key: "",
        options: {
            search_depth: 'basic',
            max_results: 5,
            topic: 'general',
            include_answer: false,
            include_raw_content: false,
            country: 'china'
        },
        models: [],
        model_mapping: {}
    });
    selectedEndpoint = { client, index: 0 };
    render();
}

window.updateWebSearchOption = function(client, index, key, value) {
    const endpoint = config.clients[client].endpoints[index];
    endpoint.options = endpoint.options && typeof endpoint.options === 'object'
        ? endpoint.options
        : {};
    if (value === '' || value == null) delete endpoint.options[key];
    else endpoint.options[key] = value;
}

window.setAsDefaultWebSearch = async function(client, index) {
    const endpoint = config.clients[client].endpoints[index];
    if (endpoint?.purpose !== 'web_search') return;
    const previous = config.clients[client].endpoints.map(ep => ({
        purpose: ep.purpose,
        is_default: ep.is_default === true,
    }));
    config.clients[client].endpoints.forEach((ep, i) => {
        if (ep.purpose === 'web_search') ep.is_default = (i === index);
    });
    render();
    const saved = await saveConfig({ client, scope: 'default-web-search' });
    if (!saved) {
        config.clients[client].endpoints.forEach((ep, i) => {
            if (previous[i]?.purpose === 'web_search') ep.is_default = previous[i].is_default;
        });
        render();
    }
}

window.removeEndpoint = async function(client, index) {
    if (!confirm('确定删除这个节点吗？')) return;
    const [removedEndpoint] = config.clients[client].endpoints.splice(index, 1);
    const previousSelection = selectedEndpoint;
    if (selectedEndpoint && selectedEndpoint.client === client) {
        selectedEndpoint = null;
    }
    render();
    const saved = await saveConfig({ client, scope: 'delete' });
    if (!saved) {
        config.clients[client].endpoints.splice(index, 0, removedEndpoint);
        selectedEndpoint = previousSelection;
        render();
    }
}

window.setAsDefault = async function(client, index) {
    const purpose = config.clients[client].endpoints[index]?.purpose;
    if (['vision_fallback', 'web_search', 'embedding'].includes(purpose)) return;
    const previousDefaults = config.clients[client].endpoints.map(ep => ep.is_default === true);
    const previousSlots = client === 'code'
        ? structuredClone(config.clients.code.model_slots || {})
        : null;
    config.clients[client].endpoints.forEach((ep, i) => {
        ep.is_default = (i === index);
    });
    if (client === 'code') pruneClaudeCodeModelSlots();
    render();
    const saved = await saveConfig({ client, scope: 'default' });
    if (!saved) {
        config.clients[client].endpoints.forEach((ep, i) => {
            ep.is_default = previousDefaults[i];
        });
        if (client === 'code') config.clients.code.model_slots = previousSlots;
        render();
    }
}

window.updateEndpoint = function(client, index, field, value) {
    const endpoint = config.clients[client].endpoints[index];
    endpoint[field] = value;
    if (field === 'name' && selectedEndpoint && selectedEndpoint.client === client && selectedEndpoint.index === index) {
        const title = document.querySelector('.detail-title');
        if (title) title.textContent = value || `节点 ${index + 1}`;
    }
}

window.updateCodexCapability = function(client, index, capability, enabled) {
    const endpoint = config.clients[client].endpoints[index];
    endpoint.capabilities ||= {
        input_modalities: ['text'],
        reasoning: false,
        tools: true,
    };
    if (capability === 'image') {
        endpoint.capabilities.input_modalities = enabled
            ? ['text', 'image']
            : ['text'];
    } else {
        endpoint.capabilities[capability] = enabled;
    }
}

window.updateModelImageCapability = function(client, index, modelIndex, state) {
    const endpoint = config.clients[client].endpoints[index];
    const model = endpoint.models?.[modelIndex];
    if (!model) return;

    // state: 'auto' | 'supported' | 'unsupported'
    const desired = state === 'supported' ? true : state === 'unsupported' ? false : undefined;

    if (desired === undefined) {
        // auto = remove the field
        if (endpoint.model_capabilities?.[model]?.image != null) {
            delete endpoint.model_capabilities[model].image;
            if (Object.keys(endpoint.model_capabilities[model]).length === 0) {
                delete endpoint.model_capabilities[model];
            }
            if (endpoint.model_capabilities && Object.keys(endpoint.model_capabilities).length === 0) {
                delete endpoint.model_capabilities;
            }
        }
    } else {
        endpoint.model_capabilities ||= {};
        endpoint.model_capabilities[model] ||= {};
        endpoint.model_capabilities[model].image = desired;
    }
    render();
}

window.toggleCtxVisionMenu = function(client, index, modelIndex, event) {
    event?.stopPropagation();
    const dropdown = document.getElementById(`ctx-vision-${client}-${index}-${modelIndex}`);
    if (!dropdown) return;
    const shouldOpen = !dropdown.classList.contains('is-open');
    closeAllCtxVisionMenus();
    closeAllCtxWindowMenus();
    dropdown.classList.toggle('is-open', shouldOpen);
}

window.closeAllCtxVisionMenus = function() {
    document.querySelectorAll('.vision-dropdown.is-open').forEach(d => d.classList.remove('is-open'));
}

window.updateModelContextWindow = function(client, index, modelIndex, value) {
    const endpoint = config.clients[client].endpoints[index];
    const model = endpoint.models?.[modelIndex];
    if (!model) return;

    const cw = Number(value);
    if (cw === 1000000) {
        // 1M is the default - remove the field so config stays clean
        if (endpoint.model_capabilities?.[model]?.context_window != null) {
            delete endpoint.model_capabilities[model].context_window;
            if (Object.keys(endpoint.model_capabilities[model]).length === 0) {
                delete endpoint.model_capabilities[model];
            }
            if (endpoint.model_capabilities && Object.keys(endpoint.model_capabilities).length === 0) {
                delete endpoint.model_capabilities;
            }
        }
    } else {
        endpoint.model_capabilities ||= {};
        endpoint.model_capabilities[model] ||= {};
        endpoint.model_capabilities[model].context_window = cw;
    }
    render();
}

window.toggleCtxWindowMenu = function(client, index, modelIndex, event) {
    event?.stopPropagation();
    const dropdown = document.getElementById(`ctx-win-${client}-${index}-${modelIndex}`);
    if (!dropdown) return;
    const shouldOpen = !dropdown.classList.contains('is-open');
    closeAllCtxWindowMenus();
    closeAllCtxVisionMenus();
    dropdown.classList.toggle('is-open', shouldOpen);
}

window.closeAllCtxWindowMenus = function() {
    document.querySelectorAll('.ctx-window-dropdown.is-open').forEach(d => d.classList.remove('is-open'));
}

window.handleTagInput = function(e, client, index, field) {
    if (e.key === 'Enter') {
        e.preventDefault();
        const val = e.target.value.trim();
        if (val) {
            config.clients[client].endpoints[index][field] = config.clients[client].endpoints[index][field] || [];
            if (!config.clients[client].endpoints[index][field].includes(val)) {
                config.clients[client].endpoints[index][field].push(val);
            }
            e.target.value = '';
            render();
            setTimeout(() => {
                const input = document.getElementById(`input-${field}-${client}-${index}`);
                if (input) input.focus();
            }, 0);
        }
    }
};

window.removeTag = function(client, index, field, tagIndex) {
    const endpoint = config.clients[client].endpoints[index];
    if (endpoint[field]) {
        const removedModel = field === 'models' ? endpoint[field][tagIndex] : null;
        endpoint[field].splice(tagIndex, 1);
        if (removedModel && endpoint.model_capabilities?.[removedModel]) {
            delete endpoint.model_capabilities[removedModel];
            if (Object.keys(endpoint.model_capabilities).length === 0) {
                delete endpoint.model_capabilities;
            }
        }
        render();
    }
};

window.handleMappingInput = function(e, client, index, isReq) {
    if (e.key === 'Enter') {
        e.preventDefault();
        const reqInput = document.getElementById(`input-mapping-req-${client}-${index}`);
        const upInput = document.getElementById(`input-mapping-up-${client}-${index}`);
        if (!reqInput || !upInput) return;

        const k = reqInput.value.trim();
        const v = upInput.value.trim();

        if (isReq && k && !v) {
            upInput.focus();
            return;
        }

        if (k && v) {
            config.clients[client].endpoints[index].model_mapping = config.clients[client].endpoints[index].model_mapping || {};
            config.clients[client].endpoints[index].model_mapping[k] = v;
            render();
            setTimeout(() => {
                const input = document.getElementById(`input-mapping-req-${client}-${index}`);
                if (input) input.focus();
            }, 0);
        }
    }
};

window.togglePasswordVisibility = async function(client, index, inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const btn = input.nextElementSibling;
    if (input.type === 'password') {
        const endpoint = config.clients?.[client]?.endpoints?.[index];
        if (!input.value && endpoint?.has_api_key) {
            btn.disabled = true;
            try {
                const params = new URLSearchParams({ id: endpoint.id || '' });
                const response = await fetch(`/v1/config/secret?${params}`, {
                    headers: { 'X-Gateway-Secret-Intent': 'reveal' },
                    cache: 'no-store',
                });
                const payload = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(payload.error?.message || '读取密钥失败');
                }
                input.value = payload.api_key || '';
                if (!input.value) throw new Error('未找到已保存密钥');
            } catch (error) {
                showToast(error.message || '读取密钥失败', 'error');
                return;
            } finally {
                btn.disabled = false;
            }
        }
        input.type = 'text';
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        btn.title = '隐藏密钥';
        btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
            <line x1="1" y1="1" x2="23" y2="23"></line>
        </svg>`;
    } else {
        input.type = 'password';
        btn.title = input.value ? '显示密钥' : '查看已保存密钥';
        btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
        </svg>`;
    }
};

window.removeMapping = function(client, index, key) {
    if (config.clients[client].endpoints[index].model_mapping) {
        delete config.clients[client].endpoints[index].model_mapping[key];
        render();
    }
};

       window.saveNode = async function(client, index) {
   const endpoint = config.clients?.[client]?.endpoints?.[index];
   const btn = document.getElementById(`save-node-${client}-${index}`);
   if (!endpoint || !btn) return;
    if (endpoint.purpose === 'embedding') {
        if (!String(endpoint.base_url || '').trim()) {
            showToast('请先填写向量模型节点的 Base URL', 'error');
            return;
        }
        if (!endpoint.embedding_model && (!endpoint.models || endpoint.models.length === 0)) {
            showToast('请先为向量模型节点添加或选择一个模型', 'error');
            return;
        }
    }
    if (endpoint.purpose === 'web_search') {
        if (!endpoint.provider) {
            showToast('请先选择搜索提供商', 'error');
            return;
        }
        if (!endpoint.api_key && !endpoint.has_api_key) {
            if (!confirm('该搜索节点未配置 API Key，搜索功能将无法使用。确定要保存吗？')) {
                return;
            }
        }
    }
    await saveConfig({ button: btn, client, scope: 'node' });
}

window.saveCurrentConfig = async function() {
    const btn = document.getElementById('save-btn');
    if (!btn) return;
    if (activeClient === 'sync') {
        await saveSyncConfig('sync');
    } else if (activeClient === 'skills') {
        await refreshSkillsLibrary(true);
        showToast('技能挂载已是即时生效，当前库已刷新', 'success');
    } else {
        await saveConfig({ button: btn, client: activeClient, scope: 'global' });
    }
}

window.toggleEndpointExposure = async function(event, client, index, input) {
    event.stopPropagation();
    const endpoint = config.clients?.[client]?.endpoints?.[index];
    if (!endpoint || !input) return;
    const previous = endpoint.expose_models === true;
    endpoint.expose_models = input.checked;
    const saved = await saveConfig({
        button: input,
        client,
        scope: 'exposure',
    });
    if (!saved) {
        endpoint.expose_models = previous;
        render();
    }
}

window.toggleEndpointEnabled = async function(event, client, index, input) {
    event.stopPropagation();
    const endpoint = config.clients?.[client]?.endpoints?.[index];
    if (!endpoint || !input) return;
    const previous = endpoint.enabled !== false;
    endpoint.enabled = input.checked;
    render();
    const saved = await saveConfig({
        button: input,
        client,
        scope: 'enabled',
    });
    if (!saved) {
        endpoint.enabled = previous;
        render();
    }
}

window.saveConfig = async function(options = {}) {
    const btn = options.button || null;
    const originalContent = btn?.innerHTML || '';
    const showButtonProgress = btn?.tagName === 'BUTTON';

    if (showButtonProgress) {
        btn.innerHTML = `<svg class="spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="animation: spin 1s linear infinite;"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg> 保存中...`;
    }
    if (btn) btn.disabled = true;

    try {
        pruneClaudeCodeModelSlots();
        const res = await fetch('/v1/config/save', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Gateway-Config-Client': options.client || (options.scope === 'template' ? 'code' : activeClient)
            },
            body: JSON.stringify(config)
        });

        if (res.ok) {
            const payload = await res.json().catch(() => ({}));
            for (const client of Object.values(config.clients || {})) {
                for (const endpoint of client.endpoints || []) {
                    if (endpoint.api_key) endpoint.has_api_key = true;
                    delete endpoint.api_key;
                    delete endpoint.api_key_env;
                }
            }
            if (payload.codex_model_catalog?.path_posix) {
                codexModelCatalogPath = payload.codex_model_catalog.path_posix;
            } else if (payload.codex_model_catalog?.path) {
                codexModelCatalogPath = String(payload.codex_model_catalog.path).replaceAll('\\', '/');
            }
            render();
            if (options.scope === 'exposure') {
                showToast(
                    options.client === 'desktop' && payload.claude3pSync?.updated
                        ? '模型展示设置已保存，Claude 3P 模型列表已同步'
                        : '模型展示设置已保存',
                    'success'
                );
            } else if (options.scope === 'node' && options.client === 'desktop') {
                if (payload.claude3pSync?.updated) {
                    showToast('节点已保存，Claude 3P 模型列表已同步', 'success');
                } else if (payload.claude3pSync?.reason === 'already-in-sync') {
                    showToast('节点已保存，Claude 3P 模型列表无变化', 'success');
                } else {
                    const reason = payload.claude3pSync?.error || payload.claude3pSync?.reason || '未知原因';
                    showToast(`节点已保存，但 Claude 3P 同步未完成：${reason}`, 'error');
                }
            } else if (options.scope === 'node' && options.client === 'codex') {
                showToast(
                    payload.codex_model_catalog?.exists
                        ? '节点已保存，Codex 模型目录已刷新'
                        : '节点已保存',
                    'success'
                );
            } else if (options.scope === 'node' && options.client === 'code') {
                if (payload.claudeCodeSync?.updated) {
                    showToast('节点已保存，Claude Code 模型配置已同步', 'success');
                } else if (payload.claudeCodeSync?.reason === 'already-in-sync') {
                    showToast('节点已保存，Claude Code 模型配置无变化', 'success');
                } else {
                    const reason = payload.claudeCodeSync?.error || payload.claudeCodeSync?.reason || '未知原因';
                    showToast(`节点已保存，但 Claude Code 同步未完成：${reason}`, 'error');
                }
            } else if (options.scope === 'node') {
                showToast('节点已保存', 'success');
            } else if (options.scope === 'default') {
                showToast(
                    options.client === 'code' && payload.claudeCodeSync?.updated
                        ? '默认节点已设置，Claude Code 模型配置已同步'
                        : '默认节点已设置',
                    'success'
                );
            } else if (options.scope === 'default-web-search') {
                showToast('默认搜索节点已设置', 'success');
            } else if (options.scope === 'delete' && options.client === 'desktop' && payload.claude3pSync?.updated) {
                showToast('节点已删除，Claude 3P 模型列表已同步', 'success');
            } else if (options.scope === 'delete' && options.client === 'codex' && payload.codex_model_catalog?.exists) {
                showToast('节点已删除，Codex 模型目录已刷新', 'success');
            } else if (options.scope === 'delete') {
                showToast('节点已删除', 'success');
            } else if (options.scope === 'template') {
                showToast('默认模板已恢复', 'success');
            } else if (options.scope === 'global' && options.client === 'code') {
                if (payload.claudeCodeSync?.updated) {
                    showToast('配置已保存，Claude Code 模型配置已同步', 'success');
                } else if (payload.claudeCodeSync?.reason === 'already-in-sync') {
                    showToast('配置已保存，Claude Code 模型配置无变化', 'success');
                } else {
                    showToast('配置已保存', 'success');
                }
            } else if (options.scope === 'global' && options.client === 'desktop') {
                if (payload.claude3pSync?.updated) {
                    showToast('配置已保存，Claude 3P 模型列表已同步', 'success');
                } else if (payload.claude3pSync?.reason === 'already-in-sync') {
                    showToast('配置已保存，Claude 3P 模型列表无变化', 'success');
                } else {
                    showToast('配置已保存', 'success');
                }
            } else if (options.scope === 'global' && options.client === 'codex') {
                showToast(
                    payload.codex_model_catalog?.exists
                        ? '配置已保存，Codex 模型目录已刷新'
                        : '配置已保存',
                    'success'
                );
            } else {
                showToast('配置已保存', 'success');
            }
            return true;
        } else {
            const payload = await res.json().catch(() => null);
            const conflicts = payload?.error?.issues?.filter(issue =>
                issue.code === 'duplicate_public_model'
            ) || [];
            const invalidClaudeNames = payload?.error?.issues?.filter(issue =>
                issue.code === 'invalid_claude_model_name'
            ) || [];
            if (conflicts.length || invalidClaudeNames.length) {
                const messages = conflicts.map(issue => {
                    const suggestions = issue.occurrences
                        .map(item => `${item.endpoint_name}: ${item.suggestion}`)
                        .join('；');
                    return `模型 ${issue.model_id} 重复，候选名称：${suggestions}`;
                });
                messages.push(...invalidClaudeNames.map(issue =>
                    `Claude Desktop 映射名称 ${issue.model_id} 不符合规范，建议改为：${issue.suggestion}`
                ));
                showToast(messages.join('\n'), 'error');
            } else {
                showToast(payload?.error?.message || '保存配置失败', 'error');
            }
            return false;
        }
    } catch (e) {
        showToast('保存时网络出错', 'error');
        return false;
    } finally {
        if (showButtonProgress) btn.innerHTML = originalContent;
        if (btn) btn.disabled = false;
    }
}

window.migrateCodexHistory = async function() {
    const btn = document.getElementById('codex-history-unify-btn');
    if (!btn) return;
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '预览中...';

    try {
        const previewRes = await fetch('/v1/codex/history/unify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dry_run: true, target_provider: 'custom' }),
        });
        const preview = await previewRes.json().catch(() => ({}));
        if (!previewRes.ok || preview.success === false) {
            const msg = preview?.error?.message || '预览失败';
            if (preview?.error?.type === 'codex_running') {
                showToast('请先完全退出 Codex Desktop，再迁移历史', 'error');
            } else {
                showToast(msg, 'error');
            }
            return;
        }

        const count = Number(preview.affectedThreads || 0);
        const counts = preview.providerCounts || {};
        const detail = Object.entries(counts)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ') || '无';

        if (count === 0) {
            showToast('没有需要迁移的历史会话', 'success');
            return;
        }

        const ok = confirm(
            `将把 ${count} 条历史会话迁移到 model_provider="custom"。\n\n` +
            `来源分布：${detail}\n\n` +
            `只会改会话标签，不改登录态/插件/配置。\n` +
            `会自动备份到 ~/.codex/history-unify-backups/。\n\n` +
            `请先完全退出 Codex Desktop，然后点确定继续。`
        );
        if (!ok) {
            showToast('已取消迁移', 'success');
            return;
        }

        btn.innerHTML = '迁移中...';
        const applyRes = await fetch('/v1/codex/history/unify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                dry_run: false,
                apply: true,
                target_provider: 'custom',
            }),
        });
        const applied = await applyRes.json().catch(() => ({}));
        if (!applyRes.ok || applied.success === false) {
            if (applied?.error?.type === 'codex_running') {
                showToast('Codex 仍在运行，请完全退出后再试', 'error');
            } else {
                showToast(applied?.error?.message || '迁移失败', 'error');
            }
            return;
        }

        const backup = applied.backupRoot
            ? String(applied.backupRoot).replaceAll('\\', '/')
            : '';
        showToast(
            `已迁移 ${applied.affectedThreads || count} 条会话` +
            (backup ? `，备份：${backup}` : '') +
            '。请重新打开 Codex Desktop。',
            'success',
        );
    } catch (e) {
        showToast('迁移请求失败：' + (e?.message || e), 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = original;
    }
}

// Copy the text content of a code-snippet block to the clipboard and briefly
// flash a check mark so the user sees it succeeded.
window.copyCodeSnippet = async function(btn) {
    const snippet = btn.closest('.code-snippet');
    const pre = snippet?.querySelector('pre');
    const text = pre ? pre.textContent : '';
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        // Fallback for non-secure contexts (headless / file origins).
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
    }
    const original = btn.innerHTML;
    btn.classList.add('copied');
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = original; }, 1500);
};

/* showToast moved to ui.ts */

// Add spinner keyframes
const style = document.createElement('style');
style.textContent = `@keyframes spin { 100% { transform: rotate(360deg); } }`;
document.head.appendChild(style);

// Theme management
window.toggleTheme = function() {
    const root = document.documentElement;
    const currentTheme = root.getAttribute('data-theme') || 'dark';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

    root.setAttribute('data-theme', newTheme);
    localStorage.setItem('app-theme', newTheme);
    updateThemeIcon(newTheme);
};

function updateThemeIcon(theme) {
    const darkIcon = document.getElementById('theme-icon-dark');
    const lightIcon = document.getElementById('theme-icon-light');
    if (!darkIcon || !lightIcon) return;

    if (theme === 'dark') {
        darkIcon.style.display = 'block';
        lightIcon.style.display = 'none';
    } else {
        darkIcon.style.display = 'none';
        lightIcon.style.display = 'block';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    renderAddNodeMenus();
    // Wire the create-agent-node modal interactions once.
    document.querySelectorAll('input[name="client-create-mode"]').forEach(radio => {
        radio.addEventListener('change', (e) => { onClientCreateModeChange(e); syncClientCreateProtocol(); });
    });
    const clientCreateSource = document.getElementById('client-create-source');
    if (clientCreateSource) {
        clientCreateSource.addEventListener('change', syncClientCreateProtocol);
    }
    const createNameInput = document.getElementById('client-create-name');
    if (createNameInput) {
        createNameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); submitCreateClient(); }
        });
    }
    init();
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    updateThemeIcon(currentTheme);
});

document.addEventListener('click', (e) => {
    if (!e.target.closest('.add-node-dropdown')) closeAddNodeMenus();
    if (!e.target.closest('.ui-select-dropdown')) closeUiSelects();
    if (!e.target.closest('.model-suggest-wrap')) document.querySelectorAll('.model-suggest-wrap.is-open').forEach((el) => el.classList.remove('is-open'));
    if (!e.target.closest('.ctx-window-dropdown')) {
        closeAllCtxWindowMenus();
        closeAllCtxVisionMenus();
    }
    // Close the create-agent-node modal when clicking outside its dialog.
    if (clientCreateOpen && !e.target.closest('#client-create-modal .skill-modal') && !e.target.closest('.nav-create-client')) {
        closeClientCreateModal();
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && clientCreateOpen) {
        closeClientCreateModal();
        return;
    }
    if (e.key === 'Escape' && document.querySelector('.add-node-dropdown.is-open')) {
        closeAddNodeMenus();
        return;
    }
    if (e.key === 'Escape' && document.querySelector('.ui-select-dropdown.is-open')) {
        closeUiSelects();
        return;
    }
    if (e.key === 'Escape' && document.querySelector('.ctx-window-dropdown.is-open')) {
        closeAllCtxWindowMenus();
        closeAllCtxVisionMenus();
        return;
    }
    if (e.key === 'Escape' && selectedEndpoint) {
        // Don't hijack Esc while typing in inputs unless it's a pure cancel
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        closeEndpointDetail();
    }
});
