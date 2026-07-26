import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, "..", "..");
const MANAGED_SKILLS_ROOT = path.join(PROJECT_ROOT, "lib", "skills");
const MANAGED_CATALOG_FILE = path.join(MANAGED_SKILLS_ROOT, "managed-catalog.json");

const SESSION_SYNC_SKILL_CONTENT = `---
name: session-sync
description: 当用户需要从另一个 AI 桌面软件（Codex/Claude/Antigravity）恢复、接入或同步中断的历史会话上下文时触发。无需 MCP，直接从本地中枢 ~/.local-ai-gateway/hub 读取最新会话。
---

# Session Sync Skill

## 使用场景
当用户表达以下意图时触发：
- "恢复刚才在 Codex/Antigravity 的会话"
- "接手之前的讨论"
- "上个软件额度没了，从刚才停下的地方继续"
- "导入历史上下文"

## 操作步骤

1. **定位中枢目录**：
   读取文件 \`~/.local-ai-gateway/hub/CURRENT_ACTIVE.json\` 确定全局最新的会话指针，或者扫描 \`~/.local-ai-gateway/hub/sessions/\` 目录下匹配当前工作区（Workspace）的最后更新会话。

2. **读取会话快照**：
   读取目标 JSON 文件，获取 \`messages\` 数组与 \`summary\` 字段。

3. **构建上下文接管**：
   - 提取会话最后 5~10 轮对话的关键内容。
   - 梳理目前讨论的核心议题与终止的步骤。
   - 输出总结并准备回答用户的下一个问题。
`;

