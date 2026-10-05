import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parsePiSession, PiSessionParser } from '../src/sources/pi/format.mjs';
import { PiSource } from '../src/sources/pi/index.mjs';
import { OmpSource } from '../src/sources/omp/index.mjs';
import { TranscriptFile } from '../src/sources/files.mjs';
import { SourceReader } from '../src/sources/index.mjs';
import { paneIdentity } from '../src/navigation.mjs';

const timestamp = '2026-01-01T00:00:00.000Z';
const cwd = '/fictional/project';
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
const imageData = `data:image/png;base64,${pixel}`;
const header = (id = 'fictional-session-a', version = 3) => ({ type: 'session', version, id, cwd, timestamp });
const entry = (type, id, parentId, payload = {}) => ({ type, id, parentId, timestamp, ...payload });
const message = (id, parentId, value) => entry('message', id, parentId, { message: value });
const assistant = (text, extra = {}) => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: 1767225600000, ...extra });
const answer = (id, parentId, text, extra) => message(id, parentId, assistant(text, extra));
const user = (id, parentId) => message(id, parentId, { role: 'user', content: [{ type: 'text', text: '$$prompt$$' }], timestamp: 1767225600000 });
const session = (rows, { agent = 'pi', id, version = 3 } = {}) => [
  ...(agent === 'omp' ? [{ type: 'title', title: 'Fictional arithmetic' }] : []),
  header(id, version), ...rows,
].map(JSON.stringify).join('\n') + '\n';
const math = result => result.messages.flatMap(item => item.blocks).filter(block => block.type === 'math').map(block => block.source);
const boundPane = (agent, file) => ({ pane_id: 'fictional-pane', terminal_id: 'fictional-terminal', agent, cwd,
  agent_session: { agent, kind: 'path', value: file } });

for (const agent of ['omp', 'pi']) {
  test(`${agent} follows the persisted leaf through metadata, not an abandoned branch or compaction cutoff`, async () => {
    const rows = [
      user('u1', null),
      answer('a1', 'u1', '$$retained$$'),
      entry('model_change', 'model', 'a1', { provider: 'fictional', modelId: 'fictional-model' }),
      answer('abandoned', 'model', '$$abandoned$$'),
      entry('branch_summary', 'branch', 'model', { fromId: 'abandoned', summary: '$$branch-summary$$' }),
      user('u2', 'branch'),
      answer('a2', 'u2', '$$before-compaction$$'),
      entry('compaction', 'compact', 'a2', { summary: '$$compaction-summary$$', firstKeptEntryId: 'u2', tokensBefore: 100 }),
      entry('thinking_level_change', 'level', 'compact', { thinkingLevel: 'low' }),
      answer('a3', 'level', '$$after-compaction$$'),
      entry('session_info', 'info', 'a3', { name: 'Fictional arithmetic' }),
      entry('custom', 'custom', 'info', { customType: 'fixture', data: { text: '$$metadata$$' } }),
    ];
    const result = await parsePiSession(session(rows, { agent }));
    assert.deepEqual(math(result), ['retained', 'before-compaction', 'after-compaction']);
    assert.deepEqual(result.messages.map(item => item.turn), [1, 2, 2]);
    assert.equal(result.sessionId, 'fictional-session-a');
    assert.equal(result.limited, false);
  });

  test(`${agent} reset-to-root discards the previous tree even when the reset is the persisted leaf`, async () => {
    const rows = [user('u1', null), answer('old', 'u1', '$$old$$'),
      entry('branch_summary', 'root', null, { fromId: 'old', summary: '$$root-summary$$' })];
    assert.deepEqual((await parsePiSession(session(rows, { agent }))).messages, []);
    rows.push(entry('reset_boundary', 'reset', 'root'), user('u2', 'reset'), answer('new', 'u2', '$$new$$'));
    const result = await parsePiSession(session(rows, { agent }));
    assert.deepEqual(math(result), ['new']);
    assert.equal(result.messages[0].turn, 1);
  });
}

