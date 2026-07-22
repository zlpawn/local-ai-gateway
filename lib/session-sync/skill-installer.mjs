import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SKILL_CONTENT = `---
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

export class SkillInstaller {
  static get centralSkillDir() {
    return path.join(os.homedir(), '.agents', 'skills', 'session-sync');
  }

  static get centralSkillFile() {
    return path.join(SkillInstaller.centralSkillDir, 'SKILL.md');
  }

  static getToolPaths(homeDir = os.homedir()) {
    return {
      antigravity: path.join(homeDir, '.gemini', 'config', 'skills', 'session-sync'),
      claude: path.join(homeDir, '.claude', 'skills', 'session-sync'),
      codex: path.join(homeDir, '.codex', 'skills', 'session-sync')
    };
  }

  static installBaseSkill(centralDir = SkillInstaller.centralSkillDir) {
    if (!fs.existsSync(centralDir)) {
      fs.mkdirSync(centralDir, { recursive: true });
    }
    const targetFile = path.join(centralDir, 'SKILL.md');
    fs.writeFileSync(targetFile, SKILL_CONTENT, 'utf-8');
    return targetFile;
  }

  static getSymlinkStatus(homeDir = os.homedir()) {
    const toolPaths = SkillInstaller.getToolPaths(homeDir);
    const status = {};

    for (const [tool, dir] of Object.entries(toolPaths)) {
      const linkFile = path.join(dir, 'SKILL.md');
      try {
        const lstat = fs.lstatSync(linkFile);
        status[tool] = lstat.isSymbolicLink() || lstat.isFile();
      } catch {
        status[tool] = false;
      }
    }

    return status;
  }

  static updateSymlinks(toolSelections = {}, homeDir = os.homedir(), centralFile = SkillInstaller.centralSkillFile) {
    // Ensure base skill file exists first
    if (!fs.existsSync(centralFile)) {
      SkillInstaller.installBaseSkill(path.dirname(centralFile));
    }

    const toolPaths = SkillInstaller.getToolPaths(homeDir);
    const results = {};

    for (const [tool, dir] of Object.entries(toolPaths)) {
      const linkFile = path.join(dir, 'SKILL.md');
      const shouldLink = Boolean(toolSelections[tool]);

      try {
        if (shouldLink) {
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }

          // Check if link or file exists
          try {
            const lstat = fs.lstatSync(linkFile);
            if (lstat.isSymbolicLink() || lstat.isFile()) {
              fs.unlinkSync(linkFile);
            }
          } catch {}

          // Create symlink
          const symlinkType = process.platform === 'win32' ? 'file' : undefined;
          fs.symlinkSync(centralFile, linkFile, symlinkType);
          results[tool] = true;
        } else {
          try {
            const lstat = fs.lstatSync(linkFile);
            if (lstat.isSymbolicLink() || lstat.isFile()) {
              fs.unlinkSync(linkFile);
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

  // Backwards compatibility install method
  static install(targetDir) {
    const baseFile = SkillInstaller.installBaseSkill();
    if (targetDir) {
      SkillInstaller.updateSymlinks({ custom: true }, os.homedir(), baseFile);
    } else {
      SkillInstaller.updateSymlinks({ antigravity: true, claude: true, codex: true });
    }
    return baseFile;
  }

  static isInstalled() {
    return fs.existsSync(SkillInstaller.centralSkillFile);
  }
}
