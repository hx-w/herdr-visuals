export class PreviewModel {
  constructor() {
    this.messages = []; this.filter = 'all'; this.history = true; this.query = '';
    this.selectedId = null; this.pinned = null; this.follow = true; this.pending = 0;
  }
  get items() {
    const latest = this.messages.at(-1);
    const messages = this.history ? this.messages : Number.isInteger(latest?.turn)
      ? this.messages.filter(m => m.turn === latest.turn) : this.messages.slice(-1);
    return messages.flatMap(m => m.blocks).filter(b =>
      (this.filter === 'all' || b.type === this.filter) &&
      (!this.query || `${b.title}\n${b.context}\n${b.source}`.toLowerCase().includes(this.query.toLowerCase())));
  }
  get current() { return this.pinned || this.items.find(b => b.id === this.selectedId) || this.items[0]; }
  get index() { return this.items.findIndex(b => b.id === this.current?.id); }
  resetSource() {
    this.messages = []; this.queued = null; this.selectedId = null; this.pinned = null;
    this.follow = true; this.pending = 0; this.history = true; this.query = '';
  }
  update(messages) {
    const signature = list => list.map(m => m.id).join('|');
    if (signature(messages) === signature(this.messages)) return false;
    if (!this.follow || this.pinned) { this.queued = messages; this.pending = messages.filter(m => !this.messages.some(old => old.id === m.id)).length; return true; }
    this.messages = messages; this.selectedId = this.items.at(-1)?.id || null; this.pending = 0; return true;
  }
  resume() {
    this.pinned = null; this.follow = true; this.history = true;
    if (this.queued) { this.messages = this.queued; this.queued = null; }
    this.selectedId = this.items.at(-1)?.id || null; this.pending = 0;
  }
  move(delta) {
    this.pinned = null; this.follow = false;
    const items = this.items;
    if (items.length) this.selectedId = items[Math.max(0, Math.min(items.length - 1, this.index + delta))].id;
  }
  pin() { if (this.pinned) this.resume(); else { this.pinned = this.current; this.follow = false; } }
}
