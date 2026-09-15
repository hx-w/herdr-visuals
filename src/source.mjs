import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extract, digest } from './extract.mjs';
import { imageDataURL } from './images.mjs';

function outputImages(output) {
  if (typeof output === 'string') {
    try { output = JSON.parse(output); } catch { return []; }
  }
  const content = Array.isArray(output) ? output : output?.content;
  return Array.isArray(content) ? content.map(imageDataURL).filter(Boolean) : [];
}

export function parseRollout(text, { cwd } = {}) {
  const messages = [];
  let turn = 0;
  for (const line of text.split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; } // append-in-progress or tail starts mid-record
    const p = row.payload;
    if (['session_meta', 'turn_context'].includes(row.type) && typeof p?.cwd === 'string') cwd = p.cwd;
    if (row.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(p?.type)) {
      outputImages(p.output).forEach((imageData, index) => {
        const id = digest(`${row.timestamp}:${p.call_id || ''}:${index}:${imageData}`);
        const title = `Image ${index + 1}`;
        const text = `${title}\nEmbedded image displayed in this conversation.`;
        messages.push({ id, turn, kind: 'image', text, timestamp: row.timestamp, blocks: [{
          id: `${id}:image`, messageId: id, type: 'image', source: title, title,
          context: 'Conversation image', imageData, line: 1, raw: text, cwd,
        }] });
      });
      continue;
    }
    if (row.type !== 'response_item' || p?.type !== 'message') continue;
    if (p.role === 'user') { turn++; continue; }
    if (p.role !== 'assistant' || (p.phase && !['final', 'final_answer'].includes(p.phase))) continue;
    const content = (p.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('\n');
    if (!content.trim()) continue;
    const id = digest(`${row.timestamp}:${p.id || ''}:${content}`);
    messages.push({ id, turn, text: content, timestamp: row.timestamp, blocks: extract(content, id, cwd) });
  }
  return messages.slice(-300);
}

export class SourceReader {
  constructor({ codexHome = process.env.HERDR_VISUALS_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex') } = {}) {
    this.codexHome = codexHome; this.cache = new Map();
  }
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
        const value = { messages: parseRollout(text, { cwd: pane.foreground_cwd || pane.cwd }), origin: 'Codex transcript', limited: stat.size > 16 * 1024 * 1024 };
        this.last = { file, size: stat.size, mtime: stat.mtimeMs, value };
        return value;
      }
    }
    // A terminal's scrollback can contain earlier sessions. Never use it as
    // a substitute for the exact session transcript.
    return { messages: [], origin: 'Exact Codex transcript unavailable · select text to preview', limited: false };
  }
}
