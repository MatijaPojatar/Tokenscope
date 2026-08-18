// Tokenscope UI. Receives session models over SSE and renders the selected
// session: context gauge, per-action timeline, docs leaderboard.

const CATS = [
  ['base', 'base (system+tools+memory)'],
  ['conversation', 'conversation'],
  ['docsRead', 'docs read'],
  ['codeRead', 'code read'],
  ['search', 'search'],
  ['agent', 'agents'],
  ['toolOther', 'other tools'],
  ['attachments', 'attachments'],
  ['output', 'output'],
  ['recache', 'recache'],
];

const state = {
  sessions: [],
  detail: {},      // id -> full session model
  selected: null,
  pinned: false,   // user clicked a session; stop auto-following
  view: 'session', // 'session' | 'docs' | 'mcp' (cross-session reports)
  rateLimits: null,
  report: { read: [], unused: [] },
  reportFetched: 0,
  mcpReport: null,
  mcpReportFetched: 0,
  turnToggles: {}, // turn key -> expanded override (survives live re-renders)
  agentToggles: {}, // agent key -> expanded
  highlight: null, // {kind, subject} from a clicked Optimize entry
  suggExpanded: {}, // session id -> show all findings past the per-kind caps
  docToggles: {}, // doc key -> expanded
  baseToggles: {}, // base-context row key -> expanded
};

// What each harness-injected attachment type is.
const ATT_DESC = {
  skill_listing: 'The list of available skills and their descriptions, injected at session start.',
  agent_listing_delta: 'Available agent types for the Agent tool.',
  deferred_tools_delta: 'Names of deferred tools as they become available.',
  todo_reminder: 'Periodic harness reminders about the task list.',
  edited_text_file: 'Full file contents re-injected after edits so Claude sees current state.',
  hook_additional_context: 'Output returned by your configured hooks, added into context.',
  file: 'File contents attached by the harness.',
  plan_file_reference: 'Plan file content referenced into context.',
  nested_memory: 'CLAUDE.md from a subdirectory, auto-injected when files there were read.',
};

// What each disk-scanned base file is.
function baseFileDesc(label) {
  if (label.startsWith('↳')) return 'Imported via @-reference from a CLAUDE.md above — loaded with it at session start.';
  if (label.includes('(user)')) return 'Your global CLAUDE.md — loaded at the start of every session on this machine.';
  if (label.includes('CLAUDE.md (project)')) return 'Project CLAUDE.md — loaded at the start of every session in this project.';
  if (label.includes('MEMORY.md')) return 'Auto-memory index — loaded each session; individual memories load on demand.';
  if (label.includes('rules')) return 'Rules file from .claude\\rules — loaded at session start.';
  return 'Loaded into the base context at session start.';
}

