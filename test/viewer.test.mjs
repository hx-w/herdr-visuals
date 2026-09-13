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
  const child = spawn('python3', [path.join(root, 'test/pty-runner.py'), process.execPath, path.join(root, 'src/viewer.mjs'), '--file', path.join(root, 'examples/geometry.md')], {
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
    keys('fff'); // all -> Mermaid -> math -> empty image filter
    await until(() => calls.at(-1)?.method === 'pane.graphics.clear', 'clear old image on empty scope');
    assert.match(output, /0 items/);
    keys('f'); await until(() => sets().length >= 2, 'restore all');
    // Select a different item and export in the same PTY input burst, before redraw.
    keys(']e');
    const exported = path.join(dir, 'herdr-visuals');
    await until(async () => (await fs.readdir(exported).catch(() => [])).some(n => n.endsWith('.png')), 'export');
    const names = await fs.readdir(exported);
    const md = await fs.readFile(path.join(exported, names.find(n => n.endsWith('.md'))), 'utf8');
    assert.match(md, /E\(u\)/);
    const oracle = new Renderer();
    try {
      const source = await fs.readFile(path.join(root, 'examples/geometry.md'), 'utf8');
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
  let currentId = ids[0]; const calls = [];
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
      socket.end(JSON.stringify({ id: call.id, result }) + '\n');
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
    keys('p'); await until(() => output.includes('PINNED'), 'pin');
    output = ''; currentId = ids[1];
    await until(() => output.includes('Session 2'), 'new session in same pane');
    assert.match(output, /1 items/); assert.doesNotMatch(output, /Session 1|PINNED/);
    keys('/Session 1\r'); await until(() => output.includes('0 items'), 'search cannot see previous session');
    output = ''; currentId = '019f47ac-0000-7000-8000-000000000003';
    await until(() => output.includes('transcript unavailable'), 'missing transcript fails closed');
    assert.doesNotMatch(output, /Session 1|Session 2/);
    assert.ok(calls.filter(c => c.method === 'pane.get').every(c => c.params.pane_id === 'source'));
    assert.equal(calls.some(c => ['pane.read', 'pane.current', 'pane.list', 'agent.list', 'session.snapshot'].includes(c.method)), false);
    keys('q'); await until(() => child.exitCode !== null, 'scoped viewer exit'); assert.equal(child.exitCode, 0);
  } finally { child.kill('SIGTERM'); server.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
