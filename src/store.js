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
    if (!agentId && s.cwd && !s.baseScanRequested && this.onBaseScan) {
      s.baseScanRequested = true;
      this.onBaseScan(s); // async disk scan of base-context files
    }
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
    const read = [...map.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 200);

    // Base-loaded docs with no observed use anywhere: never Read (by any
    // session or agent) and never edited. In-context use isn't logged, so
    // this is the strongest observable dead-weight signal, not proof.
    const norm = (p) => String(p).replace(/\//g, '\\').toLowerCase();
    const readKeys = new Set([...map.keys()].map(norm));
    const editedKeys = new Set();
    for (const s of this.sessions.values()) {
      for (const p of s.editedFiles) editedKeys.add(p);
      for (const a of s.agents.values()) for (const p of a.editedFiles) editedKeys.add(p);
    }
    const loaded = new Map();
    for (const s of this.sessions.values()) {
      for (const f of s.baseFiles || []) {
        if (!/\.(md|mdx)$/i.test(f.path)) continue;
        const k = norm(f.path);
        const cur = loaded.get(k) || { path: f.path, label: f.label, chars: f.chars, sessions: 0 };
        cur.sessions += 1;
        loaded.set(k, cur);
      }
    }
    const unused = [...loaded.entries()]
      .filter(([k]) => !readKeys.has(k) && !editedKeys.has(k))
      .map(([, v]) => v)
      .sort((a, b) => b.chars - a.chars);
    return { read, unused };
  }

  // Cross-session file map: tokens spent reading each file, grouped per
  // project — the data behind the codebase treemap.
  fileReport() {
    const projects = new Map();
    for (const s of this.sessions.values()) {
      const files = s.mergedFileReads();
      if (files.length === 0) continue;
      const cwd = s.cwd || '(unknown)';
      const pk = cwd.toLowerCase();
      const proj = projects.get(pk) || { cwd, files: new Map(), sessions: 0 };
      proj.sessions += 1;
      for (const f of files) {
        const k = String(f.path).replace(/\//g, '\\').toLowerCase();
        const cur = proj.files.get(k) ||
          { path: f.path, reads: 0, tokens: 0, sessions: 0, agent: false };
        cur.reads += f.reads;
        cur.tokens += f.tokens;
        cur.sessions += 1;
        if (f.agent) cur.agent = true;
        proj.files.set(k, cur);
      }
      projects.set(pk, proj);
    }
    return [...projects.values()]
      .map((p) => {
        const all = [...p.files.values()].sort((a, b) => b.tokens - a.tokens);
        return {
          cwd: p.cwd,
          sessions: p.sessions,
          fileCount: all.length,
          totalTokens: all.reduce((n, f) => n + f.tokens, 0),
          files: all.slice(0, 500),
        };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens);
  }

  // Cross-session MCP & skills report: every server call and skill use by
  // any session or agent in the window, with never-used cohorts called out —
  // the same dead-weight logic the docs report applies to base-loaded files.
  mcpSkillsReport() {
    const skills = new Map();
    const mcp = new Map();
    const toolSearch = { calls: 0, tokens: 0, sessions: 0 };
    let listingSessions = 0;
    let listingTokensTotal = 0;
    for (const s of this.sessions.values()) {
      const r = s.mcpSkillsReport();
      if (r.listingTokens > 0) {
        listingSessions += 1;
        listingTokensTotal += r.listingTokens;
      }
      for (const x of r.skills) {
        const cur = skills.get(x.name) ||
          { name: x.name, uses: 0, tokens: 0, shareTotal: 0, listedSessions: 0, usedSessions: 0, lastTs: null };
        cur.uses += x.uses;
        cur.tokens += x.tokens;
        if (x.listed) { cur.listedSessions += 1; cur.shareTotal += x.share; }
        if (x.uses > 0) cur.usedSessions += 1;
        if (x.lastTs && (!cur.lastTs || x.lastTs > cur.lastTs)) cur.lastTs = x.lastTs;
        skills.set(x.name, cur);
      }
      for (const m of r.mcp) {
        const cur = mcp.get(m.server) ||
          { server: m.server, scope: null, calls: 0, tokens: 0, usedSessions: 0, configuredSessions: 0, tools: new Set(), lastTs: null };
        cur.calls += m.calls;
        cur.tokens += m.tokens;
        if (m.calls > 0) cur.usedSessions += 1;
        if (m.scope) { cur.scope = cur.scope || m.scope; cur.configuredSessions += 1; }
        for (const t of m.tools) cur.tools.add(t);
        if (m.lastTs && (!cur.lastTs || m.lastTs > cur.lastTs)) cur.lastTs = m.lastTs;
        mcp.set(m.server, cur);
      }
      if (r.toolSearch.calls > 0) {
        toolSearch.calls += r.toolSearch.calls;
        toolSearch.tokens += r.toolSearch.tokens;
        toolSearch.sessions += 1;
      }
    }
    const allSkills = [...skills.values()];
    const allMcp = [...mcp.values()].map((m) => ({ ...m, tools: [...m.tools] }));
    return {
      listingSessions,
      listingTokensTotal,
      usedSkills: allSkills.filter((x) => x.uses > 0)
        .sort((a, b) => b.uses - a.uses || b.tokens - a.tokens),
      unusedSkills: allSkills.filter((x) => x.uses === 0)
        .sort((a, b) => b.shareTotal - a.shareTotal),
      mcpUsed: allMcp.filter((m) => m.calls > 0).sort((a, b) => b.tokens - a.tokens),
      mcpUnused: allMcp.filter((m) => m.calls === 0),
      toolSearch,
    };
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
        compactions: s.compactions.length,
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
