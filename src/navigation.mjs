// Terminal rows are not conversation IDs. Never search a pane's entire history.
export const paneIdentity = pane => JSON.stringify([
  pane.pane_id, pane.terminal_id, pane.agent_session?.agent,
  pane.agent_session?.kind, pane.agent_session?.value,
]);

export function answerContext(messages, block) {
  const message = messages.find(m => m.id === block?.messageId);
  if (!message?.text) return null;
  const lines = message.text.replace(/\r\n/g, '\n').split('\n');
  const start = Math.max(0, Math.min(lines.length - 1, (block.line || 1) - 1));
  return { blockId: block.id, title: block.title, kind: message.kind, lines, start,
    end: Math.min(lines.length - 1, start + (block.raw || block.source).split('\n').length - 1) };
}
