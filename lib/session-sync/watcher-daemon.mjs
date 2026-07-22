import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HubStore } from './hub-store.mjs';

export class SessionWatcherDaemon {
  constructor(options = {}) {
    this.hubStore = options.hubStore || new HubStore(options);
    this.debounceMs = options.debounceMs || 1500;
    this.watchers = [];
    this.debounceTimers = new Map();
    this.isRunning = false;

    this.antigravityDir = options.antigravityDir || path.join(os.homedir(), '.gemini/antigravity/brain');
    this.codexDir = options.codexDir || path.join(os.homedir(), '.codex/sessions');
  }

  generateSummary(messages) {
    const firstUserMsg = messages.find(m => m.role === 'user');
    if (!firstUserMsg || !firstUserMsg.content) return 'Session Conversation';

    const cleanText = firstUserMsg.content
      .replace(/^[#\s]+/, '')          // 移除开头的 Markdown 标题符号 #
      .replace(/\r?\n/g, ' ')           // 将换行符替换为空格
      .replace(/\s+/g, ' ')             // 合并连续空格
      .trim();

    if (cleanText.length <= 100) return cleanText;
    return cleanText.slice(0, 100) + '...';
  }

  parseAntigravityTranscript(filePath) {
    if (!fs.existsSync(filePath)) return null;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      const messages = [];

      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          if (item.type === 'USER_INPUT' && item.content) {
            messages.push({ role: 'user', content: item.content });
          } else if (item.type === 'PLANNER_RESPONSE' && item.content) {
            messages.push({ role: 'assistant', content: item.content });
          }
        } catch {
          // skip invalid json lines
        }
      }

      if (messages.length === 0) return null;

      const pathParts = filePath.split(/[/\\]/);
      const brainIdx = pathParts.indexOf('brain');
      const convId = brainIdx !== -1 && pathParts[brainIdx + 1] ? pathParts[brainIdx + 1] : 'unknown';

      return {
        session_id: `antigravity_${convId}`,
        source_app: 'antigravity',
        workspace_path: '',
        summary: this.generateSummary(messages),
        messages
      };
    } catch {
      return null;
    }
  }

  parseCodexSession(filePath) {
    if (!fs.existsSync(filePath)) return null;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      const rawMessages = data.messages || data.history || [];
      const messages = [];

      for (const item of rawMessages) {
        if (item.role && (item.content || item.text)) {
          messages.push({
            role: item.role === 'human' ? 'user' : item.role,
            content: item.content || item.text
          });
        }
      }

      if (messages.length === 0) return null;

      const filename = path.basename(filePath, '.json');
      return {
        session_id: `codex_${filename}`,
        source_app: 'codex',
        workspace_path: data.workspace_path || data.cwd || '',
        summary: this.generateSummary(messages),
        messages
      };
    } catch {
      return null;
    }
  }

  scheduleSync(filePath, parser) {
    if (this.debounceTimers.has(filePath)) {
      clearTimeout(this.debounceTimers.get(filePath));
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      const sessionData = parser(filePath);
      if (sessionData) {
        this.hubStore.saveSession(sessionData);
      }
    }, this.debounceMs);

    this.debounceTimers.set(filePath, timer);
  }

  shouldSync(filePath, sessionId) {
    try {
      const existing = this.hubStore.getSession(sessionId);
      if (!existing || !existing.updated_at) return true;
      const stat = fs.statSync(filePath);
      return new Date(stat.mtime).getTime() > new Date(existing.updated_at).getTime();
    } catch {
      return true;
    }
  }

  scanExistingSessions() {
    // Scan Antigravity historical sessions
    if (fs.existsSync(this.antigravityDir)) {
      try {
        const subdirs = fs.readdirSync(this.antigravityDir);
        for (const dir of subdirs) {
          const logPath = path.join(this.antigravityDir, dir, '.system_generated', 'logs', 'transcript.jsonl');
          if (fs.existsSync(logPath)) {
            const sessionId = `antigravity_${dir}`;
            if (this.shouldSync(logPath, sessionId)) {
              const data = this.parseAntigravityTranscript(logPath);
              if (data) this.hubStore.saveSession(data);
            }
          }
        }
      } catch {}
    }

    // Scan Codex historical sessions
    if (fs.existsSync(this.codexDir)) {
      try {
        const files = fs.readdirSync(this.codexDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
          const fullPath = path.join(this.codexDir, file);
          const filename = path.basename(file, '.json');
          const sessionId = `codex_${filename}`;
          if (this.shouldSync(fullPath, sessionId)) {
            const data = this.parseCodexSession(fullPath);
            if (data) this.hubStore.saveSession(data);
          }
        }
      } catch {}
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    // Initial scan of historical sessions before gateway was installed
    this.scanExistingSessions();

    // Watch Antigravity
    if (fs.existsSync(this.antigravityDir)) {
      try {
        const agWatcher = fs.watch(this.antigravityDir, { recursive: true }, (eventType, filename) => {
          if (filename && filename.endsWith('transcript.jsonl')) {
            const fullPath = path.join(this.antigravityDir, filename);
            this.scheduleSync(fullPath, (fp) => this.parseAntigravityTranscript(fp));
          }
        });
        this.watchers.push(agWatcher);
      } catch (err) {
        // Watcher fallback if recursive watch fails
      }
    }

    // Watch Codex
    if (fs.existsSync(this.codexDir)) {
      try {
        const codexWatcher = fs.watch(this.codexDir, { recursive: true }, (eventType, filename) => {
          if (filename && filename.endsWith('.json')) {
            const fullPath = path.join(this.codexDir, filename);
            this.scheduleSync(fullPath, (fp) => this.parseCodexSession(fp));
          }
        });
        this.watchers.push(codexWatcher);
      } catch (err) {
        // Watcher fallback
      }
    }
  }

  stop() {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {}
    }
    this.watchers = [];
    this.isRunning = false;
  }

  status() {
    return {
      isRunning: this.isRunning,
      activeWatchers: this.watchers.length,
      hubPointer: this.hubStore.getActivePointer()
    };
  }
}