test('only successful final assistant text is extracted, not prompts, reasoning, commentary or tool logs', async () => {
  const rows = [
    user('user', null),
    message('thinking', 'user', { role: 'assistant', content: [{ type: 'thinking', thinking: '$$thinking$$' }], stopReason: 'stop' }),
    answer('commentary', 'thinking', '$$commentary$$', {
      content: [{ type: 'text', text: '$$commentary$$', textSignature: JSON.stringify({ v: 1, id: 'commentary', phase: 'commentary' }) }],
    }),
    answer('tool-use', 'commentary', '$$partial$$', { stopReason: 'toolUse' }),
    answer('failed', 'tool-use', '$$failed$$', { stopReason: 'error', errorMessage: 'Fictional failure' }),
    answer('aborted', 'failed', '$$aborted$$', { stopReason: 'aborted' }),
    message('tool', 'aborted', { role: 'toolResult', toolName: 'read', toolCallId: 'read-one', isError: false,
      content: [{ type: 'text', text: '$$tool-log$$' }] }),
    message('custom', 'tool', { role: 'custom', content: '$$custom-log$$', customType: 'fixture' }),
    answer('final', 'custom', '', {
      content: [{ type: 'thinking', thinking: '$$hidden$$' }, { type: 'text', text: '$$final$$',
        textSignature: JSON.stringify({ v: 1, id: 'final', phase: 'final_answer' }) }],
    }),
  ];
  const result = await parsePiSession(session(rows));
  assert.deepEqual(math(result), ['final']);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].text, '$$final$$');
});

test('nonvisual tool records do not evict answer history or lose user turn boundaries', async () => {
  const rows = [user('u1', null), answer('first', 'u1', '$$first$$')];
  let parent = 'first';
  for (let i = 0; i < 350; i++) {
    const id = `log-${i}`;
    rows.push(message(id, parent, { role: 'toolResult', isError: false,
      content: [{ type: 'text', text: '$$not-an-answer$$' }] }));
    parent = id;
  }
  rows.push(user('u2', parent), answer('last', 'u2', '$$last$$'));
  const result = await parsePiSession(session(rows));
  assert.deepEqual(math(result), ['first', 'last']);
  assert.deepEqual(result.messages.map(item => item.turn), [1, 2]);
  assert.equal(result.limited, false);
});

test('typed tool images survive while user images, tool text and failed tool output stay excluded', async () => {
  const rows = [
    message('user', null, { role: 'user', content: [{ type: 'text', text: '$$prompt$$' }, { type: 'image', mimeType: 'image/png', data: pixel }] }),
    message('tool', 'user', { role: 'toolResult', toolName: 'read', toolCallId: 'read-one', isError: false,
      content: [{ type: 'text', text: '$$tool-log$$' }, { type: 'image', mimeType: 'image/png', data: pixel }] }),
    message('failed', 'tool', { role: 'toolResult', toolName: 'read', toolCallId: 'read-two', isError: true,
      content: [{ type: 'image', mimeType: 'image/png', data: pixel }, { type: 'text', text: '$$failed-log$$' }] }),
    answer('final', 'failed', '$$final$$'),
  ];
  const result = await parsePiSession(session(rows));
  assert.deepEqual(result.messages.flatMap(item => item.blocks).map(block => block.type), ['image', 'math']);
  assert.equal(result.messages[0].blocks[0].imageData, imageData);
  assert.equal(result.messages[0].turn, 1);
  assert.doesNotMatch(result.messages.map(item => item.text).join('\n'), /tool-log|failed-log|prompt|base64/);
});

