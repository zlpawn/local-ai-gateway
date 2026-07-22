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
  static get defaultTargetDir() {
    return path.join(os.homedir(), '.gemini/config/skills/session-sync');
  }

  static install(targetDir = SkillInstaller.defaultTargetDir) {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const targetFile = path.join(targetDir, 'SKILL.md');
    fs.writeFileSync(targetFile, SKILL_CONTENT, 'utf-8');
    return targetFile;
  }

  static isInstalled(targetDir = SkillInstaller.defaultTargetDir) {
    const targetFile = path.join(targetDir, 'SKILL.md');
    return fs.existsSync(targetFile);
  }
}
