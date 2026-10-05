import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const GUARD_BYTES = 4096;

async function boundary(handle, size) {
  const prefix = Buffer.alloc(Math.min(size, GUARD_BYTES));
  const tail = Buffer.alloc(Math.min(size, GUARD_BYTES));
  await handle.read(prefix, 0, prefix.length, 0);
  await handle.read(tail, 0, tail.length, Math.max(0, size - tail.length));
  return { prefix, tail };
}

function sameBoundary(left, right) {
  return left.prefix.equals(right.prefix) && left.tail.equals(right.tail);
}

/**
 * One exact, read-only JSONL file and one decoder state. Unchanged polls use
 * fstat only. Append-only journals feed new bytes to the parser; replacement,
 * truncation, option changes and modified read boundaries rebuild the state.
 * Prefix/tail guards protect session identity and the last consumed boundary.
 */
export class TranscriptFile {
  constructor(Parser) { this.Parser = Parser; }

  read(file, options) {
    const result = (this.pending || Promise.resolve()).then(() => this.#read(file, options));
    this.pending = result.catch(() => {}); // failures must not poison the next exact read
    return result;
  }

  async #read(file, { cwd, parseOptions } = {}) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || /[\x00-\x1f\x7f]/.test(file)) {
      throw new Error('Session binding must name an absolute local file.');
    }
    let handle;
    try {
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Session path is not a regular file.');
      const previous = this.previous;
      const sameFile = previous?.file === file && previous.ino === stat.ino &&
        previous.cwd === cwd && previous.parseOptions === parseOptions;
      if (sameFile && previous.size === stat.size && previous.mtime === stat.mtimeMs && previous.ctime === stat.ctimeMs) return previous;
      const append = sameFile && stat.size > previous.size &&
        sameBoundary(previous.boundary, await boundary(handle, previous.size));
      const guard = await boundary(handle, stat.size);
      if (!append) this.state = { parser: new this.Parser({ cwd, ...parseOptions }), decoder: new StringDecoder('utf8'), fragments: [] };
      const state = this.state;
      const start = append ? previous.size : 0;
      if (stat.size > start) {
        for await (const chunk of handle.createReadStream({ autoClose: false, start, end: stat.size - 1 })) {
          const text = state.decoder.write(chunk);
          let from = 0, end;
          while ((end = text.indexOf('\n', from)) >= 0) {
            const part = text.slice(from, end);
            const line = state.fragments.length ? state.fragments.join('') + part : part;
            state.fragments.length = 0;
            if (line.trim()) state.parser.append(line);
            from = end + 1;
          }
          if (from < text.length) state.fragments.push(text.slice(from));
        }
      }
      // Do not commit an in-progress JSONL line (or partial UTF-8 sequence).
      // The same decoder and fragments continue when the writer appends it.
      if (!sameBoundary(guard, await boundary(handle, stat.size))) throw new Error('Session changed while reading. Refreshing records.');
      const result = await state.parser.snapshot();
      this.previous = { ...result, file, size: stat.size, mtime: stat.mtimeMs, ino: stat.ino,
        ctime: stat.ctimeMs, cwd, parseOptions, boundary: guard };
      return this.previous;
    } catch (error) { this.previous = undefined; this.state = undefined; throw error; }
    finally { await handle?.close(); }
  }
}
