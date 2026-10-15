// Live updates to open dashboards (Server-Sent Events). Each connection
// belongs to one user and only ever receives that user's events.

export class Hub {
  constructor() {
    this.clients = new Map(); // userId -> Set<res>
    this.timer = setInterval(() => this.broadcastComment('ping'), 25000);
    this.timer.unref?.();
  }

  subscribe(userId, req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 5000\n\n');
    let set = this.clients.get(userId);
    if (!set) this.clients.set(userId, (set = new Set()));
    set.add(res);
    const drop = () => {
      set.delete(res);
      if (!set.size) this.clients.delete(userId);
    };
    req.on('close', drop);
    res.on('error', drop);
  }

  publish(userId, type, data) {
    const set = this.clients.get(userId);
    if (!set) return 0;
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) res.write(msg);
    return set.size;
  }

  broadcastComment(text) {
    for (const set of this.clients.values()) for (const res of set) res.write(`: ${text}\n\n`);
  }

  disconnectUser(userId) {
    const set = this.clients.get(userId);
    if (!set) return;
    for (const res of set) res.end();
    this.clients.delete(userId);
  }

  close() {
    clearInterval(this.timer);
    for (const set of this.clients.values()) for (const res of set) res.end();
    this.clients.clear();
  }
}
