import { TranscriptFile } from '../files.mjs';
import { validPathBinding } from '../contract.mjs';
import { PiSessionParser } from './format.mjs';

export class PiSource {
  agent = 'pi';
  label = 'pi';

  constructor() {
    this.transcript = new TranscriptFile(PiSessionParser);
  }

  async transcriptFor(pane) {
    const binding = validPathBinding(pane, this.agent);
    if (!binding) throw new Error('pi requires an exact absolute transcript path.');
    return this.transcript.read(binding.value, { cwd: pane.foreground_cwd || pane.cwd });
  }

  async resolvePane(pane) {
    const value = await this.transcriptFor(pane);
    return { ...pane, source_session: value.sessionId };
  }

  async read(pane) {
    const value = await this.transcriptFor(pane);
    if (pane.source_session && pane.source_session !== value.sessionId) throw new Error('Session changed while reading. Refreshing records.');
    return { messages: value.messages, origin: 'pi transcript', limited: value.limited, issue: null };
  }
}
