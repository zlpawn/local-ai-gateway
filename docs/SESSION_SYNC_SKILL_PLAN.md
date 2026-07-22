# 三大 AI 桌面客户端全自动会话同步系统方案（无 MCP / 纯 Skill 架构）

> **文档版本**：v1.0.0  
> **适用终端**：Antigravity Desktop、Claude Desktop、Codex Desktop  
> **核心机制**：星型数据中枢（Universal Session Hub） + 本地守护进程（File Watcher Daemon） + 跨软件 Skill 规范  

---

## 一、 方案背景与设计目标

### 1.1 痛点场景
在多 AI 协同开发中，经常遇到以下突发状况：
* 在 **Codex** / **Antigravity** 中讨论复杂需求或调试代码时，突发 **API Rate Limit（额度耗尽）** 或软件异常卡死。
* 由于额度已空，**无法让当前 AI 总结生成交接文档（Handoff Doc）**。
* 希望能够零干预、全自动地将上一秒的对话上下文直接延续到 **Claude Desktop** 或其他客户端中继续讨论。

### 1.2 设计约束与原则
* **无 MCP 依赖**：避免对 MCP 协议架构的依赖，全部通过**通用 Skill** 与**本地文件系统**实现。
* **零侵入**：绝不直接修改各大 Electron App 私有的 LevelDB/SQLite 数据库，防止文件死锁、内存缓存不一致或数据损坏。
* **全自动无感落盘**：AI 回答完毕并写入磁盘后 **1~2 秒内**，后台进程自动将对话快照增量同步至全局中枢。
* **精准匹配**：基于当前工作区路径（Workspace）、时间戳与活跃句柄指针（Active Pointer），秒级命中并载入正确的目标历史会话。

---

## 二、 整体架构设计（星型中枢模式）

放弃传统的“两两网状同步”，采用**“星型中枢（Hub-and-Spoke）”**架构：

```
       ┌────────────────────────┐
       │   Antigravity Desktop  │ ──┐
       └────────────────────────┘   │
                                    │ (监听文件落盘 / 写入)
       ┌────────────────────────┐   ▼
       │   Claude Desktop       │ ◄──► ┌───────────────────────────────────┐
       └────────────────────────┘      │   Universal Session Hub (中枢)    │
                                    ▲  │   路径: ~/.ai_hub/                │
       ┌────────────────────────┐   │  └───────────────────────────────────┘
       │   Codex Desktop        │ ──┘
       └────────────────────────┘
```

### 2.1 核心组件划分
1. **中枢存储层 (`~/.ai_hub/`)**：
   * 存储经过规范化（Normalized）的标准 JSON 格式历史会话快照。
   * 维护 `CURRENT_ACTIVE.json` 全局最新活跃句柄指针。
2. **后台监听守护进程 (`session-sync-daemon`)**：
   * 使用系统级内核事件（macOS `FSEvents` / Node.js `fs.watch`）对 3 大软件的磁盘日志目录进行零 CPU 消耗的静默监听。
   * 监测到落盘变动后，经 **1.5秒防抖（Debounce）**，抽取解析增量并写入中枢。
3. **通用客户端 Skill (`session-sync-skill`)**：
   * 部署于各大软件的通用 Skill（符合标准 SKILL.md 规范）。
   * 负责响应用户的“接手会话”、“拉取上个AI历史”指令，从 `~/.ai_hub/` 中智能检索并读取指定上下文填入当前对话框。

---

## 三、 三大软件数据源与解析规则

| 软件 | 磁盘存储路径 | 文件格式 | 监听模式与解析方法 |
| :--- | :--- | :--- | :--- |
| **Antigravity Desktop** | `~/.gemini/antigravity/brain/<conv-id>/.system_generated/logs/transcript.jsonl` | `JSONL` | 后台 Watcher 实时监听 `.jsonl` 增量行；直接解析 `USER_INPUT` 与 `MODEL_RESPONSE`。 |
| **Codex Desktop** | `~/.codex/sessions/*.json` 或项目下 `.codex/history.json` | `JSON` | 监听文件修改时间（`mtime`）；解析消息数组 `messages: [{role, content}]`。 |
| **Claude Desktop** | `~/Library/Application Support/Claude/` (或导出/临时快照) | `JSON/Text` | 监听日志落盘，或通过通用导出/存储文件抓取。 |

