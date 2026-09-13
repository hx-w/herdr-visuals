import test from 'node:test';
import assert from 'node:assert/strict';
import { paneIdentity, answerContext } from '../src/navigation.mjs';
import { extract, extractSelection } from '../src/extract.mjs';

const text = '## Public statistics\nThis sample describes a basic arithmetic calculation.\n\n$$x = (1 + 2 + 3) / 3$$\n\nThe result is two.';
const message = { id: 'answer', text, blocks: extract(text, 'answer') };
const block = message.blocks[0];
test('answer context maps the chosen block to its own message and line', () => {
  const unrelated = { id: 'other', text: '$$x$$', blocks: extract('$$x$$', 'other') };
  const context = answerContext([unrelated, message], block);
  assert.equal(context.lines[context.start], '$$x = (1 + 2 + 3) / 3$$');
  assert.equal(context.blockId, block.id);
  assert.equal(answerContext([unrelated], block), null);
});

test('pane identity distinguishes terminal, agent, reference kind and session changes', () => {
  const pane = { pane_id: 'bound', terminal_id: 'terminal', agent_session: { agent: 'codex', kind: 'id', value: 'session' } };
  for (const next of [
    { ...pane, pane_id: 'other' }, { ...pane, terminal_id: 'replacement' },
    ...['agent', 'kind', 'value'].map(key => ({ ...pane, agent_session: { ...pane.agent_session, [key]: 'different' } })),
  ]) assert.notEqual(paneIdentity(next), paneIdentity(pane));
});

test('raw selected text retains original lines and does not invent context delimiters', () => {
  const text = 'flowchart LR\nA --> B';
  const blocks = extractSelection(text, '/sample');
  const context = answerContext([{ id: 'selection', text, blocks }], blocks[0]);
  assert.deepEqual(context.lines, ['flowchart LR', 'A --> B']);
  assert.equal(context.start, 0); assert.equal(context.end, 1);
  assert.equal(blocks[0].raw, text); assert.equal(blocks[0].cwd, '/sample');
});
