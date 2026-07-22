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
    this.claudeDir = options.claudeDir || (options.codexDir ? path.join(path.dirname(options.codexDir), 'claude') : path.join(os.homedir(), '.claude'));
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

  parseClaudeSession(filePath) {
    if (!fs.existsSync(filePath)) return null;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const messages = [];
      let workspace_path = '';

      if (filePath.endsWith('.jsonl')) {
        const lines = content.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const item = JSON.parse(line);
            if (item.cwd && !workspace_path) {
              workspace_path = item.cwd;
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
        session_id: `claude_${filename}`,
        source_app: 'claude',
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

    // 3. Claude sessions (~/.claude/projects/*/*.jsonl)
    const claudeProjectsDir = path.join(this.claudeDir, 'projects');
    if (fs.existsSync(claudeProjectsDir)) {
      try {
        const projectDirs = fs.readdirSync(claudeProjectsDir);
        for (const pDir of projectDirs) {
          const pPath = path.join(claudeProjectsDir, pDir);
          try {
            if (fs.statSync(pPath).isDirectory()) {
              const files = fs.readdirSync(pPath).filter(f => f.endsWith('.jsonl'));
              for (const file of files) {
                const fullPath = path.join(pPath, file);
                const filename = path.basename(file, '.jsonl');
                const sessionId = `claude_${filename}`;
                if (this.shouldSync(fullPath, sessionId)) {
                  const data = this.parseClaudeSession(fullPath);
                  if (data) this.hubStore.saveSession(data);
                }
              }
            }
          } catch {}
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

    // Watch Claude
    if (fs.existsSync(this.claudeDir)) {
      try {
        const claudeWatcher = fs.watch(this.claudeDir, { recursive: true }, (eventType, filename) => {
          if (filename && filename.endsWith('.jsonl')) {
            const fullPath = path.join(this.claudeDir, filename);
            this.scheduleSync(fullPath, (fp) => this.parseClaudeSession(fp));
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
