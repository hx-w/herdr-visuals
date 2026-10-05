import { CodexSource } from './codex/index.mjs';
import { OmpSource } from './omp/index.mjs';
import { PiSource } from './pi/index.mjs';
import { ClaudeSource } from './claude/index.mjs';
import { unavailable } from './contract.mjs';

/**
 * Exact-session coordinator. Adapters own format, transport and caches; the
 * viewer knows only SourceSnapshot and the resolved pane identity.
 * Add a source by registering one adapter, without modifying viewer behavior.
 */
export class SourceReader {
  constructor(options = {}) {
    /** @type {Map<string, import('./contract.mjs').SourceAdapter>} */
    this.adapters = new Map([
      new CodexSource(options), new OmpSource(options), new PiSource(options), new ClaudeSource(options),
    ].map(adapter => [adapter.agent, adapter]));
  }

  adapter(pane) {
    return this.adapters.get(pane.agent || pane.agent_session?.agent);
  }

  async resolvePane(pane) {
    const adapter = this.adapter(pane);
    if (adapter && pane.agent_session && pane.agent_session.agent !== adapter.agent) {
      pane = { ...pane, agent_session: undefined, source_session: undefined };
    }
    if (!adapter) return { ...pane, source_session: undefined };
    try { return await adapter.resolvePane(pane); }
    catch { return { ...pane, source_session: undefined }; }
  }

  async read(pane) {
    const adapter = this.adapter(pane);
    if (!adapter) return {
      messages: [], origin: 'No supported session source', limited: false,
      issue: { title: 'Source session is not connected.',
        hint: 'Open Visuals from an omp, Codex, Claude Code or pi pane; or preview selected text.' },
    };
    if (pane.agent_session && pane.agent_session.agent !== adapter.agent) {
      pane = { ...pane, agent_session: undefined, source_session: undefined };
    }
    try { return await adapter.read(pane); }
    catch (error) { return unavailable(adapter.agent, adapter.label, true, error.message); }
  }

  close() { for (const adapter of this.adapters.values()) adapter.close?.(); }
}