const GROK_IMAGINE_SKILL_CONTENT = `---
name: grok-imagine
description: 使用用户的 Grok 订阅凭证，进行文生图、图生图（修改图）、文生视频、图生视频及多参考图动图生成。
---

# Grok Imagine Multi-Modal Skill

## 使用场景
当用户表达以下意图或在聊天中使用指令时触发：
- **文生图**: "用 Grok 画一张..." / "帮我生成一张图片" / "/imagine prompt: ..."
- **图生图 / 修改图**: "修改这张图片" / "基于这几张图合成一个..." / "给图中人物换个背景"
- **文生视频 / 图生视频**: "做一段视频" / "把这张图片变成动图" / "/imagine_video"
- **多参考图动图合成**: "用这几张图片合成一个动画视频"

## 依赖与前提条件
1. **鉴权凭证**: 本技能自动读取本地 Grok 登录凭证 \`~/.grok/auth.json\`。
   - 若运行时提示 \`[401 Unauthorized]\` 或 \`凭证未找到\`，请提示用户先在系统终端执行 \`grok\` 命令完成官方账号登录与授权。
2. **执行环境**: 本技能包含标准 Node.js ES Module 脚本 \`scripts/grok_imagine.mjs\`。

## 🤖 大模型工具调用与参数规范 (LLM Call Constraints)
大模型 (Codex / Claude / Antigravity) 在构造 Shell 命令或工具调用参数时，**必须严格遵守以下类型规约**：
1. **纯整数格式 (Strict Integer Format)**：
   - 所有数值型参数（如视频时长 \`--duration 6\`、系统工具超时 \`yield_time_ms: 120000\`、\`session_id\` 等），**严禁写入带小数点的浮点数（例如禁止写 \`6.0\`, \`120000.0\`）**！
   - 必须使用纯整数字面量（Strict Integer），否则部分宿主客户端（如 Codex Rust 后端）会因 JSON 反序列化失败（\`expected u64 / expected i32\`）而中断。
2. **绝对路径规约**：
   - 图片与输出目录路径如果包含空格，必须使用双引号包裹，如 \`--image "/path with space/cat.jpg"\`。

## 脚本调度路径 (推荐绝对/主路径)
为了避免 Agent 在不同工作区 (CWD) 执行命令时找不到相对路径，请优先使用以下兼容展开路径唤起脚本：
- **通用挂载路径 (首选)**:
  - Antigravity: \`node ~/.gemini/config/skills/grok-imagine/scripts/grok_imagine.mjs\`
  - Claude: \`node ~/.claude/skills/grok-imagine/scripts/grok_imagine.mjs\`
  - Codex: \`node ~/.codex/skills/grok-imagine/scripts/grok_imagine.mjs\`
  - 中央库: \`node ~/.agents/skills/grok-imagine/scripts/grok_imagine.mjs\`

## 命令行参数与用法示例

### 1. 文生图 (Text to Image)
\`\`\`bash
node ~/.agents/skills/grok-imagine/scripts/grok_imagine.mjs --prompt "赛博朋克风的未来城市夜景，霓虹灯光" --aspect-ratio "16:9"
\`\`\`

### 2. 多参考图图生图 / 修改图片 (Image Edit)
\`\`\`bash
node ~/.agents/skills/grok-imagine/scripts/grok_imagine.mjs --prompt "给图中的猫咪戴上一顶海盗帽" --images "/path/cat.jpg,/path/hat.jpg"
\`\`\`

### 3. 文生视频 / 首帧图生视频 (Text/Image to Video)
\`\`\`bash
node ~/.agents/skills/grok-imagine/scripts/grok_imagine.mjs --type video --prompt "海浪拍打沙滩，夕阳余晖" --duration 6 --aspect-ratio "16:9"
\`\`\`

### 4. 多参考图生成视频 / 动图 (Multi-Image Reference Video)
支持传入多张图片路径（逗号分隔）：
\`\`\`bash
node ~/.agents/skills/grok-imagine/scripts/grok_imagine.mjs --type video --prompt "多图连贯过渡动画" --images "/path/img1.jpg,/path/img2.jpg" --duration 10
\`\`\`

### 5. 预检模式 (--dry-run) 与帮助 (--help)
\`\`\`bash
# 查看完整 CLI 参数帮助
node ~/.agents/skills/grok-imagine/scripts/grok_imagine.mjs --help

# 预检参数与凭证，打印 Payload 但不扣费
node ~/.agents/skills/grok-imagine/scripts/grok_imagine.mjs --type video --prompt "测试" --dry-run
\`\`\`

### 6. 任务恢复与进度补抓 (--check-status)
若因网络波动导致视频生成超时，可以从报错中复制 Request ID 并恢复查询下载：
\`\`\`bash
node ~/.agents/skills/grok-imagine/scripts/grok_imagine.mjs --check-status "req_123456789"
\`\`\`

## 输出目录与文件命名
1. **默认存储路径**：
   - **图片**: 当前工作区的 \`./images/\` 目录下（如 \`./images/grok_cyberpunk_city_20260723150412.jpg\`）。
   - **视频**: 当前工作区的 \`./videos/\` 目录下（如 \`./videos/grok_sea_waves_20260723150530.mp4\`）。
2. **格式规约**：语义化提示词缩写 + \`YYYYMMDDHHmmss\` 时间戳，自动保持文件防重与可读性。

## Agent 回传与渲染规则 (必须执行)
1. **标准输出解析**: 脚本执行成功后会在控制台输出包含 Markdown 的文本段落。
2. **回传要求**: Agent **必须将控制台输出的原始 Markdown 语法块直接包含在回复给用户的 Message 中**（兼容 Codex / Antigravity / Claude 界面直接预览与点击播放）：
   - 图片格式：\`![Generated Image](/absolute/path/to/image.jpg)\`
   - 视频格式：\`![Generated Video](/absolute/path/to/video.mp4)\` 以及 \`[▶️ 点击播放/预览视频](file:///absolute/path/to/video.mp4)\`
   这样用户的 AI 客户端界面才能直接渲染预览与一键拉起播放器！

## 异常处理与恢复指引
- **401 Unauthorized / Token Missing**: 告知用户 \`~/.grok/auth.json\` 凭证缺失或过期，请运行 \`grok\` 命令重连。
- **422 Unprocessable Entity**: 检查提示词或传入的图片路径是否存在。
- **Video Poll Timeout**: 脚本会将 \`Request ID\` 附带在错误信息中，Agent 应告知用户，并自动调用 \`--check-status "<request_id>"\` 进行轮询恢复。
`;

const TOOL_META = {
  antigravity: {
    label: "Google Antigravity",
    short: "G",
    color: "#10a37f",
    // Windows: ~/.gemini/antigravity/builtin/skills
    // macOS:   ~/.gemini/config/skills
    pathTemplateWin: "~/.gemini/antigravity/builtin/skills/{name}",
    pathTemplateMac: "~/.gemini/config/skills/{name}",
    pathTemplate: "~/.gemini/antigravity/builtin/skills/{name}",
  },
  claude: {
    label: "Claude Code / Desktop",
    short: "C",
    color: "#d97706",
    pathTemplate: "~/.claude/skills/{name}",
  },
  codex: {
    label: "OpenAI Codex",
    short: "O",
    color: "#2563eb",
    // Codex discovers skills from the central agents skills root.
    pathTemplate: "~/.agents/skills/{name}",
    isCentral: true,
  },
};

