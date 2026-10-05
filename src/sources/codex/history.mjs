import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import packageMetadata from '../../../package.json' with { type: 'json' };

export const sessionID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const maxBytes = 16 * 1024 * 1024;

// Read-only connection to the already-running local server. Never start/resume
// a thread, enumerate sessions, or run a command to discover a conversation.
export class CodexHistory {
  constructor(codexHome) {
    this.path = path.join(codexHome, 'app-server-control', 'app-server-control.sock');
    this.pending = new Map();
  }
  async connect() {
    if (this.ready) return this.ready;
    await fs.access(this.path);
    this.ready = new Promise((resolve, reject) => {
      const socket = this.socket = new WebSocket('ws://localhost/', {
        createConnection: () => net.createConnection(this.path),
        // A single original image can exceed the history budget. Keep its
        // complete record; bound the retained history rather than its pixels.
        handshakeTimeout: 3000, maxPayload: 0,
      });
      socket.on('error', reject);
      socket.on('message', data => {
        let reply;
        try { reply = JSON.parse(data.toString()); } catch { return; }
        const pending = this.pending.get(reply.id);
        if (!pending) return; // no subscriptions or unsolicited notifications
        this.pending.delete(reply.id); clearTimeout(pending.timer);
        if (reply.error) pending.reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }));
        else pending.resolve(reply.result);
      });
      socket.on('close', () => {
        this.ready = null;
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer); pending.reject(new Error('Codex history disconnected'));
        }
        this.pending.clear();
      });
      socket.once('open', async () => {
        try {
          await this.request('initialize', { clientInfo: { name: 'herdr-visuals', version: packageMetadata.version }, capabilities: { experimentalApi: true } });
          socket.send(JSON.stringify({ method: 'initialized' })); resolve();
        } catch (error) { reject(error); socket.close(); }
      });
    });
    try { await this.ready; } catch (error) { this.close(); throw error; }
  }
  request(method, params) {
    if (!['initialize', 'thread/read', 'thread/items/list'].includes(method)) throw new Error('Codex history is read-only');
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex history timed out')); }, 3000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  async read(id) {
    if (!sessionID.test(id || '')) return null;
    try { await this.connect(); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const { thread } = await this.request('thread/read', { threadId: id, includeTurns: false });
    if (thread?.id !== id) throw new Error('Codex history returned a different session');
    if (thread.historyMode !== 'paginated') return null;
    const entries = [], cursors = new Set();
    let cursor, bytes = 0, limited = false;
    for (let page = 0; page < 100; page++) {
      const result = await this.request('thread/items/list', { threadId: id, sortDirection: 'desc', limit: 10, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result.data)) throw new Error('Invalid Codex history page');
      for (const entry of result.data) {
        entries.push(entry);
        bytes += Buffer.byteLength(JSON.stringify(entry));
        if (bytes > maxBytes) { limited = true; break; }
      }
      if (limited || !result.nextCursor) break;
      limited = page === 99;
      cursor = result.nextCursor;
      if (cursors.has(cursor)) throw new Error('Codex history pagination did not advance');
      cursors.add(cursor);
    }
    return { rows: historyRows(entries.reverse()), cwd: thread.cwd, limited };
  }
  close() { this.socket?.terminate(); this.ready = null; }
}

export function historyRows(entries) {
  const rows = []; let turn;
  for (const { item, turnId, startedAtMs, completedAtMs } of entries) {
    if (!item) continue;
    if (turnId !== turn) {
      turn = turnId;
      rows.push({ type: 'response_item', payload: { type: 'message', role: 'user' } });
    }
    const timestamp = startedAtMs ?? completedAtMs ?? item.id;
    let payload;
    if (item.type === 'agentMessage') payload = { type: 'message', role: 'assistant', id: item.id, phase: item.phase, content: [{ type: 'output_text', text: item.text }] };
    else if (item.type === 'functionCallOutput') payload = { type: 'function_call_output', id: item.id, output: item.output };
    else if (item.type === 'mcpToolCall' && item.status === 'completed') payload = { type: 'function_call_output', id: item.id, output: item.result };
    else if (item.type === 'dynamicToolCall' && item.status === 'completed') payload = { type: 'function_call_output', id: item.id, output: (item.contentItems || []).flatMap(c => c.type === 'inputImage' ? [{ type: 'input_image', image_url: c.imageUrl }] : c.type === 'inputText' ? [{ type: 'input_text', text: c.text }] : []) };
    else if (item.type === 'imageView') payload = { type: 'image_view', id: item.id, path: item.path };
    else if (item.type === 'imageGeneration') payload = { type: 'image_generation_call', id: item.id, status: item.status, result: item.result, failure: item.failure, saved_path: item.savedPath };
    if (payload) rows.push({ type: 'response_item', timestamp, payload });
  }
  return rows;
}
