import { digest, extract } from '../../extract.mjs';
import { imageDataURL } from '../../images.mjs';

const BUDGET = 16 * 1024 * 1024;
const entryTypes = new Set(['user', 'assistant', 'progress', 'system', 'attachment']);
const main = row => !row.isSidechain && !row.teamName && !row.isMeta && !row.agentId && !row.parent_tool_use_id;

// Schema evidence: Anthropic's SDK _internal/sessions.py reconstructs uuid /
// parentUuid ancestry and does not follow compact-boundary logicalParentUuid.
// https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/sessions.py
// Complete assistant blocks share message.id, even when stop_reason is null:
// https://code.claude.com/docs/en/agent-sdk/streaming-output#message-flow
// Typed tool_result images use image.source.{type,media_type,data}:
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls
// This file observes persisted complete blocks, not token-level live events;
// a later tool block can reclassify an earlier same-API text block as tool chatter.
export class ClaudeSessionParser {
  constructor({ cwd } = {}) {
    this.cwd = cwd;
    this.entries = new Map();
    this.retained = [];
    this.bytes = 0;
    this.position = 0;
    this.toolApis = new Map();
    this.limited = false;
  }

  append(line) {
    if (!line.trim()) return;
    const { entries, retained, cwd } = this;
    let bytes = this.bytes;
    let row;
    try { row = JSON.parse(line); } catch { return; } // incomplete append
    if (!row || !entryTypes.has(row.type) || typeof row.uuid !== 'string' || !row.uuid ||
        !Object.hasOwn(row, 'parentUuid')) return;
    if (main(row) && typeof row.sessionId === 'string' && row.sessionId) {
      if (this.sessionId && this.sessionId !== row.sessionId) throw new Error('Claude transcript contains conflicting session identities.');
      this.sessionId = row.sessionId;
    }
    const previous = entries.get(row.uuid);
    if (previous?.type === 'assistant' && (previous.hasTool || previous.toolStop || previous.failed)) {
      const count = this.toolApis.get(previous.apiId) - 1;
      if (count) this.toolApis.set(previous.apiId, count);
      else this.toolApis.delete(previous.apiId);
    }
    if (previous?.answer || previous?.images?.length) {
      const index = retained.findIndex(item => item.entry === previous);
      if (index >= 0) bytes -= retained.splice(index, 1)[0].size;
      this.bytes = bytes;
    }
    const entry = { id: row.uuid, parent: row.parentUuid, type: row.type, position: this.position++,
      visible: main(row), timestamp: row.timestamp, cwd: typeof row.cwd === 'string' ? row.cwd : cwd };
    entries.set(entry.id, entry); // repeated persisted UUID replaces, never duplicates
    if (!entry.visible || !row.message || row.message.role !== row.type) return;
    const content = Array.isArray(row.message.content) ? row.message.content : [];
    entry.apiId = typeof row.message.id === 'string' && row.message.id ? row.message.id : entry.id;
    entry.tools = content.filter(block => block?.type === 'tool_use' && typeof block.id === 'string').map(block => block.id);
    entry.hasTool = content.some(block => block?.type === 'tool_use' || block?.type === 'server_tool_use');
    entry.toolStop = row.message.stop_reason === 'tool_use';
    entry.failed = !!row.error || row.isApiErrorMessage === true;
    entry.prompt = row.type === 'user' && !content.some(block => block?.type === 'tool_result');
    if (row.type === 'assistant' && (entry.hasTool || entry.toolStop || entry.failed)) {
      this.toolApis.set(entry.apiId, (this.toolApis.get(entry.apiId) || 0) + 1);
      // A later complete tool block reclassifies earlier text of this API call.
      for (let index = retained.length - 1; index >= 0; index--) {
        const item = retained[index];
        if (item.entry.type !== 'assistant' || item.entry.apiId !== entry.apiId) continue;
        bytes -= item.size; retained.splice(index, 1);
        delete item.entry.answer; delete item.entry.images;
      }
      this.bytes = bytes;
    }
    entry.answer = row.type === 'assistant' && !this.toolApis.has(entry.apiId)
      ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';
    entry.images = row.type === 'user' ? content.filter(block => block?.type === 'tool_result' && !block.is_error &&
      typeof block.tool_use_id === 'string' && Array.isArray(block.content)).flatMap(result => result.content
      .filter(block => block?.type === 'image' && block.source?.type === 'base64')
      .map(block => ({ toolId: result.tool_use_id, data: block.source.data, mimeType: block.source.media_type }))) : [];
    if (!entry.answer.trim() && !entry.images.length) {
      delete entry.answer; delete entry.images;
      return;
    }
    const size = Buffer.byteLength(entry.answer) + entry.images.reduce((sum, image) => sum + (image.data?.length || 0), 0);
    retained.push({ entry, size }); bytes += size;
    while (retained.length > 300 || (bytes > BUDGET && retained.length > 1)) {
      const removed = retained.shift(); bytes -= removed.size;
      delete removed.entry.answer; delete removed.entry.images; this.limited = true;
    }
    if (size > BUDGET) this.limited = true; // retain a complete large typed image
    this.bytes = bytes;
  }

