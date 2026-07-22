import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export class HubStore {
  constructor(options = {}) {
    this.baseDir = options.baseDir || path.join(os.homedir(), '.local-ai-gateway', 'hub');
    this.sessionsDir = path.join(this.baseDir, 'sessions');
    this.pointerFile = path.join(this.baseDir, 'CURRENT_ACTIVE.json');
  }

  ensureStorage() {
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  saveSession(sessionData) {
    this.ensureStorage();

    if (!sessionData.session_id) {
      throw new Error('sessionData must contain session_id');
    }

    const sessionPath = path.join(this.sessionsDir, `${sessionData.session_id}.json`);
    const record = {
      session_id: sessionData.session_id,
      source_app: sessionData.source_app || 'unknown',
      workspace_path: sessionData.workspace_path || '',
      created_at: sessionData.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      summary: sessionData.summary || '',
      messages: sessionData.messages || []
    };

    fs.writeFileSync(sessionPath, JSON.stringify(record, null, 2), 'utf-8');

    // Update CURRENT_ACTIVE pointer
    const pointerData = {
      active_session_id: record.session_id,
      source_app: record.source_app,
      workspace_path: record.workspace_path,
      updated_at: record.updated_at
    };
    fs.writeFileSync(this.pointerFile, JSON.stringify(pointerData, null, 2), 'utf-8');

    return record;
  }

  getActivePointer() {
    if (!fs.existsSync(this.pointerFile)) return null;
    try {
      const content = fs.readFileSync(this.pointerFile, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  getSession(sessionId) {
    const sessionPath = path.join(this.sessionsDir, `${sessionId}.json`);
    if (!fs.existsSync(sessionPath)) return null;
    try {
      const content = fs.readFileSync(sessionPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  listSessions() {
    this.ensureStorage();
    const files = fs.readdirSync(this.sessionsDir).filter(f => f.endsWith('.json'));
    const sessions = [];

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(this.sessionsDir, file), 'utf-8');
        sessions.push(JSON.parse(content));
      } catch {
        // ignore malformed session files
      }
    }

    return sessions.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  }

  findSessionByWorkspace(workspacePath) {
    if (!workspacePath) return this.findLatestSession();
    const sessions = this.listSessions();
    const normalizedTarget = path.normalize(workspacePath);

    const matched = sessions.find(s => s.workspace_path && path.normalize(s.workspace_path) === normalizedTarget);
    return matched || this.findLatestSession();
  }

  findLatestSession() {
    const sessions = this.listSessions();
    return sessions.length > 0 ? sessions[0] : null;
  }
}
