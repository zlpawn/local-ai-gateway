import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HubStore } from '../../lib/session-sync/hub-store.mjs';
import { SessionWatcherDaemon } from '../../lib/session-sync/watcher-daemon.mjs';
import { SkillInstaller } from '../../lib/session-sync/skill-installer.mjs';
import { interactiveSetup } from '../../lib/cli/init-config.mjs';

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

test('SessionWatcherDaemon - scanExistingSessions on startup', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-existing-test-'));
  const codexDir = path.join(tmpDir, 'codex');
  const agDir = path.join(tmpDir, 'brain');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(path.join(agDir, 'conv1', '.system_generated', 'logs'), { recursive: true });

  // Existing Codex session prior to gateway startup
  fs.writeFileSync(path.join(codexDir, 'old_sess.json'), JSON.stringify({
    workspace_path: '/old/project',
    messages: [{ role: 'user', content: 'Old question' }, { role: 'assistant', content: 'Old answer' }]
  }));

  // Existing Antigravity session prior to gateway startup
  fs.writeFileSync(path.join(agDir, 'conv1', '.system_generated', 'logs', 'transcript.jsonl'), [
    JSON.stringify({ type: 'USER_INPUT', content: 'Past question' }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'Past answer' })
  ].join('\n'));

  try {
    const hubStore = new HubStore({ baseDir: path.join(tmpDir, 'hub') });
    const daemon = new SessionWatcherDaemon({
      hubStore,
      codexDir,
      antigravityDir: agDir
    });

    daemon.start();
    // scanExistingSessions is async/background now; wait for it to finish.
    await new Promise((resolve) => setTimeout(resolve, 50));
    daemon.stop();

    const sessions = hubStore.listSessions();
    assert.equal(sessions.length, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SkillInstaller - central installation and symlinks management', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-symlink-test-'));
  try {
    const centralDir = path.join(tmpHome, '.agents', 'skills', 'session-sync');
    const centralFile = SkillInstaller.installBaseSkill(centralDir);
    assert.ok(fs.existsSync(centralFile));

    // Test symlinks update (select antigravity & codex, unselect claude)
    const results = SkillInstaller.updateSymlinks(
      { antigravity: true, claude: false, codex: true },
      tmpHome,
      centralFile
    );

    assert.equal(results.antigravity, true);
    assert.equal(results.claude, false);
    assert.equal(results.codex, true);

    const status = SkillInstaller.getSymlinkStatus(tmpHome);
    assert.equal(status.antigravity, true);
    assert.equal(status.claude, false);
    assert.equal(status.codex, true);

    const agLink = path.join(tmpHome, '.gemini', 'config', 'skills', 'session-sync', 'SKILL.md');
    assert.ok(fs.existsSync(agLink));
    assert.ok(fs.lstatSync(agLink).isSymbolicLink() || fs.lstatSync(agLink).isFile());
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('interactiveSetup - interactive mode choice', async () => {
  const pkgDir = path.resolve('.');
  const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-setup-test-'));
  try {
    const res = await interactiveSetup(pkgDir, tmpDataDir, { isTTY: true, forceChoice: true });
    assert.equal(res.enableSync, true);
    assert.ok(fs.existsSync(path.join(tmpDataDir, 'gateway.config.json')));
    const config = JSON.parse(fs.readFileSync(path.join(tmpDataDir, 'gateway.config.json'), 'utf-8'));
    assert.equal(config.sessionSync?.enabled, true);
  } finally {
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  }
});

test('HubStore - default hub path is under ~/.local-ai-gateway/hub', () => {
  const prev = process.env.LOCAL_AI_GATEWAY_HUB_DIR;
  delete process.env.LOCAL_AI_GATEWAY_HUB_DIR;
  try {
    const store = new HubStore();
    const expected = path.join(os.homedir(), '.local-ai-gateway', 'hub');
    assert.equal(store.baseDir, expected);
    assert.equal(store.sessionsDir, path.join(expected, 'sessions'));
    assert.equal(store.pointerFile, path.join(expected, 'CURRENT_ACTIVE.json'));
  } finally {
    if (prev === undefined) delete process.env.LOCAL_AI_GATEWAY_HUB_DIR;
    else process.env.LOCAL_AI_GATEWAY_HUB_DIR = prev;
  }
});

test('SessionWatcherDaemon - Claude Desktop only, skip Claude Code CLI', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-only-'));
  try {
    const daemon = new SessionWatcherDaemon({ baseDir: tmpDir });

    const desktopFile = path.join(tmpDir, 'desktop-sess.jsonl');
    fs.writeFileSync(desktopFile, [
      JSON.stringify({ type: 'user', timestamp: '2026-07-22T01:00:00.000Z', entrypoint: 'claude-desktop-3p', cwd: 'D:\\\\agent-transfer', message: { content: 'hello from desktop' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-07-22T01:00:01.000Z', entrypoint: 'claude-desktop-3p', message: { content: 'hi desktop' } }),
    ].join('\n'));

    const cliFile = path.join(tmpDir, 'cli-sess.jsonl');
    fs.writeFileSync(cliFile, [
      JSON.stringify({ type: 'user', timestamp: '2026-07-22T01:00:00.000Z', entrypoint: 'cli', cwd: 'D:\\\\agent-transfer', message: { content: 'hello from cli' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-07-22T01:00:01.000Z', entrypoint: 'cli', message: { content: 'hi cli' } }),
    ].join('\n'));

    const desktop = daemon.parseClaudeDesktopSession(desktopFile);
    const cli = daemon.parseClaudeDesktopSession(cliFile);
    assert.ok(desktop);
    assert.equal(desktop.source_app, 'claude');
    assert.equal(desktop.messages.length, 2);
    assert.equal(cli, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});