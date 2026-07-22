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
        summary: messages[0]?.content?.slice(0, 100) || 'Antigravity Session',
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
        summary: messages[0]?.content?.slice(0, 100) || 'Codex Session',
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

  start() {
    if (this.isRunning) return;
    this.isRunning = true;

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