test('omp generation details and typed blob images use only the explicitly selected agent directory', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-pi-blobs-'));
  try {
    const agentDir = path.join(dir, 'explicit-agent');
    await fs.mkdir(path.join(agentDir, 'blobs'), { recursive: true });
    const bytes = Buffer.from(pixel, 'base64');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const blob = `blob:sha256:${hash}`;
    await fs.writeFile(path.join(agentDir, 'blobs', hash), bytes);
    const missingOriginal = path.join(dir, 'deleted-original.png');
    const rows = [
      user('user', null),
      message('typed', 'user', { role: 'toolResult', toolName: 'read', toolCallId: 'read-one', isError: false,
        content: [{ type: 'image', mimeType: 'image/png', data: blob }] }),
      message('generated', 'typed', { role: 'toolResult', toolName: 'generate_image', toolCallId: 'generate-one', isError: false,
        content: [{ type: 'text', text: `Generated 1 image(s): ${missingOriginal}` }],
        details: { provider: 'fictional', model: 'fictional-image-model', imageCount: 1, imagePaths: [missingOriginal],
          images: [{ mimeType: 'image/png', data: blob, size: '1x1', quality: 'high' }] } }),
      message('inline', 'generated', { role: 'toolResult', toolName: 'generate_image', toolCallId: 'generate-two', isError: false,
        content: [{ type: 'text', text: 'Generated another fictional image.' }],
        details: { images: [{ mimeType: 'image/png', data: pixel }] } }),
    ];
    const file = path.join(dir, 'outside-managed-sessions.jsonl');
    await fs.writeFile(file, session(rows, { agent: 'omp' }));
    const pane = boundPane('omp', file);
    const source = new OmpSource({ ompHome: agentDir });
    const resolved = await source.resolvePane(pane);
    assert.equal(resolved.source_session, 'fictional-session-a');
    const result = await source.read(resolved);
    const blocks = result.messages.flatMap(item => item.blocks);
    assert.equal(result.origin, 'omp transcript');
    assert.equal(result.issue, null);
    assert.equal(blocks.length, 3);
    assert.ok(blocks.every(block => block.type === 'image' && block.imageData === imageData));
    assert.equal(new Set(blocks.map(block => block.id)).size, 3, 'separate image events remain independently selectable');
    assert.doesNotMatch(result.messages.map(item => item.text).join('\n'), /deleted-original|blob:|base64/);
    await assert.rejects(fs.access(missingOriginal), { code: 'ENOENT' });
    const wrongAgentDir = path.join(dir, 'empty-agent');
    const wrongRoot = await new OmpSource({ ompHome: wrongAgentDir }).read(pane);
    const wrongBlocks = wrongRoot.messages.flatMap(item => item.blocks);
    assert.deepEqual(wrongBlocks.filter(block => block.imageData).map(block => block.imageData), [imageData],
      'missing blobs are not resolved through another agent directory or original image paths');
    assert.equal(wrongBlocks.filter(block => !block.imageData).length, 2);
    assert.ok(wrongBlocks.filter(block => !block.imageData).every(block => block.source === path.join(wrongAgentDir, 'blobs', hash)));
    const pi = new PiSource();
    const piPane = boundPane('pi', file);
    assert.deepEqual((await pi.read(await pi.resolvePane(piPane))).messages, [],
      'pi must not read omp blobs or generate_image detail payloads');
    assert.deepEqual((await parsePiSession(session(rows))).messages, [],
      'the common parser has no implicit omp behavior');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('TranscriptFile refreshes appended content and same-size replacements without stale cached answers', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-pi-cache-'));
  try {
    const file = path.join(dir, 'exact.jsonl');
    const reader = new TranscriptFile(PiSessionParser);
    await fs.writeFile(file, session([answer('one', null, '$$first$$')]));
    const first = await reader.read(file);
    assert.deepEqual(math(first), ['first']);
    await fs.appendFile(file, JSON.stringify(answer('two', 'one', '$$appended$$')) + '\n');
    const appended = await reader.read(file);
    assert.deepEqual(math(appended), ['first', 'appended']);
    const replacement = session([answer('one', null, '$$other$$')], { id: 'fictional-session-b' });
    await fs.writeFile(file, replacement);
    await fs.utimes(file, new Date('2026-01-02T00:00:00Z'), new Date('2026-01-02T00:00:00Z'));
    const replaced = await reader.read(file);
    assert.equal(replaced.size, first.size, 'fixture exercises same-size replacement');
    assert.equal(replaced.sessionId, 'fictional-session-b');
    assert.deepEqual(math(replaced), ['other']);
    await fs.unlink(file);
    await assert.rejects(reader.read(file), { code: 'ENOENT' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

for (const agent of ['omp', 'pi']) {
  test(`${agent} exact file bindings refresh path and header identity and fail closed without stale answers`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-pi-bound-'));
    const reader = new SourceReader({ ompHome: dir, codexHome: dir, history: { async read() { assert.fail('No Codex history lookup for omp/pi'); } } });
    try {
      const firstFile = path.join(dir, 'first.jsonl'), secondFile = path.join(dir, 'second.jsonl');
      await fs.writeFile(firstFile, session([answer('a', null, '$$first$$')], { agent }));
      await fs.writeFile(secondFile, session([answer('b', null, '$$second$$')], { agent }));
      const pane = { pane_id: 'fictional-pane', terminal_id: 'fictional-terminal', agent, cwd,
        agent_session: { agent, kind: 'path', value: firstFile } };
      const firstPane = await reader.resolvePane(pane);
      const first = await reader.read(firstPane);
      assert.equal(first.issue, null);
      assert.deepEqual(math(first), ['first']);
      const secondPane = await reader.resolvePane({ ...pane, agent_session: { ...pane.agent_session, value: secondFile } });
      assert.notEqual(paneIdentity(firstPane), paneIdentity(secondPane), 'switching exact files resets viewer identity');
      assert.deepEqual(math(await reader.read(secondPane)), ['second']);
      await fs.writeFile(secondFile, session([answer('b', null, '$$newest$$')], { agent, id: 'fictional-session-b' }));
      await fs.utimes(secondFile, new Date('2026-01-03T00:00:00Z'), new Date('2026-01-03T00:00:00Z'));
      const replacedPane = await reader.resolvePane(secondPane);
      assert.notEqual(paneIdentity(secondPane), paneIdentity(replacedPane), 'a new session at the same path resets viewer identity');
      assert.deepEqual(math(await reader.read(replacedPane)), ['newest']);
      await fs.unlink(secondFile);
      const missingPane = await reader.resolvePane(replacedPane);
      assert.equal(missingPane.source_session, undefined, 'file failure clears session identity');
      const missing = await reader.read(missingPane);
      assert.deepEqual(missing.messages, []);
      assert.ok(missing.issue?.title);
      assert.match(missing.origin, /unavailable/i);
      for (const binding of [undefined, { agent, kind: 'id', value: 'fictional-session-a' }, { agent, kind: 'path', value: 'first.jsonl' }]) {
        const rejected = await reader.read(await reader.resolvePane({ ...pane, agent_session: binding }));
        assert.deepEqual(rejected.messages, [], 'a same-cwd transcript cannot be guessed from an absent, ID-only or relative binding');
        assert.ok(rejected.issue?.title);
      }
      assert.deepEqual(math(await reader.read(await reader.resolvePane(pane))), ['first'], 'a later valid exact binding still works');
    } finally { reader.close(); await fs.rm(dir, { recursive: true, force: true }); }
  });
}

test('shared typed inline images and explicit image resolver options are independent of omp defaults', async () => {
  const rows = [
    message('typed', null, { role: 'toolResult', toolName: 'read', isError: false,
      content: [{ type: 'image', image_url: imageData }, { type: 'image', data: 'fictional-reference', mimeType: 'image/png' }] }),
    message('generated', 'typed', { role: 'toolResult', toolName: 'generate_image', isError: false,
      content: [], details: { images: [{ mimeType: 'image/png', data: pixel }] } }),
  ];
  const baseline = await parsePiSession(session(rows));
  assert.deepEqual(baseline.messages.map(item => item.blocks[0].imageData), [imageData]);
  assert.equal(baseline.messages[0].blocks[0].title, 'Image 1');
  const calls = [];
  const resolved = await parsePiSession(session(rows), {
    generatedImages: true,
    async resolveImage(image) {
      calls.push(image.data);
      return { source: '/fictional/custom-resource.png' };
    },
  });
  assert.deepEqual(calls, ['fictional-reference'], 'inline data never needs a source-specific resolver');
  assert.deepEqual(resolved.messages.map(item => item.blocks[0].title), ['Image 1', 'Image 2', 'Generated image']);
  assert.equal(resolved.messages[1].blocks[0].source, '/fictional/custom-resource.png');
  assert.equal(resolved.messages[2].blocks[0].imageData, imageData);
  assert.equal((await parsePiSession(session(rows), { async resolveImage() { return null; } })).messages.length, 1);
});

test('omp agent directory precedence is explicit config, environment, managed hierarchy, then home', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-omp-roots-'));
  const keys = ['HERDR_VISUALS_OMP_HOME', 'PI_CODING_AGENT_DIR'];
  const original = keys.map(key => process.env[key]);
  t.mock.method(os, 'homedir', () => dir);
  try {
    const roots = {
      explicit: path.join(dir, 'explicit-agent'),
      herdr: path.join(dir, 'herdr-agent'),
      pi: path.join(dir, 'pi-agent'),
      managed: path.join(dir, 'managed-agent'),
      fallback: path.join(dir, '.omp', 'agent'),
    };
    const bytes = Buffer.from(pixel, 'base64');
    const hash = createHash('sha256').update(bytes).digest('hex');
    for (const root of Object.values(roots)) {
      await fs.mkdir(path.join(root, 'blobs'), { recursive: true });
      await fs.writeFile(path.join(root, 'blobs', hash), bytes);
    }
    const text = session([message('image', null, { role: 'toolResult', isError: false,
      content: [{ type: 'image', data: `blob:sha256:${hash}`, mimeType: 'image/png' }] })], { agent: 'omp' });
    const managedFile = path.join(roots.managed, 'sessions', '--fictional-project--', 'session.jsonl');
    const outsideFile = path.join(dir, 'outside.jsonl');
    await fs.mkdir(path.dirname(managedFile), { recursive: true });
    await fs.writeFile(managedFile, text);
    await fs.writeFile(outsideFile, text);
    const check = async (source, file, root) => {
      const result = await source.read(boundPane('omp', file));
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].blocks[0].source, path.join(root, 'blobs', hash));
      assert.equal(result.messages[0].blocks[0].imageData, imageData);
    };
    process.env.HERDR_VISUALS_OMP_HOME = roots.herdr;
    process.env.PI_CODING_AGENT_DIR = roots.pi;
    await check(new OmpSource({ ompHome: roots.explicit }), managedFile, roots.explicit);
    await check(new OmpSource(), managedFile, roots.herdr);
    delete process.env.HERDR_VISUALS_OMP_HOME;
    await check(new OmpSource(), managedFile, roots.pi);
    delete process.env.PI_CODING_AGENT_DIR;
    const source = new OmpSource();
    await check(source, managedFile, roots.managed);
    await check(source, outsideFile, roots.fallback);
    await check(source, managedFile, roots.managed);
  } finally {
    keys.forEach((key, index) => { if (original[index] === undefined) delete process.env[key]; else process.env[key] = original[index]; });
    t.mock.restoreAll();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

for (const [agent, Source] of [['omp', OmpSource], ['pi', PiSource]]) {
  test(`${agent} adapter accepts only its own exact path binding and throws source failures for the coordinator`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `hv-${agent}-adapter-`));
    try {
      const file = path.join(dir, 'session.jsonl');
      await fs.writeFile(file, session([answer('final', null, '$$final$$')], { agent }));
      const source = new Source({ ompHome: dir });
      const pane = boundPane(agent, file);
      const resolved = await source.resolvePane(pane);
      assert.equal(resolved.source_session, 'fictional-session-a');
      assert.deepEqual(math(await source.read(resolved)), ['final']);
      for (const binding of [undefined, { agent, kind: 'id', value: 'fictional-session-a' },
        { agent, kind: 'path', value: 'session.jsonl' },
        { agent: agent === 'pi' ? 'omp' : 'pi', kind: 'path', value: file }]) {
        const rejected = { ...pane, agent_session: binding };
        await assert.rejects(source.resolvePane(rejected), /exact absolute transcript path/);
        await assert.rejects(source.read(rejected), /exact absolute transcript path/);
      }
      await fs.writeFile(file, session([answer('new', null, '$$new$$')], { agent, id: 'fictional-session-b' }));
      await assert.rejects(source.read(resolved), /Session changed/);
      await fs.unlink(file);
      await assert.rejects(source.resolvePane(resolved), { code: 'ENOENT' });
      await assert.rejects(source.read(resolved), { code: 'ENOENT' });
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
}


test('session parser rejects unsupported headers and broken ancestry while tolerating an incomplete append', async () => {
  await assert.rejects(parsePiSession(''), /no session header/);
  await assert.rejects(parsePiSession('{"type":"message"}\n'), /Not an omp\/pi session transcript/);
  await assert.rejects(parsePiSession(session([], { version: 4 })), /Unsupported omp\/pi session version/);
  await assert.rejects(parsePiSession(session([answer('leaf', 'missing', '$$orphan$$')])), /ancestry is incomplete/);
  await assert.rejects(parsePiSession(session([answer('cycle', 'cycle', '$$cycle$$')])), /ancestry contains a cycle/);
  assert.deepEqual(math(await parsePiSession(session([answer('final', null, '$$final$$')]) + '{"type":"message"')), ['final']);
});

test('incremental parser snapshots preserve header and active-branch state across append and reset', async () => {
  const parser = new PiSessionParser({ cwd: '/fictional/fallback' });
  for (const row of [header(), user('u1', null), answer('a1', 'u1', '$$retained$$'), answer('abandoned', 'a1', '$$abandoned$$')]) {
    parser.append(JSON.stringify(row));
  }
  assert.deepEqual(math(await parser.snapshot()), ['retained', 'abandoned']);
  parser.append(JSON.stringify(entry('branch_summary', 'branch', 'a1', { fromId: 'abandoned', summary: '$$metadata$$' })));
  parser.append(JSON.stringify(user('u2', 'branch')));
  parser.append(JSON.stringify(answer('a2', 'u2', '$$active$$')));
  const active = await parser.snapshot();
  assert.deepEqual(math(active), ['retained', 'active']);
  assert.deepEqual(active.messages.map(item => item.turn), [1, 2]);
  assert.equal(active.sessionId, 'fictional-session-a');
  assert.deepEqual(active.messages.map(item => item.timestamp), [timestamp, timestamp]);
  assert.deepEqual(await parser.snapshot(), active, 'snapshot traversal must not consume the persisted leaf');
  parser.append(JSON.stringify(entry('reset_boundary', 'reset', null)));
  assert.deepEqual((await parser.snapshot()).messages, []);
  parser.append(JSON.stringify(user('u3', 'reset')));
  parser.append(JSON.stringify(answer('a3', 'u3', '$$after-reset$$')));
  assert.deepEqual(math(await parser.snapshot()), ['after-reset']);
  assert.equal((await parser.snapshot()).messages[0].turn, 1);
});

test('incremental transcript reading buffers an incomplete final line through branch switches and replaces same-path sessions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-pi-incremental-'));
  try {
    const file = path.join(dir, 'session.jsonl');
    const reader = new TranscriptFile(PiSessionParser);
    await fs.writeFile(file, session([user('u1', null), answer('a1', 'u1', '$$retained$$'),
      answer('abandoned', 'a1', '$$abandoned$$')]));
    assert.deepEqual(math(await reader.read(file)), ['retained', 'abandoned']);
    const completed = JSON.stringify(answer('active', 'a1', '$$active$$'));
    const split = Math.floor(completed.length / 2);
    await fs.appendFile(file, completed.slice(0, split));
    assert.deepEqual(math(await reader.read(file)), ['retained', 'abandoned']);
    await fs.appendFile(file, completed.slice(split) + '\n');
    assert.deepEqual(math(await reader.read(file)), ['retained', 'active']);
    await fs.appendFile(file, JSON.stringify(entry('reset_boundary', 'reset', null)) + '\n');
    assert.deepEqual((await reader.read(file)).messages, []);
    await fs.appendFile(file, JSON.stringify(answer('fresh', 'reset', '$$fresh$$')) + '\n');
    assert.deepEqual(math(await reader.read(file)), ['fresh']);
    await fs.writeFile(file, session([answer('replacement', null, '$$replacement$$')], { id: 'fictional-session-b' }));
    const replaced = await reader.read(file);
    assert.equal(replaced.sessionId, 'fictional-session-b');
    assert.deepEqual(math(replaced), ['replacement']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('replayed tree IDs do not evict distinct answer history', async () => {
  const final = answer('second', 'first', '$$second$$');
  const result = await parsePiSession(session([answer('first', null, '$$first$$'), ...Array(350).fill(final)]));
  assert.deepEqual(math(result), ['first', 'second']);
  assert.equal(result.limited, false);
});

test('incremental file decoding preserves a Unicode character split across appends', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-utf8-'));
  try {
    const file = path.join(dir, 'session.jsonl'), reader = new TranscriptFile(PiSessionParser);
    await fs.writeFile(file, session([answer('first', null, '$$first$$')]));
    await reader.read(file);
    const data = Buffer.from(JSON.stringify(answer('second', 'first', '## 森林路线\n$$x=1$$')) + '\n');
    const split = data.indexOf(Buffer.from('森')) + 1;
    await fs.appendFile(file, data.subarray(0, split));
    assert.deepEqual(math(await reader.read(file)), ['first']);
    await fs.appendFile(file, data.subarray(split));
    const result = await reader.read(file);
    assert.equal(result.messages.at(-1).blocks[0].title, '森林路线');
    assert.deepEqual(math(result), ['first', 'x=1']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('concurrent identity reads preserve an unfinished append exactly once', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-concurrent-'));
  try {
    const file = path.join(dir, 'session.jsonl'), reader = new TranscriptFile(PiSessionParser);
    await fs.writeFile(file, session([answer('first', null, '$$first$$')]));
    await reader.read(file);
    const next = JSON.stringify(answer('second', 'first', '$$second$$')) + '\n';
    const split = Math.floor(next.length / 2);
    await fs.appendFile(file, next.slice(0, split));
    await Promise.all(Array.from({ length: 20 }, () => reader.read(file)));
    await fs.appendFile(file, next.slice(split));
    assert.deepEqual(math(await reader.read(file)), ['first', 'second']);
    await fs.appendFile(file, JSON.stringify(answer('third', 'second', '$$third$$')) + '\n');
    assert.deepEqual(math(await reader.read(file)), ['first', 'second', 'third']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('omp bounds retained decoded blob pixels rather than only blob references', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-blob-budget-'));
  try {
    await fs.mkdir(path.join(dir, 'blobs'));
    const data = Buffer.alloc(9 * 1024 * 1024);
    Buffer.from(pixel, 'base64').copy(data);
    const rows = [];
    for (let index = 0; index < 2; index++) {
      data[data.length - 1] = index;
      const hash = createHash('sha256').update(data).digest('hex');
      await fs.writeFile(path.join(dir, 'blobs', hash), data);
      rows.push(message(`image-${index}`, index ? 'image-0' : null, { role: 'toolResult', isError: false,
        content: [{ type: 'image', mimeType: 'image/png', data: `blob:sha256:${hash}` }] }));
    }
    const file = path.join(dir, 'session.jsonl');
    await fs.writeFile(file, session(rows, { agent: 'omp' }));
    const result = await new OmpSource({ ompHome: dir }).read(boundPane('omp', file));
    assert.equal(result.messages.length, 1);
    const pixels = Buffer.from(result.messages[0].blocks[0].imageData.split(',')[1], 'base64');
    assert.equal(pixels[pixels.length - 1], 1, 'the newest complete image is retained');
    assert.equal(result.limited, true);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