// Is this action a read of the given doc? (labels hold relative paths,
// docs hold absolute ones — match on the suffix)
function docActionMatch(path, a) {
  if (a.cat !== 'docsRead') return false;
  const lp = a.label.replace(/^(Read|auto) /, '').replace(/\//g, '\\').toLowerCase();
  return lp.length > 0 && String(path).replace(/\//g, '\\').toLowerCase().endsWith(lp);
}

// Does an action row belong to the clicked Optimize finding?
function actionMatches(hl, a) {
  if (!hl) return false;
  if (hl.kind === 'search') return a.cat === 'search' && a.label === hl.subject;
  if (hl.kind === 'reread') return a.label === 'Read ' + hl.subject;
  if (hl.kind === 'fatdoc') return docActionMatch(hl.subject, a);
  if (hl.kind === 'skill') return commandSig(a.label) === hl.subject;
  if (hl.kind === 'agentroi') return a.cat === 'agent' && a.agentPrompt === hl.subject;
  return false;
}

// Mirror of src/attribution.js commandSig — must stay in sync.
function commandSig(label) {
  const sp = label.indexOf(' ');
  const tool = sp < 0 ? label : label.slice(0, sp);
  let cmd = sp < 0 ? '' : label.slice(sp + 1);
  cmd = cmd
    .replace(/^cd\s+("[^"]*"|\S+)\s*(&&|;)\s*/i, '')
    .replace(/^set-location\s+("[^"]*"|\S+)\s*(&&|;)\s*/i, '');
  return `${tool} ${cmd.split(' ').slice(0, 3).join(' ')}`.trim();
}

const turnKey = (sid, t) => `${sid}|${t.ts}|${(t.prompt || '').slice(0, 40)}`;

// Friendly names for harness-injected attachment types.
const ATT_NAMES = {
  skill_listing: 'skill listing',
  agent_listing_delta: 'agent listing',
  deferred_tools_delta: 'deferred tools',
  todo_reminder: 'todo reminders',
  edited_text_file: 'edited files re-injected',
  hook_additional_context: 'hook context',
  file: 'file attachments',
  plan_file_reference: 'plan file',
  nested_memory: 'nested CLAUDE.md',
};

// Default per-kind display caps for the Optimize panel.
const SUGG_CAPS = { search: 4, reread: 3, fatdoc: 2, injected: 2, basefile: 3, skill: 2, skilllist: 1, agentroi: 2, compact: 1, recache: 99 };
function cappedSuggs(all) {
  const seen = {};
  return all.filter((g) => {
    seen[g.kind] = (seen[g.kind] || 0) + 1;
    return seen[g.kind] <= (SUGG_CAPS[g.kind] ?? 3);
  });
}

const $ = (id) => document.getElementById(id);
const catColor = (cat) => `var(--c-${cat})`;

function fmtTok(n) {
  if (n == null) return '–';
  if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k';
  return String(n);
}

function fmtClock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d) ? '' : d.toLocaleTimeString('en-GB', { hour12: false });
}

function fmtMs(ms) {
  if (ms == null) return '';
  if (ms < 1000) return Math.round(ms) + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function fmtDur(startTs, endTs) {
  if (!startTs || !endTs) return '';
  const s = Math.max(0, (new Date(endTs) - new Date(startTs)) / 1000);
  if (s < 60) return Math.round(s) + 's';
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

// Agent compression ratio: tokens burned in the agent's window per token
// its result added to the parent context.
function roiRatio(burned, returned) {
  if (!returned) return null;
  const r = burned / returned;
  return (r >= 10 ? Math.round(r) : r.toFixed(1)) + ':1';
}

function fmtAgo(ts) {
  if (!ts) return '';
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 90) return 'now';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
}

function relPath(p, cwd) {
  const norm = String(p || '').replace(/\//g, '\\');
  if (cwd) {
    const prefix = String(cwd).replace(/\//g, '\\').replace(/\\+$/, '') + '\\';
    if (norm.toLowerCase().startsWith(prefix.toLowerCase())) return norm.slice(prefix.length);
  }
  return norm;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// ---- collapsible right-column sections (state survives reloads) ----

let sectPrefs = {};
try { sectPrefs = JSON.parse(localStorage.getItem('tokenscope.sections') || '{}'); } catch { /* fresh */ }
for (const h of document.querySelectorAll('.sect > h2')) {
  const wrap = h.parentElement;
  const key = h.dataset.sect;
  if (sectPrefs[key]) wrap.classList.add('closed');
  h.tabIndex = 0;
  h.setAttribute('role', 'button');
  h.setAttribute('aria-expanded', String(!sectPrefs[key]));
  const tgl = () => {
    const closed = wrap.classList.toggle('closed');
    sectPrefs[key] = closed;
    h.setAttribute('aria-expanded', String(!closed));
    try { localStorage.setItem('tokenscope.sections', JSON.stringify(sectPrefs)); } catch { /* private mode */ }
  };
  h.onclick = tgl;
  h.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tgl(); }
  };
}

// Cross-links (clicking a flagged call, jumping to an agent row) must land
// somewhere visible — reopen the target section if the user closed it.
function openSect(key) {
  const h = document.querySelector(`h2[data-sect="${key}"]`);
  if (h && h.parentElement.classList.contains('closed')) h.click();
}

// ---- sidebar ----

function renderList() {
  const box = $('session-list');
  box.replaceChildren();
  for (const s of state.sessions) {
    const item = el('div', 'session-item' + (s.id === state.selected ? ' active' : ''));
    item.append(el('div', 'st', s.title || s.id.slice(0, 8)));
    const meta = el('div', 'sm');
    meta.append(
      el('span', null, fmtTok(s.contextNow) + ' ctx'),
      el('span', null, (s.compactions ? `⟲${s.compactions} · ` : '') + fmtAgo(s.lastActivity)),
    );
    item.append(meta);
    item.onclick = () => { state.selected = s.id; state.pinned = true; state.view = 'session'; render(); };
    box.append(item);
  }
}

// ---- detail ----

function renderDetail() {
  const s = state.detail[state.selected];
  $('empty').hidden = !!s;
  $('detail').hidden = !s;
  if (!s) return;

  $('s-title').textContent = s.title || s.id;
  $('s-cwd').textContent = s.cwd || '';
  $('s-model').textContent = s.model || '';
  $('s-cost').textContent = s.costUsd != null ? `$${s.costUsd.toFixed(2)}` : '';
  const rl = state.rateLimits;
  $('s-rl').textContent = rl
    ? ['five_hour', 'seven_day'].filter((k) => rl[k] && rl[k].used_percentage != null)
        .map((k) => `${k === 'five_hour' ? '5h' : '7d'} ${Math.round(rl[k].used_percentage)}%`)
        .join(' · ')
    : '';
  const active = s.lastActivity && Date.now() - new Date(s.lastActivity).getTime() < 120000;
  $('live-dot').className = 'dot' + (active ? ' on' : '');

  // gauge
  const used = s.contextNow || 0;
  const win = s.window || 200000;
  $('g-num').textContent = `${fmtTok(used)} / ${fmtTok(win)} · ${Math.round((used / win) * 100)}%`;
  const gauge = $('gauge');
  gauge.replaceChildren();
  const legend = $('legend');
  legend.replaceChildren();
  const ctxSum = CATS.reduce((a, [k]) => a + (s.context[k] || 0), 0);
  // Buckets are lifetime accumulation; scale them onto current usage so the
  // gauge reflects composition even after compaction shrinks the window.
  const scale = ctxSum > 0 ? Math.min(1, used / ctxSum) : 0;
  for (const [k, label] of CATS) {
    const v = s.context[k] || 0;
    if (v <= 0) continue;
    const seg = document.createElement('div');
    seg.style.width = ((v * scale) / win) * 100 + '%';
    seg.style.background = catColor(k);
    let title = `${label}: ${fmtTok(v)}`;
    if (k === 'output' && s.outputBreakdown) {
      const b = s.outputBreakdown;
      title += ` — thinking ~${fmtTok(b.thinking)} · text ~${fmtTok(b.text)} · tool calls ~${fmtTok(b.toolUse)}`;
    }
    seg.title = title;
    gauge.append(seg);
    const li = el('span');
    const sw = el('i', 'swatch');
    sw.style.background = catColor(k);
    li.append(sw, document.createTextNode(`${label} ${fmtTok(v)}`));
    li.title = title;
    legend.append(li);
  }

  // compaction history + growth forecast under the gauge
  const comps = s.compactions || [];
  const gc = $('g-compact');
  const gcBits = [];
  if (comps.length > 0) {
    const dropped = comps.reduce((n, c) => n + Math.max(0, (c.preTokens || 0) - (c.postTokens || 0)), 0);
    gcBits.push(`⟲ compacted ${comps.length}× · ${fmtTok(dropped)} of history dropped`);
  }
  if (s.forecast && s.forecast.turnsToFull != null && s.forecast.turnsToFull <= 40) {
    gcBits.push(`≈${s.forecast.turnsToFull} turns to a full window at the current ~${fmtTok(s.forecast.perTurn)}/turn`);
  }
  gc.hidden = gcBits.length === 0;
  gc.textContent = gcBits.join('   ·   ');

  // Optimize findings indexed for cross-linking: calls belonging to a finding
  // get marked, and clicking one focuses its card in the Optimize panel.
  const allSuggs = s.suggestions || [];
  const findingFor = (a) =>
    allSuggs.find((g) => g.kind !== 'recache' && actionMatches(g, a)) || null;
  const focusFinding = (g) => {
    state.highlight = { kind: g.kind, subject: g.subject };
    openSect('optimize');
    if (!state.suggExpanded[s.id] && !cappedSuggs(allSuggs).includes(g)) {
      state.suggExpanded[s.id] = true; // card is past the caps — reveal it
    }
    renderDetail();
    requestAnimationFrame(() => {
      const active = document.querySelector('.sugg-item.active');
      if (active) active.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  // timeline — newest turn first, with compaction boundaries interleaved
  const turnsBox = $('turns');
  turnsBox.replaceChildren();
  const turns = [...(s.turns || [])].reverse();
  const maxTok = Math.max(200, ...turns.flatMap((t) => t.actions.map((a) => a.tokens)));
  const entries = turns.map((t, i) => ({ t, i }));
  for (const c of comps) {
    // The continuation-summary turn shares the boundary's timestamp — the
    // marker goes just below it, above the first pre-compaction turn.
    const ct = new Date(c.ts).getTime();
    let at = entries.findIndex((e) => e.t && e.t.ts && new Date(e.t.ts).getTime() < ct);
    if (at < 0) at = entries.length;
    entries.splice(at, 0, { c });
  }
  entries.forEach(({ t, i, c }) => {
    if (c) {
      const row = el('div', 'compact-marker');
      const label = `⟲ context compacted — ${fmtTok(c.preTokens)} → ${fmtTok(c.postTokens)}` +
        ` (${c.trigger}${c.durationMs ? ' · ' + fmtMs(c.durationMs) : ''})`;
      row.append(el('span', 'cm-line'), el('span', 'cm-label', label), el('span', 'cm-line'));
      turnsBox.append(row);
      return;
    }
    const key = turnKey(s.id, t);
    const expanded = state.turnToggles[key] ?? (i === 0); // newest open by default
    const turn = el('div', 'turn' + (expanded ? '' : ' collapsed'));
    const head = el('div', 'turn-head');
    head.tabIndex = 0;
    head.setAttribute('role', 'button');
    head.setAttribute('aria-expanded', String(expanded));
    const tp = t.compactSummary
      ? el('span', 'tp cs', '⟲ compaction summary — what the model kept of the dropped history')
      : el('span', 'tp', '> ' + (t.prompt || ''));
    if (t.compactSummary) tp.title = t.prompt || '';
    head.append(
      el('span', 'chev', expanded ? '▾' : '▸'),
      tp,
      el('span', 'tt', `${t.ts ? fmtClock(t.ts) + ' · ' : ''}${t.actions.length} actions · +${fmtTok(t.fresh)} in · ${fmtTok(t.output)} out`),
    );
    const toggle = () => {
      state.turnToggles[key] = !expanded;
      renderDetail();
    };
    head.onclick = toggle;
    head.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    };
    turn.append(head);
    const actionsBox = el('div', 'turn-actions');
    for (const [ai, a] of t.actions.entries()) {
      const row = el('div', 'arow' + (actionMatches(state.highlight, a) ? ' hl' : ''));
      row.dataset.akey = `${key}#${ai}`;
      const found = findingFor(a);
      if (found) {
        row.classList.add('opt');
        row.title = 'Part of an Optimize finding — click to focus it';
        row.onclick = () => focusFinding(found);
      }
      const label = el('span', 'al');
      const [tool, ...rest] = (a.label || a.name).split(' ');
      label.append(document.createTextNode(tool + ' '));
      label.append(el('em', null, rest.join(' ')));
      label.title = a.label || a.name;
      const bar = el('span', 'abar');
      const fill = document.createElement('div');
      fill.style.width = Math.max(1.5, (a.tokens / maxTok) * 100) + '%';
      fill.style.background = catColor(a.cat);
      bar.append(fill);
      const time = el('span', 'atime',
        [
          fmtClock(a.ts),
          a.durMs != null ? fmtMs(a.durMs) : null,
          a.genTokens != null ? `~${fmtTok(a.genTokens)} out` : null,
        ].filter(Boolean).join(' · '));
      if (a.genTokens != null) {
        time.title = `~${fmtTok(a.genTokens)} output tokens to issue this call (payload + its share of the message’s thinking)`;
      }
      row.append(label, time, bar, el('span', 'anum', '+' + fmtTok(a.tokens)));
      actionsBox.append(row);
    }
    turn.append(actionsBox);
    turnsBox.append(turn);
  });

  // Observable usage signals for an always-loaded file. In-context use
  // isn't logged anywhere, so we report what is: explicit Reads/Edits of
  // the same file, and how many sessions paid to load it.
  const fileUsage = (f) => {
    const norm = String(f.path).replace(/\//g, '\\').toLowerCase();
    let reads = 0;
    let edits = 0;
    const scan = (acts) => {
      for (const a of acts) {
        const sp = a.label.indexOf(' ');
        if (sp < 0) continue;
        const verb = a.label.slice(0, sp);
        const rest = a.label.slice(sp + 1).replace(/\//g, '\\').toLowerCase();
        if (!rest || !norm.endsWith(rest)) continue;
        if (verb === 'Read' || verb === 'auto') reads += 1;
        else if (verb === 'Edit' || verb === 'Write') edits += 1;
      }
    };
    for (const t of s.turns || []) scan(t.actions);
    for (const ag of s.agents || []) scan(ag.actions || []);
    return { reads, edits };
  };
  const projSessionCount = Math.max(1, state.sessions.filter(
    (x) => x.cwd && s.cwd && x.cwd.toLowerCase() === s.cwd.toLowerCase()).length);

  // Expandable key/value rows — shared by the base, compaction, and
  // MCP & skills panels. Toggle state lives in state.baseToggles.
  const estTok = (chars) => Math.max(1, Math.round(chars / 3.8));
  const rowAdder = (container) => ({
    group(label, v) {
      const h = el('div', 'base-group');
      h.append(el('span', null, label), el('b', null, v));
      container.append(h);
    },
    row(id, k, v, detail) {
      const rowKey = `${s.id}|${id}`;
      const open = !!state.baseToggles[rowKey];
      const r = el('div', 'base-row' + (detail ? ' exp' : ''));
      r.append(el('span', null, (detail ? (open ? '▾ ' : '▸ ') : '') + k), el('b', null, v));
      container.append(r);
      if (!detail) return;
      r.tabIndex = 0;
      r.setAttribute('role', 'button');
      r.setAttribute('aria-expanded', String(open));
      const tgl = () => { state.baseToggles[rowKey] = !open; renderDetail(); };
      r.onclick = tgl;
      r.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tgl(); }
      };
      if (open) {
        const box = el('div', 'base-detail');
        for (const line of detail().filter(Boolean)) box.append(el('div', null, line));
        container.append(box);
      }
    },
  });

  // base context breakdown: disk-scanned files + measured injections +
  // the unitemizable remainder (system prompt, tool schemas)
  const baseWrap = $('base-wrap');
  const baseRows = $('base-rows');
  baseRows.replaceChildren();
  const baseTotal = (s.context && s.context.base) || 0;
  baseWrap.hidden = baseTotal === 0;
  if (baseTotal > 0) {
    const { row: addBaseRow, group: addGroupHead } = rowAdder(baseRows);
    addGroupHead('loaded at session start', fmtTok(baseTotal));

    let diskSum = 0;
    for (const f of s.baseFiles || []) {
      const t = estTok(f.chars);
      diskSum += t;
      addBaseRow(`file|${f.path}`, f.label, '~' + fmtTok(t), () => {
        const u = fileUsage(f);
        return [
          f.path,
          `${(f.chars / 1024).toFixed(1)} KB · ${f.lines ?? '?'} lines · ~${fmtTok(t)} tokens (estimated)`,
          f.mtime ? `modified ${new Date(f.mtime).toLocaleString('en-GB')}` : null,
          `loaded by ${projSessionCount} session${projSessionCount === 1 ? '' : 's'} in this window · ~${fmtTok(t * projSessionCount)} total`,
          `this session: read directly ${u.reads}× · edited ${u.edits}×`,
          baseFileDesc(f.label),
          'In-context use isn’t logged by Claude — loads, Reads, and edits are the observable signals.',
        ];
      });
    }
    const remainder = baseTotal - diskSum;
    if (remainder > 0) {
      addBaseRow('remainder', 'system prompt + tools (est.)', '~' + fmtTok(remainder), () => [
        'Claude Code’s system prompt, tool definitions, and other startup content.',
        'Not itemized in the transcript — estimated as the base total minus the files above.',
        'Run /context in the terminal for the interactive breakdown.',
      ]);
    }
    const injectedList = (s.baseAttachments || []).filter((a) => (a.tokens || estTok(a.chars)) > 0);
    if (injectedList.length > 0) {
      const injSum = injectedList.reduce((n, a) => n + (a.tokens || estTok(a.chars)), 0);
      addGroupHead('injected during session', fmtTok(injSum));
    }
    for (const a of injectedList) {
      const tok = a.tokens || estTok(a.chars);
      addBaseRow(`att|${a.label}`, ATT_NAMES[a.label] || a.label, fmtTok(tok), () => [
        ATT_DESC[a.label] || 'Harness-injected context.',
        `${a.count} injection${a.count === 1 ? '' : 's'} · ~${fmtTok(Math.round(tok / Math.max(1, a.count)))} each · ${(a.chars / 1024).toFixed(1)} KB total`,
        a.firstTs ? `first ${fmtClock(a.firstTs)} · last ${fmtClock(a.lastTs)}` : null,
        a.tokens > 0 ? 'Tokens measured from usage attribution.' : 'Tokens estimated from size.',
      ]);
    }
  }

  // optimize suggestions
  const SUGG = {
    search: (g) => [
      `${g.subject} — ${g.count}× · ${fmtTok(g.impact)}`,
      'Document this concept in a docs .md (what it is, where it lives) so Claude reads a focused doc instead of searching the codebase.',
    ],
    reread: (g) => [
      `${relPath(g.subject, s.cwd)} — read ${g.count}× · ${fmtTok(g.impact)}`,
      'Add a short doc covering this file’s API (or split the file) so re-checks are cheap.',
    ],
    fatdoc: (g) => [
      `${relPath(g.subject, s.cwd)} — ~${fmtTok(Math.round(g.impact / g.count))} per read · ${g.count} reads`,
      'Split into smaller focused docs so only the relevant part loads.',
    ],
    recache: (g) => [
      `${fmtTok(g.impact)} re-cached after idle gaps (${g.count}% of input spend)`,
      'The prompt cache expires when a session sits idle; grouping interactions (or starting fresh sessions) avoids re-paying the whole prefix.',
    ],
    agentroi: (g) => [
      `agent returned ${fmtTok(g.impact)} into the parent context`,
      'Delegation’s value is compression: the agent’s reading stays in its own window and only conclusions come back. A return this large re-pays the work in the parent — ask agents for findings and summaries, not file contents or raw dumps.',
    ],
    skilllist: (g) => [
      `${g.subject} listed skills never used — ~${fmtTok(g.impact)} every session`,
      'The skill listing is paid at every session start. Disable plugins or skills this project doesn’t use (/plugin, or move rarely-needed personal skills out of ~/.claude/skills) to slim it — the MCP & skills panel shows each skill’s share.',
    ],
    compact: (g) => [
      `context compacted ${g.count}× — ~${fmtTok(g.impact)} re-paid`,
      'Each compaction summarizes and drops history, then re-pays the rebuilt context as fresh input. Trim always-loaded base files, route heavy searches and reads through agents (their tokens stay in separate windows), and prefer a fresh session per task.',
    ],
    skill: (g) => [
      `${g.subject}… — ran ${g.count}× · ${fmtTok(g.tokens)} in results`,
      'A workflow Claude re-runs by hand — package it as a skill (.claude/skills/<name>/SKILL.md) with the exact command and how to read its output, or a hook in settings.json if it should run automatically.',
    ],
    basefile: (g) => [
      `${g.subject} — ~${fmtTok(g.impact)} every session`,
      'Loaded at every session start in this project (@-imported into CLAUDE.md). Trim it, or move it to an on-demand doc that Claude Reads only when the task needs it — the docs leaderboard will then show whether it earns its keep.',
    ],
    injected: (g) => {
      const FIX = {
        hook_additional_context: 'A hook is injecting output into context on many tool calls — check hooks in settings.json and trim what they print.',
        edited_text_file: 'Edited files are re-injected in full — frequent edits to large files re-pay their content each time; smaller files and batched edits reduce this.',
        todo_reminder: 'Harness reminders accumulate over very long sessions — starting a fresh session per task avoids the buildup.',
        plan_file_reference: 'Plan files get re-referenced into context — keep plans lean.',
      };
      return [
        `${ATT_NAMES[g.subject] || g.subject} — ${g.count}× · ${fmtTok(g.impact)} injected`,
        FIX[g.subject] || 'Harness-injected context — mostly automatic; leaner hook output and shorter sessions reduce it.',
      ];
    },
  };
  const suggWrap = $('sugg-wrap');
  const suggRows = $('sugg-rows');
  suggRows.replaceChildren();
  suggWrap.hidden = allSuggs.length === 0;
  const expandedSuggs = !!state.suggExpanded[s.id];
  const suggs = expandedSuggs ? allSuggs : cappedSuggs(allSuggs);
  for (const g of suggs) {
    const render = SUGG[g.kind];
    if (!render) continue;
    const [headline, fix] = render(g);
    const clickable = g.kind !== 'recache' && g.kind !== 'injected' && g.kind !== 'basefile' && g.kind !== 'compact' && g.kind !== 'skilllist';
    const isActive = clickable && state.highlight &&
      state.highlight.kind === g.kind && state.highlight.subject === g.subject;
    const item = el('div', 'sugg-item' + (clickable ? ' clickable' : '') + (isActive ? ' active' : ''));
    const hl = el('div', 'sugg-head', headline);
    hl.title = clickable ? 'Show these calls in the timeline' : (g.subject || '');
    item.append(hl);
    if (g.context) item.append(el('div', 'sugg-ctx', `during: ${g.context.slice(0, 90)}`));
    item.append(el('div', 'sugg-fix', fix));
    if (clickable) {
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      const jump = () => {
        const next = isActive ? null : { kind: g.kind, subject: g.subject };
        state.highlight = next;
        if (next) {
          for (const t of s.turns || []) {
            if (t.actions.some((a) => actionMatches(next, a))) state.turnToggles[turnKey(s.id, t)] = true;
          }
          for (const ag of s.agents || []) {
            if ((ag.actions || []).some((a) => actionMatches(next, a))) {
              state.agentToggles[`${s.id}|${ag.id}`] = true;
              openSect('agents');
            }
          }
        }
        renderDetail();
        if (next) {
          requestAnimationFrame(() => {
            const first = document.querySelector('.hl');
            if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
          });
        }
      };
      item.onclick = jump;
      item.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(); }
      };
    }
    suggRows.append(item);
  }
  const hiddenCount = allSuggs.length - suggs.length;
  if (hiddenCount > 0 || expandedSuggs) {
    const more = el('button', 'sugg-more', expandedSuggs ? 'show less' : `show ${hiddenCount} more`);
    more.onclick = () => {
      state.suggExpanded[s.id] = !expandedSuggs;
      renderDetail();
    };
    suggRows.append(more);
  }

  // compaction events — what each dropped and what the rebuild cost
  const compactWrap = $('compact-wrap');
  const compactRows = $('compact-rows');
  compactRows.replaceChildren();
  compactWrap.hidden = comps.length === 0;
  const compactAdder = rowAdder(compactRows);
  comps.forEach((c, ci) => {
    const dropped = Math.max(0, (c.preTokens || 0) - (c.postTokens || 0));
    compactAdder.row(`compact|${ci}`, `${fmtClock(c.ts)} · ${c.trigger}`, '−' + fmtTok(dropped), () => [
      `context ${fmtTok(c.preTokens)} → ${fmtTok(c.postTokens)} · ${fmtTok(dropped)} tokens of history dropped`,
      (c.summaryTokens || c.rebuildTokens)
        ? `cost: ~${fmtTok(c.summaryTokens)} summary + ~${fmtTok(c.rebuildTokens)} rebuilt context, re-paid as fresh input`
        : null,
      c.durationMs ? `compaction ran ${fmtMs(c.durationMs)}` : null,
      'Dropped history is gone for the model — earlier decisions survive only in the summary turn marked ⟲ in the timeline.',
    ]);
  });

  // MCP servers & skills — measured calls and results; schemas and the
  // listing are the per-session standing cost
  const mcpWrap = $('mcp-wrap');
  const mcpRows = $('mcp-rows');
  mcpRows.replaceChildren();
  const ms = s.mcpSkills || { skills: [], mcp: [], toolSearch: { calls: 0, tokens: 0 } };
  const hasMcp = (ms.mcp || []).length > 0 || (ms.toolSearch && ms.toolSearch.calls > 0);
  const hasSkills = (ms.skills || []).length > 0;
  mcpWrap.hidden = !hasMcp && !hasSkills;
  if (!mcpWrap.hidden) {
    const M = rowAdder(mcpRows);
    if (hasMcp) {
      const mcpTotal = (ms.mcp || []).reduce((n, m) => n + m.tokens, 0) + (ms.toolSearch.tokens || 0);
      M.group('mcp servers', fmtTok(mcpTotal));
      for (const m of ms.mcp || []) {
        const used = m.calls > 0;
        M.row(`mcp|${m.server}`, m.server,
          used ? `${m.calls}× · ${fmtTok(m.tokens)}` : 'never called',
          () => [
            used
              ? `tools used: ${m.tools.join(', ')}`
              : 'No calls by any turn or agent of this session in the loaded window.',
            used && m.lastTs ? `last call ${fmtClock(m.lastTs)}` : null,
            m.scope ? `configured: ${m.scope}` : null,
            m.agent ? 'Includes calls made by subagents.' : null,
            'Tool schemas load into base context every session; transcripts don’t itemize their size — calls and result tokens are the measured signals.',
          ]);
      }
      if (ms.toolSearch.calls > 0) {
        M.row('mcp|toolsearch', 'deferred tool loads',
          `${ms.toolSearch.calls}× · ${fmtTok(ms.toolSearch.tokens)}`, () => [
            'Schemas fetched on demand via ToolSearch — the measured context cost of loading deferred tools in this session and its agents.',
          ]);
      }
    }
    if (hasSkills) {
      const skills = ms.skills || [];
      M.group('skills', ms.listingTokens ? `~${fmtTok(ms.listingTokens)}/session` : '');
      for (const x of skills.filter((k) => k.uses > 0)) {
        M.row(`skill|${x.name}`, x.name,
          `${x.uses}×${x.tokens ? ' · ' + fmtTok(x.tokens) : ''}`,
          () => [
            x.listed
              ? `~${fmtTok(x.share)}/session as its share of the skill listing`
              : 'Invoked via the Skill tool; not in this session’s listing.',
            x.tokens ? `${fmtTok(x.tokens)} of invocation results in context` : null,
            x.lastTs ? `last used ${fmtClock(x.lastTs)}` : null,
          ]);
      }
      const unusedSkills = skills.filter((k) => k.uses === 0);
      if (unusedSkills.length > 0) {
        const unusedShare = unusedSkills.reduce((n, k) => n + k.share, 0);
        M.row('skill|unused', `${unusedSkills.length} skills never used`,
          `~${fmtTok(unusedShare)}/session`, () => {
            const top = [...unusedSkills].sort((a, b) => b.share - a.share);
            const lines = top.slice(0, 15).map((k) => `${k.name} — ~${fmtTok(k.share)}/session`);
            if (top.length > 15) lines.push(`… and ${top.length - 15} more`);
            lines.push('Their listing entries are paid at every session start. Only invocations are observable — a skill can still steer behavior from its description alone.');
            return lines;
          });
      }
    }
  }

  // docs leaderboard
  const docsBox = $('doc-rows');
  docsBox.replaceChildren();
  if (!s.docs || s.docs.length === 0) {
    docsBox.append(el('div', 'ds', 'no docs read yet'));
  }
  for (const d of s.docs || []) {
    const dkey = `${s.id}|${d.path}`;
    const docExpanded = !!state.docToggles[dkey];
    const item = el('div', 'doc-item');
    const head = el('div', 'doc-row doc-head');
    head.tabIndex = 0;
    head.setAttribute('role', 'button');
    head.setAttribute('aria-expanded', String(docExpanded));
    const name = el('span', 'dp', (docExpanded ? '▾ ' : '▸ ') + relPath(d.path, s.cwd));
    if (d.agent) name.append(el('i', 'abadge', 'A'));
    head.append(name, el('span', 'ds', `${d.reads}× · ${fmtTok(d.tokens)}`));
    head.title = d.path + (d.agent ? ' (read by a subagent)' : '');
    const docToggle = () => { state.docToggles[dkey] = !docExpanded; renderDetail(); };
    head.onclick = docToggle;
    head.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); docToggle(); }
    };
    item.append(head);

    if (docExpanded) {
      // every use of this doc across the loaded turns and agents
      const uses = [];
      for (const t of s.turns || []) {
        t.actions.forEach((a, ai) => {
          if (docActionMatch(d.path, a)) uses.push({ t, a, akey: `${turnKey(s.id, t)}#${ai}` });
        });
      }
      for (const ag of s.agents || []) {
        (ag.actions || []).forEach((x, xi) => {
          if (docActionMatch(d.path, x)) {
            uses.push({ agent: ag, a: x, akey: `agent|${s.id}|${ag.id}#${xi}` });
          }
        });
      }
      const avg = Math.round(d.tokens / Math.max(1, d.reads));
      const stamps = uses.map((u) => u.a.ts).filter(Boolean).sort();
      const metaBits = [
        `${d.reads} reads · ${fmtTok(d.tokens)} · ~${fmtTok(avg)}/read`,
        stamps.length ? `${fmtClock(stamps[0])} → ${fmtClock(stamps[stamps.length - 1])}` : null,
      ].filter(Boolean);
      item.append(el('div', 'doc-meta', metaBits.join(' · ')));

      const list = el('div', 'doc-uses');
      for (const u of uses) {
        const r = el('div', 'doc-use');
        const ctx = u.agent
          ? `agent: ${(u.agent.title || u.agent.id).slice(0, 60)}`
          : `"${(u.t.prompt || '').slice(0, 60)}"`;
        r.append(
          el('span', 'du-time', fmtClock(u.a.ts)),
          el('span', 'du-ctx', ctx),
          el('span', 'anum', '+' + fmtTok(u.a.tokens)),
        );
        r.title = 'Jump to this call in the timeline';
        r.onclick = () => {
          state.highlight = { kind: 'fatdoc', subject: d.path };
          if (u.t) state.turnToggles[turnKey(s.id, u.t)] = true;
          if (u.agent) { state.agentToggles[`${s.id}|${u.agent.id}`] = true; openSect('agents'); }
          renderDetail();
          requestAnimationFrame(() => {
            const target = document.querySelector(`[data-akey="${CSS.escape(u.akey)}"]`);
            if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          });
        };
        list.append(r);
      }
      if (uses.length < d.reads) {
        list.append(el('div', 'du-note', `${d.reads - uses.length} more outside the loaded window`));
      }
      item.append(list);
    }
    docsBox.append(item);
  }

  // base-loaded docs with no observed use this session
  const unusedBase = (s.baseFiles || [])
    .filter((f) => /\.(md|mdx)$/i.test(f.path))
    .map((f) => ({ f, u: fileUsage(f) }))
    .filter((x) => x.u.reads + x.u.edits === 0);
  if (unusedBase.length > 0) {
    docsBox.append(el('div', 'doc-unused-head', 'loaded · no observed use this session'));
    for (const { f } of unusedBase) {
      const row = el('div', 'doc-row unusedrow');
      row.append(
        el('span', 'dp', relPath(f.path, s.cwd)),
        el('span', 'ds', `~${fmtTok(Math.max(1, Math.round(f.chars / 3.8)))} loaded`),
      );
      row.title = f.path + " — in-context use isn't logged; no Reads or edits this session";
      docsBox.append(row);
    }
  }

  // agents — each runs in its own context window
  const agentsWrap = $('agents-wrap');
  const agentRows = $('agent-rows');
  agentRows.replaceChildren();
  const agents = s.agents || [];
  agentsWrap.hidden = agents.length === 0;
  const roiKnown = agents.filter((a) => a.returned != null);
  if (roiKnown.length > 0) {
    const burned = roiKnown.reduce((n, a) => n + a.tokens, 0);
    const returned = roiKnown.reduce((n, a) => n + a.returned, 0);
    agentRows.append(el('div', 'agents-sum',
      `${fmtTok(burned)} burned in agent windows → ${fmtTok(returned)} returned to parent` +
      (returned > 0 ? ` · ${roiRatio(burned, returned)} compression` : '')));
  }
  for (const a of [...agents].sort((x, y) => y.tokens - x.tokens)) {
    const key = `${s.id}|${a.id}`;
    const expanded = !!state.agentToggles[key];
    const item = el('div', 'agent-item');
    const head = el('div', 'doc-row agent-head');
    head.tabIndex = 0;
    head.setAttribute('role', 'button');
    head.setAttribute('aria-expanded', String(expanded));
    head.append(
      el('span', 'dp', (expanded ? '▾ ' : '▸ ') + (a.title || a.id)),
      el('span', 'ds',
        `${fmtTok(a.tokens)}${a.returned != null ? ' → ' + fmtTok(a.returned) : ''} · ${a.calls} calls`),
    );
    head.title = a.title || a.id;
    const toggle = () => { state.agentToggles[key] = !expanded; renderDetail(); };
    head.onclick = toggle;
    head.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    };
    item.append(head);
    if (expanded) {
      const metaBits = [
        a.model,
        `ctx ${fmtTok(a.contextNow)}`,
        `+${fmtTok(a.fresh)} in · ${fmtTok(a.output)} out`,
        a.returned != null
          ? `returned ${fmtTok(a.returned)}${a.returned > 0 ? ' · ' + roiRatio(a.tokens, a.returned) + ' compression' : ''}`
          : null,
        fmtDur(a.started, a.ended),
        a.docsReads ? `${a.docsReads} docs reads` : null,
      ].filter(Boolean);
      item.append(el('div', 'agent-meta', metaBits.join(' · ')));
      const list = el('div', 'agent-actions');
      for (const [xi, x] of (a.actions || []).entries()) {
        const r = el('div', 'agent-action' + (actionMatches(state.highlight, x) ? ' hl' : ''));
        r.dataset.akey = `agent|${s.id}|${a.id}#${xi}`;
        const found = findingFor(x);
        if (found) {
          r.classList.add('opt');
          r.title = 'Part of an Optimize finding — click to focus it';
          r.onclick = () => focusFinding(found);
        }
        const dot = el('i', 'adot');
        dot.style.background = catColor(x.cat);
        const lbl = el('span', 'aal', x.label);
        lbl.title = x.label + (x.ts ? ` · ${fmtClock(x.ts)}` : '');
        const adur = el('span', 'adur', [
          x.durMs != null ? fmtMs(x.durMs) : null,
          x.genTokens != null ? `~${fmtTok(x.genTokens)} out` : null,
        ].filter(Boolean).join(' · '));
        if (x.genTokens != null) {
          adur.title = `~${fmtTok(x.genTokens)} output tokens to issue this call (payload + thinking share)`;
        }
        r.append(dot, lbl, adur, el('span', 'anum', '+' + fmtTok(x.tokens)));
        list.append(r);
      }
      if (!list.childElementCount) list.append(el('div', 'ds', 'no tool calls'));
      item.append(list);
    }
    agentRows.append(item);
  }

  // totals
  const totalsBox = $('totals');
  totalsBox.replaceChildren();
  const rows = [
    ['API calls', String(s.totals.calls)],
    ['fresh input tokens', fmtTok(s.totals.fresh)],
    ['output tokens', fmtTok(s.totals.output)],
    ['subagent calls', String(s.sidechain.calls)],
    ['subagent tokens', fmtTok(s.sidechain.tokens)],
  ];
  const ob = s.outputBreakdown;
  if (ob) {
    rows.splice(3, 0,
      [`↳ thinking${ob.thinkingMeasured ? '' : ' (est.)'}`, '~' + fmtTok(ob.thinking)],
      ['↳ visible text', '~' + fmtTok(ob.text)],
      ['↳ tool calls', '~' + fmtTok(ob.toolUse)]);
  }
  for (const [k, v] of rows) {
    const r = el('div');
    r.append(el('span', null, k), el('b', null, v));
    totalsBox.append(r);
  }
}

