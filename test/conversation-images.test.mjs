import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRollout } from '../src/source.mjs';
import { Renderer } from '../src/render.mjs';
import { PreviewModel } from '../src/model.mjs';
import { answerContext } from '../src/navigation.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Fictional, self-contained PNG; no original file is needed to preview it.
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
const row = payload => JSON.stringify({ type: 'response_item', timestamp: '2026-09-15T00:00:00Z', payload });
const result = (type, output, call_id = 'image-call') => row({ type, call_id, output });

test('actual images in tool results become image items without a final answer or local file', async () => {
  const transcript = [
    row({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect the pictures.' }] }),
    row({ type: 'custom_tool_call', name: 'exec', call_id: 'image-call', input: 'const file = unknown; image(await getImage(file));' }),
    result('custom_tool_call_output', [{ type: 'input_text', text: 'PRIVATE LOG /tmp/unrelated.png' },
      { type: 'input_image', image_url: png }, { type: 'input_image', image_url: png }]),
  ].join('\n');
  const messages = parseRollout(transcript), blocks = messages.flatMap(m => m.blocks);
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every(b => b.type === 'image' && b.imageData === png));
  assert.notEqual(blocks[0].id, blocks[1].id);
  assert.ok(messages.every(m => m.turn === 1));
  assert.ok(messages.every(m => !m.text.includes('PRIVATE LOG') && !m.text.includes('base64')));
  const context = answerContext(messages, blocks[1]);
  assert.equal(context.kind, 'image');
  assert.match(context.lines.join('\n'), /embedded/i);
  const model = new PreviewModel(); model.update(messages); model.filter = 'image';
  assert.equal(model.items.length, 2);
  model.history = false;
  assert.equal(model.items.length, 2, 'latest turn includes every image in the tool result');
  model.update(parseRollout(transcript + '\n' + row({ type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: 'Both pictures look correct.' }] })));
  assert.equal(model.items.length, 2, 'a final answer without links retains the images from its turn');
  model.pin(); model.resetSource(); assert.equal(model.items.length, 0); assert.equal(model.pinned, null);
  const renderer = new Renderer();
  try {
    const frame = await renderer.render(blocks[0], { width: 400, height: 240 });
    assert.equal(frame.error, '');
    assert.equal(await renderer.page.locator('#content img').evaluate(el => el.naturalWidth), 1);
    assert.ok((await renderer.exportPNG()).length > 100);
  } finally { await renderer.close(); }
});

test('structured image outputs are supported while tool text, remote URLs and malformed data are ignored', () => {
  const outputs = [
    result('function_call_output', [{ type: 'input_image', image_url: { url: png } }], 'direct'),
    result('custom_tool_call_output', JSON.stringify({ content: [{ type: 'image', mimeType: 'image/png', data: png.split(',')[1] }] }), 'mcp'),
    result('function_call_output', [{ type: 'input_text', text: '[Secret](/tmp/secret.png)' },
      { type: 'input_image', image_url: 'https://example.com/private.png' },
      { type: 'input_image', image_url: 'file:///tmp/secret.png' },
      { type: 'input_image', image_url: 'data:text/html;base64,PHNjcmlwdD4=' },
      { type: 'input_image', image_url: 'data:image/png;base64,not valid' }], 'ignored'),
    row({ type: 'function_call', name: 'view_image', arguments: '{"path":"/tmp/not-executed.png"}' }),
    result('function_call_output', 'Unable to open /tmp/missing.png', 'failed'),
  ];
  assert.equal(parseRollout(outputs.join('\n')).flatMap(m => m.blocks).length, 2);
  assert.equal(parseRollout(outputs.slice(2).join('\n')).length, 0);
});

test('real viewer lists embedded images, opens image context and clears them on a session change', { timeout: 30000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-images-'));
  const root = fileURLToPath(new URL('..', import.meta.url));
  await fs.mkdir(path.join(dir, 'sessions'));
  let session = '019f47ac-0000-7000-8000-000000000001';
  await fs.writeFile(path.join(dir, 'sessions', `rollout-${session}.jsonl`), result('custom_tool_call_output', [
    { type: 'input_text', text: 'PRIVATE LOG' }, { type: 'input_image', image_url: png }, { type: 'input_image', image_url: png },
  ]) + '\n');
  const calls = [], socketPath = path.join(dir, 'api.sock');
  const server = net.createServer(socket => {
    let buffer = ''; socket.setEncoding('utf8'); socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk; if (!buffer.includes('\n')) return;
      const call = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))); calls.push(call);
      const value = call.method === 'pane.get' ? { pane: { pane_id: 'source', terminal_id: 'terminal', label: 'Preview source',
        agent_session: { agent: 'codex', kind: 'id', value: session } } }
        : call.method === 'pane.graphics.info' ? { cell_width_px: 20, cell_height_px: 40, pane_visible: true } : {};
      socket.end(JSON.stringify({ id: call.id, result: value }) + '\n');
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  const child = spawn('python3', [path.join(root, 'test/pty-runner.py'), process.execPath, path.join(root, 'src/viewer.mjs')], {
    env: { ...process.env, HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: 'viewer', HERDR_VISUALS_SOURCE: 'source',
      HERDR_VISUALS_CODEX_HOME: dir, HERDR_VISUALS_RECORD: '' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const keys = keys => child.stdin.write(JSON.stringify({ keys }) + '\n');
  const until = async predicate => {
    const end = Date.now() + 15000;
    while (!predicate()) { if (Date.now() > end) throw new Error(`Viewer timeout: ${output.slice(-1000)}`); await delay(30); }
  };
  try {
    await until(() => calls.some(c => c.method === 'pane.graphics.set'));
    assert.match(output, /2 items/);
    keys('l'); await until(() => output.includes('IMAGE  Image 1') && output.includes('IMAGE  Image 2'));
    keys('\r'); keys('g'); await until(() => output.includes('Image context'));
    assert.match(output, /Embedded image displayed in this conversation/);
    assert.doesNotMatch(output, /PRIVATE LOG|base64/);
    const frames = calls.filter(c => c.method === 'pane.graphics.set').length;
    keys('\x1b'); await until(() => calls.filter(c => c.method === 'pane.graphics.set').length > frames);
    keys('p'); await until(() => output.includes('PINNED'));
    const clears = calls.filter(c => c.method === 'pane.graphics.clear').length;
    output = ''; session = '019f47ac-0000-7000-8000-000000000002';
    await until(() => output.includes('transcript unavailable') && calls.filter(c => c.method === 'pane.graphics.clear').length > clears);
    assert.match(output, /0 items/); assert.doesNotMatch(output, /PINNED|Image context/);
    assert.ok(calls.every(c => ['pane.get', 'pane.graphics.info', 'pane.graphics.set', 'pane.graphics.clear'].includes(c.method)));
    keys('q'); await until(() => child.exitCode !== null); assert.equal(child.exitCode, 0);
  } finally { child.kill('SIGTERM'); server.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