const BUILTIN_MANAGED_SKILL_CATALOG = [
  {
    id: "session-sync",
    name: "session-sync",
    title: "会话同步",
    summary: "跨 Codex / Claude / Antigravity 恢复与接管历史会话上下文。",
    category: "system",
    categoryLabel: "系统",
    icon: "🔄",
    managed: true,
    featured: true,
    tags: ["session", "handoff", "context"],
    requiresDaemon: true,
    builtin: true,
  },
  {
    id: "grok-imagine",
    name: "grok-imagine",
    title: "Grok 多模态视觉生成",
    summary: "使用本地 Grok 订阅凭证做文生图 / 图生图 / 文生视频 / 图生视频。",
    category: "media",
    categoryLabel: "媒体创作",
    icon: "🎨",
    managed: true,
    featured: true,
    tags: ["image", "video", "grok"],
    requiresDaemon: false,
    builtin: true,
  },
];

const EMBEDDED_SKILL_CONTENT = {
  "session-sync": SESSION_SYNC_SKILL_CONTENT,
  "grok-imagine": GROK_IMAGINE_SKILL_CONTENT,
};

const CATEGORY_META = {
  system: { id: "system", label: "系统", order: 10 },
  media: { id: "media", label: "媒体创作", order: 20 },
  download: { id: "download", label: "下载采集", order: 30 },
  browser: { id: "browser", label: "浏览器与登录态", order: 40 },
  writing: { id: "writing", label: "写作与内容", order: 50 },
  research: { id: "research", label: "研究与知识", order: 60 },
  workflow: { id: "workflow", label: "工作流", order: 70 },
  other: { id: "other", label: "其他", order: 100 },
};

function emptyToolMap(value = false) {
  return {
    antigravity: Boolean(value),
    claude: Boolean(value),
    codex: Boolean(value),
  };
}

function normalizeToolMap(input = {}) {
  return {
    antigravity: Boolean(input?.antigravity),
    claude: Boolean(input?.claude),
    codex: Boolean(input?.codex),
  };
}

function countEnabledTools(targets = {}) {
  return ["antigravity", "claude", "codex"].filter((tool) => Boolean(targets?.[tool])).length;
}

function parseFrontmatter(raw = "") {
  const text = String(raw || "");
  if (!text.startsWith("---")) {
    return { data: {}, body: text };
  }
  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    return { data: {}, body: text };
  }
  const fm = text.slice(3, end).replace(/^\r?\n/, "");
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  const data = {};
  for (const line of fm.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idxColon = trimmed.indexOf(":");
    if (idxColon === -1) continue;
    const key = trimmed.slice(0, idxColon).trim();
    let value = trimmed.slice(idxColon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }
  return { data, body };
}

function inferCategory(name = "", description = "") {
  const hay = `${name} ${description}`.toLowerCase();
  if (/(cookie|browser|chrome|login|auth)/.test(hay)) return "browser";
  if (/(download|yt-dlp|gallery|bilibili|youtube|media-kit|video|audio|image|imagine|seedance|seedream)/.test(hay)) return "download";
  if (/(write|article|translate|post|wechat|weibo|xhs|markdown|comic|cover)/.test(hay)) return "writing";
  if (/(research|search|docs|knowledge|understand|obsidian)/.test(hay)) return "research";
  if (/(workflow|plan|sync|session|manager|ship|debug|gsd)/.test(hay)) return "workflow";
  if (name === "session-sync") return "system";
  if (name === "grok-imagine") return "media";
  return "other";
}

function extractSummary(description = "", body = "") {
  const desc = String(description || "").trim();
  if (desc) return desc.slice(0, 180);
  const line = String(body || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith("#") && !item.startsWith("```"));
  return (line || "本地 Agent Skill").slice(0, 180);
}

function titleFromName(name = "") {
  return String(name || "")
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isSafeSkillName(name = "") {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(String(name || "").trim());
}

function readJsonFile(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function copyDirRecursive(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.name || entry.name === "." || entry.name === "..") continue;
    // Never promote local virtualenvs / caches into the project managed tree.
    if ([".venv", "venv", "node_modules", ".git", "__pycache__"].includes(entry.name)) continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(src, dest);
      continue;
    }
    if (entry.isFile()) {
      fs.copyFileSync(src, dest);
    }
  }
}

function removeDirRecursive(targetDir) {
  fs.rmSync(targetDir, { recursive: true, force: true });
}

