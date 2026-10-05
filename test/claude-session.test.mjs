import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ClaudeSource } from '../src/sources/claude/index.mjs';
import { ClaudeSessionParser, parseClaudeSession } from '../src/sources/claude/format.mjs';

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
const sessionId = '11111111-2222-4333-8444-555555555555';
const text = value => ({ type: 'text', text: value });
const image = (source = { type: 'base64', media_type: 'image/png', data: pixel }) => ({ type: 'image', source });
function row(type, uuid, parentUuid, content, extra = {}) {
  return { type, uuid, parentUuid, sessionId, isSidechain: false, cwd: '/fictional/project',
    timestamp: '2026-01-02T03:04:05.000Z', message: { role: type, id: `api-${uuid}`, content, stop_reason: null }, ...extra };
}
const jsonl = rows => rows.map(value => JSON.stringify(value)).join('\n') + '\n';
const user = () => row('user', 'prompt', null, [text('PROMPT_ONLY $$secret=1$$'), image()]);
const answer = (id = 'answer', parent = 'prompt', value = '## Orchard\n$$x^2=1$$') => row('assistant', id, parent, [text(value)]);

test('Claude parses complete assistant blocks, not prompts, thinking or streaming deltas', async () => {
  const rows = [user(), row('assistant', 'thinking', 'prompt', [{ type: 'thinking', thinking: 'THINKING_ONLY $$secret=2$$' }]),
    { type: 'stream_event', uuid: 'delta', parentUuid: 'thinking', sessionId,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'PARTIAL_ONLY $$secret=3$$' } } },
    answer('answer', 'thinking')];
  const result = await parseClaudeSession(jsonl(rows));
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].turn, 1);
  assert.equal(result.messages[0].blocks[0].type, 'math');
  assert.doesNotMatch(JSON.stringify(result.messages), /PROMPT_ONLY|THINKING_ONLY|PARTIAL_ONLY/);
});

test('Claude groups API-split text and tool_use and only shows final assistant output', async () => {
  const preliminary = answer('preliminary', 'prompt', 'TOOL_COMMENTARY $$secret=4$$');
  preliminary.message.id = 'shared-api';
  const call = row('assistant', 'call', 'preliminary', [{ type: 'tool_use', id: 'tool-1', name: 'fictional_image', input: {} }]);
  call.message.id = 'shared-api';
  const result = row('user', 'result', 'call', [{ type: 'tool_result', tool_use_id: 'tool-1', content: [
    text('TOOL_LOG $$secret=5$$'), image(),
  ] }]);
  const parsed = await parseClaudeSession(jsonl([user(), preliminary, call, result, answer('final', 'result')]));
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0].kind, 'image');
  assert.equal(parsed.messages[0].blocks[0].imageData, `data:image/png;base64,${pixel}`);
  assert.equal(parsed.messages[1].turn, 1, 'tool results are not new prompt turns');
  assert.doesNotMatch(JSON.stringify(parsed.messages), /TOOL_COMMENTARY|TOOL_LOG/);
});

test('Claude joins distinct text blocks sharing API identity and deduplicates replayed UUIDs', async () => {
  const first = answer('first', 'prompt', '## Orchard'); first.message.id = 'shared-api';
  const second = answer('second', 'first', '$$x=1$$'); second.message.id = 'shared-api';
  const parsed = await parseClaudeSession(jsonl([user(), first, second, second]));
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0].text, '## Orchard\n$$x=1$$');
  assert.equal(parsed.messages[0].blocks.length, 1);
});

