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

    // Interpret configured YYYY-MM-DD as local calendar days, not hard UTC midnight.
    // This keeps "今天" aligned with the user's machine timezone.
    if (this.dateRange.startDate) {
      const [y, m, d] = String(this.dateRange.startDate).split('-').map(Number);
      if (y && m && d) {
        const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
        if (t < start) return false;
      }
    }

    if (this.dateRange.endDate) {
      const [y, m, d] = String(this.dateRange.endDate).split('-').map(Number);
      if (y && m && d) {
        const end = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
        if (t > end) return false;
      }
    }

    return true;
  }

  isNoiseMessage(content) {
    const text = String(content || '');
    if (!text.trim()) return true;
    return (
      text.startsWith('<permissions instructions>')
      || text.startsWith('<multi_agent_mode>')
      || text.startsWith('<recommended_plugins>')
      || text.startsWith('<environment_context>')
      || text.startsWith('<skills_instructions>')
      || text.startsWith('<app-context>')
      || text.startsWith('<collaboration_mode>')
      || text.startsWith('You are `/root`')
      || text.startsWith('Filesystem sandboxing defines')
    );
  }

  generateSummary(messages) {
    const firstUserMsg = (messages || []).find((m) => m.role === 'user' && !this.isNoiseMessage(m.content));
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

  isClaudeDesktopEntrypoint(entrypoint) {
    const text = String(entrypoint || '').toLowerCase();
    if (!text) return false;
    // Explicitly exclude Claude Code CLI / SDK sessions.
    if (text === 'cli' || text === 'sdk-cli' || text.includes('claude-code') || text.startsWith('sdk-')) {
      return false;
    }
    // Keep Claude Desktop app sessions (including Desktop third-party provider mode).
    return text.includes('desktop');
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
      let entrypoint = '';

      if (filePath.endsWith('.jsonl')) {
        const lines = content.split('\n').filter(Boolean);

        for (const line of lines) {
          try {
            const item = JSON.parse(line);
            if (item.timestamp && !createdAt) createdAt = item.timestamp;
            if (item.timestamp) updatedAt = item.timestamp;

            if (item.cwd && !workspace_path) {
              workspace_path = item.cwd;
            }
            if (item.entrypoint) {
              entrypoint = item.entrypoint;
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

        // Only Claude Desktop GUI/app sessions for now. Claude Code CLI (`cli` /
        // `sdk-cli`) lives in the same ~/.claude/projects tree and must be skipped.
        if (!this.isClaudeDesktopEntrypoint(entrypoint)) return null;
      } else {
        // Non-jsonl Claude transcripts are not supported yet.
        return null;
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
        ruleFallback: sessionData.summary,
        client: 'code',
        timeoutMs: 30000,
      }).then(llmSummary => {
        if (llmSummary && llmSummary !== sessionData.summary) {
          sessionData.summary = `[AI 摘要] ${llmSummary}`;
          this.hubStore.saveSession(sessionData);
        }
      }).catch((error) => {
        console.error(`LLM summary async failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  pruneSessionsOutsideDateRange() {
    if (!this.dateRange || (!this.dateRange.startDate && !this.dateRange.endDate)) {
      return { removed: 0, kept: 0 };
    }

    const sessions = this.hubStore.listSessions();
    let removed = 0;
    let kept = 0;
    for (const session of sessions) {
      if (this.sessionTouchesDateRange(session, session._filePath || null)) {
        kept += 1;
        continue;
      }
      if (session._filePath) {
        try {
          fs.unlinkSync(session._filePath);
          removed += 1;
        } catch {}
      }
    }

    // Refresh active pointer to the newest remaining session.
    const remaining = this.hubStore.listSessions();
    if (remaining.length === 0) {
      try {
        if (fs.existsSync(this.hubStore.pointerFile)) fs.unlinkSync(this.hubStore.pointerFile);
      } catch {}
    } else {
      const latest = remaining[0];
      this.hubStore.saveSession(latest);
    }

    return { removed, kept };
  }

  scheduleSync(filePath, parser) {
    if (this.debounceTimers.has(filePath)) {
      clearTimeout(this.debounceTimers.get(filePath));
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      const sessionData = parser(filePath);
      if (sessionData && this.sessionTouchesDateRange(sessionData, filePath)) {
        this.hubStore.saveSession(sessionData);
        this.processLLMSummaryAsync(sessionData);
      }
    }, this.debounceMs);

    this.debounceTimers.set(filePath, timer);
  }

  sessionTouchesDateRange(sessionData, filePath = null) {
    const stamps = [];
    if (sessionData?.updated_at) stamps.push(sessionData.updated_at);
    if (sessionData?.created_at) stamps.push(sessionData.created_at);
    if (filePath) {
      try {
        stamps.push(new Date(fs.statSync(filePath).mtime).toISOString());
      } catch {}
    }
    if (stamps.length === 0) return true;
    // Include the session if ANY of created/updated/file-mtime falls in range.
    // Claude Desktop often rewrites old transcript files today while content
    // timestamps stay on the original conversation day.
    return stamps.some((stamp) => this.isWithinDateRange(stamp));
  }

  shouldSync(filePath, sessionId) {
    try {
      const existing = this.hubStore.getSession(sessionId);
      const stat = fs.statSync(filePath);
      const mtimeIso = new Date(stat.mtime).toISOString();

      // Only hard-skip when neither the file mtime nor an existing hub record
      // looks related to the configured window. Final include decision still
      // uses sessionTouchesDateRange() with parsed timestamps.
      if (!this.isWithinDateRange(mtimeIso) && existing && !this.sessionTouchesDateRange(existing, filePath)) {
        return false;
      }
      if (!existing || !existing.updated_at) return true;
      return new Date(stat.mtime).getTime() > new Date(existing.updated_at).getTime();
    } catch {
      return true;
    }
  }

  async yieldTick() {
    await new Promise((resolve) => setImmediate(resolve));
  }

  async scanExistingSessions() {
    // 1. Antigravity sessions
    if (fs.existsSync(this.antigravityDir)) {
      try {
        const subdirs = fs.readdirSync(this.antigravityDir);
        for (const dir of subdirs) {
          if (!this.isRunning) return;
          const logPath = path.join(this.antigravityDir, dir, '.system_generated', 'logs', 'transcript.jsonl');
          if (fs.existsSync(logPath)) {
            const sessionId = `antigravity_${dir}`;
            if (this.shouldSync(logPath, sessionId)) {
              const data = this.parseAntigravityTranscript(logPath);
              if (data && this.sessionTouchesDateRange(data, logPath)) {
                this.hubStore.saveSession(data);
                this.processLLMSummaryAsync(data);
              }
            }
          }
          await this.yieldTick();
        }
      } catch {}
    }

    // 2. Codex Desktop sessions
    const codexDirs = [
      this.codexDir,
      path.join(this.codexDir, 'sessions'),
      path.join(this.codexDir, 'archived_sessions')
    ];
    const queue = codexDirs.filter((dir) => fs.existsSync(dir));
    while (queue.length > 0) {
      if (!this.isRunning) return;
      const dir = queue.shift();
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!this.isRunning) return;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name !== 'cache' && entry.name !== 'plugins' && entry.name !== 'vendor_imports') {
              queue.push(fullPath);
            }
          } else if (entry.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl'))) {
            if (!entry.name.includes('config') && !entry.name.includes('catalog') && !entry.name.includes('state')) {
              const filename = path.basename(entry.name, path.extname(entry.name));
              const sessionId = `codex_${filename}`;
              if (this.shouldSync(fullPath, sessionId)) {
                const data = this.parseCodexSession(fullPath);
                if (data && this.sessionTouchesDateRange(data, fullPath)) {
                  this.hubStore.saveSession(data);
                  this.processLLMSummaryAsync(data);
                }
              }
            }
          }
        }
      } catch {}
      await this.yieldTick();
    }

    // 3. Claude Desktop sessions
    if (fs.existsSync(this.claudeProjectsDir)) {
      try {
        const projectDirs = fs.readdirSync(this.claudeProjectsDir);
        for (const pDir of projectDirs) {
          if (!this.isRunning) return;
          const pPath = path.join(this.claudeProjectsDir, pDir);
          try {
            if (fs.statSync(pPath).isDirectory()) {
              const files = fs.readdirSync(pPath).filter(f => f.endsWith('.jsonl'));
              for (const file of files) {
                if (!this.isRunning) return;
                if (file.startsWith('agent-')) continue;
                const fullPath = path.join(pPath, file);
                const filename = path.basename(file, '.jsonl');
                const sessionId = `claude_${filename}`;
                if (this.shouldSync(fullPath, sessionId)) {
                  const data = this.parseClaudeDesktopSession(fullPath);
                  if (data && this.sessionTouchesDateRange(data, fullPath)) {
                    this.hubStore.saveSession(data);
                    this.processLLMSummaryAsync(data);
                  }
                }
                await this.yieldTick();
              }
            }
          } catch {}
          await this.yieldTick();
        }
      } catch {}
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    // Watch first, then catch up in the background without blocking health checks.
    void (async () => {
      try {
        const pruned = this.pruneSessionsOutsideDateRange();
        if (pruned.removed > 0) {
          console.log(`Session sync pruned ${pruned.removed} out-of-range hub sessions (kept ${pruned.kept}).`);
        }
        await this.scanExistingSessions();
      } catch (error) {
        console.error(`Session sync scan failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();

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
