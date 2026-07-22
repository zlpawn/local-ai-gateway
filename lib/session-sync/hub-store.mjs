import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export class HubStore {
  constructor(options = {}) {
    this.baseDir = options.baseDir || (options.runtimeDir ? path.join(options.runtimeDir, 'hub') : path.join(process.cwd(), 'hub'));
    this.sessionsDir = path.join(this.baseDir, 'sessions');
    this.pointerFile = path.join(this.baseDir, 'CURRENT_ACTIVE.json');
  }

  ensureStorage() {
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  formatWorkspaceName(workspacePath) {
    if (!workspacePath) return 'global';
    const base = path.basename(path.normalize(workspacePath)).trim();
    if (!base || base === '/' || base === '.') return 'global';
    return base.replace(/[^a-zA-Z0-9_\-\.]/g, '-');
  }

  formatDateStr(dateStr) {
    const d = dateStr ? new Date(dateStr) : new Date();
    if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
    return d.toISOString().slice(0, 10);
  }

  buildFilename(sessionData) {
    const dateStr = this.formatDateStr(sessionData.updated_at || sessionData.created_at);
    const wsName = this.formatWorkspaceName(sessionData.workspace_path);
    const cleanSessionId = sessionData.session_id.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    return `${dateStr}_${wsName}_${cleanSessionId}.json`;
  }

  saveSession(sessionData) {
    this.ensureStorage();

    if (!sessionData.session_id) {
      throw new Error('sessionData must contain session_id');
    }

    const filename = this.buildFilename(sessionData);
    const sessionPath = path.join(this.sessionsDir, filename);

    // Remove old filename if session_id was previously saved under a different date/workspace filename
    const existing = this.getSession(sessionData.session_id);
    if (existing && existing._filePath && existing._filePath !== sessionPath) {
      try {
        fs.unlinkSync(existing._filePath);
      } catch {}
    }

    const record = {
      session_id: sessionData.session_id,
      source_app: sessionData.source_app || 'unknown',
      workspace_path: sessionData.workspace_path || '',
      created_at: sessionData.created_at || new Date().toISOString(),
      updated_at: sessionData.updated_at || new Date().toISOString(),
      summary: sessionData.summary || '',
      messages: sessionData.messages || []
    };

    fs.writeFileSync(sessionPath, JSON.stringify(record, null, 2), 'utf-8');

    // Update CURRENT_ACTIVE pointer
    const pointerData = {
      active_session_id: record.session_id,
      source_app: record.source_app,
      workspace_path: record.workspace_path,
      file_path: sessionPath,
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
    this.ensureStorage();
    const files = fs.readdirSync(this.sessionsDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const fullPath = path.join(this.sessionsDir, file);
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const data = JSON.parse(content);
        if (data.session_id === sessionId || file.includes(sessionId)) {
          data._filePath = fullPath;
          return data;
        }
      } catch {}
    }
    return null;
  }

  listSessions() {
    this.ensureStorage();
    const files = fs.readdirSync(this.sessionsDir).filter(f => f.endsWith('.json'));
    const sessions = [];

    for (const file of files) {
      const fullPath = path.join(this.sessionsDir, file);
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const data = JSON.parse(content);
        data._filePath = fullPath;
        sessions.push(data);
      } catch {}
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