test('Claude honors active ancestry and excludes physically adjacent sidechain, team and meta output', async () => {
  const old = answer('old', 'prompt', 'OLD_BRANCH $$old=1$$');
  const active = answer('active', 'prompt', 'ACTIVE_BRANCH $$x=1$$');
  const parsed = await parseClaudeSession(jsonl([user(), old, active,
    { type: 'progress', uuid: 'bridge', parentUuid: 'active', sessionId },
    { ...answer('side', 'prompt', 'SIDECHAIN_ONLY $$side=1$$'), isSidechain: true },
    { ...answer('team', 'prompt', 'TEAM_ONLY $$team=1$$'), teamName: 'fictional-team' },
    { ...answer('meta', 'prompt', 'META_ONLY $$meta=1$$'), isMeta: true },
    { ...answer('subagent', 'prompt', 'SUBAGENT_ONLY $$sub=1$$'), parent_tool_use_id: 'agent-call' },
  ]));
  assert.equal(parsed.messages.length, 1);
  assert.match(parsed.messages[0].text, /ACTIVE_BRANCH/);
  assert.doesNotMatch(JSON.stringify(parsed), /OLD_BRANCH|SIDECHAIN_ONLY|TEAM_ONLY|META_ONLY|SUBAGENT_ONLY/);
});

test('Claude follows system/progress bridges but not logical pre-compaction ancestry', async () => {
  const rows = [user(), answer('old', 'prompt', 'OLD_COMPACTED $$old=1$$'),
    { type: 'system', uuid: 'boundary', parentUuid: null, logicalParentUuid: 'old', sessionId, subtype: 'compact_boundary' },
    row('user', 'summary', 'boundary', [text('COMPACT_SUMMARY_ONLY')], { isCompactSummary: true }),
    { type: 'progress', uuid: 'progress', parentUuid: 'summary', sessionId }, answer('final', 'progress')];
  const parsed = await parseClaudeSession(jsonl(rows));
  assert.equal(parsed.messages.length, 1);
  assert.doesNotMatch(JSON.stringify(parsed.messages), /OLD_COMPACTED|COMPACT_SUMMARY_ONLY/);
});

test('Claude only accepts successful typed base64 images from matching tool results', async () => {
  const call = row('assistant', 'call', 'prompt', [{ type: 'tool_use', id: 'tool-1', name: 'fictional_image', input: {} }]);
  const result = row('user', 'result', 'call', [
    { type: 'tool_result', tool_use_id: 'tool-1', is_error: true, content: [image()] },
    { type: 'tool_result', tool_use_id: 'unknown-tool', content: [image()] },
    { type: 'tool_result', tool_use_id: 'tool-1', content: [
      image({ type: 'url', url: 'https://example.invalid/fictional.png' }),
      image({ type: 'base64', media_type: 'text/plain', data: pixel }),
      image({ type: 'base64', media_type: 'image/png', data: 'broken' }),
      text(JSON.stringify(image())), image(),
    ] },
  ]);
  const parsed = await parseClaudeSession(jsonl([user(), call, result]));
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0].kind, 'image');
});

test('Claude extracts relative assistant image links with persisted source cwd', async () => {
  const parsed = await parseClaudeSession(jsonl([user(), answer('final', 'prompt', '![Orchard](./images/orchard.png)')]), { cwd: '/wrong-cwd' });
  assert.equal(parsed.messages[0].blocks[0].source, './images/orchard.png');
  assert.equal(parsed.messages[0].blocks[0].cwd, '/fictional/project');
});

test('Claude rejects missing identity, conflicting identities and broken ancestry', async () => {
  await assert.rejects(parseClaudeSession(''), /main-session identity/);
  await assert.rejects(parseClaudeSession(jsonl([answer('final', 'absent')])), /ancestry is incomplete/);
  await assert.rejects(parseClaudeSession(jsonl([answer('cycle', 'cycle')])), /cycle/);
  await assert.rejects(parseClaudeSession(jsonl([user(), { ...answer(), sessionId: 'other-session' }])), /conflicting session/);
  const parsed = await parseClaudeSession(jsonl([user(), answer()]) + '{"type":"assistant"');
  assert.equal(parsed.messages.length, 1, 'unfinished appends do not discard completed blocks');
});