function normalizeManagedEntry(raw = {}, fallbackName = "") {
  const name = String(raw.name || fallbackName || "").trim();
  if (!name) return null;
  const category = String(raw.category || inferCategory(name, raw.summary || raw.description || "")).trim() || "other";
  const categoryMeta = CATEGORY_META[category] || CATEGORY_META.other;
  return {
    id: String(raw.id || name).trim() || name,
    name,
    title: String(raw.title || titleFromName(name)).trim() || titleFromName(name),
    summary: String(raw.summary || raw.description || "网关托管技能").trim(),
    category,
    categoryLabel: String(raw.categoryLabel || categoryMeta.label).trim() || categoryMeta.label,
    icon: String(raw.icon || (category === "media" ? "🎨" : category === "browser" ? "🍪" : category === "download" ? "⬇️" : category === "system" ? "🔄" : "🧩")).trim(),
    managed: true,
    featured: Boolean(raw.featured),
    tags: Array.isArray(raw.tags) ? raw.tags.map((tag) => String(tag)) : [],
    requiresDaemon: Boolean(raw.requiresDaemon),
    builtin: Boolean(raw.builtin),
    promoted: Boolean(raw.promoted),
    sourceDir: raw.sourceDir ? String(raw.sourceDir) : null,
  };
}

export class SkillInstaller {
  static get TOOLS() {
    return TOOL_META;
  }

  static get PROJECT_ROOT() {
    return PROJECT_ROOT;
  }

  static get MANAGED_SKILLS_ROOT() {
    return MANAGED_SKILLS_ROOT;
  }

  static get MANAGED_CATALOG_FILE() {
    return MANAGED_CATALOG_FILE;
  }

  static get MANAGED_SKILLS() {
    return SkillInstaller.loadManagedCatalog();
  }

  static getManagedSkillSourceDir(skillName = "session-sync") {
    return path.join(MANAGED_SKILLS_ROOT, skillName);
  }

  static loadPromotedCatalogEntries() {
    const data = readJsonFile(MANAGED_CATALOG_FILE, { skills: [] });
    const list = Array.isArray(data?.skills) ? data.skills : Array.isArray(data) ? data : [];
    return list
      .map((item) => normalizeManagedEntry(item))
      .filter(Boolean)
      .filter((item) => isSafeSkillName(item.name));
  }

  static savePromotedCatalogEntries(entries = []) {
    const skills = entries
      .map((item) => normalizeManagedEntry(item))
      .filter(Boolean)
      .filter((item) => !item.builtin)
      .map((item) => ({
        id: item.id,
        name: item.name,
        title: item.title,
        summary: item.summary,
        category: item.category,
        categoryLabel: item.categoryLabel,
        icon: item.icon,
        featured: Boolean(item.featured),
        tags: item.tags || [],
        requiresDaemon: Boolean(item.requiresDaemon),
        promoted: true,
        managed: true,
      }));
    writeJsonFile(MANAGED_CATALOG_FILE, {
      version: 1,
      updatedAt: new Date().toISOString(),
      skills,
    });
    return skills;
  }

