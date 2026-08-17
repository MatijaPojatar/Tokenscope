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
    this.rateLimits = null; // account-wide, from the statusline feed
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

  ingest(sessionId, evt, agentId) {
    const s = this.getOrCreate(sessionId);
    if (agentId) s.agentEvent(agentId, evt);
    else s.addEvent(evt);
    this.dirty.add(sessionId);
  }

  // Statusline snapshot: per-session cost + exact window, global rate limits.
  applyStatus(body) {
    if (body.session_id && this.sessions.has(body.session_id)) {
      this.sessions.get(body.session_id).applyStatus(body);
      this.dirty.add(body.session_id);
    }
    if (body.rate_limits) {
      this.rateLimits = body.rate_limits;
      this.dirty.add('*'); // force a list broadcast even if no session changed
    }
  }

  applyOtelEvents(events) {
    for (const e of events) {
      if (e.sessionId && this.sessions.has(e.sessionId)) {
        this.sessions.get(e.sessionId).applyOtel(e);
        this.dirty.add(e.sessionId);
      }
    }
  }

  docsReport() {
    const map = new Map();
    for (const s of this.sessions.values()) {
      for (const d of s.mergedDocs()) {
        const cur = map.get(d.path) || { path: d.path, reads: 0, tokens: 0, sessions: 0, agent: false };
        cur.reads += d.reads;
        cur.tokens += d.tokens;
        cur.sessions += 1;
        if (d.agent) cur.agent = true;
        map.set(d.path, cur);
      }
    }
    return [...map.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 200);
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
        window: s.windowExact || s.window,
        totals: s.totals,
        costUsd: s.costUsd,
        agentCount: s.agents.size,
      }))
      .sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
  }

  subscribe(res) {
    this.subscribers.add(res);
    res.on('close', () => this.subscribers.delete(res));
    this.send(res, { type: 'hello', sessions: this.sessionList(), rateLimits: this.rateLimits });
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
    this.broadcast({ type: 'list', sessions: this.sessionList(), rateLimits: this.rateLimits });
    for (const id of ids) {
      const s = this.sessions.get(id);
      if (s) this.broadcast({ type: 'session', session: s.toJSON() });
    }
  }
}
