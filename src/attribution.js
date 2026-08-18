// Attribution engine. Consumes normalized adapter events for one session and
// maintains the session model: turns, per-action token costs, context
// composition, and docs statistics.
//
// The core rule: each API call's fresh tokens (input + cache_creation) pay
// for exactly the material inserted into context since the previous call —
// the user prompt, tool results, and injected attachments. Those inserted
// items are held in `pending` and settled when the next call's usage arrives,
// prorated by character count. cache_read is the already-paid prefix.

import {
  inputPricePerMTok, usd,
  CACHE_READ_MULT, CACHE_WRITE_5M_MULT, CACHE_WRITE_1H_MULT,
} from './pricing.js';

const CHARS_PER_TOKEN = 3.8;
const MAX_TURNS = 200;
const DEFAULT_WINDOW = 200000;

// Bucket order for timeline snapshots — mirrored by CATS in public/app.js;
// the two must stay in sync.
const CAT_KEYS = ['base', 'conversation', 'docsRead', 'codeRead', 'search',
  'agent', 'toolOther', 'attachments', 'output', 'recache'];

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

// Harness-internal files (transcript spill files, scratchpads, memory
// internals) read back by Claude are not the user's documentation — keep
// them out of docs stats. Project-level .claude\*.md ARE user docs and must
// stay eligible, so only the harness's own trees are excluded:
// ~\.claude\projects\ (transcripts, tool-results, memory) and Temp\claude.
const HARNESS_PATH = /[\\/]\.claude[\\/]projects[\\/]|[\\/]tool-results[\\/]|[\\/]Temp[\\/]claude[\\/]/i;
const isDocPath = (fp) => /\.(md|mdx|rst)$/i.test(fp) && !HARNESS_PATH.test(fp);

