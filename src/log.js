// In-memory activity log + event bus that the dashboard subscribes to.

import { EventEmitter } from 'node:events';

export class Bus extends EventEmitter {
  constructor({ max = 500, echo = true } = {}) {
    super();
    this.setMaxListeners(100);
    this.entries = [];
    this.max = max;
    this.echo = echo;
    this.seq = 0;
  }

  log(level, message, extra = {}) {
    const entry = { id: ++this.seq, ts: Date.now(), level, message, ...extra };
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    if (this.echo) {
      const t = new Date(entry.ts).toLocaleTimeString('en-AU', { hour12: false });
      const tag = level === 'error' ? 'ERR ' : level === 'warn' ? 'WARN' : level === 'success' ? ' OK ' : 'INFO';
      // eslint-disable-next-line no-console
      console.log(`[${t}] ${tag} ${message}`);
    }
    this.emit('log', entry);
    return entry;
  }

  recent(n = 200) {
    return this.entries.slice(-n);
  }
}
