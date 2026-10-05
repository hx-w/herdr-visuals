import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { CodexHistory, historyRows } from '../src/sources/codex/history.mjs';
import { SourceReader } from '../src/sources/index.mjs';
import { parseRollout } from '../src/sources/codex/rollout.mjs';

const ids = ['019f47ac-0000-7000-8000-000000000001', '019f47ac-0000-7000-8000-000000000002'];
const answer = text => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] } });

test('paged history supersedes a stale JSONL snapshot for the exact bound ID', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-paged-'));
  try {
    await fs.mkdir(path.join(dir, 'sessions'));
    await fs.writeFile(path.join(dir, 'sessions', `rollout-${ids[0]}.jsonl`), JSON.stringify(answer('$$old$$')));
    const calls = [];
    const history = { async read(id) { calls.push(id); return { rows: [answer('$$current$$')], cwd: '/fictional', limited: false }; } };
    const reader = new SourceReader({ codexHome: dir, history });
    const pane = { agent_session: { agent: 'codex', kind: 'id', value: ids[0] } };
    assert.equal((await reader.read(pane)).messages[0].blocks[0].source, 'current');
    assert.deepEqual(calls, [ids[0]]);
    await fs.unlink(path.join(dir, 'sessions', `rollout-${ids[0]}.jsonl`));
    assert.equal((await reader.read(pane)).messages[0].blocks[0].source, 'current', 'new paginated threads need no JSONL');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a configured live footer resolves two panes sharing a cwd without using stale hooks', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-binding-'));
  try {
    await fs.writeFile(path.join(dir, 'config.toml'), '[tui]\nstatus_line = ["thread-id", "model"]\n');
    const requests = [];
    const reader = new SourceReader({ codexHome: dir, readFooter: async pane => {
      requests.push(pane.pane_id);
      return `\n ${pane.pane_id === 'one' ? ids[0] : ids[1]} · Fictional model\n ? for shortcuts\n`;
    } });
    const one = { pane_id: 'one', agent: 'codex', cwd: '/shared', terminal_id: 'one', agent_session: { agent: 'codex', kind: 'id', value: ids[1] } };
    const two = { ...one, pane_id: 'two', terminal_id: 'two', agent_session: undefined };
    assert.equal((await reader.resolvePane(one)).agent_session.value, ids[0]);
    assert.equal((await reader.resolvePane(two)).agent_session.value, ids[1]);
    assert.deepEqual(requests, ['one', 'two']);
    assert.equal((await reader.resolvePane({ ...two, agent: undefined })).agent_session, undefined);
    assert.equal((await reader.resolvePane({ ...one, agent: undefined })).agent_session, undefined, 'loss of agent identity cannot restore a stale hook');
    await fs.writeFile(path.join(dir, 'config.toml'), '[tui]\nstatus_line = ["model"]\n');
    assert.equal((await reader.resolvePane(one)).agent_session, undefined, 'disabling the footer cannot restore a stale hook');
    await fs.writeFile(path.join(dir, 'config.toml'), 'invalid TOML');
    assert.equal((await reader.resolvePane(one)).agent_session, undefined, 'invalid config cannot restore a stale hook');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('footer discovery excludes answer UUIDs, partial IDs and unconfigured footers', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-binding-'));
  try {
    let footer = `${ids[0]}\nordinary answer\n› Ask Codex\nmodel · project\n? for shortcuts\n`;
    const reader = new SourceReader({ codexHome: dir, readFooter: async () => footer });
    const pane = { pane_id: 'one', agent: 'codex', cwd: '/shared' };
    assert.equal((await reader.resolvePane(pane)).agent_session, undefined);
    await fs.writeFile(path.join(dir, 'config.toml'), '[tui]\nstatus_line = ["thread-id", "model"]\n');
    assert.equal((await reader.resolvePane(pane)).agent_session, undefined);
    footer = `\n${ids[0].slice(0, 32)} · model\n? for shortcuts\n`;
    assert.equal((await reader.resolvePane(pane)).agent_session, undefined);
    footer = `\n${ids[0]} · model\n? for shortcuts\n`;
    assert.equal((await reader.resolvePane(pane)).agent_session.value, ids[0]);
    footer = 'model · project\n? for shortcuts\n';
    assert.equal((await reader.resolvePane({ ...pane, agent_session: { agent: 'codex', kind: 'id', value: ids[0] } })).agent_session, undefined, 'missing live identity clears a stale hook');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('private socket pagination stays read-only and rejects another thread or looping cursors', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-api-'));
  await fs.mkdir(path.join(dir, 'app-server-control'));
  const server = http.createServer(), wss = new WebSocketServer({ server });
  await new Promise(resolve => server.listen(path.join(dir, 'app-server-control', 'app-server-control.sock'), resolve));
  let mode = 'normal'; const calls = [];
  wss.on('connection', socket => socket.on('message', data => {
    const request = JSON.parse(data); calls.push(request);
    if (!request.id) return;
    let result;
    if (request.method === 'initialize') result = {};
    else if (request.method === 'thread/read') result = { thread: { id: mode === 'wrong' ? ids[1] : ids[0], historyMode: 'paginated', cwd: '/fictional' } };
    else if (request.method === 'thread/items/list' && mode === 'large') result = {
      data: [{ turnId: 'turn', item: { type: 'imageGeneration', id: 'large', status: 'completed', result: 'A'.repeat(17 * 1024 * 1024) } }], nextCursor: null,
    };
    else if (request.method === 'thread/items/list') result = {
      data: [{ turnId: 'turn', item: { type: 'agentMessage', id: request.params.cursor ? 'old' : 'new', phase: 'final_answer', text: request.params.cursor ? '$$old$$' : '$$new$$' } }],
      nextCursor: !request.params.cursor || mode === 'loop' ? 'previous' : null,
    };
    else { assert.fail(`Unexpected method ${request.method}`); }
    socket.send(JSON.stringify({ id: request.id, result }));
  }));
  const history = new CodexHistory(dir);
  try {
    assert.equal(await history.read('invalid'), null);
    assert.equal(calls.length, 0);
    const result = await history.read(ids[0]);
    const messages = parseRollout(result.rows.map(JSON.stringify).join('\n'));
    assert.deepEqual(messages.map(m => m.blocks[0].source), ['old', 'new']);
    assert.equal(result.limited, false);
    assert.deepEqual(calls.map(c => c.method), ['initialize', 'initialized', 'thread/read', 'thread/items/list', 'thread/items/list']);
    assert.ok(calls.filter(c => c.params?.threadId).every(c => c.params.threadId === ids[0]));
    mode = 'wrong';
    await assert.rejects(history.read(ids[0]), /different session/);
    mode = 'loop';
    await assert.rejects(history.read(ids[0]), /did not advance/);
    mode = 'large';
    const large = await history.read(ids[0]);
    assert.equal(large.limited, true);
    assert.equal(large.rows.at(-1).payload.result.length, 17 * 1024 * 1024, 'one complete image can exceed the history budget without disconnecting');
    assert.throws(() => history.request('thread/resume', {}), /read-only/);
  } finally {
    history.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('paged typed images survive normalization while prompts, reasoning and tool text stay excluded', () => {
  const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1cAAAAASUVORK5CYII=';
  const image = `data:image/png;base64,${pixel}`;
  const entries = [
    { type: 'userMessage', content: [{ text: '$$prompt$$' }] },
    { type: 'reasoning', text: '$$reasoning$$' },
    { type: 'dynamicToolCall', status: 'completed', contentItems: [{ type: 'inputText', text: '$$log$$' }, { type: 'inputImage', imageUrl: image }] },
    { type: 'imageGeneration', status: 'completed', result: pixel },
    { type: 'imageView', path: '/fictional/viewed.png' },
    { type: 'imageView', path: 'https://example.invalid/untrusted.png' },
    { type: 'agentMessage', phase: 'commentary', text: '$$commentary$$' },
    { type: 'agentMessage', phase: 'final_answer', text: '$$final$$' },
  ].map((item, i) => ({ turnId: 'turn', startedAtMs: i, item: { id: String(i), ...item } }));
  const messages = parseRollout(historyRows(entries).map(JSON.stringify).join('\n'));
  assert.equal(messages.length, 4);
  assert.deepEqual(messages.map(m => m.blocks[0].type), ['image', 'image', 'image', 'math']);
  assert.equal(messages[0].blocks[0].imageData, image);
  assert.equal(messages[1].blocks[0].imageData, image);
  assert.equal(messages[2].blocks[0].source, '/fictional/viewed.png');
  assert.equal(messages[3].blocks[0].source, 'final');
});
