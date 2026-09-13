import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extract, extractSelection } from '../src/extract.mjs';
import { parseRollout, SourceReader } from '../src/source.mjs';
import { PreviewModel } from '../src/model.mjs';
import { Renderer } from '../src/render.mjs';
import { resolveImage, imageReferences, readImage } from '../src/images.mjs';
import { spawnSync } from 'node:child_process';

const example = await fs.readFile(new URL('../examples/geometry.md', import.meta.url), 'utf8');

test('provided geometry example keeps graph labels, equations, and order', () => {
  const blocks = extract(example);
  assert.deepEqual(blocks.map(b => b.type), ['mermaid', 'math', 'math', 'math']);
  assert.match(blocks[0].source, /仍有违反/);
  assert.match(blocks[1].source, /\\frac\{1\}\{2\}/);
  assert.equal(blocks[3].title, 'H 的展开式');
  assert.match(blocks[3].source, /\\begin\{aligned\}/);
});

test('automatic detection ignores ordinary code and incomplete streamed blocks', () => {
  const ordinary = '```python\npattern = "$$x$$"\n```\nInline $x$ and `K`.\n';
  assert.equal(extract(ordinary).length, 0);
  assert.equal(extract('```mermaid\nflowchart LR\nA-->B').length, 0);
  assert.equal(extract('\\[\nx^2').length, 0);
  assert.equal(extract('$$x^2$$')[0].source, 'x^2');
  assert.equal(extractSelection('flowchart LR\nA-->B')[0].type, 'mermaid');
  assert.equal(extractSelection('H=KM^{-1}K')[0].type, 'math');
});

test('image references preserve path spaces and resolve against the source cwd', () => {
  const text = '[Scan](</tmp/upper scan (1).png>)\n![View](assets/view.webp)\n`./mesh.png`\n/Users/me/result.jpg\nhttps://example.com/private.png';
  const blocks = extract(text, 'answer', '/project');
  assert.equal(blocks.length, 4); assert.ok(blocks.every(b => b.type === 'image'));
  assert.equal(blocks[0].source, '/tmp/upper scan (1).png');
  assert.equal(resolveImage(blocks[1].source, blocks[1].cwd), '/project/assets/view.webp');
  assert.equal(resolveImage('file:///tmp/a%20b.png'), '/tmp/a b.png');
  assert.equal(imageReferences('[a](/tmp/a.png)')[0].source, '/tmp/a.png');
  assert.equal(extract('```sh\ncat /tmp/a.png\n```').length, 0);
  assert.throws(() => resolveImage('https://example.com/a.png', '/project'), /Only local/);
});

