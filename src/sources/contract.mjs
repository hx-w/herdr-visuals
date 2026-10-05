import path from 'node:path';

/**
 * @typedef {Object} VisualRecord
 * @property {string} id Stable content identity within one source session.
 * @property {number} [turn] User-turn ordinal, shared by answers and tool images.
 * @property {string} text Displayable answer or safe image context, never raw logs.
 * @property {'image'} [kind]
 * @property {Array<object>} blocks Renderable blocks with id, messageId, type,
 * source, title, context, line, raw, cwd and optional embedded imageData.
 *
 * @typedef {Object} SourceSnapshot
 * @property {VisualRecord[]} messages
 * @property {string} origin
 * @property {boolean} limited
 * @property {{title:string,hint:string}|null} issue
 *
 * @typedef {Object} SourceAdapter
 * @property {string} agent Herdr agent discriminator, not a display name.
 * @property {string} label Human-readable source name.
 * @property {(pane:object)=>Promise<object>} resolvePane Read-only exact identity
 * resolution; returned source_session invalidates same-path replacement state.
 * @property {(pane:object)=>Promise<SourceSnapshot>} read Exact-session snapshot.
 * @property {()=>void} [close] Release owned connections, if any.
 */

export function validPathBinding(pane, agent) {
  const binding = pane.agent_session;
  return binding?.agent === agent && binding.kind === 'path' &&
    typeof binding.value === 'string' && path.isAbsolute(binding.value) &&
    !/[\x00-\x1f\x7f]/.test(binding.value) ? binding : null;
}

export function unavailable(agent, label, connected, hint) {
  return {
    messages: [], origin: `Exact ${label} transcript unavailable`, limited: false,
    issue: {
      title: connected ? `The bound ${label} transcript is unavailable.` : `${label} session is not connected.`,
      hint: hint || (connected ? `Check the ${label} transcript location; or preview selected text.`
        : `Report the exact ${agent} session file to this Herdr pane; or preview selected text.`),
    },
  };
}
