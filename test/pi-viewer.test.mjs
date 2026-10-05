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
// Fictional, embedded red pixel: the viewer must not need an image file.
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
const clearImage = '\x1b_Ga=d,d=I,i=1,q=2\x1b\\';

async function until(predicate, describe, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${describe}`);
}

function session(id, title, cwd) {
  const timestamp = '2026-01-02T03:04:05.000Z';
  const message = (entryId, parentId, value) => ({ type: 'message', id: entryId, parentId, timestamp, message: value });
  return [
    { type: 'session', version: 3, id, cwd },
    message('user', null, { role: 'user', content: [{ type: 'text', text: 'Show a fictional route and equation.' }] }),
    message('call', 'user', { role: 'assistant', stopReason: 'toolUse', content: [
      { type: 'toolCall', id: 'image-call', name: 'fictional_image', arguments: {} },
    ] }),
    message('image', 'call', { role: 'toolResult', toolCallId: 'image-call', toolName: 'fictional_image', isError: false,
      content: [{ type: 'image', mimeType: 'image/png', data: pixel }] }),
    message('answer', 'image', { role: 'assistant', stopReason: 'stop', content: [{ type: 'text',
      text: `## ${title}\n\n\`\`\`mermaid\nflowchart LR\n  A[${title}] --> B[Gate]\n\`\`\`\n\n$$x^2 + y^2 = 1$$\n` }] }),
  ].map(row => JSON.stringify(row)).join('\n') + '\n';
}

// Decode complete Kitty transmissions, including multi-chunk PNGs. Counting
// escape prefixes alone would accept incomplete graphics or non-image output.
function kittyFrames(output) {
  const frames = [];
  let data = null;
  for (const match of output.matchAll(/\x1b_G([^;\x1b]+);([A-Za-z0-9+/=]*)\x1b\\/g)) {
    const [, control, payload] = match;
    if (control.startsWith('a=T,')) {
      assert.match(control, /(?:^|,)f=100(?:,|$)/);
      data = '';
    }
    if (data === null || !/(?:^|,)m=[01](?:,|$)/.test(control)) continue;
    data += payload;
    if (/(?:^|,)m=0(?:,|$)/.test(control)) {
      frames.push(Buffer.from(data, 'base64'));
      data = null;
    }
  }
  return frames;
}

function assertPNG(png) {
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(png.subarray(12, 16).toString(), 'IHDR');
  assert.ok(png.readUInt32BE(16) > 100, 'Kitty receives a rendered viewport, not the original one-pixel fixture');
  assert.ok(png.readUInt32BE(20) > 100);
  assert.equal(png.subarray(-8, -4).toString(), 'IEND');
}

