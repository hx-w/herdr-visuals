import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import stringWidth from 'string-width';
import net from 'node:net';
import { rpc } from './herdr.mjs';
import { extract, extractSelection, digest } from './extract.mjs';
import { SourceReader } from './source.mjs';
import { PreviewModel } from './model.mjs';
import { Renderer } from './render.mjs';

const model = new PreviewModel(), renderer = new Renderer(), reader = new SourceReader();
let sourcePane = process.env.HERDR_VISUALS_SOURCE, origin = '', sourceLabel = '', notice = '';
let raw = false, list = false, help = false, search = null, zoom = 1, x = 0, y = 0, fitDiagram = false;
let stopping = false, drawing = false, dirty = true, polling = false, request = 0, selection = false;
let lastImageKey, metrics, timer, hasImage = false, exporting = false, sessionIdentity;
let viewRevision = 0;
let commandServer, pendingCommand;
const paneId = process.env.HERDR_PANE_ID;
const fileArg = process.argv.indexOf('--file');
const file = fileArg >= 0 ? process.argv[fileArg + 1] : null;
if (fileArg >= 0 && !file) throw new Error('--file requires a Markdown file');

function safe(text) { return String(text || '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' '); }
function fit(text, columns) {
  let result = '';
  for (const c of safe(text)) { if (stringWidth(result + c) > columns) break; result += c; }
  return result;
}
function line(row, text, color = '') {
  process.stdout.write(`\x1b[${row};1H\x1b[2K${color}${fit(text, (process.stdout.columns || 80) - 1)}\x1b[0m`);
}
function resetView() { x = 0; y = 0; zoom = 1; lastImageKey = null; dirty = true; viewRevision++; }
async function clearImage() {
  if (hasImage) await rpc('pane.graphics.clear', { pane_id: paneId, layer_id: 'visuals' }).catch(() => {});
  hasImage = false;
  lastImageKey = null;
}
async function poll() {
  if (polling || stopping) return;
  polling = true;
  try {
    if (file) {
      const text = await fs.readFile(file, 'utf8');
      if (model.update([{ id: digest(text), text, blocks: extract(text, digest(text), path.dirname(path.resolve(file))) }])) dirty = true;
      origin = 'Markdown file'; sourceLabel = path.basename(file);
      return;
    }
    if (pendingCommand) {
      const record = pendingCommand; pendingCommand = null;
      if (record.request && record.request !== request) {
        request = record.request;
        if (!model.pinned || sourcePane !== record.source) {
          if (sourcePane !== record.source || record.selection || selection) { model.resetSource(); resetView(); }
          if (sourcePane !== record.source) sessionIdentity = undefined;
          sourcePane = record.source || sourcePane;
          selection = !!record.selection;
          if (selection) {
            model.messages = [{ id: 'selection', blocks: extractSelection(record.selection, record.cwd) }];
            model.follow = false; origin = 'Selected text';
          }
        } else notice = 'Pinned. Press r to resume this session.';
      }
    }
    if (!sourcePane) throw new Error('No source pane. Open Visuals from a Codex pane.');
    const expectedSource = sourcePane;
    const { pane } = await rpc('pane.get', { pane_id: expectedSource });
    if (sourcePane !== expectedSource) return;
    const identity = `${pane.terminal_id}:${pane.agent_session?.agent || pane.agent || ''}:${pane.agent_session?.value || ''}`;
    if (sessionIdentity !== undefined && sessionIdentity !== identity) {
      model.resetSource(); selection = false; resetView();
    }
    sessionIdentity = identity;
    sourceLabel = pane.label || path.basename(pane.foreground_cwd || pane.cwd || 'Session');
    if (!selection) {
      const value = await reader.read(pane);
      if (sourcePane !== expectedSource || selection) return;
      origin = value.origin + (value.limited ? ' · partial history' : '');
      if (model.update(value.messages)) dirty = true;
    }
  } catch (error) { const next = error.message; if (notice !== next) { notice = next; dirty = true; } }
  finally { polling = false; }
}
async function draw() {
  if (drawing || exporting || !dirty || stopping) return;
  drawing = true; dirty = false;
  const cols = process.stdout.columns || 80, rows = process.stdout.rows || 30;
  try {
    line(1, ` VISUALS   ${model.pinned ? 'PINNED' : model.follow ? 'LIVE' : 'BROWSING'}   ${sourceLabel}`, '\x1b[1;38;2;52;91;116m');
    line(2, ` ${model.history ? 'This session' : 'Latest answer'} · ${model.filter} · ${model.items.length} items${model.pending ? ` · ${model.pending} new answer(s) — r to refresh` : ''}`);
    line(3, ` ${model.current ? `${model.index + 1}/${model.items.length}  ${model.current.title}` : 'No diagrams, equations or image paths in this answer.'}`);
    line(4, ` ${origin}${model.query ? ` · search: ${model.query}` : ''}`, '\x1b[2m');
    line(rows - 2, search !== null ? ` Search: ${search}_` : ` ${notice || '[ ] items  l list  f type  h scope  / search'}`);
    line(rows - 1, ' p pin  r live  s source  +/- zoom  0 fit  ? help');
    line(rows, ' arrows pan  y copy  e export  q / Esc close', '\x1b[2m');
    if (rows < 12 || cols < 28 || help || list || search !== null || !model.current) {
      await clearImage();
      for (let row = 5; row < rows - 2; row++) line(row, '');
      if (help) {
        ['Controls — this session only', '[ / ] or b / n: previous / next item', 'l: item list; j/k select; Enter opens', 'f: all / Mermaid / math / images', 'h: session records / latest answer', '/: search this session; Enter confirms', 'p: pin; r: resume this session', 'j/k and arrows: scroll / pan', '+/-: zoom; 0: fit; s: original source', 'y: copy source; e: export PNG + Markdown', '?: close help; q / Escape: close preview'].slice(0, rows - 8).forEach((text, i) => line(i + 6, ' ' + text));
      } else if (list || search !== null) {
        const start = Math.max(0, model.index - Math.floor((rows - 9) / 2));
        model.items.slice(start, start + rows - 8).forEach((b, i) => line(i + 6,
          ` ${b.id === model.current?.id ? '>' : ' '} ${start + i + 1}. ${b.type.toUpperCase()}  ${b.title}`, b.id === model.current?.id ? '\x1b[1m' : ''));
      } else line(6, rows < 12 || cols < 28 ? ' Enlarge this pane to preview.' : ' h: previous answers   r: latest   q: close');
      return;
    }
    // Probe on every changed frame to adapt to terminal DPI and resized clients.
    metrics = await rpc('pane.graphics.info', { pane_id: paneId });
    if (!metrics.cell_width_px || !metrics.cell_height_px) throw new Error('No graphics-capable client attached. Use s for source view.');
    const gridRows = rows - 8, gridCols = cols - 2;
    const scale = Math.min(1, 2400 / (gridCols * metrics.cell_width_px), 1800 / (gridRows * metrics.cell_height_px));
    const width = Math.round(gridCols * metrics.cell_width_px * scale / 2);
    const height = Math.round(gridRows * metrics.cell_height_px * scale / 2);
    const block = model.current;
    const revision = viewRevision;
    const key = JSON.stringify([block.id, width, height, x, y, zoom, raw, fitDiagram]);
    if (key !== lastImageKey) {
      // Clear text from a previously open index before placing the image.
      for (let row = 5; row < rows - 2; row++) line(row, '');
      const frame = await renderer.render(block, { width, height, zoom, x, y, source: raw, fit: fitDiagram });
      if (stopping || revision !== viewRevision || block.id !== model.current?.id || help || list || search !== null) { dirty = true; return; }
      x = frame.x; y = frame.y;
      await rpc('pane.graphics.set', { pane_id: paneId, layer_id: 'visuals', format: 'png',
        image_width: frame.imageWidth, image_height: frame.imageHeight, data_base64: frame.png.toString('base64'),
        placement: { viewport_col: 1, viewport_row: 4, grid_cols: gridCols, grid_rows: gridRows } });
      lastImageKey = key;
      hasImage = true;
      if (frame.error) line(rows - 2, ' Render error — source shown. Press s to inspect or y to copy.', '\x1b[31m');
    }
  } catch (error) {
    await clearImage();
    line(6, ` ${error.message}`, '\x1b[31m');
    if (raw && model.current) model.current.raw.split('\n').slice(Math.floor(y / 24), Math.floor(y / 24) + rows - 10).forEach((text, i) => line(i + 8, text));
  } finally { if (stopping) await clearImage(); drawing = false; }
}
async function close() {
  if (stopping) return;
  stopping = true; clearInterval(timer);
  while (drawing || exporting) await new Promise(resolve => setTimeout(resolve, 20));
  await clearImage();
  await renderer.close();
  commandServer?.close();
  if (process.env.HERDR_VISUALS_RECORD) await fs.rm(process.env.HERDR_VISUALS_RECORD + '.sock', { force: true });
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write('\x1b[?25h\x1b[?1049l');
  process.stdin.pause();
  process.exit(0);
}
async function keypress(text, key = {}) {
  if (stopping) return;
  viewRevision++;
  if (key.ctrl && key.name === 'c') return close();
  if (search !== null) {
    if (key.name === 'escape') { search = null; model.query = ''; }
    else if (key.name === 'return') { search = null; list = true; }
    else if (key.name === 'backspace') search = [...search].slice(0, -1).join('');
    else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text)) search += text;
    if (search !== null) model.query = search;
    model.selectedId = null; dirty = true; return;
  }
  notice = '';
  if (text === '?') { help = !help; dirty = true; return; }
  if (['q', 'escape'].includes(key.name)) return close();
  if (text === ']' || key.name === 'n' || (list && ['down', 'j'].includes(key.name))) { model.move(1); resetView(); }
  else if (text === '[' || key.name === 'b' || (list && ['up', 'k'].includes(key.name))) { model.move(-1); resetView(); }
  else if (key.name === 'return' && list) { list = false; resetView(); }
  else if (key.name === 'l') { list = !list; model.follow = false; }
  else if (key.name === 'f') { const types = ['all', 'mermaid', 'math', 'image']; model.filter = types[(types.indexOf(model.filter) + 1) % types.length]; model.selectedId = null; resetView(); }
  else if (key.name === 'h') { model.history = !model.history; model.follow = false; model.selectedId = null; resetView(); }
  else if (text === '/') { search = ''; list = true; model.history = true; model.follow = false; }
  else if (key.name === 'p' && !model.pinned) model.pin();
  else if (key.name === 'r' || (key.name === 'p' && model.pinned)) {
    if (selection) model.resetSource();
    else model.resume();
    selection = false;
    model.query = ''; list = false; resetView(); await poll();
  }
  else if (key.name === 's') { raw = !raw; resetView(); }
  else if (text === '+' || text === '=') { zoom = Math.min(4, zoom * 1.25); model.follow = false; }
  else if (text === '-') { zoom = Math.max(0.4, zoom / 1.25); model.follow = false; }
  else if (text === '0') { fitDiagram = true; resetView(); }
  else if (['j', 'down', 'pagedown'].includes(key.name)) { y += key.name === 'pagedown' ? 500 : 100; model.follow = false; }
  else if (['k', 'up', 'pageup'].includes(key.name)) { y = Math.max(0, y - (key.name === 'pageup' ? 500 : 100)); model.follow = false; }
  else if (key.name === 'right') { x += 100; model.follow = false; }
  else if (key.name === 'left') { x = Math.max(0, x - 100); model.follow = false; }
  else if (key.name === 'y' && model.current) {
    const value = model.current.raw || model.current.source;
    const candidates = process.platform === 'darwin' ? [['pbcopy', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]];
    let copied = false;
    for (const [command, args] of candidates) {
      const result = spawnSync(command, args, { input: value, encoding: 'utf8', timeout: 3000 });
      if (result.status === 0) { copied = true; break; }
    }
    notice = copied ? 'Source copied.' : 'Clipboard unavailable. Use e to export the source.';
  } else if (key.name === 'e' && model.current && !exporting) {
    exporting = true;
    const block = { ...model.current };
    try {
    while (drawing) await new Promise(resolve => setTimeout(resolve, 20));
    // Render the captured item explicitly: export must never use a previous frame.
    await renderer.render(block, { width: 1000, height: 700, zoom: 1, fit: false });
    const png = await renderer.exportPNG();
    const directory = path.join(process.env.HERDR_VISUALS_EXPORT_DIR || path.join(os.homedir(), 'Downloads'), 'herdr-visuals');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const base = path.join(directory, `${new Date().toISOString().replaceAll(':', '-')}-${digest(block.id)}`);
    await fs.writeFile(base + '.md', block.raw || block.source, { mode: 0o600, flag: 'wx' });
    await fs.writeFile(base + '.png', png, { mode: 0o600, flag: 'wx' });
    notice = `Saved: ${base}`;
    } finally { exporting = false; lastImageKey = null; dirty = true; }
  }
  dirty = true;
}

