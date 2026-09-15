import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';

export const IMAGE_EXT = /\.(?:png|jpe?g|webp|gif|bmp|avif|svg)$/i;

// Only image content blocks may supply embedded pixels. Never turn tool text,
// arbitrary JSON strings, or remote/file URLs into automatic image sources.
export function imageDataURL(content) {
  if (!['input_image', 'output_image', 'image'].includes(content?.type)) return null;
  const url = typeof content.image_url === 'string' ? content.image_url : content.image_url?.url;
  const data = url || (typeof content.data === 'string' && typeof content.mimeType === 'string'
    ? `data:${content.mimeType};base64,${content.data}` : null);
  if (typeof data !== 'string' || !/^data:image\/(?:png|jpeg|webp|gif|bmp|avif|svg\+xml);base64,/i.test(data)) return null;
  const encoded = data.slice(data.indexOf(',') + 1);
  if (!encoded.length || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  return data;
}

export function imageReferences(line) {
  const refs = [], occupied = [];
  const add = (source, label, start, end) => {
    if (!IMAGE_EXT.test(source) || /^(?:https?:|data:)/i.test(source)) return;
    if (occupied.some(([a, b]) => start >= a && start < b)) return;
    refs.push({ source, label }); occupied.push([start, end]);
  };
  // Angle-bracket destinations support spaces and parentheses in local filenames.
  const markdown = /!?\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/g;
  for (const m of line.matchAll(markdown)) add(m[2] || m[3], m[1], m.index, m.index + m[0].length);
  for (const m of line.matchAll(/`([^`\n]+)`/g)) add(m[1], '', m.index, m.index + m[0].length);
  for (const m of line.matchAll(/(?:^|[\s("'])((?:file:\/\/|~\/|\/|\.\.?\/)[^\s<>"'`]+?\.(?:png|jpe?g|webp|gif|bmp|avif|svg))(?=$|[\s),.;:!?])/gi)) {
    const start = m.index + m[0].indexOf(m[1]); add(m[1], '', start, start + m[1].length);
  }
  return refs;
}

export function resolveImage(reference, cwd) {
  let value = reference;
  if (value.startsWith('file://')) return fileURLToPath(value);
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) throw new Error('Only local image paths and file:// links are supported.');
  try { value = decodeURIComponent(value); } catch { /* literal percent in a filename */ }
  if (value.startsWith('~/')) value = path.join(os.homedir(), value.slice(2));
  if (!path.isAbsolute(value) && !cwd) throw new Error('Relative image path needs a source working directory.');
  return path.resolve(cwd || '.', value);
}

export async function readImage(reference, cwd) {
  const file = resolveImage(reference, cwd);
  // O_NONBLOCK prevents a path or symlink to a FIFO from hanging before fstat.
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Image path is not a regular file.');
    const buffer = Buffer.alloc(stat.size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const part = await handle.read(buffer, bytesRead, Math.min(1024 * 1024, buffer.length - bytesRead), bytesRead);
      if (!part.bytesRead) break;
      bytesRead += part.bytesRead;
    }
    const after = await handle.stat();
    if (bytesRead !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Image changed while loading. Try again.');
    const bytes = buffer.subarray(0, bytesRead);
    const head = bytes.subarray(0, 512).toString('utf8');
    let mime;
    if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime = 'image/png';
    else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
    else if (/^GIF8[79]a/.test(head)) mime = 'image/gif';
    else if (head.startsWith('RIFF') && bytes.subarray(8, 12).toString() === 'WEBP') mime = 'image/webp';
    else if (head.startsWith('BM')) mime = 'image/bmp';
    else if (bytes.subarray(4, 8).toString() === 'ftyp' && /avif|avis/.test(bytes.subarray(8, 32).toString())) mime = 'image/avif';
    else if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)?<svg\b/i.test(head)) mime = 'image/svg+xml';
    else throw new Error('File is not a supported PNG, JPEG, WebP, GIF, BMP, AVIF, or SVG image.');
    return { file, mime, bytes, revision: `${stat.mtimeMs}:${stat.size}`, dataURL: `data:${mime};base64,${bytes.toString('base64')}` };
  } finally { await handle.close(); }
}