test('non-regular image paths cannot hang preview loading', { timeout: 3000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'visuals-fifo-'));
  try {
    const file = path.join(dir, 'scan.png');
    const command = spawnSync('mkfifo', [file]); assert.equal(command.status, 0);
    await assert.rejects(readImage(file), /not a regular file/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('transcript adapter excludes prompts, internal reasoning, tools and commentary', () => {
  const row = (role, text, phase) => JSON.stringify({ type: 'response_item', timestamp: '2026-09-13T00:00:00Z', payload: { type: 'message', role, phase, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] } });
  const rows = [row('developer', '$$secret$$'), row('user', '$$prompt$$'), row('assistant', '$$progress$$', 'commentary'),
    JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', summary: '$$private$$' } }),
    row('assistant', example, 'final_answer'), '{"incomplete":'];
  const messages = parseRollout(rows.join('\n'));
  assert.equal(messages.length, 1); assert.equal(messages[0].blocks.length, 4);
  assert.equal(messages[0].turn, 1);
});

test('reading an exact Codex session handles append and refuses unrelated sessions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'visuals-source-'));
  try {
    const id = '019f47ac-0000-7000-8000-000000000001';
    const nested = path.join(dir, 'sessions', '2026', '01', '01'); await fs.mkdir(nested, { recursive: true });
    const file = path.join(nested, `rollout-${id}.jsonl`);
    const row = text => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] } }) + '\n';
    await fs.writeFile(file, row(example));
    const reader = new SourceReader({ codexHome: dir });
    const pane = { pane_id: 'w1:p1', agent_session: { agent: 'codex', kind: 'id', value: id } };
    assert.equal((await reader.read(pane)).messages[0].blocks.length, 4);
    await fs.appendFile(file, row('$$z^2$$'));
    assert.equal((await reader.read(pane)).messages.length, 2);
    const archive = path.join(dir, 'archived_sessions'); await fs.mkdir(archive);
    await fs.rename(file, path.join(archive, path.basename(file)));
    assert.equal((await reader.read(pane)).messages.length, 2);
    const missing = await reader.read({ ...pane, agent_session: { ...pane.agent_session, value: '../../invalid' } });
    assert.match(missing.origin, /unavailable/); assert.deepEqual(missing.messages, []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('pinning and browsing preserve the viewed item until follow is resumed', () => {
  const model = new PreviewModel();
  const first = { id: 'first', blocks: extract(example, 'first') }, second = { id: 'second', blocks: extract('$$z$$', 'second') };
  model.update([first]); model.move(2); const viewed = model.current;
  model.update([first, second]); assert.equal(model.current.id, viewed.id); assert.equal(model.pending, 1);
  model.pin(); model.update([first, second]); assert.equal(model.current.id, viewed.id);
  model.resume(); assert.equal(model.current.source, 'z'); assert.equal(model.pending, 0);
  model.history = true; model.filter = 'mermaid'; assert.equal(model.items.length, 1);
  model.filter = 'math'; model.query = '展开'; assert.equal(model.items.length, 1);
  model.move(0); model.update([first, second, { id: 'third', blocks: extract('$$privateA$$', 'third') }]);
  model.resetSource();
  assert.equal(model.current, undefined); assert.equal(model.pending, 0);
  model.resume(); assert.equal(model.current, undefined);
});

test('real Mermaid and KaTeX rendering produces nonempty graph and mathematical layout', { timeout: 60000 }, async () => {
  const renderer = new Renderer();
  const out = new URL('../test-output/', import.meta.url); await fs.mkdir(out, { recursive: true });
  try {
    const blocks = extract(example);
    const graph = await renderer.render(blocks[0], { width: 1000, height: 640 });
    assert.equal(graph.error, ''); assert.ok(graph.png.length > 10000);
    assert.equal(await renderer.page.locator('svg .node').count(), 6);
    assert.equal(await renderer.page.locator('svg .flowchart-link').count(), 6);
    await fs.writeFile(new URL('diagram.png', out), graph.png);
    const imagePath = path.join(path.dirname(new URL(out).pathname), 'test-output', 'scan with spaces.png');
    await fs.writeFile(imagePath, graph.png);
    const imageBlock = extract(`[Scan](<${imagePath}>)`)[0];
    const imageFrame = await renderer.render(imageBlock, { width: 850, height: 500 });
    assert.equal(imageFrame.error, '');
    assert.equal(await renderer.page.locator('#content img').evaluate(el => el.naturalWidth), graph.imageWidth);
    await renderer.render(imageBlock, { width: 600, height: 600 });
    await renderer.render(imageBlock, { width: 600, height: 200 });
    assert.ok(await renderer.page.locator('#content img').evaluate(el => el.getBoundingClientRect().height) <= 100);
    assert.equal((await readImage(imagePath)).mime, 'image/png');
    await fs.writeFile(new URL('image-preview.png', out), imageFrame.png);
    const missing = await renderer.render({ ...imageBlock, id: 'missing-image', source: imagePath + '.missing' });
    assert.match(missing.error, /ENOENT/);
    const formula = await renderer.render(blocks[1], { width: 850, height: 500 });
    assert.equal(formula.error, '');
    assert.ok(await renderer.page.locator('math mfrac').count() > 0);
    assert.match(await renderer.page.locator('math annotation').textContent(), /u_a/);
    await fs.writeFile(new URL('equation.png', out), formula.png);
    const aligned = await renderer.render(blocks[3], { width: 850, height: 500 });
    assert.equal(aligned.error, ''); assert.ok(await renderer.page.locator('math mtable mtr').count() >= 3);
    await fs.writeFile(new URL('expanded.png', out), aligned.png);
    const invalid = await renderer.render({ id: 'invalid', type: 'math', source: '\\frac{', raw: '\\frac{' });
    assert.match(invalid.error, /Could not render/);
    assert.equal(await renderer.page.locator('#content pre').textContent(), '\\frac{');
    const injection = await renderer.render({ id: 'injection', type: 'math', source: '\\includegraphics{https://example.com/secret}', raw: 'blocked' });
    assert.equal(await renderer.page.locator('#content img').count(), 0);
    assert.ok(injection.png.length > 1000);
    await renderer.render({ id: 'html', type: 'mermaid', source: 'flowchart LR\nA["<img src=x onerror=alert(1)>"] --> B[End]', context: '<script>window.secret=true</script>' });
    assert.equal(await renderer.page.evaluate(() => window.secret), undefined);
    assert.equal(await renderer.page.locator('#context script').count(), 0);
  } finally { await renderer.close(); }
});