// Invocation signature for grouping repeated commands: tool + first words of
// the command, ignoring a leading cd/Set-Location prefix and volatile tails.
// Mirrored in public/app.js for click-to-highlight matching.
export function commandSig(label) {
  const sp = label.indexOf(' ');
  const tool = sp < 0 ? label : label.slice(0, sp);
  let cmd = sp < 0 ? '' : label.slice(sp + 1);
  cmd = cmd
    .replace(/^cd\s+("[^"]*"|\S+)\s*(&&|;)\s*/i, '')
    .replace(/^set-location\s+("[^"]*"|\S+)\s*(&&|;)\s*/i, '');
  return `${tool} ${cmd.split(' ').slice(0, 3).join(' ')}`.trim();
}

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
  if (input.pattern) return `${name} "${clip(input.pattern, 400)}"`;
  if (input.command) return `${name} ${clip(input.command, 2000)}`;
  if (input.description) return `${name} ${clip(input.description, 300)}`;
  if (input.prompt) return `${name} ${clip(input.prompt, 2000)}`;
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
    this.firstActivity = null;
    this.lastActivity = null;
    this.window = DEFAULT_WINDOW;
    this.contextNow = 0;
    this.turns = [];
    this.docs = new Map(); // path -> {path, reads, tokens}
    this.fileReads = new Map(); // path -> {path, reads, tokens} — every Read, code and docs
    this.context = {
      base: 0, conversation: 0, docsRead: 0, codeRead: 0,
      search: 0, agent: 0, toolOther: 0, attachments: 0,
      output: 0, recache: 0,
    };
    this.totals = { calls: 0, fresh: 0, output: 0 };
    this.sidechain = { calls: 0, tokens: 0 };
    this.editedFiles = new Set(); // normalized paths touched by Edit/Write
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
    this.compactions = []; // {ts, trigger, preTokens, postTokens, durationMs, summaryTokens, rebuildTokens}
    this.seenCompactions = new Set(); // boundary uuids — resumes re-append old lines
    this.pendingCompaction = null; // record awaiting its first post-compaction settle
    this.skillList = new Map(); // name -> chars in the latest skill_listing
    this.skillUses = new Map(); // name -> {count, actions: [], lastTs, viaTool}
    this.mcpUses = new Map(); // server -> {server, calls, actions: [], tools: Set, lastTs}
    this.toolSearchUses = { calls: 0, actions: [] }; // deferred tool schema loads
    this.mcpConfigured = null; // disk-scanned MCP server config (set by the store)
    this.outputChars = { thinking: 0, text: 0, toolUse: 0 }; // from content blocks
    this.seenApiLines = new Set(); // line uuids — resumes re-append old lines
    this.apiOutput = new Map(); // apiId -> {textChars, tools: [{id, chars}], output}
    this.cache = { read: 0, write: 0, write5m: 0, write1h: 0, input: 0 }; // from usage
    this.timeline = []; // {ts, ctx, b: [per-CAT_KEYS bucket]} — one per settle
  }

  currentTurn() {
    if (this.turns.length === 0) {
      this.turns.push({ prompt: '(session start)', ts: null, actions: [], fresh: 0, output: 0 });
    }
    return this.turns[this.turns.length - 1];
  }

  addEvent(evt) {
    if (!evt) return;
    if (evt.timestamp) {
      if (!this.firstActivity) this.firstActivity = evt.timestamp;
      this.lastActivity = evt.timestamp;
    }

    switch (evt.kind) {
      case 'title':
        this.title = evt.title;
        return;

      case 'prompt': {
        if (evt.isSidechain && !this.ignoreSidechain) return;
        if (evt.cwd) this.cwd = evt.cwd;
        this.turns.push({
          prompt: evt.text.slice(0, 2000),
          ts: evt.timestamp,
          actions: [],
          fresh: 0,
          output: 0,
          compactSummary: !!evt.isCompactSummary,
        });
        if (this.turns.length > MAX_TURNS) this.turns.shift();
        for (const cmd of evt.commands || []) this.noteSkillUse(cmd, null, evt.timestamp);
        this.pending.push({
          cat: 'conversation',
          chars: evt.chars,
          // The continuation summary belongs to the compaction that produced
          // it — credit() also books its tokens on that record.
          compactRec: evt.isCompactSummary ? this.pendingCompaction : null,
        });
        return;
      }

      case 'compaction': {
        if (this.seenCompactions.has(evt.uuid)) return;
        this.seenCompactions.add(evt.uuid);
        const rec = {
          ts: evt.timestamp,
          trigger: evt.trigger,
          preTokens: evt.preTokens,
          postTokens: evt.postTokens,
          durationMs: evt.durationMs,
          summaryTokens: 0,
          rebuildTokens: 0,
        };
        this.compactions.push(rec);
        this.pendingCompaction = rec;
        // The next call rewrites the whole rebuilt context; the previous
        // output no longer re-enters the cache as a plain prefix append.
        this.prevOutput = 0;
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
          if ((name === 'Edit' || name === 'Write' || name === 'NotebookEdit') && input && input.file_path) {
            this.editedFiles.add(String(input.file_path).replace(/\//g, '\\').toLowerCase());
          }
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
          // The subagent's transcript opens with this same prompt — the
          // only join key between an agent call and its transcript.
          if (cat === 'agent' && input && typeof input.prompt === 'string') {
            action.agentPrompt = input.prompt.slice(0, 240);
          }
          const gen = this.genCostFor(r.toolUseId);
          if (gen != null) action.genTokens = gen;
          turn.actions.push(action);
          if (name.startsWith('mcp__')) {
            const parts = name.split('__');
            const server = parts[1] || name;
            const rec = this.mcpUses.get(server) ||
              { server, calls: 0, actions: [], tools: new Set(), lastTs: null };
            rec.calls += 1;
            rec.actions.push(action);
            rec.tools.add(parts.slice(2).join('__') || name);
            rec.lastTs = evt.timestamp;
            this.mcpUses.set(server, rec);
          } else if (name === 'Skill' && input && input.skill) {
            this.noteSkillUse(String(input.skill), action, evt.timestamp);
          } else if (name === 'ToolSearch') {
            this.toolSearchUses.calls += 1;
            this.toolSearchUses.actions.push(action);
          }
          let docPath = null;
          if (cat === 'docsRead' || cat === 'codeRead') {
            docPath = input && input.file_path;
            if (docPath && cat === 'docsRead') {
              const d = this.docs.get(docPath) || { path: docPath, reads: 0, tokens: 0 };
              d.reads += 1;
              this.docs.set(docPath, d);
            }
            if (docPath) {
              const fr = this.fileReads.get(docPath) || { path: docPath, reads: 0, tokens: 0 };
              fr.reads += 1;
              this.fileReads.set(docPath, fr);
            }
          }
          this.pending.push({ cat, chars: r.chars, action, docPath });
        }
        return;
      }

      case 'attachment': {
        // Each skill_listing injection is the full current listing — keep
        // the latest split so listing cost can be prorated per skill.
        if (evt.atype === 'skill_listing' && evt.skills) {
          this.skillList = new Map(evt.skills.map((x) => [x.name, x.chars]));
        }
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
          const fr = this.fileReads.get(evt.path) || { path: evt.path, reads: 0, tokens: 0 };
          fr.reads += 1;
          this.fileReads.set(evt.path, fr);
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
        // Output chars are counted once per line uuid: session resumes
        // re-append old lines verbatim and would double-count otherwise.
        const newLine = !evt.uuid || !this.seenApiLines.has(evt.uuid);
        if (evt.uuid) this.seenApiLines.add(evt.uuid);
        let apiRec = this.apiOutput.get(evt.apiId);
        if (!apiRec) {
          apiRec = { textChars: 0, tools: [], output: 0 };
          this.apiOutput.set(evt.apiId, apiRec);
        }
        for (const b of evt.blocks) {
          if (b.type === 'tool_use' && b.id) {
            this.toolUses.set(b.id, { name: b.name, input: b.input, ts: evt.timestamp, apiId: evt.apiId });
            if (newLine) {
              const chars = JSON.stringify(b.input || {}).length;
              this.outputChars.toolUse += chars;
              apiRec.tools.push({ id: b.id, chars });
            }
          } else if (newLine && b.type === 'thinking') {
            this.outputChars.thinking += b.chars;
          } else if (newLine && b.type === 'text') {
            this.outputChars.text += b.chars;
            apiRec.textChars += b.chars;
          }
        }
        if (this.seenApi.has(evt.apiId)) return; // usage already settled
        this.seenApi.add(evt.apiId);
        if (evt.model) this.model = evt.model;
        const u = evt.usage;
        if (!u) return;
        apiRec.output = u.output;
        this.settle(u);
        return;
      }
    }
  }

  // Distribute one API call's fresh tokens across the pending inserted items.
  settle(u) {
    this.cache.read += u.cacheRead;
    this.cache.write += u.cacheWrite;
    this.cache.input += u.input;
    if (u.cacheWrite5m != null) {
      this.cache.write5m += u.cacheWrite5m;
      this.cache.write1h += u.cacheWrite1h;
    }
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
    } else if (this.pendingCompaction) {
      // First call after a compaction rewrites the rebuilt context — base,
      // summary, and preserved tail — as fresh cacheWrite. Attribute known
      // pending items at their estimate; the excess is the rebuild cost,
      // booked on the compaction record rather than misread as recache.
      this.pending.forEach((p, i) => this.credit(p, estimates[i]));
      this.pendingCompaction.rebuildTokens += Math.max(0, fresh - estSum);
      this.pendingCompaction = null;
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
    this.timeline.push({
      ts: this.lastActivity,
      ctx: this.contextNow,
      b: CAT_KEYS.map((k) => this.context[k] || 0),
    });
  }

  // Timeline for the scrubber — downsampled evenly so the payload stays
  // small on very long sessions; first and last snapshots always survive.
  timelineSample() {
    const tl = this.timeline;
    const MAX = 300;
    if (tl.length <= MAX) return tl;
    const out = [];
    const stepN = (tl.length - 1) / (MAX - 1);
    for (let i = 0; i < MAX; i++) out.push(tl[Math.round(i * stepN)]);
    return out;
  }

  // One skill invocation — via the Skill tool (action carries its result
  // cost) or a slash command in a prompt (no action).
  noteSkillUse(name, action, ts) {
    const key = String(name).replace(/^\//, '');
    if (!key) return;
    const rec = this.skillUses.get(key) ||
      { count: 0, actions: [], lastTs: null, viaTool: false };
    rec.count += 1;
    if (action) {
      rec.actions.push(action);
      rec.viaTool = true;
    }
    if (ts) rec.lastTs = ts;
    this.skillUses.set(key, rec);
  }

  // MCP-server and skill usage, merged across the session and its agents.
  // Per-skill listing cost is the measured skill_listing injection prorated
  // by each entry's share of the listing text. MCP tool *schemas* live in
  // the unitemized base remainder — calls and results are what's measurable.
  mcpSkillsReport() {
    const sum = (actions) => actions.reduce((n, a) => n + a.tokens, 0);

    const mcp = new Map();
    const addMcp = (rec, viaAgent) => {
      const cur = mcp.get(rec.server) ||
        { server: rec.server, scope: null, calls: 0, tokens: 0, tools: new Set(), lastTs: null, agent: false };
      cur.calls += rec.calls;
      cur.tokens += sum(rec.actions);
      for (const t of rec.tools) cur.tools.add(t);
      if (rec.lastTs && (!cur.lastTs || rec.lastTs > cur.lastTs)) cur.lastTs = rec.lastTs;
      if (viaAgent) cur.agent = true;
      mcp.set(rec.server, cur);
    };
    for (const rec of this.mcpUses.values()) addMcp(rec, false);
    for (const a of this.agents.values()) for (const rec of a.mcpUses.values()) addMcp(rec, true);
    for (const c of this.mcpConfigured || []) {
      const cur = mcp.get(c.name);
      if (cur) cur.scope = c.scope;
      else mcp.set(c.name, { server: c.name, scope: c.scope, calls: 0, tokens: 0, tools: new Set(), lastTs: null, agent: false });
    }

    const uses = new Map();
    const addUse = (name, rec) => {
      const cur = uses.get(name) || { count: 0, tokens: 0, lastTs: null, viaTool: false };
      cur.count += rec.count;
      cur.tokens += sum(rec.actions);
      if (rec.viaTool) cur.viaTool = true;
      if (rec.lastTs && (!cur.lastTs || rec.lastTs > cur.lastTs)) cur.lastTs = rec.lastTs;
      uses.set(name, cur);
    };
    for (const [n, rec] of this.skillUses) addUse(n, rec);
    for (const a of this.agents.values()) for (const [n, rec] of a.skillUses) addUse(n, rec);

    const listRec = this.baseAttachments.get('skill_listing');
    const listTotal = [...this.skillList.values()].reduce((a, b) => a + b, 0);
    const listingTokens = listRec
      ? Math.round((listRec.tokens || est(listRec.chars)) / Math.max(1, listRec.count))
      : 0;
    const skills = [];
    for (const [name, chars] of this.skillList) {
      const u = uses.get(name);
      skills.push({
        name, listed: true,
        share: listTotal > 0 ? Math.round((listingTokens * chars) / listTotal) : 0,
        uses: u ? u.count : 0,
        tokens: u ? u.tokens : 0,
        lastTs: u ? u.lastTs : null,
      });
      uses.delete(name);
    }
    // Uses with no listing entry: real skills only if invoked via the Skill
    // tool — bare slash commands not in the listing are built-ins.
    for (const [name, u] of uses) {
      if (!u.viaTool) continue;
      skills.push({ name, listed: false, share: 0, uses: u.count, tokens: u.tokens, lastTs: u.lastTs });
    }
    skills.sort((x, y) => (y.uses - x.uses) || (y.share - x.share));

    let tsCalls = this.toolSearchUses.calls;
    let tsTokens = sum(this.toolSearchUses.actions);
    for (const a of this.agents.values()) {
      tsCalls += a.toolSearchUses.calls;
      tsTokens += sum(a.toolSearchUses.actions);
    }

    return {
      listingTokens,
      skills,
      mcp: [...mcp.values()]
        .map((m) => ({ ...m, tools: [...m.tools] }))
        .sort((x, y) => y.tokens - x.tokens || y.calls - x.calls),
      toolSearch: { calls: tsCalls, tokens: tsTokens },
    };
  }

  // Match each subagent to the parent Agent/Task call that spawned it and
  // report what its result cost in the parent's context ("returned").
  // Join: the agent transcript's first prompt equals the call's input.prompt;
  // identical prompts (parallel fan-outs) tie-break by end-time proximity.
  // Returns Map(agentId -> {returned, prompt}).
  agentReturns() {
    const actions = [];
    for (const t of this.turns) {
      for (const a of t.actions) {
        if (a.cat === 'agent' && a.agentPrompt) actions.push(a);
      }
    }
    const out = new Map();
    if (actions.length === 0) return out;
    for (const ag of this.agents.values()) {
      const first = ag.turns[0];
      if (!first || !first.prompt || first.prompt === '(session start)') continue;
      const end = ag.lastActivity ? new Date(ag.lastActivity).getTime() : 0;
      let best = null;
      let bestGap = Infinity;
      for (const a of actions) {
        if (a.roiClaimed || a.agentPrompt !== first.prompt) continue;
        const gap = a.ts ? Math.abs(new Date(a.ts).getTime() - end) : Infinity;
        if (gap < bestGap) { bestGap = gap; best = a; }
      }
      if (best) {
        best.roiClaimed = true;
        out.set(ag.id, { returned: best.tokens, prompt: best.agentPrompt });
      }
    }
    for (const a of actions) delete a.roiClaimed;
    return out;
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

  // Cache economics ledger. Reads bill at 0.1x the input price (savings vs
  // sending the same tokens uncached); writes carry a premium over plain
  // input — 1.25x at 5m TTL, 2x at 1h. Idle-gap re-writes (the recache
  // bucket) are priced against the cache read they would have been had the
  // entry not expired. USD figures need a known model price; token figures
  // are always measured.
  cacheEconomics() {
    const c = this.cache;
    const denom = c.read + c.write + c.input;
    if (denom === 0) return null;
    const price = inputPricePerMTok(this.model);
    // Old transcripts lack the TTL split — assume the cheaper 5m premium
    // for the unattributed remainder and say so.
    const unsplit = Math.max(0, c.write - c.write5m - c.write1h);
    const write5m = c.write5m + unsplit;
    const out = {
      read: c.read,
      write: c.write,
      write5m,
      write1h: c.write1h,
      splitAssumed: unsplit > 0,
      input: c.input,
      hitRatio: c.read / denom,
      recache: this.context.recache,
      priceKnown: price != null,
    };
    if (price != null) {
      out.savedUsd = usd(c.read, price, 1 - CACHE_READ_MULT);
      out.premiumUsd = usd(write5m, price, CACHE_WRITE_5M_MULT - 1) +
        usd(c.write1h, price, CACHE_WRITE_1H_MULT - 1);
      out.netUsd = out.savedUsd - out.premiumUsd;
      const recacheMult = c.write1h > write5m ? CACHE_WRITE_1H_MULT : CACHE_WRITE_5M_MULT;
      out.recacheUsd = usd(this.context.recache, price, recacheMult - CACHE_READ_MULT);
    }
    return out;
  }

  // Plain-text digest of the whole session — the input handed to the
  // local claude CLI when generating a handoff context file.
  contextDigest() {
    const L = [];
    L.push(`# Session digest: ${this.title || this.id}`);
    L.push(`project: ${this.cwd || 'unknown'}`);
    L.push(`model: ${this.model || 'unknown'} · started ${this.firstActivity || '?'} · last activity ${this.lastActivity || '?'}`);
    L.push(`totals: ${this.totals.calls} API calls · ${this.totals.fresh} fresh input tokens · ${this.totals.output} output tokens`);
    if (this.compactions.length > 0) {
      L.push(`compactions: ${this.compactions.length} — history before each survives only in its summary turn below`);
    }
    L.push('', '## Conversation (chronological; prompts truncated to 240 chars)');
    for (const t of this.turns) {
      if (!t.prompt || t.prompt === '(session start)') continue;
      L.push(`- ${t.ts ? t.ts + ' ' : ''}${t.compactSummary ? '[COMPACTION SUMMARY] ' : 'USER: '}${t.prompt}`);
      const top = [...t.actions].sort((a, b) => b.tokens - a.tokens).slice(0, 5);
      for (const a of top) L.push(`    · ${a.label.slice(0, 140)} (${a.tokens} tok)`);
    }
    const edited = new Set(this.editedFiles);
    for (const a of this.agents.values()) for (const p of a.editedFiles) edited.add(p);
    if (edited.size > 0) {
      L.push('', '## Files edited');
      for (const p of edited) L.push(`- ${p}`);
    }
    const reads = this.mergedFileReads().sort((a, b) => b.tokens - a.tokens).slice(0, 25);
    if (reads.length > 0) {
      L.push('', '## Files read most');
      for (const f of reads) L.push(`- ${f.path} (${f.tokens} tok · ${f.reads} reads)`);
    }
    const docs = this.mergedDocs().slice(0, 15);
    if (docs.length > 0) {
      L.push('', '## Docs used');
      for (const d of docs) L.push(`- ${d.path} (${d.reads} reads)`);
    }
    if (this.agents.size > 0) {
      L.push('', '## Subagents spawned');
      for (const a of this.agents.values()) L.push(`- ${(a.title || a.id).slice(0, 160)}`);
    }
    return L.join('\n');
  }

  // Plain-text digest of the Optimize findings plus the supporting facts
  // a plan needs — the input handed to the local claude CLI when
  // generating an optimization plan.
  optimizeDigest() {
    const KIND = {
      search: 'expensive search pattern',
      reread: 'file re-read many times',
      fatdoc: 'fat doc',
      injected: 'heavy harness injection',
      basefile: 'always-loaded base file',
      skill: 'repeated command (skill candidate)',
      skilllist: 'unused skill-listing share',
      agentroi: 'fat agent return',
      compact: 'repeated compaction',
      recache: 'idle-gap recache',
    };
    const L = [];
    L.push(`# Optimize digest: ${this.title || this.id}`);
    L.push(`project: ${this.cwd || 'unknown'} · model: ${this.model || 'unknown'}`);
    L.push(`totals: ${this.totals.calls} API calls · ${this.totals.fresh} fresh input tokens · ${this.totals.output} output tokens`);
    const ce = this.cacheEconomics();
    if (ce) {
      L.push(`cache: ${(ce.hitRatio * 100).toFixed(1)}% hit ratio · idle-gap recache ${this.context.recache} tokens` +
        (ce.priceKnown && ce.recacheUsd ? ` (~$${ce.recacheUsd.toFixed(2)})` : ''));
    }
    if (this.compactions.length > 0) L.push(`compactions this session: ${this.compactions.length}`);
    L.push('', '## Findings (from measured token spend)');
    for (const g of this.suggestions()) {
      L.push(`- [${KIND[g.kind] || g.kind}] ${g.subject || ''} — impact ~${g.impact} tokens · ${g.count}×` +
        (g.context ? ` · during: ${g.context}` : ''));
    }
    if (this.baseFiles && this.baseFiles.length > 0) {
      L.push('', '## Base files loaded at every session start');
      for (const f of this.baseFiles) L.push(`- ${f.label}: ${f.path} (${f.chars} chars)`);
    }
    const ms = this.mcpSkillsReport();
    const unusedSkills = ms.skills.filter((x) => x.listed && x.uses === 0);
    if (unusedSkills.length > 0) {
      L.push('', `## Skills listed but never used (listing costs ~${ms.listingTokens} tokens/session)`);
      for (const x of unusedSkills) L.push(`- ${x.name} (~${x.share} tok/session)`);
    }
    const reads = this.mergedFileReads().sort((a, b) => b.tokens - a.tokens).slice(0, 15);
    if (reads.length > 0) {
      L.push('', '## Most-read files');
      for (const f of reads) L.push(`- ${f.path} (${f.tokens} tok · ${f.reads} reads)`);
    }
    return L.join('\n');
  }

  // Compact per-session summary for the persistent rollup file — the
  // record that survives after the session leaves the live window.
  rollupSummary() {
    const ob = this.outputBreakdown();
    const ce = this.cacheEconomics();
    let agentTokens = 0;
    for (const a of this.agents.values()) agentTokens += a.totals.fresh + a.totals.output;
    return {
      cacheRead: ce ? ce.read : 0,
      cacheWrite: ce ? ce.write : 0,
      cacheInput: ce ? ce.input : 0,
      cacheSavedUsd: ce && ce.priceKnown ? Math.round(ce.savedUsd * 10000) / 10000 : null,
      cachePremiumUsd: ce && ce.priceKnown ? Math.round(ce.premiumUsd * 10000) / 10000 : null,
      v: 1,
      id: this.id,
      cwd: this.cwd,
      model: this.model,
      started: this.firstActivity,
      last: this.lastActivity,
      calls: this.totals.calls,
      fresh: this.totals.fresh,
      output: this.totals.output,
      base: this.context.base,
      maxContext: this.maxContext,
      window: this.windowExact || this.window,
      costUsd: this.costUsd ?? (this.exactCostUsd > 0 ? this.exactCostUsd : null),
      compactions: this.compactions.length,
      agents: this.agents.size,
      agentTokens,
      thinking: ob ? ob.thinking : 0,
      text: ob ? ob.text : 0,
      toolUse: ob ? ob.toolUse : 0,
    };
  }

  // Output tokens spent issuing one tool call: its payload estimate plus an
  // even share of its API message's thinking remainder (thinking preceded
  // all of a message's parallel calls jointly, so an even split is the
  // least-wrong attribution). Tool results arrive only after the message
  // completed, so the message's blocks are fully accumulated by then.
  genCostFor(toolUseId) {
    const tu = this.toolUses.get(toolUseId);
    if (!tu || !tu.apiId) return null;
    const rec = this.apiOutput.get(tu.apiId);
    if (!rec || rec.tools.length === 0) return null;
    const i = rec.tools.findIndex((t) => t.id === toolUseId);
    if (i < 0) return null;
    const tok = (chars) => (chars > 0 ? est(chars) : 0);
    const payloads = rec.tools.map((t) => tok(t.chars));
    const sum = tok(rec.textChars) + payloads.reduce((a, b) => a + b, 0);
    let scale = 1;
    let thinking = 0;
    if (rec.output > 0) {
      if (sum > rec.output) scale = rec.output / sum;
      else thinking = rec.output - sum;
    }
    return Math.round(payloads[i] * scale + thinking / rec.tools.length);
  }

  // Output composition. Visible text and tool-call payloads are measured
  // from content blocks; thinking is the remainder of usage output_tokens,
  // since recent transcripts persist only thinking signatures, not text.
  outputBreakdown() {
    const out = this.totals.output;
    if (!out) return null;
    const tok = (chars) => (chars > 0 ? est(chars) : 0);
    let text = tok(this.outputChars.text);
    let toolUse = tok(this.outputChars.toolUse);
    // Estimates can overshoot the measured total (char-ratio noise) — fit
    // them and let thinking be what's genuinely left.
    if (text + toolUse > out) {
      const scale = out / (text + toolUse);
      text = Math.round(text * scale);
      toolUse = Math.round(toolUse * scale);
    }
    return {
      text,
      toolUse,
      thinking: Math.max(0, out - text - toolUse),
      thinkingMeasured: this.outputChars.thinking > 0,
    };
  }

  // Context-growth forecast: median fresh+output over recent completed
  // turns → turns left until the window fills (compaction territory).
  // Median rather than mean so one recache spike or compaction rebuild
  // doesn't dominate.
  forecast() {
    if (!this.contextNow) return null;
    const samples = this.turns.slice(0, -1).slice(-10)
      .map((t) => t.fresh + t.output)
      .filter((v) => v > 0);
    if (samples.length < 3) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    const perTurn = sorted[Math.floor(sorted.length / 2)];
    if (perTurn <= 0) return null;
    const win = this.windowExact || this.window;
    return { perTurn, turnsToFull: Math.max(0, Math.ceil((win - this.contextNow) / perTurn)) };
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

  // Every file read by this session or its agents, summed per path —
  // feeds the cross-session codebase map. Harness-internal files (tool
  // result spill, transcripts, scratchpads) are the harness's plumbing,
  // not the user's codebase — same exclusion the docs stats apply.
  mergedFileReads() {
    const map = new Map();
    const add = (f, viaAgent) => {
      if (HARNESS_PATH.test(String(f.path))) return;
      const k = String(f.path).replace(/\//g, '\\').toLowerCase();
      const cur = map.get(k) || { path: f.path, reads: 0, tokens: 0, agent: false };
      cur.reads += f.reads;
      cur.tokens += f.tokens;
      if (viaAgent) cur.agent = true;
      map.set(k, cur);
    };
    for (const f of this.fileReads.values()) add(f, false);
    for (const a of this.agents.values()) {
      for (const f of a.fileReads.values()) add(f, true);
    }
    return [...map.values()];
  }

  // Optimization suggestions, grounded in this session's actual token spend.
  // Each finding: {kind, impact (tokens), count, subject, context}.
  suggestions() {
    const out = [];
    const searches = new Map(); // label -> {tokens, count, context, agent}
    const reads = new Map(); // path -> {tokens, count}
    const commands = new Map(); // command signature -> {tokens, count, context, agent}

    const collect = (turns, agentTitle) => {
      for (const t of turns) {
        for (const a of t.actions) {
          if (a.name === 'Bash' || a.name === 'PowerShell') {
            const sig = commandSig(a.label);
            const cur = commands.get(sig) ||
              { tokens: 0, count: 0, context: null, maxTok: -1, agent: false };
            cur.tokens += a.tokens;
            cur.count += 1;
            if (a.tokens > cur.maxTok) {
              cur.maxTok = a.tokens;
              cur.context = agentTitle ? `agent: ${agentTitle.slice(0, 60)}` : (t.prompt || null);
            }
            if (agentTitle) cur.agent = true;
            commands.set(sig, cur);
          } else if (a.cat === 'search') {
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
    // Repeated command invocations: a workflow Claude re-runs by hand every
    // time — a candidate for a skill (or a hook, if it should be automatic).
    // Rank weights repetition as well as tokens: a cheap command run 20×
    // is a stronger skill candidate than its token cost suggests.
    const skillSuggs = [];
    for (const [sig, c] of commands) {
      if (c.count >= 5) {
        skillSuggs.push({
          kind: 'skill', impact: c.tokens + c.count * 150,
          tokens: c.tokens, count: c.count, subject: sig, context: c.context,
        });
      }
    }
    // Never-used share of the skill listing: paid at every session start
    // for skills this project doesn't touch. Disabling unused plugins or
    // skills is measured, direct savings.
    const skilllistSuggs = [];
    const ms = this.mcpSkillsReport();
    const listedSkills = ms.skills.filter((x) => x.listed);
    const unusedSkills = listedSkills.filter((x) => x.uses === 0);
    const unusedShare = unusedSkills.reduce((n, x) => n + x.share, 0);
    if (unusedShare >= 1500 && unusedSkills.length >= 3) {
      skilllistSuggs.push({
        kind: 'skilllist', impact: unusedShare, count: unusedSkills.length,
        subject: `${unusedSkills.length} of ${listedSkills.length}`, context: null,
      });
    }
    // Fat agent returns: delegation's value is compression — work happens
    // in the agent's own window and only conclusions come back. A large
    // return re-pays the reading in the parent context.
    const agentroiSuggs = [];
    const areturns = this.agentReturns();
    for (const ag of this.agents.values()) {
      const r = areturns.get(ag.id);
      if (r && r.returned >= 5000) {
        agentroiSuggs.push({
          kind: 'agentroi', impact: r.returned, count: 1,
          subject: r.prompt, context: (ag.title || ag.id).slice(0, 90),
        });
      }
    }
    // Repeated compaction: the session keeps outgrowing its window — every
    // event re-pays a summary plus the rebuilt context, and drops history.
    const compactSuggs = [];
    const compactCost = this.compactions.reduce(
      (n, c) => n + c.summaryTokens + c.rebuildTokens, 0);
    if (this.compactions.length >= 2 || compactCost >= 30000) {
      compactSuggs.push({
        kind: 'compact', impact: Math.max(1, compactCost),
        count: this.compactions.length, subject: null, context: null,
      });
    }
    out.push(...searchSuggs, ...rereadSuggs, ...fatdocSuggs, ...injectedSuggs, ...basefileSuggs, ...skillSuggs, ...skilllistSuggs, ...agentroiSuggs, ...compactSuggs);
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
    if (p.compactRec) p.compactRec.summaryTokens += tokens;
    if (p.docPath && p.cat === 'docsRead') {
      const d = this.docs.get(p.docPath);
      if (d) d.tokens += tokens;
    }
    if (p.docPath) {
      const fr = this.fileReads.get(p.docPath);
      if (fr) fr.tokens += tokens;
    }
  }

  toJSON() {
    const areturns = this.agentReturns();
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
      outputBreakdown: this.outputBreakdown(),
      sidechain: this.sidechain,
      costUsd: this.costUsd ?? (this.exactCostUsd > 0 ? this.exactCostUsd : null),
      turns: this.turns.slice(-60),
      compactions: this.compactions,
      forecast: this.forecast(),
      timeline: this.timelineSample(),
      cacheEconomics: this.cacheEconomics(),
      mcpSkills: this.mcpSkillsReport(),
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
        returned: areturns.has(a.id) ? areturns.get(a.id).returned : null,
        fresh: a.totals.fresh,
        output: a.totals.output,
        contextNow: a.contextNow,
        docsReads: [...a.docs.values()].reduce((n, d) => n + d.reads, 0),
        started: a.turns.length ? a.turns[0].ts : null,
        ended: a.lastActivity,
        actions: a.turns
          .flatMap((t) => t.actions)
          .slice(-200)
          .map((x) => ({ label: x.label, cat: x.cat, tokens: x.tokens, ts: x.ts, durMs: x.durMs, genTokens: x.genTokens })),
      })),
    };
  }
}
