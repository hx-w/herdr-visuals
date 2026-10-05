import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRollout } from '../src/sources/codex/rollout.mjs';
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

test('completed image-generation records retain saved files and deduplicate their tool output', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-generated-'));
  const file = path.join(dir, 'generated sample.png');
  try {
    await fs.writeFile(file, Buffer.from(png.split(',')[1], 'base64'));
    const event = payload => JSON.stringify({ type: 'event_msg', payload });
    const generated = { call_id: 'generated-call', status: 'completed', result: png.split(',')[1], saved_path: file };
    const transcript = [
      event({ type: 'image_generation_end', ...generated }),
      row({ type: 'image_generation_call', id: generated.call_id, ...generated }),
      result('function_call_output', [{ type: 'input_image', image_url: png }], generated.call_id),
      event({ type: 'image_generation_end', call_id: 'saved-only', status: 'completed', saved_path: file }),
      event({ type: 'item_completed', item: { type: 'Extension', kind: 'image_gen.generation', id: 'nested-generation',
        status: 'completed', result: png.split(',')[1], savedPath: file + '.png' } }),
      result('custom_tool_call_output', [{ type: 'input_image', image_url: png },
        { type: 'input_text', text: `Generated images are saved as ${file}.png by default.` }], 'outer-exec'),
    ].join('\n');
    const messages = parseRollout(transcript);
    const blocks = messages.flatMap(m => m.blocks);
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].imageData, png);
    assert.equal(blocks[1].source, file);
    const renderer = new Renderer();
    try {
      const frame = await renderer.render(blocks[1], { width: 400, height: 240 });
      assert.equal(frame.error, '');
      assert.equal(await renderer.page.locator('#content img').evaluate(el => el.naturalWidth), 1);
      assert.ok(frame.png.length > 100);
    } finally { await renderer.close(); }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('generation adapters ignore prompts, unfinished events, remote paths and arbitrary saved-to text', () => {
  const event = payload => JSON.stringify({ type: 'event_msg', payload });
  const messages = parseRollout([
    event({ type: 'image_generation_end', status: 'failed', result: png.split(',')[1], saved_path: '/tmp/rejected.png' }),
    event({ type: 'image_generation_end', status: 'in_progress', saved_path: '/tmp/rejected.png' }),
    event({ type: 'image_generation_end', status: 'completed', saved_path: 'https://example.com/rejected.png' }),
    event({ type: 'image_generation_end', status: 'completed', saved_path: 'relative.png' }),
    event({ type: 'image_generation_end', status: 'completed', saved_path: '/tmp/rejected.txt', revised_prompt: png }),
    result('custom_tool_call_output', 'Saved to: file:///tmp/unrelated.png'),
    row({ type: 'image_generation_call', id: 'native-generation', status: 'completed', result: png.split(',')[1] }),
  ].join('\n'));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].blocks[0].imageData, png);
  assert.doesNotMatch(messages[0].text, /rejected|unrelated/);
});

test('appended pixels replace a generation file fallback and refresh the selected item', () => {
  const saved = JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: {
    type: 'Extension', kind: 'image_gen.generation', id: 'generated', status: 'completed', savedPath: 'file:///tmp/sample.png',
  } } });
  const initial = parseRollout(saved);
  const updated = parseRollout(saved + '\n' + result('function_call_output', [{ type: 'input_image', image_url: png }], 'generated'));
  assert.equal(initial[0].blocks[0].source, '/tmp/sample.png');
  assert.equal(updated.length, 1);
  assert.notEqual(initial[0].id, updated[0].id);
  assert.equal(updated[0].blocks[0].messageId, updated[0].id);
  const model = new PreviewModel(); model.update(initial);
  assert.equal(model.update(updated), true);
  assert.equal(model.current.imageData, png);
});

test('later saved-path metadata deduplicates a code-mode mirror of an earlier native generation', () => {
  const messages = parseRollout([
    row({ type: 'image_generation_call', id: 'generated', status: 'completed', result: png.split(',')[1] }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'image_generation_end', call_id: 'generated',
      status: 'completed', saved_path: '/tmp/sample.png' } }),
    result('custom_tool_call_output', [{ type: 'input_image', image_url: png },
      { type: 'input_text', text: 'Generated images are saved as /tmp/sample.png by default.' }], 'outer-exec'),
  ].join('\n'));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].blocks[0].source, '/tmp/sample.png');
  assert.equal(messages[0].blocks[0].imageData, png);
});

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
        : {};
      socket.end(JSON.stringify({ id: call.id, result: value }) + '\n');
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  const child = spawn('python3', [path.join(root, 'test/pty-runner.py'), process.execPath, path.join(root, 'src/viewer.mjs')], {
    env: { ...process.env, HERDR_ENV: '1', HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: 'viewer', HERDR_VISUALS_SOURCE: 'source',
      HERDR_VISUALS_CODEX_HOME: dir, HERDR_VISUALS_RECORD: '' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '', graphicsOutput = ''; child.stdout.on('data', data => { output += data; graphicsOutput += data; }); child.stderr.on('data', data => { output += data; });
  const keys = keys => child.stdin.write(JSON.stringify({ keys }) + '\n');
  const until = async predicate => {
    const end = Date.now() + 15000;
    while (!predicate()) { if (Date.now() > end) throw new Error(`Viewer timeout: ${output.slice(-1000)}`); await delay(30); }
  };
  try {
    await until(() => output.includes('\x1b_Ga=T,'));
    assert.match(output, /2 items/);
    keys('l'); await until(() => output.includes('IMAGE  Image 1') && output.includes('IMAGE  Image 2'));
    keys('\r'); keys('g'); await until(() => output.includes('Image context') && output.includes('Embedded image displayed in this conversation'));
    assert.match(output, /Embedded image displayed in this conversation/);
    assert.doesNotMatch(output, /PRIVATE LOG|base64/);
    const frames = [...graphicsOutput.matchAll(/\x1b_Ga=T,/g)].length;
    keys('\x1b'); await until(() => [...graphicsOutput.matchAll(/\x1b_Ga=T,/g)].length > frames);
    keys('p'); await until(() => output.includes('PINNED'));
    const clearSequence = '\x1b_Ga=d,d=I,i=1,q=2\x1b\\';
    output = ''; session = '019f47ac-0000-7000-8000-000000000002';
    await until(() => output.includes('transcript unavailable') && output.includes(clearSequence));
    assert.match(output, /0 items/); assert.doesNotMatch(output, /PINNED|Image context/);
    assert.ok(calls.every(c => c.method === 'pane.get'));
    keys('q'); await until(() => child.exitCode !== null); assert.equal(child.exitCode, 0);
  } finally { child.kill('SIGTERM'); server.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
