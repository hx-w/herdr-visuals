import { createHash } from 'node:crypto';
import path from 'node:path';
import { imageReferences } from './images.mjs';

export const digest = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
const cleanHeading = text => text.replace(/^\s*(?:#{1,6}\s+|\d+[.)、]\s*)/, '').replace(/\*\*/g, '').replace(/[:：]\s*$/, '').trim();

// Consume complete blocks only. Never inspect code fences for embedded math.
export function extract(text, messageId = 'selection', cwd) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let title = '', context = '';
  function add(type, source, start, end) {
    source = source.trim();
    if (!source) return;
    blocks.push({ id: `${messageId}:${start}:${digest(source)}`, messageId, type, source,
      title: title || (type === 'mermaid' ? 'Diagram' : 'Equation'), context,
      line: start + 1, raw: lines.slice(start, end + 1).join('\n'), cwd });
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w-]*)[^\n]*$/);
    if (fence) {
      const start = i, char = fence[1][0], count = fence[1].length;
      let end = i + 1;
      while (end < lines.length && !new RegExp(`^\\s*${char}{${count},}\\s*$`).test(lines[end])) end++;
      if (end === lines.length) break;
      const type = fence[2].toLowerCase();
      if (type === 'mermaid') add('mermaid', lines.slice(i + 1, end).join('\n'), start, end);
      if (['math', 'latex', 'tex'].includes(type)) add('math', lines.slice(i + 1, end).join('\n'), start, end);
      i = end; continue;
    }
    const trimmed = line.trim();
    const delimiter = trimmed.startsWith('$$') ? ['$$', '$$'] : trimmed.startsWith('\\[') ? ['\\[', '\\]'] : null;
    if (delimiter) {
      const start = i, rest = trimmed.slice(2), inlineEnd = rest.indexOf(delimiter[1]);
      if (inlineEnd >= 0) { add('math', rest.slice(0, inlineEnd), start, i); continue; }
      const body = [rest];
      let end = i + 1, complete = false;
      for (; end < lines.length; end++) {
        const at = lines[end].indexOf(delimiter[1]);
        if (at >= 0) { body.push(lines[end].slice(0, at)); complete = true; break; }
        body.push(lines[end]);
      }
      if (!complete) break;
      add('math', body.join('\n'), start, end); i = end; continue;
    }
    if (/^\s*#{1,6}\s|^\s*\*\*.+\*\*\s*[:：]?\s*$/.test(line)) title = cleanHeading(line);
    for (const ref of imageReferences(line)) {
      if (blocks.some(b => b.type === 'image' && b.source === ref.source)) continue;
      blocks.push({ id: `${messageId}:image:${digest(ref.source)}`, messageId, type: 'image', source: ref.source,
        title: ref.label || path.basename(ref.source), context: title, line: i + 1, raw: line, cwd });
    }
    if (trimmed && !/^\s{4}/.test(line)) context = cleanHeading(line);
  }
  return blocks;
}

export function extractSelection(text, cwd) {
  const blocks = extract(text, 'selection', cwd);
  if (blocks.length) return blocks;
  if (/^\s*(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|mindmap|timeline|gitGraph|journey|xychart)\b/.test(text)) {
    return extract('```mermaid\n' + text + '\n```', 'selection', cwd).map(b => ({ ...b, line: 1, raw: text }));
  }
  // Explicit selection can opt into raw math; automatic discovery never does.
  if (/\\[a-zA-Z]+|[_^{}=]/.test(text)) return extract('$$\n' + text + '\n$$', 'selection', cwd).map(b => ({ ...b, line: 1, raw: text }));
  return [];
}