  static loadManagedCatalog() {
    const byName = new Map();
    for (const item of BUILTIN_MANAGED_SKILL_CATALOG) {
      byName.set(item.name, normalizeManagedEntry(item));
    }

    for (const item of SkillInstaller.loadPromotedCatalogEntries()) {
      if (byName.has(item.name)) continue;
      byName.set(item.name, {
        ...item,
        promoted: true,
        sourceDir: SkillInstaller.getManagedSkillSourceDir(item.name),
      });
    }

    // Discover any managed skill folders under lib/skills even if catalog is stale.
    if (fs.existsSync(MANAGED_SKILLS_ROOT)) {
      for (const entry of fs.readdirSync(MANAGED_SKILLS_ROOT, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        if (!isSafeSkillName(name) || name.startsWith(".")) continue;
        const skillFile = path.join(MANAGED_SKILLS_ROOT, name, "SKILL.md");
        if (!fs.existsSync(skillFile)) continue;
        if (byName.has(name)) {
          const existing = byName.get(name);
          byName.set(name, {
            ...existing,
            sourceDir: SkillInstaller.getManagedSkillSourceDir(name),
          });
          continue;
        }
        const raw = fs.readFileSync(skillFile, "utf-8");
        const { data, body } = parseFrontmatter(raw);
        const description = String(data.description || "").trim();
        const category = inferCategory(name, description);
        const categoryMeta = CATEGORY_META[category] || CATEGORY_META.other;
        byName.set(
          name,
          normalizeManagedEntry({
            id: name,
            name,
            title: titleFromName(name),
            summary: extractSummary(description, body),
            category,
            categoryLabel: categoryMeta.label,
            promoted: true,
            sourceDir: SkillInstaller.getManagedSkillSourceDir(name),
          }),
        );
      }
    }

    return [...byName.values()].sort((a, b) => {
      if (a.featured !== b.featured) return a.featured ? -1 : 1;
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
      return String(a.name).localeCompare(String(b.name));
    });
  }

  static getManagedSkill(skillName = "") {
    const name = String(skillName || "").trim();
    return SkillInstaller.loadManagedCatalog().find((item) => item.name === name) || null;
  }

  static getCentralSkillsRoot(homeDir = os.homedir()) {
    return path.join(homeDir, ".agents", "skills");
  }

  static getCentralSkillDir(skillName = "session-sync", homeDir = os.homedir()) {
    return path.join(SkillInstaller.getCentralSkillsRoot(homeDir), skillName);
  }

  static getCentralSkillFile(skillName = "session-sync", homeDir = os.homedir()) {
    return path.join(SkillInstaller.getCentralSkillDir(skillName, homeDir), "SKILL.md");
  }

  static get centralSkillDir() {
    return SkillInstaller.getCentralSkillDir("session-sync");
  }

  static get centralSkillFile() {
    return SkillInstaller.getCentralSkillFile("session-sync");
  }

  static isWindows() {
    return process.platform === "win32";
  }

  static getAntigravitySkillsRoot(homeDir = os.homedir()) {
    // User-confirmed layout:
    // - Windows: ~/.gemini/antigravity/builtin/skills
    // - macOS:   ~/.gemini/config/skills
    if (SkillInstaller.isWindows()) {
      return path.join(homeDir, ".gemini", "antigravity", "builtin", "skills");
    }
    return path.join(homeDir, ".gemini", "config", "skills");
  }

  static getToolPaths(homeDir = os.homedir(), skillName = "session-sync") {
    return {
      antigravity: path.join(SkillInstaller.getAntigravitySkillsRoot(homeDir), skillName),
      claude: path.join(homeDir, ".claude", "skills", skillName),
      // Codex uses the central agents skills root directly.
      codex: path.join(SkillInstaller.getCentralSkillDir(skillName, homeDir)),
    };
  }

  static getToolPathMeta(skillName = "session-sync") {
    return Object.fromEntries(
      Object.entries(TOOL_META).map(([tool, meta]) => {
        let pathTemplate = meta.pathTemplate;
        if (tool === "antigravity") {
          pathTemplate = SkillInstaller.isWindows()
            ? (meta.pathTemplateWin || meta.pathTemplate)
            : (meta.pathTemplateMac || meta.pathTemplate);
        }
        return [
          tool,
          {
            ...meta,
            pathTemplate,
            path: pathTemplate.replace("{name}", skillName),
            isCentral: Boolean(meta.isCentral),
          },
        ];
      }),
    );
  }

  static resolveManagedSkillContent(skillName = "session-sync") {
    const sourceDir = SkillInstaller.getManagedSkillSourceDir(skillName);
    const sourceFile = path.join(sourceDir, "SKILL.md");
    if (fs.existsSync(sourceFile)) {
      return {
        content: fs.readFileSync(sourceFile, "utf-8"),
        sourceDir,
        fromProject: true,
      };
    }
    if (EMBEDDED_SKILL_CONTENT[skillName]) {
      return {
        content: EMBEDDED_SKILL_CONTENT[skillName],
        sourceDir: null,
        fromProject: false,
      };
    }
    return null;
  }

  static installBaseSkill(centralDir = SkillInstaller.centralSkillDir, skillName = "session-sync") {
    if (!fs.existsSync(centralDir)) {
      fs.mkdirSync(centralDir, { recursive: true });
    }
    const targetFile = path.join(centralDir, "SKILL.md");
    const resolved = SkillInstaller.resolveManagedSkillContent(skillName);
    if (!resolved?.content) {
      throw new Error(`No managed skill content found for ${skillName}`);
    }
    fs.writeFileSync(targetFile, resolved.content, "utf-8");

    const sourceScriptDir = resolved.sourceDir
      ? path.join(resolved.sourceDir, "scripts")
      : path.join(MANAGED_SKILLS_ROOT, skillName, "scripts");
    const candidateScriptDirs = [
      sourceScriptDir,
      path.join(process.cwd(), "lib", "skills", skillName, "scripts"),
    ];
    let scriptsDir = null;
    for (const candidate of candidateScriptDirs) {
      if (candidate && fs.existsSync(candidate)) {
        scriptsDir = candidate;
        break;
      }
    }

    if (scriptsDir) {
      const targetScriptDir = path.join(centralDir, "scripts");
      if (!fs.existsSync(targetScriptDir)) {
        fs.mkdirSync(targetScriptDir, { recursive: true });
      }
      for (const file of fs.readdirSync(scriptsDir)) {
        const srcPath = path.join(scriptsDir, file);
        const dest = path.join(targetScriptDir, file);
        if (fs.statSync(srcPath).isFile()) {
          fs.copyFileSync(srcPath, dest);
        }
      }
    }

    // Copy any additional non-script files from project managed source.
    if (resolved.sourceDir && fs.existsSync(resolved.sourceDir)) {
      for (const entry of fs.readdirSync(resolved.sourceDir, { withFileTypes: true })) {
        if (entry.name === "SKILL.md" || entry.name === "scripts" || entry.name.startsWith(".")) continue;
        if ([".venv", "venv", "node_modules", ".git", "__pycache__"].includes(entry.name)) continue;
        const src = path.join(resolved.sourceDir, entry.name);
        const dest = path.join(centralDir, entry.name);
        if (entry.isDirectory()) {
          copyDirRecursive(src, dest);
        } else if (entry.isFile()) {
          fs.copyFileSync(src, dest);
        }
      }
    }

    return targetFile;
  }

  static getSymlinkStatus(homeDir = os.homedir(), skillName = "session-sync") {
    const toolPaths = SkillInstaller.getToolPaths(homeDir, skillName);
    const centralDir = SkillInstaller.getCentralSkillDir(skillName, homeDir);
    const status = {};

    for (const [tool, dir] of Object.entries(toolPaths)) {
      try {
        const isCentralTarget = Boolean(TOOL_META[tool]?.isCentral) || path.resolve(dir) === path.resolve(centralDir);
        if (isCentralTarget) {
          status[tool] = fs.existsSync(path.join(centralDir, "SKILL.md"));
          continue;
        }
        const lstat = fs.lstatSync(dir);
        const skillFileExists = fs.existsSync(path.join(dir, "SKILL.md"));
        status[tool] = (lstat.isSymbolicLink() || lstat.isDirectory() || lstat.isFile()) && skillFileExists;
      } catch {
        status[tool] = false;
      }
    }

    return status;
  }

  static updateSymlinks(
    toolSelections = {},
    homeDir = os.homedir(),
    centralFile = null,
    skillName = "session-sync",
  ) {
    const centralDir = SkillInstaller.getCentralSkillDir(skillName, homeDir);
    const targetCentralFile = centralFile || SkillInstaller.getCentralSkillFile(skillName, homeDir);

    if (!fs.existsSync(targetCentralFile)) {
      if (SkillInstaller.getManagedSkill(skillName)) {
        SkillInstaller.installBaseSkill(centralDir, skillName);
      }
    }

    const toolPaths = SkillInstaller.getToolPaths(homeDir, skillName);
    const results = {};

    for (const [tool, targetSkillDir] of Object.entries(toolPaths)) {
      const shouldLink = Boolean(toolSelections[tool]);
      const isCentralTarget = Boolean(TOOL_META[tool]?.isCentral) || path.resolve(targetSkillDir) === path.resolve(centralDir);

      try {
        if (isCentralTarget) {
          // Codex/central: presence of SKILL.md in ~/.agents/skills/<name> is the mount state.
          // Never create a self-symlink, and never delete the central skill on "unmount".
          if (shouldLink) {
            if (!fs.existsSync(path.join(centralDir, "SKILL.md")) && SkillInstaller.loadManagedCatalog().some((item) => item.name === skillName)) {
              SkillInstaller.installBaseSkill(centralDir, skillName);
            }
            results[tool] = fs.existsSync(path.join(centralDir, "SKILL.md"));
          } else {
            results[tool] = false;
          }
          continue;
        }

        if (shouldLink) {
          if (!fs.existsSync(targetCentralFile) && !fs.existsSync(path.join(centralDir, "SKILL.md"))) {
            results[tool] = false;
            continue;
          }

          const parentDir = path.dirname(targetSkillDir);
          if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
          }

          try {
            const lstat = fs.lstatSync(targetSkillDir);
            if (lstat.isSymbolicLink() || lstat.isDirectory() || lstat.isFile()) {
              fs.rmSync(targetSkillDir, { recursive: true, force: true });
            }
          } catch {}

          const symlinkType = process.platform === "win32" ? "junction" : "dir";
          fs.symlinkSync(centralDir, targetSkillDir, symlinkType);
          results[tool] = true;
        } else {
          try {
            const lstat = fs.lstatSync(targetSkillDir);
            if (lstat.isSymbolicLink() || lstat.isDirectory() || lstat.isFile()) {
              fs.rmSync(targetSkillDir, { recursive: true, force: true });
            }
          } catch {}
          results[tool] = false;
        }
      } catch (err) {
        results[tool] = false;
      }
    }

    return results;
  }

