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

    this.antigravityDir = options.antigravityDir || path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
    this.codexDir = options.codexDir || path.join(os.homedir(), '.codex');
    this.claudeDesktopDir = options.claudeDesktopDir || path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
  }

  generateSummary(messages) {
    const firstUserMsg = messages.find(m => m.role === 'user');
    if (!firstUserMsg || !firstUserMsg.content) return 'Session Conversation';

    const cleanText = String(firstUserMsg.content)
      .replace(/^[#\s]+/, '')
      .replace(/\r?\n/g, ' ')
      .replace(/\s+/g, ' ')
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
            messages.push({ role: 'user', content: String(item.content) });
          } else if (item.type === 'PLANNER_RESPONSE' && item.content) {
            messages.push({ role: 'assistant', content: String(item.content) });
          }
        } catch {}
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

      // Case 1: Standard JSON session
      if (filePath.endsWith('.json')) {
        const data = JSON.parse(content);
        const rawMessages = data.messages || data.history || [];
        const messages = [];

        for (const item of rawMessages) {
          if (item.role && (item.content || item.text)) {
            messages.push({
              role: item.role === 'human' ? 'user' : item.role,
              content: String(item.content || item.text)
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
      }

      // Case 2: Codex Rollout JSONL session
      if (filePath.endsWith('.jsonl')) {
        const lines = content.split('\n').filter(Boolean);
        const messages = [];
        let workspace_path = '';

        for (const line of lines) {
          try {
            const item = JSON.parse(line);
            if (item.type === 'turn_context' && item.payload?.cwd) {
              workspace_path = item.payload.cwd;
            }
            if (item.type === 'response_item' && item.payload?.type === 'message') {
              const role = item.payload.role === 'developer' ? 'user' : (item.payload.role || 'user');
              let textContent = '';
              if (Array.isArray(item.payload.content)) {
                textContent = item.payload.content
                  .map(c => typeof c === 'string' ? c : (c.text || ''))
                  .filter(Boolean)
                  .join('\n');
              } else if (typeof item.payload.content === 'string') {
                textContent = item.payload.content;
              }
              if (textContent) {
                messages.push({ role, content: textContent });
              }
            }
          } catch {}
        }

        if (messages.length === 0) return null;

        const filename = path.basename(filePath, '.jsonl');
        return {
          session_id: `codex_${filename}`,
          source_app: 'codex',
          workspace_path,
          summary: this.generateSummary(messages),
          messages
        };
      }
    } catch {
      return null;
    }
  }

  parseClaudeDesktopSession(filePath) {
    if (!fs.existsSync(filePath)) return null;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const messages = [];
      let workspace_path = '';

      if (filePath.endsWith('.json')) {
        const data = JSON.parse(content);
        const rawMessages = data.messages || data.history || [];
        for (const item of rawMessages) {
          if (item.role && (item.content || item.text)) {
            messages.push({
              role: item.role,
              content: String(item.content || item.text)
            });
          }
        }
        workspace_path = data.workspace_path || data.cwd || '';
      } else if (filePath.endsWith('.jsonl')) {
        const lines = content.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const item = JSON.parse(line);
            if (item.cwd && !workspace_path) {
              workspace_path = item.cwd;
            }
            // Only capture Claude Desktop entries (e.g. entrypoint === 'claude-desktop' or 'claude-desktop-3p')
            if (item.entrypoint && !item.entrypoint.includes('desktop')) {
              continue;
            }
            if ((item.type === 'user' || item.type === 'assistant') && item.message) {
              const role = item.type;
              let text = '';
              if (typeof item.message.content === 'string') {
                text = item.message.content;
              } else if (Array.isArray(item.message.content)) {
                text = item.message.content
                  .map(c => typeof c === 'string' ? c : (c.text || ''))
                  .filter(Boolean)
                  .join('\n');
              }
              if (text) {
                messages.push({ role, content: text });
              }
            }
          } catch {}
        }
      }

      if (messages.length === 0) return null;

      const filename = path.basename(filePath, path.extname(filePath));
      return {
        session_id: `claude_desktop_${filename}`,
        source_app: 'claude_desktop',
        workspace_path,
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
    // 1. Antigravity sessions
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

    // 2. Codex sessions (codexDir root, sessions, and archived_sessions)
    const codexDirs = [
      this.codexDir,
      path.join(this.codexDir, 'sessions'),
      path.join(this.codexDir, 'archived_sessions')
    ];
    for (const cDir of codexDirs) {
      if (fs.existsSync(cDir)) {
        try {
          const files = fs.readdirSync(cDir).filter(f => f.endsWith('.json') || f.endsWith('.jsonl'));
          for (const file of files) {
            const fullPath = path.join(cDir, file);
            if (fs.statSync(fullPath).isFile()) {
              const filename = path.basename(file, path.extname(file));
              const sessionId = `codex_${filename}`;
              if (this.shouldSync(fullPath, sessionId)) {
                const data = this.parseCodexSession(fullPath);
                if (data) this.hubStore.saveSession(data);
              }
            }
          }
        } catch {}
      }
    }

    // 3. Claude Desktop sessions ONLY (ignore CLI Claude Code projects)
    if (fs.existsSync(this.claudeDesktopDir)) {
      const scanDirRecursively = (dir) => {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (entry.name !== 'Cache' && entry.name !== 'Code Cache' && entry.name !== 'GPUCache') {
                scanDirRecursively(fullPath);
              }
            } else if (entry.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl'))) {
              const filename = path.basename(entry.name, path.extname(entry.name));
              const sessionId = `claude_desktop_${filename}`;
              if (this.shouldSync(fullPath, sessionId)) {
                const data = this.parseClaudeDesktopSession(fullPath);
                if (data) this.hubStore.saveSession(data);
              }
            }
          }
        } catch {}
      };
      scanDirRecursively(this.claudeDesktopDir);
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
      } catch {}
    }

    // Watch Codex
    if (fs.existsSync(this.codexDir)) {
      try {
        const codexWatcher = fs.watch(this.codexDir, { recursive: true }, (eventType, filename) => {
          if (filename && (filename.endsWith('.json') || filename.endsWith('.jsonl'))) {
            const fullPath = path.join(this.codexDir, filename);
            this.scheduleSync(fullPath, (fp) => this.parseCodexSession(fp));
          }
        });
        this.watchers.push(codexWatcher);
      } catch {}
    }

    // Watch Claude Desktop
    if (fs.existsSync(this.claudeDesktopDir)) {
      try {
        const claudeWatcher = fs.watch(this.claudeDesktopDir, { recursive: true }, (eventType, filename) => {
          if (filename && (filename.endsWith('.json') || filename.endsWith('.jsonl'))) {
            const fullPath = path.join(this.claudeDesktopDir, filename);
            this.scheduleSync(fullPath, (fp) => this.parseClaudeDesktopSession(fp));
          }
        });
        this.watchers.push(claudeWatcher);
      } catch {}
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
