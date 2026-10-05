import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse as parseToml } from 'smol-toml';
import { CodexHistory, sessionID } from './history.mjs';
import { parseRollout } from './rollout.mjs';
import { unavailable } from '../contract.mjs';
import { rpc } from '../../herdr.mjs';

export class CodexSource {
  agent = 'codex';
  label = 'Codex';

  constructor({ codexHome = process.env.HERDR_VISUALS_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    history, readFooter } = {}) {
    this.codexHome = codexHome; this.cache = new Map(); this.footerPanes = new Set();
    this.history = history || new CodexHistory(codexHome);
    this.readFooter = readFooter || (async pane => (await rpc('pane.read', { pane_id: pane.pane_id, source: 'visible', lines: 3 })).read.text);
  }
  async resolvePane(pane) {
    if (!pane.pane_id) return pane;
    const key = `${pane.pane_id}:${pane.terminal_id || ''}`;
    const fallback = () => this.footerPanes.has(key) ? { ...pane, agent_session: undefined } : pane;
    if (pane.agent !== 'codex') return fallback();
    let configured;
    try {
      const config = parseToml(await fs.readFile(path.join(this.codexHome, 'config.toml'), 'utf8'));
      configured = ['thread-id', 'session-id'].includes(config.tui?.status_line?.[0]);
    } catch { return fallback(); }
    if (!configured) return fallback();
    // This is only the live footer's explicit identifier, never a transcript,
    // status card in scrollback, title substring, or cwd/session-list heuristic.
    let text;
    try { text = await this.readFooter(pane); } catch { return fallback(); }
    if (typeof text !== 'string') return fallback();
    const footer = text.trimEnd().split('\n').slice(-3);
    const matches = footer.map(line => line.trim().match(/^([a-f\d-]{36})(?:\s+[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])?\s+·\s+/i)?.[1]).filter(id => sessionID.test(id || ''));
    // Once a terminal supplies live identity, missing/ambiguous identity must
    // clear it rather than falling back to an older hook's session.
    if (matches.length !== 1) return fallback();
    this.footerPanes.add(key);
    return { ...pane, agent_session: { agent: 'codex', kind: 'id', value: matches[0], source: 'visuals:codex-footer' } };
  }
  close() { this.history.close?.(); }
  async resolve(id) {
    if (!/^[a-f\d-]{36}$/i.test(id || '')) return null;
    const cached = this.cache.get(id);
    if (cached?.file || (cached && Date.now() - cached.at < 10000)) return cached?.file;
    let file = null;
    // UUIDv7 gives the creation date, avoiding a directory-wide walk in the common case.
    const millis = parseInt(id.replaceAll('-', '').slice(0, 12), 16);
    const date = new Date(millis);
    const guess = path.join(this.codexHome, 'sessions', String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0'));
    try { file = (await fs.readdir(guess)).find(n => n.endsWith(`${id}.jsonl`)); if (file) file = path.join(guess, file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!file) {
      for (const directory of ['sessions', 'archived_sessions']) {
        for await (const candidate of fs.glob(`**/*${id}.jsonl`, { cwd: path.join(this.codexHome, directory) })) {
          file = path.join(this.codexHome, directory, candidate); break;
        }
        if (file) break;
      }
    }
    this.cache.set(id, { at: Date.now(), file });
    return file;
  }
  async read(pane) {
    if (pane.agent_session?.agent === 'codex' && pane.agent_session.kind === 'id') {
      const id = pane.agent_session.value;
      if (!sessionID.test(id || '')) return unavailable(this.agent, this.label, true);
      try {
        const current = await this.history.read(id);
        if (current) return { messages: parseRollout(current.rows.map(row => JSON.stringify(row)).join('\n'), { cwd: current.cwd || pane.foreground_cwd || pane.cwd }), origin: 'Codex history', limited: current.limited, issue: null };
      } catch (error) {
        // A known active server failure must not silently show a stale snapshot.
        return { ...unavailable(this.agent, this.label, true), issue: { title: 'The bound Codex history is unavailable.', hint: error.message } };
      }
      let file = await this.resolve(id);
      if (file) {
        try { await fs.access(file); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          this.cache.delete(id); this.last = null; file = await this.resolve(id);
        }
      }
      if (file) {
        const stat = await fs.stat(file);
        if (this.last?.file === file && this.last.size === stat.size && this.last.mtime === stat.mtimeMs) return this.last.value;
        const handle = await fs.open(file, 'r');
        let text;
        try {
          const start = Math.max(0, stat.size - 16 * 1024 * 1024);
          const buffer = Buffer.alloc(stat.size - start);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
          text = buffer.subarray(0, bytesRead).toString('utf8');
        } finally { await handle.close(); }
        const value = { messages: parseRollout(text, { cwd: pane.foreground_cwd || pane.cwd }), origin: 'Codex transcript', limited: stat.size > 16 * 1024 * 1024, issue: null };
        this.last = { file, size: stat.size, mtime: stat.mtimeMs, value };
        return value;
      }
    }
    // A terminal's scrollback can contain earlier sessions. Never use it as
    // a substitute for the exact session transcript.
    return unavailable(this.agent, this.label, pane.agent_session?.agent === this.agent && pane.agent_session.kind === 'id',
      "Enable thread-id first in the Codex status line; or check Herdr's SessionStart binding.");
  }
}
