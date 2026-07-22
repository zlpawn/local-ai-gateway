import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HubStore } from './hub-store.mjs';
import { generateLLMSummary } from './llm-summarizer.mjs';

export class SessionWatcherDaemon {
  constructor(options = {}) {
    this.hubStore = options.hubStore || new HubStore(options);
    this.debounceMs = options.debounceMs || 1500;
    this.watchers = [];
    this.debounceTimers = new Map();
    this.isRunning = false;
    this.dateRange = options.dateRange || null;
    this.summaryMode = options.summaryMode || 'rule'; // 'rule' | 'llm'
    this.summaryModel = options.summaryModel || '';
    this.listenPort = options.listenPort || 8787;

    const tmpParent = options.codexDir ? path.dirname(options.codexDir) : null;
    this.antigravityDir = options.antigravityDir || path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
    this.codexDir = options.codexDir || path.join(os.homedir(), '.codex');
    this.claudeProjectsDir = options.claudeProjectsDir || (tmpParent ? path.join(tmpParent, 'claude', 'projects') : path.join(os.homedir(), '.claude', 'projects'));
    this.claudeDesktopDir = options.claudeDesktopDir || (tmpParent ? path.join(tmpParent, 'Claude-3p') : path.join(os.homedir(), 'Library', 'Application Support', 'Claude-3p'));
  }

  setDateRange(range) {
    this.dateRange = range;
  }

  setSummaryOptions(mode, model, port) {
    this.summaryMode = mode || 'rule';
    this.summaryModel = model || '';
    if (port) this.listenPort = port;
  }