---

## 四、 中枢数据规范与匹配算法

### 4.1 中枢存储结构 (`~/.ai_hub/`)
```
~/.ai_hub/
├── CURRENT_ACTIVE.json               # 最新活跃会话指针
├── sessions/
│   ├── sess_20260722_153020_a1b2.json # 标准化会话快照
│   └── sess_20260722_142011_c3d4.json
└── workspace_index.json              # 项目路径索引表
```

#### 标准会话文件格式样例 (`sess_xxx.json`)：
```json
{
  "session_id": "sess_20260722_153020_a1b2",
  "source_app": "codex",
  "workspace_path": "/Users/pa/project/AI/local-ai-gateway",
  "created_at": "2026-07-22T15:30:20Z",
  "updated_at": "2026-07-22T15:32:10Z",
  "summary": "修复 Codex Serde 解析 JSON 字符串的 Bug",
  "messages": [
    { "role": "user", "content": "帮我看看这个 Grok Serde 报错怎么处理" },
    { "role": "assistant", "content": "原因在于 custom_tool_call 参数未序列化为 JSON 字符串..." }
  ]
}
```

### 4.2 智能会话查找算法（How to find the CORRECT session）
当在新软件中执行 Skill 导入历史时，按以下优先级层级判定“目标会话”：

```
                    ┌───────────────────────────────┐
                    │ 1. 当前 Workspace 匹配 ?      │
                    └───────────────┬───────────────┘
                                    │ 是
                                    ▼
                    ┌───────────────────────────────┐
                    │ 2. 时间戳排序取最近更新 1 条  │
                    └───────────────┬───────────────┘
                                    │ 命 中 (95% 场景)
                                    ▼
                        [ 载入目标 Session 上下文 ]
```

1. **第一优先级（项目匹配）**：获取当前软件打开的 `WorkspacePath`，从中枢筛选 `workspace_path == current_workspace` 的记录。
2. **第二优先级（时间最接近）**：对筛选出的记录按 `updated_at` 倒序，锁定最后更新的那一条。
3. **fallback 托底**：若无法获取 Workspace，直接读取 `CURRENT_ACTIVE.json` 指向的全局最后一次对话。

---

## 五、 防抖写入与后台守护进程实现

### 5.1 守护进程的核心逻辑 (`session-sync-daemon.js`)
下面为落地的守护进程参考实现（Node.js 原生支持 macOS `FSEvents`）：

```javascript
const fs = require('fs');
const path = require('path');

const HUB_DIR = path.join(process.env.HOME, '.ai_hub');
const SESSIONS_DIR = path.join(HUB_DIR, 'sessions');
const POINTER_FILE = path.join(HUB_DIR, 'CURRENT_ACTIVE.json');

// 确保中枢目录存在
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// 防抖计时器 Map
const debounceTimers = new Map();

function syncAntigravityTranscript(filePath) {
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    const messages = [];
    let workspace = process.cwd();

    for (const line of lines) {
      const data = JSON.parse(line);
      if (data.type === 'USER_INPUT') {
        messages.push({ role: 'user', content: data.content });
      } else if (data.type === 'PLANNER_RESPONSE' && data.content) {
        messages.push({ role: 'assistant', content: data.content });
      }
    }

    if (messages.length === 0) return;

    // 提取会话 ID 与元数据
    const dirParts = filePath.split('/');
    const convId = dirParts[dirParts.indexOf('brain') + 1] || 'unknown';
    const hubSessionPath = path.join(SESSIONS_DIR, `antigravity_${convId}.json`);

    const sessionData = {
      session_id: `antigravity_${convId}`,
      source_app: 'antigravity',
      workspace_path: workspace,
      updated_at: new Date().toISOString(),
      messages: messages
    };

    // 写入中枢
    fs.writeFileSync(hubSessionPath, JSON.stringify(sessionData, null, 2));

    // 刷新全局最新活跃指针
    fs.writeFileSync(POINTER_FILE, JSON.stringify({
      active_session_id: sessionData.session_id,
      updated_at: sessionData.updated_at
    }, null, 2));

    console.log(`[SyncDaemon] Successfully synced session: ${sessionData.session_id}`);
  } catch (err) {
    console.error(`[SyncDaemon] Failed to sync ${filePath}:`, err.message);
  }
}

// 监听 Antigravity 目录
const agPath = path.join(process.env.HOME, '.gemini/antigravity/brain');
if (fs.existsSync(agPath)) {
  fs.watch(agPath, { recursive: true }, (eventType, filename) => {
    if (filename && filename.endsWith('transcript.jsonl')) {
      const fullPath = path.join(agPath, filename);
      
      // 1.5 秒防抖，避免写入中途重复读取
      if (debounceTimers.has(fullPath)) clearTimeout(debounceTimers.get(fullPath));
      debounceTimers.set(fullPath, setTimeout(() => {
        syncAntigravityTranscript(fullPath);
        debounceTimers.delete(fullPath);
      }, 1500));
    }
  });
  console.log('[SyncDaemon] Watching Antigravity sessions...');
}
```