  static install(targetDir, skillName = "session-sync") {
    const baseFile = SkillInstaller.installBaseSkill(SkillInstaller.getCentralSkillDir(skillName), skillName);
    if (targetDir) {
      SkillInstaller.updateSymlinks({ custom: true }, os.homedir(), baseFile, skillName);
    } else {
      SkillInstaller.updateSymlinks({ antigravity: true, claude: true, codex: true }, os.homedir(), baseFile, skillName);
    }
    return baseFile;
  }

  static isInstalled(skillName = "session-sync", homeDir = os.homedir()) {
    return fs.existsSync(SkillInstaller.getCentralSkillFile(skillName, homeDir));
  }

  static ensureManagedSkills(homeDir = os.homedir()) {
    const results = {};
    for (const skill of SkillInstaller.loadManagedCatalog()) {
      const dir = SkillInstaller.getCentralSkillDir(skill.name, homeDir);
      results[skill.name] = SkillInstaller.installBaseSkill(dir, skill.name);
    }
    return results;
  }

  static promoteLocalSkillToManaged(skillName, {
    homeDir = os.homedir(),
    title,
    summary,
    category,
    icon,
    tags,
    featured = false,
  } = {}) {
    const name = String(skillName || "").trim();
    if (!isSafeSkillName(name)) {
      throw new Error("invalid skill name");
    }

    const existingManaged = SkillInstaller.getManagedSkill(name);
    if (existingManaged) {
      throw new Error(`${name} 已经是网关托管技能`);
    }

    const centralDir = SkillInstaller.getCentralSkillDir(name, homeDir);
    const centralSkillFile = path.join(centralDir, "SKILL.md");
    if (!fs.existsSync(centralSkillFile)) {
      throw new Error(`${name} 未安装在中央目录，无法转成网关托管`);
    }

    const projectDir = SkillInstaller.getManagedSkillSourceDir(name);
    if (fs.existsSync(projectDir)) {
      removeDirRecursive(projectDir);
    }
    copyDirRecursive(centralDir, projectDir);

    const meta = SkillInstaller.readSkillMeta(projectDir, name);
    const entry = normalizeManagedEntry({
      id: name,
      name,
      title: title || meta.title,
      summary: summary || meta.summary,
      category: category || meta.category,
      categoryLabel: (CATEGORY_META[category || meta.category] || CATEGORY_META.other).label,
      icon: icon || meta.icon,
      tags: Array.isArray(tags) ? tags : meta.tags || [],
      featured: Boolean(featured),
      promoted: true,
      managed: true,
      sourceDir: projectDir,
    });

    const promoted = SkillInstaller.loadPromotedCatalogEntries().filter((item) => item.name !== name);
    promoted.push(entry);
    SkillInstaller.savePromotedCatalogEntries(promoted);

    // Keep central install in sync with the newly managed project source.
    SkillInstaller.installBaseSkill(centralDir, name);

    return {
      skill: entry,
      projectDir,
      centralDir,
      catalogFile: MANAGED_CATALOG_FILE,
    };
  }

