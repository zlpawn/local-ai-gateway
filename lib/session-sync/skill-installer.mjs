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
- "用 Grok 画一张..." / "帮我生成一张图片" / "修改这张图片" (图生图)
- "做一段视频" / "把这张图片变成动图" (图生视频)
- "/imagine prompt: ..." 或 \`/imagine_video\`

## 规则与命令
技能脚本直接放置于技能目录的 \`scripts/\` 文件夹下。

1. **文生图**: \`node scripts/grok_imagine.mjs --prompt "..." --aspect-ratio "16:9"\`
2. **图生图**: \`node scripts/grok_imagine.mjs --prompt "..." --image "/path/to/img.png"\`
3. **生视频**: \`node scripts/grok_imagine.mjs --type video --prompt "..." --duration 6\`
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
