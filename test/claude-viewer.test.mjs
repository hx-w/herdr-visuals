import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
async function until(predicate, describe, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await delay(50); }
  throw new Error(`Timed out: ${describe}`);
}
function session(sessionId, title, cwd) {
  const row = (type, uuid, parentUuid, content, apiId = uuid) => ({ type, uuid, parentUuid, sessionId,
    isSidechain: false, cwd, timestamp: '2026-01-02T03:04:05.000Z',
    message: { role: type, id: apiId, content, stop_reason: null } });
  return [
    row('user', 'prompt', null, [{ type: 'text', text: 'PROMPT_ONLY $$private=1$$' }]),
    row('assistant', 'commentary', 'prompt', [{ type: 'text', text: 'TOOL_COMMENTARY $$private=2$$' }], 'tool-api'),
    row('assistant', 'call', 'commentary', [{ type: 'tool_use', id: 'image-call', name: 'fictional_image', input: {} }], 'tool-api'),
    row('user', 'result', 'call', [{ type: 'tool_result', tool_use_id: 'image-call', content: [
      { type: 'text', text: 'TOOL_LOG $$private=3$$' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pixel } },
    ] }]),
    row('assistant', 'answer', 'result', [{ type: 'text',
      text: `## ${title}\n\n\`\`\`mermaid\nflowchart LR\n  A[${title}] --> B[Gate]\n\`\`\`\n\n$$x^2 + y^2 = 1$$\n` }]),
    { ...row('assistant', 'side', 'prompt', [{ type: 'text', text: 'SIDECHAIN_ONLY $$private=4$$' }]), isSidechain: true },
  ].map(row => JSON.stringify(row)).join('\n') + '\n';
}
function kittyFrames(output) {
  const frames = [];
  let data = null;
  for (const match of output.matchAll(/\x1b_G([^;\x1b]+);([A-Za-z0-9+/=]*)\x1b\\/g)) {
    const [, control, payload] = match;
    if (control.startsWith('a=T,')) { assert.match(control, /(?:^|,)f=100(?:,|$)/); data = ''; }
    if (data === null || !/(?:^|,)m=[01](?:,|$)/.test(control)) continue;
    data += payload;
    if (/(?:^|,)m=0(?:,|$)/.test(control)) { frames.push(Buffer.from(data, 'base64')); data = null; }
  }
  return frames;
}
function assertPNG(png) {
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(png.subarray(12, 16).toString(), 'IHDR');
  assert.ok(png.readUInt32BE(16) > 100);
  assert.ok(png.readUInt32BE(20) > 100);
  assert.equal(png.subarray(-8, -4).toString(), 'IEND');
}

test('real PTY renders exact Claude visuals and clears pinned identity on replacement and missing file', { timeout: 180000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-claude-viewer-'));
  const file = path.join(dir, 'exact.jsonl'), socketPath = path.join(dir, 'herdr.sock');
  const calls = [], sockets = new Set();
  let child;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    socket.setEncoding('utf8'); socket.on('error', () => {});
    let buffer = '';
    socket.on('data', data => {
      buffer += data;
      if (!buffer.includes('\n')) return;
      const call = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))); calls.push(call);
      if (call.method !== 'pane.get' || call.params?.pane_id !== 'source') {
        socket.end(JSON.stringify({ id: call.id, error: { message: 'Only exact pane.get is permitted' } }) + '\n'); return;
      }
      socket.end(JSON.stringify({ id: call.id, result: { pane: {
        pane_id: 'source', terminal_id: 'fictional-terminal', agent: 'claude', cwd: dir,
        label: 'Fictional source', agent_session: { agent: 'claude', kind: 'path', value: file },
      } } }) + '\n');
    });
  });
  try {
    await fs.writeFile(file, session('11111111-2222-4333-8444-555555555555', 'Orchard', dir));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    child = spawn('python3', [path.join(root, 'test/pty-runner.py'), process.execPath, path.join(root, 'src/viewer.mjs')], {
      env: { ...process.env, HERDR_ENV: '1', HERDR_PANE_ID: 'viewer', HERDR_SOCKET_PATH: socketPath,
        HERDR_VISUALS_RECORD: '', HERDR_VISUALS_SOURCE: 'source', HERDR_VISUALS_CODEX_HOME: dir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', graphics = '', transcript = '', launchError;
    child.once('error', error => { launchError = error; });
    child.stdout.on('data', data => { output += data; graphics += data; transcript += data; });
    child.stderr.on('data', data => { output += data; transcript += data; });
    const keys = value => child.stdin.write(JSON.stringify({ keys: value }) + '\n');
    const wait = (predicate, describe) => until(() => {
      if (launchError) throw launchError;
      assert.equal(child.exitCode, null, `viewer exited before ${describe}: ${output}`);
      return predicate();
    }, describe);
    const frames = () => kittyFrames(graphics);
    await wait(() => output.includes('Claude Code transcript') && output.includes('3 items') && output.includes('LIVE'), 'Claude transcript preview');
    const rendered = [];
    for (const type of ['mermaid', 'math', 'image']) {
      const before = frames().length;
      output = ''; keys('f');
      await wait(() => output.includes(`· ${type} · 1 items`) && frames().length > before, `Claude ${type} Kitty rendering`);
      const png = frames().at(-1); assertPNG(png); rendered.push(png);
    }
    assert.notDeepEqual(rendered[0], rendered[1]);
    assert.notDeepEqual(rendered[1], rendered[2]);
    output = ''; keys('f');
    await wait(() => output.includes('· all · 3 items'), 'restore all visuals');
    output = ''; keys('/Orchard\r');
    await wait(() => output.includes('search: Orchard') && output.includes('2 items'), 'search final assistant output');
    output = ''; keys('pg');
    await wait(() => output.includes('PINNED') && output.includes('Answer context') && output.includes('flowchart LR'), 'pin searched answer');
    output = '';
    const before = frames().length;
    await fs.writeFile(file, session('66666666-7777-4888-8999-aaaaaaaaaaaa', 'Harbor', dir));
    await wait(() => output.includes('Harbor') && output.includes('LIVE') && output.includes('3 items') && frames().length > before,
      'real JSONL identity replacement resets pinned answer and search');
    assert.doesNotMatch(output.split('\x1b[1;1H').at(-1), /Orchard|PINNED|Answer context|search: Orchard/);
    output = ''; keys('p');
    await wait(() => output.includes('PINNED'), 'pin replacement');
    output = ''; await fs.unlink(file);
    await wait(() => output.includes('transcript unavailable') && output.includes('0 items') &&
      output.includes('LIVE') && output.includes('\x1b_Ga=d,d=I,i=1,q=2\x1b\\'), 'missing bound file clears visuals and Kitty graphics');
    assert.doesNotMatch(output.split('\x1b[1;1H').at(-1), /Harbor|Orchard|PINNED|Answer context/);
    assert.doesNotMatch(transcript, /PROMPT_ONLY|TOOL_COMMENTARY|TOOL_LOG|SIDECHAIN_ONLY|Render error|Could not render|Invalid embedded image/);
    assert.ok(calls.every(call => call.method === 'pane.get' && call.params?.pane_id === 'source'), 'no pane reads or discovery');
    keys('q'); await until(() => child.exitCode !== null, 'viewer exits'); assert.equal(child.exitCode, 0);
  } finally {
    try {
      if (child && child.exitCode === null) {
        child.kill('SIGTERM'); await until(() => child.exitCode !== null || child.signalCode !== null, 'PTY cleanup', 25000);
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});