async function main() {
  if (process.env.HERDR_ENV !== '1' || !paneId) throw new Error('Run this viewer inside Herdr.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Visuals requires an interactive terminal pane.');
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J');
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true); process.stdin.resume();
  process.stdin.on('keypress', (text, key) => { keypress(text, key).catch(error => { notice = error.message; dirty = true; }); });
  process.stdout.on('resize', () => { resetView(); });
  process.on('SIGTERM', close); process.on('SIGHUP', close); process.on('SIGINT', close);
  if (process.env.HERDR_VISUALS_RECORD) {
    const socket = process.env.HERDR_VISUALS_RECORD + '.sock';
    await fs.rm(socket, { force: true });
    commandServer = net.createServer(connection => {
      let text = '';
      connection.setTimeout(2000, () => connection.destroy());
      connection.setEncoding('utf8');
      connection.on('error', () => {});
      connection.on('data', data => {
        text += data;
        if (text.length > 200000) { connection.destroy(); return; }
        if (!text.includes('\n')) return;
        try {
          const command = JSON.parse(text.slice(0, text.indexOf('\n')));
          if (typeof command.source !== 'string' || (command.selection && typeof command.selection !== 'string')) throw new Error('Invalid preview request');
          pendingCommand = command; dirty = true; connection.end('ok\n');
          void poll();
        } catch { connection.destroy(); }
      });
    });
    await new Promise((resolve, reject) => { commandServer.once('error', reject); commandServer.listen(socket, resolve); });
    await fs.chmod(socket, 0o600);
  }
  await poll(); await draw();
  let ticks = 0;
  timer = setInterval(() => { if (ticks++ % 5 === 0) void poll(); void draw(); }, 200);
}
main().catch(async error => {
  console.error(error.message);
  await renderer.close();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write('\x1b[?25h\x1b[?1049l');
  process.exitCode = 1;
});
