// Attribution engine. Consumes normalized adapter events for one session and
// maintains the session model: turns, per-action token costs, context
// composition, and docs statistics.
//
// The core rule: each API call's fresh tokens (input + cache_creation) pay
// for exactly the material inserted into context since the previous call —
// the user prompt, tool results, and injected attachments. Those inserted
// items are held in `pending` and settled when the next call's usage arrives,
// prorated by character count. cache_read is the already-paid prefix.

const CHARS_PER_TOKEN = 3.8;
const MAX_TURNS = 200;
const DEFAULT_WINDOW = 200000;

const est = (chars) => Math.max(1, Math.round(chars / CHARS_PER_TOKEN));

// Full path, made relative to the session cwd when it's inside the project —
// complete information without the repetitive prefix.
function displayPath(p, cwd) {
  if (!p) return '';
  const norm = String(p).replace(/\//g, '\\');
  if (cwd) {
    const prefix = String(cwd).replace(/\//g, '\\').replace(/\\+$/, '') + '\\';
    if (norm.toLowerCase().startsWith(prefix.toLowerCase())) return norm.slice(prefix.length);
  }
  return norm;
}

// Harness-internal files (transcript spill files, scratchpads) read back by
// Claude are not the user's documentation — keep them out of docs stats.
const HARNESS_PATH = /[\\/](\.claude|tool-results)[\\/]|[\\/]Temp[\\/]claude[\\/]/i;
const isDocPath = (fp) => /\.(md|mdx|rst)$/i.test(fp) && !HARNESS_PATH.test(fp);

function classifyTool(name, input) {
  if (name === 'Read') {
    const fp = (input && input.file_path) || '';
    return isDocPath(fp) ? 'docsRead' : 'codeRead';
  }
  if (name === 'Glob' || name === 'Grep') return 'search';
  if (name === 'Task' || name === 'Agent') return 'agent';
  return 'toolOther';
}

// Collapse whitespace (multi-line commands become one row) and clip with a
// visible ellipsis only when genuinely over the cap.
function clip(s, n) {
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
}

function toolLabel(name, input, cwd) {
  if (!input) return name;
  if (input.file_path) return `${name} ${displayPath(input.file_path, cwd)}`;
  if (input.pattern) return `${name} "${clip(input.pattern, 80)}"`;
  if (input.command) return `${name} ${clip(input.command, 200)}`;
  if (input.description) return `${name} ${clip(input.description, 120)}`;
  if (input.prompt) return `${name} ${clip(input.prompt, 120)}`;
  return name;
}

export class SessionModel {
  constructor(id, opts = {}) {
    // Subagent transcripts flag every entry isSidechain — an agent model
    // ignores the flag and treats its own transcript as the main lane.
    this.ignoreSidechain = !!opts.ignoreSidechain;
    this.id = id;
    this.title = null;
    this.cwd = null;
    this.model = null;
    this.lastActivity = null;
    this.window = DEFAULT_WINDOW;
    this.contextNow = 0;
    this.turns = [];
    this.docs = new Map(); // path -> {path, reads, tokens}
    this.context = {
      base: 0, conversation: 0, docsRead: 0, codeRead: 0,
      search: 0, agent: 0, toolOther: 0, attachments: 0,
      output: 0, recache: 0,
    };
    this.totals = { calls: 0, fresh: 0, output: 0 };
    this.sidechain = { calls: 0, tokens: 0 };
    this.toolUses = new Map(); // toolUseId -> {name, input}
    this.pending = []; // [{cat, chars, action?, docPath?}]
    this.seenApi = new Set();
    this.prevOutput = 0; // last call's output tokens — re-enter cache next call
    this.maxContext = 0;
    this.agents = new Map(); // agentId -> SessionModel (own context window)
    this.baseFiles = null; // disk-scanned base-context files (set by the store)
    this.baseScanRequested = false;
    this.baseAttachments = new Map(); // atype -> {label, chars, tokens, count}
    this.costUsd = null; // authoritative session cost from the statusline feed
    this.exactCostUsd = 0; // accumulated from OTel api_request events
    this.windowExact = null; // exact window size from the statusline feed
  }

  currentTurn() {
    if (this.turns.length === 0) {
      this.turns.push({ prompt: '(session start)', ts: null, actions: [], fresh: 0, output: 0 });
    }
    return this.turns[this.turns.length - 1];
  }

  addEvent(evt) {
    if (!evt) return;
    if (evt.timestamp) this.lastActivity = evt.timestamp;

    switch (evt.kind) {
      case 'title':
        this.title = evt.title;
        return;

      case 'prompt': {
        if (evt.isSidechain && !this.ignoreSidechain) return;
        if (evt.cwd) this.cwd = evt.cwd;
        this.turns.push({
          prompt: evt.text.slice(0, 240),
          ts: evt.timestamp,
          actions: [],
          fresh: 0,
          output: 0,
        });
        if (this.turns.length > MAX_TURNS) this.turns.shift();
        this.pending.push({ cat: 'conversation', chars: evt.chars });
        return;
      }

      case 'tool_results': {
        if (evt.isSidechain && !this.ignoreSidechain) return;
        const turn = this.currentTurn();
        for (const r of evt.results) {
          const tu = this.toolUses.get(r.toolUseId);
          const name = tu ? tu.name : 'tool';
          const input = tu ? tu.input : null;
          const cat = tu ? classifyTool(name, input) : 'toolOther';
          // Execution time: result timestamp minus the issuing tool_use's.
          const durMs = tu && tu.ts && evt.timestamp
            ? Math.max(0, new Date(evt.timestamp) - new Date(tu.ts))
            : null;
          const action = {
            name, cat,
            label: toolLabel(name, input, this.cwd),
            chars: r.chars,
            tokens: 0,
            ts: evt.timestamp,
            durMs,
          };
          turn.actions.push(action);
          let docPath = null;
          if (cat === 'docsRead' || cat === 'codeRead') {
            docPath = input && input.file_path;
            if (docPath && cat === 'docsRead') {
              const d = this.docs.get(docPath) || { path: docPath, reads: 0, tokens: 0 };
              d.reads += 1;
              this.docs.set(docPath, d);
            }
          }
          this.pending.push({ cat, chars: r.chars, action, docPath });
        }
        return;
      }

      case 'attachment': {
        // Auto-injected CLAUDE.md files count as docs — they cost context
        // tokens the same way an explicit Read does.
        if (evt.atype === 'nested_memory' && evt.path) {
          const turn = this.currentTurn();
          const action = {
            name: 'CLAUDE.md', cat: 'docsRead',
            label: `auto ${displayPath(evt.path, this.cwd)}`,
            chars: evt.chars, tokens: 0, ts: evt.timestamp,
          };
          turn.actions.push(action);
          const d = this.docs.get(evt.path) || { path: evt.path, reads: 0, tokens: 0 };
          d.reads += 1;
          this.docs.set(evt.path, d);
          this.pending.push({ cat: 'docsRead', chars: evt.chars, action, docPath: evt.path });
        } else {
          // Track injected context by type so the base-context panel can
          // itemize what the harness added (skill listing, tool deltas, ...).
          const label = evt.atype || 'attachment';
          const rec = this.baseAttachments.get(label) ||
            { label, chars: 0, tokens: 0, count: 0, firstTs: null, lastTs: null };
          rec.chars += evt.chars;
          rec.count += 1;
          if (evt.timestamp) {
            rec.firstTs = rec.firstTs || evt.timestamp;
            rec.lastTs = evt.timestamp;
          }
          this.baseAttachments.set(label, rec);
          this.pending.push({ cat: 'attachments', chars: evt.chars, baseRec: rec });
        }
        return;
      }

      case 'api': {
        if (evt.isSidechain && !this.ignoreSidechain) {
          if (!this.seenApi.has(evt.apiId)) {
            this.seenApi.add(evt.apiId);
            const u = evt.usage;
            if (u) {
              this.sidechain.calls += 1;
              this.sidechain.tokens += u.input + u.cacheWrite + u.output;
            }
          }
          return;
        }
        // Register issued tool calls on every line — content blocks of one
        // API message arrive as separate lines sharing the same apiId.
        for (const b of evt.blocks) {
          if (b.type === 'tool_use' && b.id) {
            this.toolUses.set(b.id, { name: b.name, input: b.input, ts: evt.timestamp });
          }
        }
        if (this.seenApi.has(evt.apiId)) return; // usage already settled
        this.seenApi.add(evt.apiId);
        if (evt.model) this.model = evt.model;
        const u = evt.usage;
        if (!u) return;
        this.settle(u);
        return;
      }
    }
  }

  // Distribute one API call's fresh tokens across the pending inserted items.
  settle(u) {
    const rawFresh = u.input + u.cacheWrite;
    // The previous call's output (text + thinking) is written into the cache
    // on this call. It's already counted in the `output` bucket when it was
    // generated — subtract it so it isn't misattributed to pending items.
    const fresh = Math.max(0, rawFresh - this.prevOutput);
    const turn = this.currentTurn();
    const firstCall = this.totals.calls === 0;

    const estimates = this.pending.map((p) => est(p.chars));
    const estSum = estimates.reduce((a, b) => a + b, 0);

    if (firstCall) {
      // The first call's fresh tokens also carry the invisible base context:
      // system prompt, tool schemas, memory. Attribute known items at their
      // estimate; the remainder is the base.
      let spent = 0;
      this.pending.forEach((p, i) => {
        const t = Math.min(estimates[i], Math.max(0, fresh - spent));
        spent += t;
        this.credit(p, t);
      });
      this.context.base = Math.max(0, fresh - spent);
    } else if (estSum === 0) {
      // Nothing known was inserted, yet tokens were written — a cache
      // refresh (TTL expiry) or context material we can't see. Don't invent
      // an attribution for it.
      this.context.recache += fresh;
    } else {
      const scale = fresh / estSum;
      if (scale > 3) {
        // Far more fresh tokens than inserted content: the prefix was
        // re-cached. Attribute items at their estimate, excess to recache.
        this.pending.forEach((p, i) => this.credit(p, estimates[i]));
        this.context.recache += fresh - estSum;
      } else {
        this.pending.forEach((p, i) => this.credit(p, Math.round(estimates[i] * scale)));
      }
    }
    this.pending = [];

    turn.fresh += fresh;
    turn.output += u.output;
    this.context.output += u.output;
    this.totals.calls += 1;
    this.totals.fresh += rawFresh; // what the API actually charged as input writes
    this.totals.output += u.output;
    this.prevOutput = u.output;
    this.contextNow = u.cacheRead + u.cacheWrite + u.input + u.output;
    this.maxContext = Math.max(this.maxContext, this.contextNow);
    this.window = this.maxContext > 210000 ? 1000000 : DEFAULT_WINDOW;
  }

  // Route one event from a subagent transcript to that agent's own model.
  // Agents run in their own context window, so their tokens never touch the
  // parent's gauge — but their docs reads join the parent's leaderboard.
  agentEvent(agentId, evt) {
    let a = this.agents.get(agentId);
    if (!a) {
      a = new SessionModel(agentId, { ignoreSidechain: true });
      this.agents.set(agentId, a);
    }
    if (!a.title && evt.kind === 'prompt') a.title = evt.text.slice(0, 100);
    a.addEvent(evt);
    if (evt.timestamp) this.lastActivity = evt.timestamp;
  }

  // Statusline feed: authoritative cost and exact context-window size.
  applyStatus(s) {
    const cw = s.context_window || {};
    if (typeof cw.context_window_size === 'number' && cw.context_window_size > 0) {
      this.windowExact = cw.context_window_size;
    }
    if (s.cost && typeof s.cost.total_cost_usd === 'number') {
      this.costUsd = s.cost.total_cost_usd;
    }
  }

  applyOtel(e) {
    if (e.costUsd > 0) this.exactCostUsd += e.costUsd;
  }

  // Session docs + docs read by this session's agents, summed per path.
  mergedDocs() {
    const map = new Map();
    const add = (d, viaAgent) => {
      const cur = map.get(d.path) || { path: d.path, reads: 0, tokens: 0, agent: false };
      cur.reads += d.reads;
      cur.tokens += d.tokens;
      if (viaAgent) cur.agent = true;
      map.set(d.path, cur);
    };
    for (const d of this.docs.values()) add(d, false);
    for (const a of this.agents.values()) {
      for (const d of a.docs.values()) add(d, true);
    }
    return [...map.values()].sort((x, y) => y.tokens - x.tokens);
  }

  // Optimization suggestions, grounded in this session's actual token spend.
  // Each finding: {kind, impact (tokens), count, subject, context}.
  suggestions() {
    const out = [];
    const searches = new Map(); // label -> {tokens, count, context, agent}
    const reads = new Map(); // path -> {tokens, count}

    const collect = (turns, agentTitle) => {
      for (const t of turns) {
        for (const a of t.actions) {
          if (a.cat === 'search') {
            const cur = searches.get(a.label) ||
              { tokens: 0, count: 0, context: null, maxTok: -1, agent: false };
            cur.tokens += a.tokens;
            cur.count += 1;
            if (a.tokens > cur.maxTok) {
              cur.maxTok = a.tokens;
              cur.context = agentTitle ? `agent: ${agentTitle.slice(0, 60)}` : (t.prompt || null);
            }
            if (agentTitle) cur.agent = true;
            searches.set(a.label, cur);
          } else if (a.cat === 'codeRead' && a.name === 'Read') {
            const p = a.label.startsWith('Read ') ? a.label.slice(5) : a.label;
            const cur = reads.get(p) || { tokens: 0, count: 0 };
            cur.tokens += a.tokens;
            cur.count += 1;
            reads.set(p, cur);
          }
        }
      }
    };
    collect(this.turns, null);
    for (const ag of this.agents.values()) collect(ag.turns, ag.title || ag.id);

    // Per-kind caps so one noisy category can't crowd out the others.
    const byImpact = (a, b) => b.impact - a.impact;

    const searchSuggs = [];
    for (const [label, s] of searches) {
      if (s.tokens >= 2500 || (s.count >= 3 && s.tokens >= 1200)) {
        searchSuggs.push({ kind: 'search', impact: s.tokens, count: s.count, subject: label, context: s.context });
      }
    }
    const rereadSuggs = [];
    for (const [p, r] of reads) {
      if (r.count >= 3 && r.tokens >= 3000) {
        rereadSuggs.push({ kind: 'reread', impact: r.tokens, count: r.count, subject: p, context: null });
      }
    }
    const fatdocSuggs = [];
    for (const d of this.mergedDocs()) {
      const avg = d.tokens / Math.max(1, d.reads);
      if (d.reads >= 2 && avg >= 3500) {
        fatdocSuggs.push({ kind: 'fatdoc', impact: d.tokens, count: d.reads, subject: d.path, context: null });
      }
    }
    // Send every finding — the UI shows a per-kind capped subset by default
    // with a "show more" toggle for the rest.
    const injectedSuggs = [];
    for (const rec of this.baseAttachments.values()) {
      if (rec.tokens >= 15000) {
        injectedSuggs.push({
          kind: 'injected', impact: rec.tokens, count: rec.count,
          subject: rec.label, context: null,
        });
      }
    }
    // Heavy always-loaded base files (@-imported CLAUDE.md content, rules):
    // paid at the start of every session in this project.
    const basefileSuggs = [];
    for (const f of this.baseFiles || []) {
      const t = est(f.chars);
      if (t >= 2000) {
        basefileSuggs.push({ kind: 'basefile', impact: t, count: 1, subject: f.label, context: null });
      }
    }
    out.push(...searchSuggs, ...rereadSuggs, ...fatdocSuggs, ...injectedSuggs, ...basefileSuggs);
    out.sort(byImpact);
    out.splice(40);
    // Recache is mostly a workflow fact, not a docs fix — one entry, always last,
    // and only when it's a meaningful share of what the session paid.
    if (this.context.recache >= 100000 && this.context.recache >= this.totals.fresh * 0.25) {
      out.push({
        kind: 'recache',
        impact: this.context.recache,
        count: Math.round((this.context.recache / Math.max(1, this.totals.fresh)) * 100),
        subject: null,
        context: null,
      });
    }
    return out;
  }

  credit(p, tokens) {
    this.context[p.cat] = (this.context[p.cat] || 0) + tokens;
    if (p.action) p.action.tokens += tokens;
    if (p.baseRec) p.baseRec.tokens += tokens;
    if (p.docPath && p.cat === 'docsRead') {
      const d = this.docs.get(p.docPath);
      if (d) d.tokens += tokens;
    }
  }

  toJSON() {
    return {
      id: this.id,
      title: this.title,
      cwd: this.cwd,
      model: this.model,
      lastActivity: this.lastActivity,
      window: this.windowExact || this.window,
      contextNow: this.contextNow,
      context: this.context,
      totals: this.totals,
      sidechain: this.sidechain,
      costUsd: this.costUsd ?? (this.exactCostUsd > 0 ? this.exactCostUsd : null),
      turns: this.turns.slice(-60),
      docs: this.mergedDocs().slice(0, 30),
      suggestions: this.suggestions(),
      baseFiles: this.baseFiles,
      baseAttachments: [...this.baseAttachments.values()].sort((a, b) => b.tokens - a.tokens),
      agents: [...this.agents.values()].map((a) => ({
        id: a.id,
        title: a.title,
        model: a.model,
        calls: a.totals.calls,
        tokens: a.totals.fresh + a.totals.output,
        fresh: a.totals.fresh,
        output: a.totals.output,
        contextNow: a.contextNow,
        docsReads: [...a.docs.values()].reduce((n, d) => n + d.reads, 0),
        started: a.turns.length ? a.turns[0].ts : null,
        ended: a.lastActivity,
        actions: a.turns
          .flatMap((t) => t.actions)
          .slice(-200)
          .map((x) => ({ label: x.label, cat: x.cat, tokens: x.tokens, ts: x.ts, durMs: x.durMs })),
      })),
    };
  }
}
