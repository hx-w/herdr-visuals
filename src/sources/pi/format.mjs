import { extract, digest } from '../../extract.mjs';
import { imageDataURL } from '../../images.mjs';

const BUDGET = 16 * 1024 * 1024;

function finalText(block) {
  if (block?.type !== 'text' || typeof block.text !== 'string') return '';
  try {
    if (JSON.parse(block.textSignature).phase === 'commentary') return '';
  } catch { /* providers may use an opaque signature or no signature */ }
  return block.text;
}

// Keep the complete ancestry, but bound retained message payloads. Cutting a
// byte tail first would lose parents and leak physically adjacent old branches.
export class PiSessionParser {
  constructor({ cwd, resolveImage, generatedImages = false } = {}) {
    this.cwd = cwd;
    this.resolveImage = resolveImage;
    this.generatedImages = generatedImages;
    this.entries = new Map();
    this.retained = [];
    this.bytes = 0;
    this.limited = false;
  }

  append(line) {
    if (!line.trim()) return;
    let row;
    try { row = JSON.parse(line); } catch { return; } // append-in-progress
    if (!this.header) {
      if (row.type === 'title') return;
      if (row.type !== 'session' || typeof row.id !== 'string' || !row.id) throw new Error('Not an omp/pi session transcript.');
      if (row.version !== 3) throw new Error('Unsupported omp/pi session version.');
      this.header = { id: row.id };
      if (typeof row.cwd === 'string') this.cwd = row.cwd;
      return;
    }
    if (typeof row.id !== 'string' || !Object.hasOwn(row, 'parentId')) return;
    const id = row.id;
    const previous = this.entries.get(id);
    if (previous?.answer || previous?.images?.length) {
      const index = this.retained.findIndex(item => item.entry === previous);
      if (index >= 0) this.bytes -= this.retained.splice(index, 1)[0].size;
    }
    const entry = { id, parentId: row.parentId, timestamp: row.timestamp };
    this.entries.set(id, entry); this.leaf = id;
    if (row.type !== 'message' || !row.message) return;
    const message = row.message;
    entry.role = message.role;
    if (!['assistant', 'toolResult'].includes(message.role)) return;
    if (message.role === 'assistant' && message.stopReason !== 'stop') return;
    if (message.role === 'toolResult' && message.isError) return;
    const content = Array.isArray(message.content) ? message.content : [];
    entry.answer = message.role === 'assistant' && !content.some(b => b.type === 'toolCall')
      ? content.map(finalText).filter(Boolean).join('\n') : '';
    entry.images = content.filter(b => b.type === 'image').map(image => ({
      type: 'image', data: image.data, mimeType: image.mimeType,
      image_url: typeof image.image_url === 'string' ? image.image_url : image.image_url?.url,
    }));
    entry.generated = this.generatedImages && message.role === 'toolResult' && message.toolName === 'generate_image';
    if (entry.generated && Array.isArray(message.details?.images)) {
      entry.images.push(...message.details.images.map(image => ({ type: 'image', data: image.data, mimeType: image.mimeType })));
    }
    if (!entry.answer.trim() && !entry.images.length) {
      delete entry.answer; delete entry.images;
      return;
    }
    const size = Buffer.byteLength(entry.answer) + entry.images.reduce((sum, image) => sum + (image.data?.length || image.image_url?.length || 0), 0);
    this.retained.push({ entry, size }); this.bytes += size;
    while (this.retained.length > 300 || (this.bytes > BUDGET && this.retained.length > 1)) {
      const removed = this.retained.shift(); this.bytes -= removed.size;
      delete removed.entry.answer; delete removed.entry.images; this.limited = true;
    }
    if (size > BUDGET) this.limited = true; // retain one complete large image
  }

  async snapshot() {
    const { header, entries, cwd, resolveImage } = this;
    if (!header) throw new Error('The bound session has no session header yet.');
    const branch = [], seen = new Set();
    let leaf = this.leaf;
    while (leaf !== null && leaf !== undefined) {
      if (seen.has(leaf)) throw new Error('Session ancestry contains a cycle.');
      seen.add(leaf);
      const entry = entries.get(leaf);
      if (!entry) throw new Error('Session ancestry is incomplete.');
      branch.push(entry); leaf = entry.parentId;
    }
    branch.reverse();
    const messages = [];
    let turn = 0, bytes = 0, limited = this.limited;
    const retain = message => {
      const size = Buffer.byteLength(message.text) + message.blocks.reduce((sum, block) => sum + (block.imageData?.length || 0), 0);
      messages.push({ message, size }); bytes += size;
      while (messages.length > 300 || (bytes > BUDGET && messages.length > 1)) {
        bytes -= messages.shift().size; limited = true;
      }
      if (size > BUDGET) limited = true;
    };
    for (const entry of branch) {
      if (entry.role === 'user') { turn++; continue; }
      if (entry.answer?.trim()) {
        const id = digest(`${header.id}:${entry.id}:${entry.answer}`);
        retain({ id, turn, text: entry.answer, timestamp: entry.timestamp, blocks: extract(entry.answer, id, cwd) });
      }
      for (const [index, image] of (entry.images || []).entries()) {
        let imageData = imageDataURL(image), source;
        if (!imageData && resolveImage) {
          const resolved = await resolveImage(image);
          imageData = resolved?.imageData;
          source = resolved?.source;
        }
        if (!imageData && !source) continue;
        const id = digest(`${header.id}:${entry.id}:image:${index}:${imageData || source}`);
        const title = entry.generated ? 'Generated image' : `Image ${index + 1}`;
        const context = `${title}\nEmbedded image displayed in this conversation.`;
        retain({ id, turn, kind: 'image', text: context, timestamp: entry.timestamp, blocks: [{
          id: `${id}:image`, messageId: id, type: 'image', source: source || title, title,
          context: 'Conversation image', ...(imageData ? { imageData } : {}), line: 1, raw: context, cwd,
        }] });
      }
    }
    return { messages: messages.map(item => item.message), sessionId: header.id, limited };
  }
}

export async function parsePiSession(text, options) {
  const parser = new PiSessionParser(options);
  const lines = typeof text === 'string' ? text.split('\n') : text;
  for await (const line of lines) parser.append(line);
  return parser.snapshot();
}