test('real PTY renders exact omp/pi sessions and drops stale state on rebinding, replacement and removal', { timeout: 180000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-pi-viewer-'));
  const files = { omp: path.join(dir, 'explicit-omp.jsonl'), pi: path.join(dir, 'explicit-pi.jsonl') };
  const socketPath = path.join(dir, 'herdr.sock');
  const calls = [], sockets = new Set();
  let binding = { agent: 'omp', kind: 'path', value: files.omp }, child;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', data => {
      buffer += data;
      if (!buffer.includes('\n')) return;
      const call = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
      calls.push(call);
      if (call.method !== 'pane.get' || call.params?.pane_id !== 'source') {
        socket.end(JSON.stringify({ id: call.id, error: { message: 'Only explicitly scoped pane.get is allowed' } }) + '\n');
        return;
      }
      socket.end(JSON.stringify({ id: call.id, result: { pane: {
        pane_id: 'source', terminal_id: 'fictional-terminal', agent: binding.agent, cwd: dir,
        label: 'Fictional source', agent_session: { ...binding },
      } } }) + '\n');
    });
  });
  try {
    await fs.writeFile(files.omp, session('omp-orchard', 'Orchard', dir));
    await fs.writeFile(files.pi, session('pi-meadow', 'Meadow', dir));
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
    }, describe).catch(error => {
      const screen = output.replace(/\x1b_G[^;\x1b]+;[A-Za-z0-9+/=]*\x1b\\/g, '<Kitty image chunk>');
      error.message += `\nTerminal output:\n${screen}`;
      throw error;
    });
    const frames = () => kittyFrames(graphics);

    for (const agent of ['omp', 'pi']) {
      if (agent === 'pi') {
        output = '';
        binding = { agent, kind: 'path', value: files.pi };
      }
      await wait(() => output.includes(`${agent} transcript`) && output.includes('3 items') && output.includes('LIVE'), `${agent} session preview`);
      if (agent === 'pi') assert.doesNotMatch(output.split('\x1b[1;1H').at(-1), /Orchard|PINNED|Answer context|search: Orchard/);

      const rendered = [];
      for (const type of ['mermaid', 'math', 'image']) {
        const before = frames().length;
        output = ''; keys('f');
        await wait(() => output.includes(`· ${type} · 1 items`) && frames().length > before, `${agent} ${type} Kitty rendering`);
        const png = frames().at(-1);
        assertPNG(png);
        rendered.push(png);
      }
      assert.notDeepEqual(rendered[0], rendered[1], 'diagram and math produce distinct rendered pixels');
      assert.notDeepEqual(rendered[1], rendered[2], 'typed embedded image is rendered, not the preceding equation');
      output = ''; keys('f');
      await wait(() => output.includes('· all · 3 items'), 'restore the complete session');

      if (agent === 'omp') {
        output = ''; keys('/Orchard\r');
        await wait(() => output.includes('search: Orchard') && output.includes('2 items'), 'search only the matching answer visuals');
        output = ''; keys('pg');
        await wait(() => output.includes('PINNED') && output.includes('Answer context') && output.includes('flowchart LR'), 'pin and open searched omp answer');
      }
    }

    // The path binding and pane remain unchanged; only the persisted header
    // identifies a new session. A pin must not hide the replacement transcript.
    output = ''; keys('/Meadow\r');
    await wait(() => output.includes('search: Meadow') && output.includes('2 items'), 'search pi answer');
    output = ''; keys('pg');
    await wait(() => output.includes('PINNED') && output.includes('Answer context'), 'pin pi before same-path replacement');
    output = '';
    const beforeReplacement = frames().length;
    await fs.writeFile(files.pi, session('pi-harbor-replacement', 'Harbor', dir));
    await wait(() => output.includes('Harbor') && output.includes('LIVE') && output.includes('3 items') && frames().length > beforeReplacement,
      'same-path header identity resets the pinned session');
    assert.doesNotMatch(output.split('\x1b[1;1H').at(-1), /Meadow|Orchard|PINNED|Answer context|search: Meadow/);
    assertPNG(frames().at(-1));

    output = ''; keys('p');
    await wait(() => output.includes('PINNED'), 'pin replacement before removing its file');
    output = '';
    await fs.unlink(files.pi);
    await wait(() => output.includes('transcript unavailable') && output.includes('0 items') &&
      output.includes('LIVE') && output.includes(clearImage), 'missing exact file clears cached records, pin and Kitty graphics');
    assert.doesNotMatch(output.split('\x1b[1;1H').at(-1), /Harbor|Meadow|Orchard|PINNED|Answer context/);
    assert.doesNotMatch(transcript, /Render error|Could not render|Invalid embedded image/);
    assert.ok(calls.every(call => call.method === 'pane.get' && call.params?.pane_id === 'source'),
      'no focus, pane.read, selection, session listing or unscoped discovery requests');

    keys('q');
    await until(() => child.exitCode !== null, 'viewer exits cleanly');
    assert.equal(child.exitCode, 0);
  } finally {
    try {
      if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        await until(() => child.exitCode !== null || child.signalCode !== null, 'PTY cleanup', 25000);
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});
