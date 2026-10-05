import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { imageDataURL } from '../../images.mjs';
import { TranscriptFile } from '../files.mjs';
import { validPathBinding } from '../contract.mjs';
import { PiSessionParser } from '../pi/format.mjs';

const blobReference = /^blob:sha256:([a-f\d]{64})$/;

function sessionAgentDir(file) {
  for (let directory = path.dirname(file); directory !== path.dirname(directory); directory = path.dirname(directory)) {
    if (path.basename(directory) === 'sessions') return path.dirname(directory);
  }
  return path.join(os.homedir(), '.omp', 'agent');
}

async function resolveBlob(image, agentDir) {
  const hash = typeof image.data === 'string' && image.data.match(blobReference)?.[1];
  if (!hash || typeof image.mimeType !== 'string' || !/^image\/(?:png|jpeg|webp|gif|bmp|avif|svg\+xml)$/i.test(image.mimeType)) return null;
  const source = path.join(agentDir, 'blobs', hash);
  let handle;
  try {
    handle = await fs.open(source, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) throw new Error('Session image blob is not a regular file.');
    const data = (await handle.readFile()).toString('base64');
    return { source, imageData: imageDataURL({ ...image, data }) };
  } catch (error) {
    if (!['ENOENT', 'EACCES'].includes(error.code)) throw error;
    return { source }; // Missing resources remain explicit image items.
  } finally { await handle?.close(); }
}

export class OmpSource {
  agent = 'omp';
  label = 'omp';

  constructor({ ompHome = process.env.HERDR_VISUALS_OMP_HOME || process.env.PI_CODING_AGENT_DIR } = {}) {
    this.ompHome = ompHome;
    this.transcript = new TranscriptFile(PiSessionParser);
  }

  async transcriptFor(pane) {
    const binding = validPathBinding(pane, this.agent);
    if (!binding) throw new Error('omp requires an exact absolute transcript path.');
    const agentDir = this.ompHome || sessionAgentDir(binding.value);
    if (agentDir !== this.agentDir) {
      this.agentDir = agentDir;
      this.parseOptions = { generatedImages: true, resolveImage: image => resolveBlob(image, agentDir) };
    }
    return this.transcript.read(binding.value, { cwd: pane.foreground_cwd || pane.cwd, parseOptions: this.parseOptions });
  }

  async resolvePane(pane) {
    const value = await this.transcriptFor(pane);
    return { ...pane, source_session: value.sessionId };
  }

  async read(pane) {
    const value = await this.transcriptFor(pane);
    if (pane.source_session && pane.source_session !== value.sessionId) throw new Error('Session changed while reading. Refreshing records.');
    return { messages: value.messages, origin: 'omp transcript', limited: value.limited, issue: null };
  }
}