  static readSkillMeta(skillDir, skillName) {
    const skillFile = path.join(skillDir, "SKILL.md");
    let raw = "";
    try {
      raw = fs.readFileSync(skillFile, "utf-8");
    } catch {
      raw = "";
    }
    const { data, body } = parseFrontmatter(raw);
    const name = String(data.name || skillName || path.basename(skillDir)).trim() || skillName;
    const description = String(data.description || "").trim();
    const managed = SkillInstaller.getManagedSkill(name);
    const category = managed?.category || inferCategory(name, description);
    const categoryMeta = CATEGORY_META[category] || CATEGORY_META.other;
    const title = managed?.title || titleFromName(name);
    const summary = managed?.summary || extractSummary(description, body);
    const hasScripts = fs.existsSync(path.join(skillDir, "scripts"));
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(skillFile).mtimeMs;
    } catch {
      mtimeMs = 0;
    }

    return {
      id: name,
      name,
      title,
      summary,
      description,
      category,
      categoryLabel: managed?.categoryLabel || categoryMeta.label,
      icon: managed?.icon || (category === "media" ? "🎨" : category === "browser" ? "🍪" : category === "download" ? "⬇️" : category === "system" ? "🔄" : "🧩"),
      managed: Boolean(managed),
      featured: Boolean(managed?.featured),
      tags: managed?.tags || [],
      requiresDaemon: Boolean(managed?.requiresDaemon),
      builtin: Boolean(managed?.builtin),
      promoted: Boolean(managed?.promoted),
      hasScripts,
      skillFile,
      skillDir,
      projectSourceDir: managed ? SkillInstaller.getManagedSkillSourceDir(name) : null,
      mtimeMs,
    };
  }

  static listCentralSkills(homeDir = os.homedir()) {
    const root = SkillInstaller.getCentralSkillsRoot(homeDir);
    const byName = new Map();
    const managedCatalog = SkillInstaller.loadManagedCatalog();

    for (const managed of managedCatalog) {
      const dir = SkillInstaller.getCentralSkillDir(managed.name, homeDir);
      const installed = fs.existsSync(path.join(dir, "SKILL.md"));
      const meta = installed
        ? SkillInstaller.readSkillMeta(dir, managed.name)
        : {
            id: managed.name,
            name: managed.name,
            title: managed.title,
            summary: managed.summary,
            description: managed.summary,
            category: managed.category,
            categoryLabel: managed.categoryLabel,
            icon: managed.icon,
            managed: true,
            featured: Boolean(managed.featured),
            tags: managed.tags || [],
            requiresDaemon: Boolean(managed.requiresDaemon),
            builtin: Boolean(managed.builtin),
            promoted: Boolean(managed.promoted),
            hasScripts: false,
            skillFile: path.join(dir, "SKILL.md"),
            skillDir: dir,
            projectSourceDir: SkillInstaller.getManagedSkillSourceDir(managed.name),
            mtimeMs: 0,
          };
      byName.set(managed.name, {
        ...meta,
        installed,
        source: installed ? "central" : "catalog",
      });
    }

    if (fs.existsSync(root)) {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const name = entry.name;
        if (!name || name.startsWith(".")) continue;
        const dir = path.join(root, name);
        const skillFile = path.join(dir, "SKILL.md");
        if (!fs.existsSync(skillFile)) continue;
        const meta = SkillInstaller.readSkillMeta(dir, name);
        byName.set(meta.name, {
          ...meta,
          installed: true,
          source: meta.managed ? "central" : "discovered",
        });
      }
    }

    return [...byName.values()].sort((a, b) => {
      if (a.featured !== b.featured) return a.featured ? -1 : 1;
      if (a.managed !== b.managed) return a.managed ? -1 : 1;
      if ((a.categoryLabel || "") !== (b.categoryLabel || "")) {
        return String(a.categoryLabel).localeCompare(String(b.categoryLabel), "zh");
      }
      return String(a.title || a.name).localeCompare(String(b.title || b.name), "zh");
    });
  }

  static getSkillMountMap(skillNames = [], homeDir = os.homedir()) {
    const map = {};
    for (const name of skillNames) {
      map[name] = SkillInstaller.getSymlinkStatus(homeDir, name);
    }
    return map;
  }

  static buildLibrarySnapshot({
    homeDir = os.homedir(),
    mounts = {},
    query = "",
    category = "all",
    scope = "all",
  } = {}) {
    // Keep mounts accepted for API compatibility, but the library is intentionally
    // simple: presence under ~/.agents/skills means the skill is installed.
    void mounts;
    const skills = SkillInstaller.listCentralSkills(homeDir).map((skill) => {
      const tools = SkillInstaller.getToolPathMeta(skill.name);
      return {
        ...skill,
        installed: Boolean(skill.installed),
        // Compatibility aliases for older UI/API consumers.
        mounted: Boolean(skill.installed),
        enabledCount: skill.installed ? 1 : 0,
        targets: emptyToolMap(false),
        tools,
        path: skill.skillDir,
        canPromote: Boolean(skill.installed && !skill.managed),
      };
    });

    const q = String(query || "").trim().toLowerCase();
    const filtered = skills.filter((skill) => {
      if (category && category !== "all" && skill.category !== category) return false;
      if ((scope === "installed" || scope === "mounted") && !skill.installed) return false;
      if (scope === "missing" && skill.installed) return false;
      if (scope === "managed" && !skill.managed) return false;
      if (scope === "local" && skill.managed) return false;
      if (!q) return true;
      const hay = [skill.name, skill.title, skill.summary, skill.description, ...(skill.tags || [])]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });

    const categories = Object.values(CATEGORY_META)
      .map((meta) => ({
        ...meta,
        count: skills.filter((skill) => skill.category === meta.id).length,
      }))
      .filter((meta) => meta.count > 0 || meta.id === "other")
      .sort((a, b) => a.order - b.order);

    const stats = {
      total: skills.length,
      installed: skills.filter((skill) => skill.installed).length,
      // Compatibility alias for older clients.
      mounted: skills.filter((skill) => skill.installed).length,
      managed: skills.filter((skill) => skill.managed).length,
      local: skills.filter((skill) => !skill.managed).length,
      missing: skills.filter((skill) => skill.managed && !skill.installed).length,
      filtered: filtered.length,
    };

    return {
      root: SkillInstaller.getCentralSkillsRoot(homeDir),
      managedRoot: MANAGED_SKILLS_ROOT,
      tools: TOOL_META,
      categories,
      stats,
      skills: filtered,
      allSkills: skills,
    };
  }

  static emptyToolMap(value = false) {
    return emptyToolMap(value);
  }

  static normalizeToolMap(input = {}) {
    return normalizeToolMap(input);
  }
}