function renderReport() {
  const box = $('report-rows');
  box.replaceChildren();
  const read = state.report.read || [];
  const unused = state.report.unused || [];
  if (read.length === 0 && unused.length === 0) {
    box.append(el('div', 'ds', 'no docs read in the loaded window'));
  }
  for (const d of read) {
    const row = el('div', 'doc-row report-row');
    const parts = d.path.replace(/\//g, '\\').split('\\');
    const name = el('span', 'dp', parts.slice(-4).join('\\'));
    if (d.agent) name.append(el('i', 'abadge', 'A'));
    row.append(
      name,
      el('span', 'ds', `${d.reads}× · ${fmtTok(d.tokens)} · ${d.sessions} session${d.sessions === 1 ? '' : 's'}`),
    );
    row.title = d.path;
    box.append(row);
  }
  if (unused.length > 0) {
    box.append(el('div', 'doc-unused-head', 'loaded every session · never read or edited'));
    for (const f of unused) {
      const row = el('div', 'doc-row report-row unusedrow');
      const parts = f.path.replace(/\//g, '\\').split('\\');
      row.append(
        el('span', 'dp', parts.slice(-4).join('\\')),
        el('span', 'ds', `${f.sessions} session${f.sessions === 1 ? '' : 's'} · ~${fmtTok(Math.round(f.chars / 3.8))} each`),
      );
      row.title = f.path + " — in-context use isn't logged; no Reads or edits were observed anywhere";
      box.append(row);
    }
  }
}

function renderMcpReport() {
  const box = $('mcp-report-rows');
  box.replaceChildren();
  const r = state.mcpReport;
  if (!r) {
    box.append(el('div', 'ds', 'loading…'));
    return;
  }
  const plural = (n) => `${n} session${n === 1 ? '' : 's'}`;
  const group = (label, v) => {
    const h = el('div', 'base-group');
    h.append(el('span', null, label), el('b', null, v || ''));
    box.append(h);
  };
  const row = (name, meta, title, cls) => {
    const rr = el('div', 'doc-row report-row' + (cls ? ' ' + cls : ''));
    rr.append(el('span', 'dp', name), el('span', 'ds', meta));
    if (title) rr.title = title;
    box.append(rr);
  };

  const hasMcp = r.mcpUsed.length || r.mcpUnused.length || r.toolSearch.calls;
  const hasSkills = r.usedSkills.length || r.unusedSkills.length;
  if (!hasMcp && !hasSkills) {
    box.append(el('div', 'ds', 'no MCP or skill activity in the loaded window'));
    return;
  }

  if (hasMcp) {
    group('mcp servers', fmtTok(r.mcpUsed.reduce((n, m) => n + m.tokens, 0) + r.toolSearch.tokens));
    for (const m of r.mcpUsed) {
      row(m.server, `${m.calls}× · ${fmtTok(m.tokens)} · ${plural(m.usedSessions)}`,
        `tools: ${m.tools.join(', ')}` + (m.scope ? ` · configured: ${m.scope}` : ''));
    }
    if (r.toolSearch.calls > 0) {
      row('deferred tool loads (ToolSearch)',
        `${r.toolSearch.calls}× · ${fmtTok(r.toolSearch.tokens)} · ${plural(r.toolSearch.sessions)}`,
        'Schemas fetched on demand — the measured context cost of loading deferred tools.');
    }
    for (const m of r.mcpUnused) {
      row(m.server, 'configured · never called',
        (m.scope ? `configured: ${m.scope} · ` : '') +
        'its tool schemas still load into base context every session (size not itemized in transcripts)', 'unusedrow');
    }
  }

  if (hasSkills) {
    group('skills', r.listingSessions
      ? `listing ~${fmtTok(Math.round(r.listingTokensTotal / r.listingSessions))}/session · ${fmtTok(r.listingTokensTotal)} across ${plural(r.listingSessions)}`
      : '');
    for (const x of r.usedSkills) {
      row(x.name, `${x.uses}× · ${plural(x.usedSessions)}${x.tokens ? ' · ' + fmtTok(x.tokens) : ''}`,
        x.listedSessions
          ? `~${fmtTok(Math.round(x.shareTotal / x.listedSessions))}/session as its listing share`
          : 'invoked via the Skill tool; not in any loaded listing');
    }
    if (r.unusedSkills.length > 0) {
      box.append(el('div', 'doc-unused-head', 'paid in the listing · never used'));
      for (const x of r.unusedSkills) {
        row(x.name,
          `${plural(x.listedSessions)} · ~${fmtTok(Math.round(x.shareTotal / Math.max(1, x.listedSessions)))} each · ${fmtTok(x.shareTotal)} total`,
          'Only invocations are observable — a skill can still steer behavior from its description alone.', 'unusedrow');
      }
    }
  }
}

async function fetchReport(force) {
  if (!force && Date.now() - state.reportFetched < 5000) return;
  state.reportFetched = Date.now();
  try {
    const res = await fetch('/api/docs');
    if (res.ok) {
      state.report = await res.json();
      if (state.view === 'docs') renderReport();
    }
  } catch { /* collector restarting */ }
}

async function fetchMcpReport(force) {
  if (!force && Date.now() - state.mcpReportFetched < 5000) return;
  state.mcpReportFetched = Date.now();
  try {
    const res = await fetch('/api/mcpskills');
    if (res.ok) {
      state.mcpReport = await res.json();
      if (state.view === 'mcp') renderMcpReport();
    }
  } catch { /* collector restarting */ }
}

function render() {
  if (!state.pinned && state.sessions.length > 0) {
    state.selected = state.sessions[0].id;
  }
  renderList();
  $('docs-btn').classList.toggle('active', state.view === 'docs');
  $('mcp-btn').classList.toggle('active', state.view === 'mcp');
  $('report').hidden = state.view !== 'docs';
  $('mcp-report').hidden = state.view !== 'mcp';
  if (state.view === 'docs' || state.view === 'mcp') {
    $('empty').hidden = true;
    $('detail').hidden = true;
    if (state.view === 'docs') renderReport();
    else renderMcpReport();
  } else {
    renderDetail();
  }
}

// Keep the drawer hover-driven after report-button clicks: a focused button
// would hold it open (:focus-within) over the content the click revealed.
$('docs-btn').onclick = () => {
  state.view = state.view === 'docs' ? 'session' : 'docs';
  if (state.view === 'docs') fetchReport(true);
  render();
  $('docs-btn').blur();
};

$('mcp-btn').onclick = () => {
  state.view = state.view === 'mcp' ? 'session' : 'mcp';
  if (state.view === 'mcp') fetchMcpReport(true);
  render();
  $('mcp-btn').blur();
};

// ---- SSE ----

let hookFade;
const es = new EventSource('/events');
es.onmessage = (msg) => {
  const data = JSON.parse(msg.data);
  if (data.type === 'hello' || data.type === 'list') {
    state.sessions = data.sessions;
    if (data.rateLimits) state.rateLimits = data.rateLimits;
    for (const s of state.sessions) {
      if (!state.detail[s.id]) fetchDetail(s.id);
    }
    if (state.view === 'docs') fetchReport(false);
    if (state.view === 'mcp') fetchMcpReport(false);
    render();
  } else if (data.type === 'session') {
    state.detail[data.session.id] = data.session;
    if (data.session.id === state.selected && state.view === 'session') renderDetail();
  } else if (data.type === 'hook') {
    const h = $('s-hook');
    h.textContent = `${data.event.name}${data.event.tool ? ': ' + data.event.tool : ''}`;
    h.style.opacity = 1;
    clearTimeout(hookFade);
    hookFade = setTimeout(() => { h.style.opacity = 0; }, 2500);
  }
};

async function fetchDetail(id) {
  try {
    const res = await fetch('/api/session/' + id);
    if (res.ok) {
      state.detail[id] = await res.json();
      if (id === state.selected) renderDetail();
    }
  } catch { /* collector restarting */ }
}

setInterval(renderList, 30000); // refresh "ago" stamps