test('Claude retains ancestry when limiting large histories and keeps one whole typed image', async () => {
  const rows = [user()];
  let parent = 'prompt';
  for (let i = 0; i < 320; i++) { rows.push(answer(`answer-${i}`, parent, `$$x=${i}$$`)); parent = `answer-${i}`; }
  const parsed = await parseClaudeSession(jsonl(rows));
  assert.equal(parsed.messages.length, 300);
  assert.equal(parsed.limited, true);
  assert.match(parsed.messages.at(-1).text, /319/);
  const data = 'AAAA'.repeat(5 * 1024 * 1024);
  const large = await parseClaudeSession(jsonl([user(),
    row('assistant', 'call', 'prompt', [{ type: 'tool_use', id: 'tool-1', name: 'fictional_image', input: {} }]),
    row('user', 'result', 'call', [{ type: 'tool_result', tool_use_id: 'tool-1', content: [image({ type: 'base64', media_type: 'image/png', data })] }]),
  ]));
  assert.equal(large.limited, true);
  assert.equal(large.messages[0].blocks[0].imageData.length, data.length + 'data:image/png;base64,'.length);
});

test('ClaudeSource uses only the exact bound file and refreshes real JSONL identity', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-claude-'));
  const file = path.join(dir, 'bound.jsonl');
  const pane = { agent: 'claude', cwd: dir, agent_session: { agent: 'claude', kind: 'path', value: file } };
  const source = new ClaudeSource({ configDir: dir });
  try {
    await fs.writeFile(file, jsonl([user(), answer()]));
    assert.equal((await source.resolvePane(pane)).source_session, sessionId);
    assert.equal((await source.read(pane)).origin, 'Claude Code transcript');
    const replacement = '66666666-7777-4888-8999-aaaaaaaaaaaa';
    await fs.writeFile(file, jsonl([user(), answer()].map(value => ({ ...value, sessionId: replacement }))));
    assert.equal((await source.resolvePane(pane)).source_session, replacement);
    await fs.unlink(file);
    await assert.rejects(source.resolvePane(pane), /ENOENT/);
    await assert.rejects(source.read(pane), /ENOENT/);
    await fs.writeFile(path.join(dir, 'unbound.jsonl'), jsonl([user(), answer()]));
    await assert.rejects(source.read({ ...pane, agent_session: undefined }), /exact absolute/);
    await assert.rejects(source.read({ ...pane, agent_session: { agent: 'pi', kind: 'path', value: file } }), /exact absolute/);
  } finally { source.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('ClaudeSource constructs one exact UUID filename without session or project discovery', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-claude-id-'));
  const source = new ClaudeSource({ configDir: dir });
  const pane = { agent: 'claude', cwd: dir, agent_session: { agent: 'claude', kind: 'id', value: sessionId } };
  try {
    const canonical = (await fs.realpath(dir)).normalize('NFC');
    const project = path.join(dir, 'projects', canonical.replace(/[^a-zA-Z0-9]/g, '-'));
    await fs.mkdir(project, { recursive: true });
    const file = path.join(project, `${sessionId}.jsonl`);
    await fs.writeFile(file, jsonl([user(), answer()]));
    assert.equal((await source.resolvePane(pane)).source_session, sessionId);
    await fs.writeFile(file, jsonl([user(), answer()].map(value => ({ ...value, sessionId: 'different-session' }))));
    await assert.rejects(source.read(pane), /does not match/);
    await fs.unlink(file);
    await fs.writeFile(path.join(project, 'another-session.jsonl'), jsonl([user(), answer()]));
    await assert.rejects(source.read(pane), /ENOENT/);
    await assert.rejects(source.read({ ...pane, cwd: undefined }), /authoritative absolute/);
    await assert.rejects(source.read({ ...pane, agent_session: { ...pane.agent_session, value: '../escape' } }), /session UUID/);
  } finally { source.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('Claude preserves intentionally repeated complete text blocks but suppresses API failures and tool stops', async () => {
  const first = answer('first', 'prompt', '$$x=1$$'); first.message.id = 'shared-api';
  const second = answer('second', 'first', '$$x=1$$'); second.message.id = 'shared-api';
  const failed = { ...answer('failed', 'second', 'FAILED_ONLY $$secret=1$$'), isApiErrorMessage: true };
  const stopped = answer('stopped', 'failed', 'TOOL_STOP_ONLY $$secret=2$$'); stopped.message.stop_reason = 'tool_use';
  const parsed = await parseClaudeSession(jsonl([user(), first, second, failed, stopped]));
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0].text, '$$x=1$$\n$$x=1$$');
  assert.equal(parsed.messages[0].blocks.length, 2);
  assert.doesNotMatch(JSON.stringify(parsed.messages), /FAILED_ONLY|TOOL_STOP_ONLY/);
});

test('incremental Claude snapshots preserve ancestry and reclassify split tool commentary after append', async () => {
  const parser = new ClaudeSessionParser();
  const preliminary = answer('preliminary', 'prompt', 'PRELIMINARY_ONLY $$x=1$$');
  preliminary.message.id = 'tool-api';
  parser.append(JSON.stringify(user()));
  parser.append(JSON.stringify(preliminary));
  assert.equal((await parser.snapshot()).messages.length, 1);
  const call = row('assistant', 'call', 'preliminary', [{ type: 'tool_use', id: 'tool-1', name: 'fictional_image', input: {} }]);
  call.message.id = 'tool-api';
  parser.append(JSON.stringify(call));
  assert.equal((await parser.snapshot()).messages.length, 0);
  parser.append(JSON.stringify(row('user', 'result', 'call', [{ type: 'tool_result', tool_use_id: 'tool-1', content: [image()] }])));
  parser.append(JSON.stringify(answer('final', 'result')));
  const snapshot = await parser.snapshot();
  assert.equal(snapshot.messages.length, 2);
  assert.equal(snapshot.messages[0].kind, 'image');
  assert.doesNotMatch(JSON.stringify(snapshot.messages), /PRELIMINARY_ONLY/);
  assert.deepEqual(await parser.snapshot(), snapshot, 'snapshots never consume normalized parser state');
});

test('replayed Claude UUIDs do not evict other blocks of the same answer', async () => {
  const first = answer('first', 'prompt', '## Orchard'); first.message.id = 'shared-api';
  const second = answer('second', 'first', '$$x=1$$'); second.message.id = 'shared-api';
  const parsed = await parseClaudeSession(jsonl([user(), first, ...Array(350).fill(second)]));
  assert.equal(parsed.messages[0].text, '## Orchard\n$$x=1$$');
  assert.equal(parsed.limited, false);
});

test('Claude path reads reject a session replaced after identity resolution', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-claude-race-'));
  const source = new ClaudeSource();
  try {
    const file = path.join(dir, 'session.jsonl');
    const pane = { agent: 'claude', cwd: dir, agent_session: { agent: 'claude', kind: 'path', value: file } };
    await fs.writeFile(file, jsonl([user(), answer()]));
    const resolved = await source.resolvePane(pane);
    assert.match((await source.read(resolved)).messages[0].text, /Orchard/);
    await fs.writeFile(file, jsonl([user(), answer()].map(value => ({ ...value, sessionId: 'replacement-session' }))));
    await assert.rejects(source.read(resolved), /Session changed while reading/);
    const replacement = await source.resolvePane(pane);
    assert.equal(replacement.source_session, 'replacement-session');
    assert.match((await source.read(replacement)).messages[0].text, /Orchard/);
  } finally { source.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('Claude tool commentary does not evict actual answer history', async () => {
  const rows = [user(), answer('visual', 'prompt', '$$retained$$')];
  let parent = 'visual';
  for (let index = 0; index < 310; index++) {
    const preliminary = answer(`pre-${index}`, parent, '$$commentary$$');
    preliminary.message.id = `tool-api-${index}`;
    const call = row('assistant', `call-${index}`, preliminary.uuid,
      [text('$$commentary$$'), { type: 'tool_use', id: `tool-${index}`, name: 'fictional_tool', input: {} }]);
    call.message.id = preliminary.message.id;
    rows.push(preliminary, call);
    parent = call.uuid;
  }
  const result = await parseClaudeSession(jsonl(rows));
  assert.deepEqual(result.messages.map(message => message.text), ['$$retained$$']);
  assert.equal(result.limited, false);
});