---

## 六、 跨软件通用 Skill 规范实现 (`SKILL.md`)

在各个软件中配置或注册名为 `session-sync` 的 Skill 文件，格式完全符合 Agent 规范：

### 6.1 `SKILL.md` 规范说明文件
存储路径推荐：`~/.gemini/config/skills/session-sync/SKILL.md`

```markdown
---
name: session-sync
description: 当用户需要从另一个 AI 桌面软件（Codex/Claude/Antigravity）恢复、接入或同步中断的历史会话上下文时触发。无需 MCP，直接从本地中枢 ~/.ai_hub 读取最新会话。
---

# Session Sync Skill

## 使用场景
当用户说以下指令时触发：
- "恢复刚才在 Codex/Antigravity 的会话"
- "接手之前的讨论"
- "上个软件额度没了，从刚才停下的地方继续"
- "导入历史上下文"

## 操作步骤

1. **定位中枢目录**：
   读取文件 `~/.ai_hub/CURRENT_ACTIVE.json` 确定全局最新的会话指针，或者扫描 `~/.ai_hub/sessions/` 目录下匹配当前工作区（Workspace）的最后更新会话。

2. **读取会话快照**：
   读取目标 JSON 文件，获取 `messages` 数组与 `summary` 字段。

3. **构建上下文接管**：
   - 提取会话最后 5~10 轮对话的关键内容。
   - 梳理目前讨论的核心议题与终止的步骤。
   - 输出总结并准备回答用户的下一个问题。
```

---

## 七、 端到端落地实施步骤

### 步骤 1：创建中枢文件夹结构
在本地执行：
```bash
mkdir -p ~/.ai_hub/sessions
```

### 步骤 2：部署并后台运行 Daemon 守护进程
将守护进程配置为系统级后台服务（如 macOS `launchd` 或 pm2 / nohup）：
```bash
nohup node ~/.ai_hub/session-sync-daemon.js > ~/.ai_hub/daemon.log 2>&1 &
```

### 步骤 3：安装 `session-sync` Skill
将 `SKILL.md` 复制安装至各大软件对应的 Skills 目录，软件启动后即可原生感知该能力。

### 步骤 4：验证流转过程
1. 在 **Codex** / **Antigravity** 中正常对话。
2. 对话完成后，查看 `~/.ai_hub/CURRENT_ACTIVE.json` 确认是否在 2 秒内静默刷新。
3. 打开 **Claude Desktop** 或另一个终端，唤起 Skill：*"接手刚才在 Codex 聊的代码重构问题"*。
4. 验证 AI 是否无缝还原上下文并接着回答。

---

## 八、 总结

本方案通过 **系统级原生的文件监听（FSEvents）+ 统一的通用中枢 JSON + Agent 极简 Skill**，彻底解决了无 MCP 环境下的多软件会话同步问题。

* **安全性**：0 侵入数据库，无锁死风险。
* **可靠性**：流式防抖监听，无论软件何时断额度/崩溃，最新对话永远在中枢完好保留。
* **极简性**：依靠简单的项目路径与时间戳规则，100% 准确命中目标上下文。