  async snapshot() { return snapshotClaude(this); }
}

function snapshotClaude({ entries, sessionId, limited }) {
  if (!sessionId) throw new Error('The bound Claude transcript has no main-session identity yet.');
  const parents = new Set([...entries.values()].map(entry => entry.parent).filter(Boolean));
  let leaf;
  for (const terminal of entries.values()) {
    if (parents.has(terminal.id)) continue;
    let current = terminal;
    const seen = new Set();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.visible && ['user', 'assistant'].includes(current.type)) {
        if (!leaf || current.position > leaf.position) leaf = current;
        break;
      }
      current = entries.get(current.parent);
    }
  }
  if (!leaf && [...entries.values()].some(entry => entry.visible && ['user', 'assistant'].includes(entry.type))) {
    throw new Error('Claude transcript ancestry contains a cycle.');
  }
  const chain = [], seen = new Set();
  while (leaf) {
    if (seen.has(leaf.id)) throw new Error('Claude transcript ancestry contains a cycle.');
    seen.add(leaf.id); chain.push(leaf);
    if (leaf.parent === null) break;
    leaf = entries.get(leaf.parent);
    if (!leaf) throw new Error('Claude transcript ancestry is incomplete.');
  }
  chain.reverse();
  const messages = [], groups = new Map(), toolIds = new Set();
  let turn = 0;
  for (const entry of chain) {
    if (!entry.visible) continue;
    if (entry.prompt) turn++;
    for (const id of entry.tools || []) toolIds.add(id);
    if (entry.type === 'assistant') {
      const key = `${turn}:${entry.apiId}`;
      let group = groups.get(key);
      if (!group) {
        group = { entry, turn, text: [], tool: false };
        groups.set(key, group); messages.push(group);
      }
      group.tool ||= entry.hasTool || entry.toolStop || entry.failed;
      if (entry.answer?.trim()) group.text.push(entry.answer);
    }
    for (const [index, image] of (entry.images || []).entries()) {
      if (!toolIds.has(image.toolId)) continue;
      const imageData = imageDataURL({ type: 'image', data: image.data, mimeType: image.mimeType });
      if (!imageData) continue;
      const id = digest(`${sessionId}:${entry.id}:image:${index}:${imageData}`);
      const title = `Image ${index + 1}`, text = `${title}\nEmbedded image displayed in this conversation.`;
      messages.push({ id, turn, kind: 'image', text, timestamp: entry.timestamp, blocks: [{
        id: `${id}:image`, messageId: id, type: 'image', imageData, source: title, title,
        context: 'Conversation image', line: 1, raw: text, cwd: entry.cwd,
      }] });
    }
  }
  const output = messages.flatMap(message => {
    if (!message.entry) return [message];
    if (message.tool || !message.text.length) return [];
    const text = message.text.join('\n'), { entry } = message;
    const id = digest(`${sessionId}:${entry.apiId}:${text}`);
    return [{ id, turn: message.turn, text, timestamp: entry.timestamp, blocks: extract(text, id, entry.cwd) }];
  });
  return { messages: output.slice(-300), sessionId, limited: limited || output.length > 300 };
}

export async function parseClaudeSession(input, options) {
  const parser = new ClaudeSessionParser(options);
  const lines = typeof input === 'string' ? input.split('\n') : input;
  for await (const line of lines) parser.append(line);
  return parser.snapshot();
}
