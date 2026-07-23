import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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

export class SkillInstaller {
  static getCentralSkillDir(skillName = "session-sync") {
    return path.join(os.homedir(), ".agents", "skills", skillName);
  }

  static getCentralSkillFile(skillName = "session-sync") {
    return path.join(SkillInstaller.getCentralSkillDir(skillName), "SKILL.md");
  }

  static get centralSkillDir() {
    return SkillInstaller.getCentralSkillDir("session-sync");
  }

  static get centralSkillFile() {
    return SkillInstaller.getCentralSkillFile("session-sync");
  }

  static getToolPaths(homeDir = os.homedir(), skillName = "session-sync") {
    return {
      antigravity: path.join(homeDir, ".gemini", "config", "skills", skillName),
      claude: path.join(homeDir, ".claude", "skills", skillName),
      codex: path.join(homeDir, ".codex", "skills", skillName),
    };
  }

  static installBaseSkill(centralDir = SkillInstaller.centralSkillDir, skillName = "session-sync") {
    if (!fs.existsSync(centralDir)) {
      fs.mkdirSync(centralDir, { recursive: true });
    }
    const targetFile = path.join(centralDir, "SKILL.md");
    const content = skillName === "grok-imagine" ? GROK_IMAGINE_SKILL_CONTENT : SESSION_SYNC_SKILL_CONTENT;
    fs.writeFileSync(targetFile, content, "utf-8");

    // Copy bundled scripts directory if present
    if (skillName === "grok-imagine") {
      const candidatePaths = [
        path.join(process.cwd(), "lib", "skills", "grok-imagine", "scripts"),
        path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "skills", "grok-imagine", "scripts"),
      ];
      let sourceScriptDir = null;
      for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
          sourceScriptDir = p;
          break;
        }
      }

      if (sourceScriptDir) {
        const targetScriptDir = path.join(centralDir, "scripts");
        if (!fs.existsSync(targetScriptDir)) {
          fs.mkdirSync(targetScriptDir, { recursive: true });
        }
        const files = fs.readdirSync(sourceScriptDir);
        for (const file of files) {
          const src = path.join(sourceScriptDir, file);
          const dest = path.join(targetScriptDir, file);
          fs.copyFileSync(src, dest);
        }
      }
    }

    return targetFile;
  }

  static getSymlinkStatus(homeDir = os.homedir(), skillName = "session-sync") {
    const toolPaths = SkillInstaller.getToolPaths(homeDir, skillName);
    const status = {};

    for (const [tool, dir] of Object.entries(toolPaths)) {
      try {
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
    const centralDir = SkillInstaller.getCentralSkillDir(skillName);
    const targetCentralFile = centralFile || SkillInstaller.getCentralSkillFile(skillName);

    if (!fs.existsSync(targetCentralFile)) {
      SkillInstaller.installBaseSkill(centralDir, skillName);
    }

    const toolPaths = SkillInstaller.getToolPaths(homeDir, skillName);
    const results = {};

    for (const [tool, targetSkillDir] of Object.entries(toolPaths)) {
      const shouldLink = Boolean(toolSelections[tool]);

      try {
        if (shouldLink) {
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

  static isInstalled(skillName = "session-sync") {
    return fs.existsSync(SkillInstaller.getCentralSkillFile(skillName));
  }
}
