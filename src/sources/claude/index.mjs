import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ClaudeSessionParser } from './format.mjs';
import { TranscriptFile } from '../files.mjs';
import { validPathBinding } from '../contract.mjs';

const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

// Exact-ID construction matches the official SDK's canonical cwd encoding.
// No project-directory listing, worktree search, prefix match or newest fallback.
function projectKey(cwd) {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (encoded.length <= 200) return encoded;
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) hash = (Math.imul(hash, 31) + cwd.charCodeAt(i)) | 0;
  return `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

export class ClaudeSource {
  agent = 'claude';
  label = 'Claude Code';

  constructor({ configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') } = {}) {
    this.configDir = configDir.normalize('NFC');
    this.file = new TranscriptFile(ClaudeSessionParser);
  }

  async boundFile(pane) {
    const binding = validPathBinding(pane, this.agent);
    if (binding) return binding.value;
    const id = pane.agent_session;
    if (id?.agent !== this.agent || id.kind !== 'id' || typeof id.value !== 'string' || !uuid.test(id.value)) {
      throw new Error('Claude requires an exact absolute transcript path or a session UUID.');
    }
    if (typeof pane.cwd !== 'string' || !path.isAbsolute(pane.cwd) || /[\x00-\x1f\x7f]/.test(pane.cwd) || !path.isAbsolute(this.configDir)) {
      throw new Error('An exact Claude session UUID requires an authoritative absolute working directory and Claude config directory.');
    }
    const cwd = (await fs.realpath(pane.cwd)).normalize('NFC');
    return path.join(this.configDir, 'projects', projectKey(cwd), `${id.value}.jsonl`);
  }

  async transcript(pane) {
    const result = await this.file.read(await this.boundFile(pane), { cwd: pane.cwd });
    if (pane.agent_session.kind === 'id' && result.sessionId !== pane.agent_session.value) {
      this.file = new TranscriptFile(ClaudeSessionParser);
      throw new Error('The bound Claude UUID does not match the transcript session identity.');
    }
    return result;
  }

  async resolvePane(pane) {
    const result = await this.transcript(pane);
    return { ...pane, source_session: result.sessionId };
  }

  async read(pane) {
    const { messages, limited, sessionId } = await this.transcript(pane);
    if (pane.source_session && pane.source_session !== sessionId) throw new Error('Session changed while reading. Refreshing records.');
    return { messages, limited, origin: 'Claude Code transcript', issue: null };
  }

  close() { this.file = new TranscriptFile(ClaudeSessionParser); }
}
