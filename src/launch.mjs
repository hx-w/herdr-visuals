import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { rpc, PLUGIN, stateDir } from './herdr.mjs';
import { digest } from './extract.mjs';
import net from 'node:net';

async function notifyViewer(recordPath, message) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection(recordPath + '.sock');
        let acknowledged = false;
        socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('Visuals viewer did not respond')); });
        socket.on('error', reject);
        socket.on('connect', () => socket.end(JSON.stringify(message) + '\n'));
        socket.on('data', () => { acknowledged = true; socket.destroy(); resolve(); });
        socket.on('close', () => { if (!acknowledged) reject(new Error('Visuals closed before accepting the preview request')); });
      }); return;
    } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code) || attempt === 29) throw error;
      await delay(100);
    }
  }
}

async function main() {
  if (process.env.HERDR_ENV !== '1') throw new Error('Visuals must be launched inside Herdr.');
  const context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || '{}');
  if (process.argv.includes('--example')) context.selected_text = await fs.readFile(new URL('../examples/overview.md', import.meta.url), 'utf8');
  if ((context.selected_text || '').length > 150000) throw new Error('Selected text exceeds the 150,000 character limit.');
  const current = context.focused_pane_id
    ? (await rpc('pane.get', { pane_id: context.focused_pane_id })).pane
    : (await rpc('pane.current', { caller_pane_id: process.env.HERDR_PANE_ID })).pane;
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const key = digest(current.tab_id), lock = path.join(dir, `${key}.lock`);
  let locked = false;
  for (let i = 0; i < 80; i++) {
    try { await fs.mkdir(lock); locked = true; break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await fs.stat(lock).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 30000) await fs.rmdir(lock).catch(() => {});
      await delay(100);
    }
  }
  if (!locked) throw new Error('Another Visuals action is still opening a pane.');
  try {
    const recordPath = path.join(dir, `${key}.json`);
    let record;
    try { record = JSON.parse(await fs.readFile(recordPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
    const { panes } = await rpc('pane.list', { workspace_id: current.workspace_id });
    const existing = panes.find(p => p.pane_id === record?.pane_id && p.terminal_id === record?.terminal_id && p.tab_id === current.tab_id);
    if (existing) {
      if (existing.pane_id === current.pane_id) {
        await rpc('plugin.pane.close', { pane_id: existing.pane_id });
        await fs.rm(recordPath, { force: true });
      } else {
        await notifyViewer(recordPath, { source: current.pane_id, cwd: current.foreground_cwd || current.cwd, selection: context.selected_text || '', request: Date.now() });
        await rpc('plugin.pane.focus', { pane_id: existing.pane_id });
      }
      return;
    }
    const result = await rpc('plugin.pane.open', {
      plugin_id: PLUGIN, entrypoint: 'viewer', placement: 'split', direction: 'right',
      target_pane_id: current.pane_id,
      cwd: current.foreground_cwd || current.cwd || process.cwd(), focus: true,
      env: { HERDR_VISUALS_SOURCE: current.pane_id, HERDR_VISUALS_RECORD: recordPath },
    });
    const pane = result.plugin_pane.pane;
    await fs.writeFile(recordPath, JSON.stringify({ pane_id: pane.pane_id, terminal_id: pane.terminal_id,
      source: current.pane_id }), { mode: 0o600 });
    if (context.selected_text) await notifyViewer(recordPath, { source: current.pane_id,
      cwd: current.foreground_cwd || current.cwd, selection: context.selected_text, request: Date.now() });
  } finally { await fs.rmdir(lock).catch(() => {}); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
