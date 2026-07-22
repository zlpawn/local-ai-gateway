import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HubStore } from '../../lib/session-sync/hub-store.mjs';
import { SessionWatcherDaemon } from '../../lib/session-sync/watcher-daemon.mjs';
import { SkillInstaller } from '../../lib/session-sync/skill-installer.mjs';

test('HubStore - save and retrieve session', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-store-test-'));
  try {
    const store = new HubStore({ baseDir: tmpDir });

    const sessionData = {
      session_id: 'test_sess_123',
      source_app: 'codex',
      workspace_path: '/tmp/my-project',
      summary: 'Test summary',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' }
      ]
    };

    const saved = store.saveSession(sessionData);
    assert.equal(saved.session_id, 'test_sess_123');

    const pointer = store.getActivePointer();
    assert.ok(pointer);
    assert.equal(pointer.active_session_id, 'test_sess_123');

    const retrieved = store.getSession('test_sess_123');
    assert.ok(retrieved);
    assert.equal(retrieved.messages.length, 2);

    const foundByWorkspace = store.findSessionByWorkspace('/tmp/my-project');
    assert.ok(foundByWorkspace);
    assert.equal(foundByWorkspace.session_id, 'test_sess_123');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SessionWatcherDaemon - parser logic', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-test-'));
  try {
    const daemon = new SessionWatcherDaemon({ baseDir: tmpDir });

    // Test Antigravity JSONL parser
    const agLogFile = path.join(tmpDir, 'transcript.jsonl');
    fs.writeFileSync(agLogFile, [
      JSON.stringify({ type: 'USER_INPUT', content: 'What is the bug?' }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'It is a syntax error.' })
    ].join('\n'));

    const agResult = daemon.parseAntigravityTranscript(agLogFile);
    assert.ok(agResult);
    assert.equal(agResult.source_app, 'antigravity');
    assert.equal(agResult.messages.length, 2);
    assert.equal(agResult.messages[0].content, 'What is the bug?');

    // Test Codex JSON parser
    const codexLogFile = path.join(tmpDir, 'codex_sess.json');
    fs.writeFileSync(codexLogFile, JSON.stringify({
      workspace_path: '/projects/demo',
      messages: [
        { role: 'user', content: 'Fix test' },
        { role: 'assistant', content: 'Done fixing' }
      ]
    }));

    const codexResult = daemon.parseCodexSession(codexLogFile);
    assert.ok(codexResult);
    assert.equal(codexResult.source_app, 'codex');
    assert.equal(codexResult.workspace_path, '/projects/demo');
    assert.equal(codexResult.messages.length, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SkillInstaller - install skill file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
  try {
    assert.equal(SkillInstaller.isInstalled(tmpDir), false);

    const installedFile = SkillInstaller.install(tmpDir);
    assert.ok(fs.existsSync(installedFile));
    assert.equal(SkillInstaller.isInstalled(tmpDir), true);

    const content = fs.readFileSync(installedFile, 'utf-8');
    assert.ok(content.includes('name: session-sync'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