  isWithinDateRange(timestampStr) {
    if (!this.dateRange) return true;
    if (!timestampStr) return true;

    const t = new Date(timestampStr).getTime();
    if (isNaN(t)) return true;

    if (this.dateRange.startDate) {
      const start = new Date(`${this.dateRange.startDate}T00:00:00.000Z`).getTime();
      if (t < start) return false;
    }

    if (this.dateRange.endDate) {
      const end = new Date(`${this.dateRange.endDate}T23:59:59.999Z`).getTime();
      if (t > end) return false;
    }

    return true;
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
      let createdAt = null;
      let updatedAt = null;

      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          if (item.timestamp && !createdAt) createdAt = item.timestamp;
          if (item.timestamp) updatedAt = item.timestamp;

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
        created_at: createdAt || new Date().toISOString(),
        updated_at: updatedAt || new Date().toISOString(),
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
          created_at: data.created_at || new Date().toISOString(),
          updated_at: data.updated_at || new Date().toISOString(),
          summary: this.generateSummary(messages),
          messages
        };
      }

      if (filePath.endsWith('.jsonl')) {
        const lines = content.split('\n').filter(Boolean);
        const messages = [];
        let workspace_path = '';
        let createdAt = null;
        let updatedAt = null;

        for (const line of lines) {
          try {
            const item = JSON.parse(line);
            if (item.timestamp && !createdAt) createdAt = item.timestamp;
            if (item.timestamp) updatedAt = item.timestamp;

            if (item.type === 'turn_context' && item.payload?.cwd) {
              workspace_path = item.payload.cwd;
            }

            if (item.type === 'event_msg' && item.payload) {
              if (item.payload.type === 'user_message' && item.payload.message) {
                messages.push({ role: 'user', content: String(item.payload.message) });
              } else if (item.payload.type === 'agent_message' && item.payload.message) {
                messages.push({ role: 'assistant', content: String(item.payload.message) });
              }
            }

            if (item.type === 'response_item' && item.payload?.type === 'message') {
              const role = item.payload.role === 'developer' ? 'user' : (item.payload.role || 'user');
              let textContent = '';
              if (Array.isArray(item.payload.content)) {
                textContent = item.payload.content
                  .map(c => typeof c === 'string' ? c : (c.text || c.output_text || ''))
                  .filter(Boolean)
                  .join('\n');
              } else if (typeof item.payload.content === 'string') {
                textContent = item.payload.content;
              }

              if (textContent && !textContent.startsWith('<environment_context>') && !textContent.startsWith('You are `/root`')) {
                if (messages.length === 0 || messages[messages.length - 1].content !== textContent) {
                  messages.push({ role, content: textContent });
                }
              }

              if (textContent && textContent.includes('<cwd>')) {
                const match = textContent.match(/<cwd>(.*?)<\/cwd>/);
                if (match && match[1]) workspace_path = match[1];
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
          created_at: createdAt || new Date().toISOString(),
          updated_at: updatedAt || new Date().toISOString(),
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

    if (filePath.includes('subagents') || path.basename(filePath).startsWith('agent-')) {
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const messages = [];
      let workspace_path = '';
      let createdAt = null;
      let updatedAt = null;

      if (filePath.endsWith('.jsonl')) {
        const lines = content.split('\n').filter(Boolean);
        let isClaudeDesktop = filePath.includes('Claude') || filePath.includes('projects');

        for (const line of lines) {
          try {
            const item = JSON.parse(line);
            if (item.timestamp && !createdAt) createdAt = item.timestamp;
            if (item.timestamp) updatedAt = item.timestamp;

            if (item.cwd && !workspace_path) {
              workspace_path = item.cwd;
            }
            if (item.entrypoint && item.entrypoint.includes('desktop')) {
              isClaudeDesktop = true;
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

              if (text && !text.includes('skills:using-superpowers') && !text.includes('<EXTREMELY_IMPORTANT>')) {
                messages.push({ role, content: text });
              }
            }
          } catch {}
        }

        if (!isClaudeDesktop) return null;
      }

      if (messages.length === 0) return null;

      const filename = path.basename(filePath, path.extname(filePath));
      return {
        session_id: `claude_${filename}`,
        source_app: 'claude',
        workspace_path,
        created_at: createdAt || new Date().toISOString(),
        updated_at: updatedAt || new Date().toISOString(),
        summary: this.generateSummary(messages),
        messages
      };
    } catch {
      return null;
    }
  }

  processLLMSummaryAsync(sessionData) {
    if (this.summaryMode === 'llm' && this.summaryModel) {
      generateLLMSummary(sessionData.messages, {
        model: this.summaryModel,
        listenPort: this.listenPort,
        ruleFallback: sessionData.summary
      }).then(llmSummary => {
        if (llmSummary && llmSummary !== sessionData.summary) {
          sessionData.summary = `[AI 摘要] ${llmSummary}`;
          this.hubStore.saveSession(sessionData);
        }
      }).catch(() => {});
    }
  }

  scheduleSync(filePath, parser) {
    if (this.debounceTimers.has(filePath)) {
      clearTimeout(this.debounceTimers.get(filePath));
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      const sessionData = parser(filePath);
      if (sessionData && this.isWithinDateRange(sessionData.updated_at)) {
        this.hubStore.saveSession(sessionData);
        this.processLLMSummaryAsync(sessionData);
      }
    }, this.debounceMs);

    this.debounceTimers.set(filePath, timer);
  }

  shouldSync(filePath, sessionId) {
    try {
      const existing = this.hubStore.getSession(sessionId);
      const stat = fs.statSync(filePath);
      const mtimeIso = new Date(stat.mtime).toISOString();

      if (!this.isWithinDateRange(mtimeIso)) return false;
      if (!existing || !existing.updated_at) return true;
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
              if (data && this.isWithinDateRange(data.updated_at)) {
                this.hubStore.saveSession(data);
                this.processLLMSummaryAsync(data);
              }
            }
          }
        }
      } catch {}
    }

    // 2. Codex Desktop sessions
    const codexDirs = [
      this.codexDir,
      path.join(this.codexDir, 'sessions'),
      path.join(this.codexDir, 'archived_sessions')
    ];
    const scanCodexRecursively = (dir) => {
      if (!fs.existsSync(dir)) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name !== 'cache' && entry.name !== 'plugins' && entry.name !== 'vendor_imports') {
              scanCodexRecursively(fullPath);
            }
          } else if (entry.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl'))) {
            if (!entry.name.includes('config') && !entry.name.includes('catalog') && !entry.name.includes('state')) {
              const filename = path.basename(entry.name, path.extname(entry.name));
              const sessionId = `codex_${filename}`;
              if (this.shouldSync(fullPath, sessionId)) {
                const data = this.parseCodexSession(fullPath);
                if (data && this.isWithinDateRange(data.updated_at)) {
                  this.hubStore.saveSession(data);
                  this.processLLMSummaryAsync(data);
                }
              }
            }
          }
        }
      } catch {}
    };

    for (const cDir of codexDirs) {
      scanCodexRecursively(cDir);
    }

    // 3. Claude Desktop sessions
    if (fs.existsSync(this.claudeProjectsDir)) {
      try {
        const projectDirs = fs.readdirSync(this.claudeProjectsDir);
        for (const pDir of projectDirs) {
          const pPath = path.join(this.claudeProjectsDir, pDir);
          try {
            if (fs.statSync(pPath).isDirectory()) {
              const files = fs.readdirSync(pPath).filter(f => f.endsWith('.jsonl'));
              for (const file of files) {
                if (file.startsWith('agent-')) continue;
                const fullPath = path.join(pPath, file);
                const filename = path.basename(file, '.jsonl');
                const sessionId = `claude_${filename}`;
                if (this.shouldSync(fullPath, sessionId)) {
                  const data = this.parseClaudeDesktopSession(fullPath);
                  if (data && this.isWithinDateRange(data.updated_at)) {
                    this.hubStore.saveSession(data);
                    this.processLLMSummaryAsync(data);
                  }
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

    this.scanExistingSessions();

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

    if (fs.existsSync(this.codexDir)) {
      try {
        const codexWatcher = fs.watch(this.codexDir, { recursive: true }, (eventType, filename) => {
          if (filename && (filename.endsWith('.json') || filename.endsWith('.jsonl')) && !filename.includes('agent-')) {
            const fullPath = path.join(this.codexDir, filename);
            this.scheduleSync(fullPath, (fp) => this.parseCodexSession(fp));
          }
        });
        this.watchers.push(codexWatcher);
      } catch {}
    }

    if (fs.existsSync(this.claudeProjectsDir)) {
      try {
        const claudeWatcher = fs.watch(this.claudeProjectsDir, { recursive: true }, (eventType, filename) => {
          if (filename && filename.endsWith('.jsonl') && !filename.includes('subagents') && !path.basename(filename).startsWith('agent-')) {
            const fullPath = path.join(this.claudeProjectsDir, filename);
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
      dateRange: this.dateRange,
      summaryMode: this.summaryMode,
      summaryModel: this.summaryModel,
      hubPointer: this.hubStore.getActivePointer()
    };
  }
}
