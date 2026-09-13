import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { extract } from '../src/extract.mjs';
import { Renderer } from '../src/render.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
async function until(predicate, describe, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await delay(50); }
  throw new Error(`Timed out: ${describe}`);
}
test('real PTY viewer clears empty filters, exports the selected item and tears down graphics', { timeout: 90000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-'));
  const socketPath = path.join(dir, 'herdr.sock'), calls = [];
  const server = net.createServer(socket => {
    let buffer = ''; socket.setEncoding('utf8'); socket.on('error', () => {});
    socket.on('data', data => {
      buffer += data;
      if (!buffer.includes('\n')) return;
      const call = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))); calls.push(call);
      const result = call.method === 'pane.graphics.info'
        ? { type: 'pane_graphics_info', cell_width_px: 20, cell_height_px: 40, pane_visible: true }
        : { type: call.method === 'pane.graphics.set' ? 'pane_graphics_set' : 'pane_graphics_cleared' };
      socket.end(JSON.stringify({ id: call.id, result }) + '\n');
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  const child = spawn('python3', [path.join(root, 'test/pty-runner.py'), process.execPath, path.join(root, 'src/viewer.mjs'), '--file', path.join(root, 'examples/overview.md')], {
    env: { ...process.env, HERDR_ENV: '1', HERDR_PANE_ID: 'test:viewer', HERDR_SOCKET_PATH: socketPath,
      HERDR_VISUALS_RECORD: '', HERDR_VISUALS_EXPORT_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const keys = text => child.stdin.write(JSON.stringify({ keys: text }) + '\n');
  const sets = () => calls.filter(c => c.method === 'pane.graphics.set');
  try {
    await until(() => sets().length > 0, 'first rendered frame');
    assert.match(output, /This session/);
    assert.match(output, /4 items/);
    keys('g');
    await until(() => output.includes('Answer context') && output.includes('二项式展开'), 'answer context at the selected item');
    output = ''; keys('\x1b[H');
    await until(() => output.includes('# Preview examples'), 'Home scrolls to the start of the answer');
    output = ''; keys('\x1b[F');
    await until(() => output.includes('二项式展开'), 'End scrolls to the end of the answer');
    assert.equal(calls.some(c => c.method === 'pane.focus' || c.method === 'pane.selection.read'), false);
    keys('\x1b');
    await until(() => sets().length >= 2, 'Escape returns from context without closing');
    assert.equal(child.exitCode, null);
    keys('fff'); // all -> Mermaid -> math -> empty image filter
    await until(() => calls.at(-1)?.method === 'pane.graphics.clear', 'clear old image on empty scope');
    assert.match(output, /0 items/);
    const beforeRestore = sets().length;
    keys('f'); await until(() => sets().length > beforeRestore, 'restore all');
    // Select a different item and export in the same PTY input burst, before redraw.
    keys(']e');
    const exported = path.join(dir, 'herdr-visuals');
    await until(async () => (await fs.readdir(exported).catch(() => [])).some(n => n.endsWith('.png')), 'export');
    const names = await fs.readdir(exported);
    const md = await fs.readFile(path.join(exported, names.find(n => n.endsWith('.md'))), 'utf8');
    assert.match(md, /\\bar\{x\}/);
    const oracle = new Renderer();
    try {
      const source = await fs.readFile(path.join(root, 'examples/overview.md'), 'utf8');
      await oracle.render(extract(source)[1], { width: 1000, height: 700 });
      assert.deepEqual(await fs.readFile(path.join(exported, names.find(n => n.endsWith('.png')))), await oracle.exportPNG());
    } finally { await oracle.close(); }
    const count = sets().length;
    child.stdin.write(JSON.stringify({ resize: [70, 22] }) + '\n');
    await until(() => sets().length > count, 'resize redraw');
    assert.equal(sets().at(-1).params.placement.grid_cols, 68);
    keys('q');
    await until(() => child.exitCode !== null, 'viewer exit');
    assert.equal(child.exitCode, 0);
    assert.equal(calls.at(-1).method, 'pane.graphics.clear');
  } finally {
    child.kill('SIGTERM');
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('viewer reads only its bound session and clears a pin when that pane starts a new session', { timeout: 45000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-scope-'));
  const sessions = path.join(dir, 'sessions'); await fs.mkdir(sessions);
  const ids = ['019f47ac-0000-7000-8000-000000000001', '019f47ac-0000-7000-8000-000000000002'];
  for (const [i, id] of ids.entries()) await fs.writeFile(path.join(sessions, `rollout-${id}.jsonl`), JSON.stringify({
    type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: `## Session ${i + 1}\n$$x_${i + 1}$$` }] },
  }) + '\n');
  let currentId = ids[0], getError = false, getDelay = 0; const calls = [];
  const socketPath = path.join(dir, 'herdr.sock');
  const server = net.createServer(socket => {
    let buffer = ''; socket.setEncoding('utf8'); socket.on('error', () => {});
    socket.on('data', data => {
      buffer += data; if (!buffer.includes('\n')) return;
      const call = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))); calls.push(call);
      let result = {};
      if (call.method === 'pane.get') result = { pane: { pane_id: 'source', terminal_id: 'terminal', agent: 'codex', cwd: dir,
        agent_session: { agent: 'codex', kind: 'id', value: currentId } } };
      if (call.method === 'pane.graphics.info') result = { cell_width_px: 20, cell_height_px: 40, pane_visible: true };
      // Any unscoped focus/session-list query is a regression, regardless of its result.
      const response = call.method === 'pane.get' && getError ? { id: call.id, error: { message: 'offline' } } : { id: call.id, result };
      if (call.method === 'pane.get' && getDelay) setTimeout(() => socket.end(JSON.stringify(response) + '\n'), getDelay);
      else socket.end(JSON.stringify(response) + '\n');
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  const child = spawn('python3', [path.join(root, 'test/pty-runner.py'), process.execPath, path.join(root, 'src/viewer.mjs')], {
    env: { ...process.env, HERDR_ENV: '1', HERDR_PANE_ID: 'viewer', HERDR_SOCKET_PATH: socketPath,
      HERDR_VISUALS_RECORD: '', HERDR_VISUALS_SOURCE: 'source', HERDR_VISUALS_CODEX_HOME: dir }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const keys = value => child.stdin.write(JSON.stringify({ keys: value }) + '\n');
  try {
    await until(() => output.includes('Session 1') && calls.some(c => c.method === 'pane.graphics.set'), 'first session');
    getError = true; output = ''; keys('g');
    await until(() => output.includes('Cannot verify source session'), 'lookup error fails closed');
    assert.doesNotMatch(output, /Answer context/);
    getError = false; getDelay = 500; output = ''; keys('g\x1b');
    await delay(700); assert.equal(child.exitCode, null); assert.doesNotMatch(output, /Answer context/);
    getDelay = 0;
    keys('g'); await until(() => output.includes('Answer context'), 'bound answer context fallback');
    output = '';
    keys('\x1b'); await until(() => output.includes('Codex transcript'), 'return to bound preview');
    keys('p'); await until(() => output.includes('PINNED'), 'pin');
    keys('g'); await until(() => output.includes('Answer context'), 'pinned answer context');
    await fs.appendFile(path.join(sessions, `rollout-${ids[0]}.jsonl`), JSON.stringify({
      type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer',
        content: [{ type: 'output_text', text: '## New answer\n$$z_2$$' }] },
    }) + '\n');
    await until(() => output.includes('1 new answer'), 'queue a new answer while reading context');
    output = ''; keys('p');
    await until(() => output.includes('New answer') && output.includes('LIVE'), 'unpin resumes queued answer');
    assert.doesNotMatch(output, /Answer context/);
    output = ''; keys('[pg'); await until(() => output.includes('Answer context'), 'pin earlier answer again');
    output = ''; currentId = ids[1];
    await until(() => output.includes('Session 2'), 'new session in same pane');
    assert.match(output, /1 items/); assert.doesNotMatch(output, /Session 1|PINNED|Answer context/);
    keys('/Session 1\r'); await until(() => output.includes('0 items'), 'search cannot see previous session');
    output = ''; currentId = '019f47ac-0000-7000-8000-000000000003';
    await until(() => output.includes('transcript unavailable'), 'missing transcript fails closed');
    assert.doesNotMatch(output, /Session 1|Session 2/);
    assert.ok(calls.filter(c => c.method === 'pane.get').every(c => c.params.pane_id === 'source'));
    assert.equal(calls.some(c => ['pane.read', 'pane.current', 'pane.list', 'agent.list', 'session.snapshot',
      'pane.selection.read', 'pane.copy_search', 'pane.scroll', 'pane.focus', 'pane.send_keys'].includes(c.method)), false);
    keys('q'); await until(() => child.exitCode !== null, 'scoped viewer exit'); assert.equal(child.exitCode, 0);
  } finally { child.kill('SIGTERM'); server.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
