// Session store and SSE broadcast. Sessions marked dirty by incoming events
// are flushed to subscribers on a short interval so a burst of transcript
// lines becomes one UI update.

import { SessionModel } from './attribution.js';

const FLUSH_MS = 400;

export class Store {
  constructor() {
    this.sessions = new Map(); // id -> SessionModel
    this.subscribers = new Set(); // http.ServerResponse (SSE)
    this.dirty = new Set();
    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
  }

  getOrCreate(id) {
    let s = this.sessions.get(id);
    if (!s) {
      s = new SessionModel(id);
      this.sessions.set(id, s);
    }
    return s;
  }

  ingest(sessionId, evt) {
    this.getOrCreate(sessionId).addEvent(evt);
    this.dirty.add(sessionId);
  }

  sessionList() {
    return [...this.sessions.values()]
      .map((s) => ({
        id: s.id,
        title: s.title,
        cwd: s.cwd,
        model: s.model,
        lastActivity: s.lastActivity,
        contextNow: s.contextNow,
        window: s.window,
        totals: s.totals,
      }))
      .sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
  }

  subscribe(res) {
    this.subscribers.add(res);
    res.on('close', () => this.subscribers.delete(res));
    this.send(res, { type: 'hello', sessions: this.sessionList() });
  }

  send(res, obj) {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {
      this.subscribers.delete(res);
    }
  }

  broadcast(obj) {
    for (const res of this.subscribers) this.send(res, obj);
  }

  flush() {
    if (this.dirty.size === 0) return;
    const ids = [...this.dirty];
    this.dirty.clear();
    this.broadcast({ type: 'list', sessions: this.sessionList() });
    for (const id of ids) {
      const s = this.sessions.get(id);
      if (s) this.broadcast({ type: 'session', session: s.toJSON() });
    }
  }
}
