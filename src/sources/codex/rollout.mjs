import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { extract, digest } from '../../extract.mjs';
import { imageDataURL, IMAGE_EXT, resolveImage } from '../../images.mjs';

function outputContent(output) {
  if (typeof output === 'string') {
    try { output = JSON.parse(output); } catch { return []; }
  }
  const content = Array.isArray(output) ? output : output?.content;
  return Array.isArray(content) ? content : [];
}

function generatedImage(row) {
  let p = row.payload;
  if (row.type === 'event_msg' && p?.type === 'item_completed' &&
      (p.item?.type === 'ImageGeneration' ||
       (p.item?.type === 'Extension' && p.item.kind === 'image_gen.generation'))) {
    p = { ...p.item, saved_path: p.item.savedPath ?? p.item.saved_path };
  } else if (!(row.type === 'event_msg' && p?.type === 'image_generation_end') &&
      !(row.type === 'response_item' && p?.type === 'image_generation_call')) return null;
  if (p.status !== 'completed' || p.failure) return null;
  const imageData = imageDataURL({ type: 'image', mimeType: 'image/png', data: p.result });
  let source;
  if (typeof p.saved_path === 'string') {
    try {
      if (path.isAbsolute(p.saved_path) || p.saved_path.startsWith('file://')) {
        const file = resolveImage(p.saved_path);
        if (IMAGE_EXT.test(file)) source = file;
      }
    } catch { /* remote or malformed saved paths are not image sources */ }
  }
  return imageData || source ? { imageData, source, callId: p.call_id || p.id } : null;
}

export function parseRollout(text, { cwd } = {}) {
  const messages = [], generatedCalls = new Map();
  let turn = 0;
  function addImage(row, index, { imageData, source, callId }, generated = false) {
    const id = digest(`${row.timestamp}:${callId || row.payload.call_id || row.payload.id || ''}:${index}:${imageData || source}`);
    const title = generated ? 'Generated image' : `Image ${index + 1}`;
    const text = `${title}\n${generated ? 'Generated image' : 'Embedded image displayed'} in this conversation.`;
    messages.push({ id, turn, kind: 'image', text, timestamp: row.timestamp, blocks: [{
      id: `${id}:image`, messageId: id, type: 'image', source: source || title, title,
      context: 'Conversation image', ...(imageData ? { imageData } : {}), line: 1, raw: text, cwd,
    }] });
    return messages.at(-1);
  }
  function mergeImage(message, { imageData, source }) {
    const block = message.blocks[0];
    const nextData = block.imageData || imageData;
    const nextSource = source || block.source;
    if (nextData === block.imageData && nextSource === block.source) return;
    // An appended embedded result must invalidate a previously rendered file
    // fallback, including a missing-file error, without changing source scope.
    message.id = digest(`${message.id}:${nextSource}:${nextData || ''}`);
    Object.assign(block, { source: nextSource, ...(nextData ? { imageData: nextData } : {}), id: `${message.id}:image`, messageId: message.id });
  }
  for (const line of text.split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; } // append-in-progress or tail starts mid-record
    const p = row.payload;
    if (['session_meta', 'turn_context'].includes(row.type) && typeof p?.cwd === 'string') cwd = p.cwd;
    const generated = generatedImage(row);
    if (generated) {
      const key = generated.callId && `${turn}:${generated.callId}`;
      const previous = key && generatedCalls.get(key);
      if (previous) {
        mergeImage(previous, generated);
      } else {
        const message = addImage(row, 0, generated, true);
        if (key) generatedCalls.set(key, message);
      }
      continue;
    }
    if (row.type === 'response_item' && p?.type === 'image_view') {
      try {
        if (typeof p.path === 'string' && path.isAbsolute(p.path) && IMAGE_EXT.test(p.path)) {
          addImage(row, 0, { source: resolveImage(p.path) });
        }
      } catch { /* invalid typed paths do not become image sources */ }
      continue;
    }
    if (row.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(p?.type)) {
      const content = outputContent(p.output);
      const images = content.map(imageDataURL).filter(Boolean);
      // Code-mode output has a different call ID. Its saved-path hint can match
      // an already validated generation record; text alone never creates items.
      const hints = content.filter(c => c.type === 'input_text' && typeof c.text === 'string').map(c => c.text);
      const matches = images.length === 1 ? [...generatedCalls.values()].filter(m => {
        const source = m.blocks[0].source;
        return m.turn === turn && path.isAbsolute(source) && hints.some(t =>
          [source, pathToFileURL(source).href].some(value => t.includes(` as ${value} by default.`)));
      }) : [];
      images.forEach((imageData, index) => {
        const generated = index === 0 && (generatedCalls.get(`${turn}:${p.call_id}`) || (matches.length === 1 && matches[0]));
        if (generated) mergeImage(generated, { imageData });
        else addImage(row, index, { imageData });
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
