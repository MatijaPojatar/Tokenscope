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
  view: 'sessions', // 'sessions' (list page) | 'session' (detail) | 'docs' | 'mcp' | 'trends' | 'map'
  rateLimits: null,
  report: { read: [], unused: [] },
  reportFetched: 0,
  mcpReport: null,
  mcpReportFetched: 0,
  trends: null,
  trendsFetched: 0,
  fileMap: null,
  fileMapFetched: 0,
  mapProject: null, // selected project cwd — shared by the map and graph pages
  graphs: {}, // lowercased cwd -> knowledge graph, null = none built yet
  graphFetching: null, // lowercased cwd with a GET in flight
  graphBuilding: false,
  graphFilter: '', // path filter in graph mode — matches + import neighbors
  scrub: null, // {id, i} — session + timeline index while time-scrubbing the gauge
  ctxGen: {}, // session id -> {running, msg} — context-file generation status
  planGen: {}, // session id -> {running, msg} — optimize-plan generation status
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

function fmtUsd(v) {
  if (v == null) return '–';
  if (v > 0 && v < 0.01) return '<$0.01';
  return (v < 0 ? '−$' : '$') + Math.abs(v).toFixed(2);
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
  // a `closed` class in the markup is the default (guide sections start
  // collapsed); a stored preference wins either way
  const closed = sectPrefs[key] ?? wrap.classList.contains('closed');
  wrap.classList.toggle('closed', closed);
  h.tabIndex = 0;
  h.setAttribute('role', 'button');
  h.setAttribute('aria-expanded', String(!closed));
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

// ---- sessions page ----

function renderSessionsPage() {
  const box = $('sessions-rows');
  box.replaceChildren();
  if (state.sessions.length === 0) {
    box.append(el('div', 'empty', 'waiting for sessions…'));
    return;
  }
  for (const s of state.sessions) {
    const live = s.lastActivity && Date.now() - new Date(s.lastActivity).getTime() < 120000;
    const card = el('div', 'session-card' + (s.id === state.selected ? ' active' : ''));
    card.tabIndex = 0;
    card.setAttribute('role', 'button');

    const top = el('div', 'sc-top');
    top.append(
      el('span', 'dot' + (live ? ' on' : '')),
      el('span', 'sc-title', s.title || s.id.slice(0, 8)),
      el('span', 'sc-ago mono', fmtAgo(s.lastActivity)),
    );
    card.append(top);
    if (s.cwd) card.append(el('div', 'sc-cwd mono', s.cwd));

    const win = s.window || 200000;
    const pct = win ? (s.contextNow || 0) / win : 0;
    const bar = el('div', 'sc-bar');
    const fill = el('div', pct > 0.9 ? 'crit' : pct > 0.75 ? 'warn' : null);
    fill.style.width = Math.min(100, pct * 100) + '%';
    bar.append(fill);
    const barrow = el('div', 'sc-barrow');
    barrow.append(bar, el('span', 'mono sc-ctx', `${fmtTok(s.contextNow)} / ${fmtTok(win)}`));
    card.append(barrow);

    const bits = [];
    if (s.model) bits.push(String(s.model).replace(/^claude-/, ''));
    if (s.costUsd != null) bits.push(fmtUsd(s.costUsd));
    if (s.agentCount) bits.push(`${s.agentCount} agent${s.agentCount === 1 ? '' : 's'}`);
    if (s.compactions) bits.push(`⟲${s.compactions}`);
    const meta = el('div', 'sc-meta mono', bits.join(' · '));
    meta.title = bits.join(' · ');
    card.append(meta);

    const open = () => { state.selected = s.id; state.pinned = true; state.view = 'session'; render(); };
    card.onclick = open;
    card.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    };
    box.append(card);
  }
}

// ---- detail ----

// Jump the context scrubber to the timeline snapshot nearest a timestamp —
// used by clickable action times in the per-action timeline. `akey` pins
// the marker to the exact row that was clicked: nearby actions often share
// a settle (near-identical timestamps), so deriving the row back from the
// snapshot time could select a neighbor instead.
function scrubToTs(s, ts, akey) {
  const tl = s.timeline || [];
  if (tl.length < 2 || !ts) return;
  const target = new Date(ts).getTime();
  let best = 0;
  let bd = Infinity;
  tl.forEach((p, i) => {
    const d = Math.abs(new Date(p.ts).getTime() - target);
    if (d < bd) { bd = d; best = i; }
  });
  state.scrub = { id: s.id, i: best, akey: akey || null };
  renderGauge(s);
  renderScrubber(s);
  updateScrubActionMarker(s, false);
}

// Mark the action call the scrubber currently points at: the last action
// at or before the snapshot's timestamp gets a dashed highlight, and its
// label appears in a chip on the strip. With scrollTo, its turn is
// expanded and the row scrolled into view (used when scrubbing ends).
function updateScrubActionMarker(s, scrollTo) {
  document.querySelectorAll('.arow.at-scrub').forEach((r) => r.classList.remove('at-scrub'));
  const chip = document.getElementById('scrub-info');
  const snap = state.scrub && state.scrub.id === s.id ? (s.timeline || [])[state.scrub.i] : null;
  if (!snap) {
    if (chip) chip.hidden = true;
    return;
  }
  // a scrub started from a specific action pins that exact row
  let row = state.scrub.akey
    ? document.querySelector(`#turns .arow[data-akey="${CSS.escape(state.scrub.akey)}"]`)
    : null;
  if (!row) {
    const t = new Date(snap.ts).getTime();
    let best = null;
    let bestTs = -Infinity;
    let nearest = null;
    let nd = Infinity;
    document.querySelectorAll('#turns .arow[data-ats]').forEach((r) => {
      const ats = new Date(r.dataset.ats).getTime();
      if (isNaN(ats)) return;
      if (ats <= t && ats > bestTs) { bestTs = ats; best = r; }
      const d = Math.abs(ats - t);
      if (d < nd) { nd = d; nearest = r; }
    });
    row = best || nearest;
  }
  if (!row) {
    if (chip) chip.hidden = true;
    return;
  }
  row.classList.add('at-scrub');
  const label = row.querySelector('.al');
  if (chip) {
    chip.textContent = '⏱ ' + ((label && label.title) || 'action');
    chip.hidden = false;
  }
  if (scrollTo) {
    const turn = row.closest('.turn');
    if (turn && turn.classList.contains('collapsed')) {
      const akey = row.dataset.akey || '';
      const key = akey.slice(0, akey.lastIndexOf('#'));
      if (key) state.turnToggles[key] = true; // survives the next re-render
      turn.classList.remove('collapsed');
      const head = turn.querySelector('.turn-head');
      if (head) {
        head.setAttribute('aria-expanded', 'true');
        const chev = head.querySelector('.chev');
        if (chev) chev.textContent = '▾';
      }
    }
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// Gauge + legend, time-travel aware: while scrubbing, composition comes
// from the selected timeline snapshot instead of the live state.
function renderGauge(s) {
  const tl = s.timeline || [];
  const snap = state.scrub && state.scrub.id === s.id ? tl[state.scrub.i] : null;
  const used = snap ? snap.ctx : (s.contextNow || 0);
  const win = s.window || 200000;
  $('g-num').textContent = (snap ? `⏱ ${fmtClock(snap.ts)} · ` : '') +
    `${fmtTok(used)} / ${fmtTok(win)} · ${Math.round((used / win) * 100)}%`;
  const gauge = $('gauge');
  // one persistent segment per category so live width changes glide via the
  // CSS transition instead of snapping; scrubbing bypasses it (would lag)
  if (gauge.childElementCount !== CATS.length) {
    gauge.replaceChildren();
    for (const [k] of CATS) {
      const seg = document.createElement('div');
      seg.style.background = catColor(k);
      seg.style.width = '0%';
      gauge.append(seg);
    }
  }
  gauge.classList.toggle('scrubbing', !!snap);
  const legend = $('legend');
  legend.replaceChildren();
  // CATS order mirrors CAT_KEYS in src/attribution.js — snapshot buckets
  // are positional.
  const bucket = (k, i) => (snap ? (snap.b[i] || 0) : (s.context[k] || 0));
  const ctxSum = CATS.reduce((a, [k], i) => a + bucket(k, i), 0);
  // Buckets are lifetime accumulation; scale them onto usage so the gauge
  // reflects composition even after compaction shrinks the window.
  const scale = ctxSum > 0 ? Math.min(1, used / ctxSum) : 0;
  CATS.forEach(([k, label], i) => {
    const v = bucket(k, i);
    const seg = gauge.children[i];
    seg.style.width = v <= 0 ? '0%' : ((v * scale) / win) * 100 + '%';
    if (v <= 0) { seg.title = ''; return; }
    let title = `${label}: ${fmtTok(v)}`;
    if (!snap && k === 'output' && s.outputBreakdown) {
      const b = s.outputBreakdown;
      title += ` — thinking ~${fmtTok(b.thinking)} · text ~${fmtTok(b.text)} · tool calls ~${fmtTok(b.toolUse)}`;
    }
    seg.title = title;
    const li = el('span');
    const sw = el('i', 'swatch');
    sw.style.background = catColor(k);
    li.append(sw, document.createTextNode(`${label} ${fmtTok(v)}`));
    li.title = title;
    legend.append(li);
  });
}

// Stacked-area strip of context size over the session — click or drag to
// scrub; the gauge above time-travels. Dashed ticks mark compactions.
function renderScrubber(s) {
  const box = $('g-scrub');
  const tl = s.timeline || [];
  if (tl.length < 2) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.replaceChildren();
  const NS = 'http://www.w3.org/2000/svg';
  const VW = 1000;
  const VH = 64;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${VW} ${VH}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const maxCtx = Math.max(...tl.map((p) => p.ctx), 1);
  const x = (i) => (i / (tl.length - 1)) * VW;
  const yOf = (v) => VH - (v / maxCtx) * (VH - 3);
  // cumulative stacks, scaled like the gauge (per-snapshot fit to ctx)
  const stacks = tl.map((p) => {
    const sum = p.b.reduce((a, v) => a + v, 0);
    const sc = sum > 0 ? Math.min(1, p.ctx / sum) : 0;
    let cum = 0;
    return p.b.map((v) => (cum += v * sc));
  });
  CATS.forEach(([k], c) => {
    let d = '';
    let any = false;
    for (let i = 0; i < tl.length; i++) {
      const top = stacks[i][c];
      if (top > (c === 0 ? 0 : stacks[i][c - 1])) any = true;
      d += `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${yOf(top).toFixed(1)}`;
    }
    if (!any) return;
    for (let i = tl.length - 1; i >= 0; i--) {
      d += `L${x(i).toFixed(1)},${yOf(c === 0 ? 0 : stacks[i][c - 1]).toFixed(1)}`;
    }
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d + 'Z');
    path.setAttribute('fill', catColor(k));
    svg.append(path);
  });
  for (const cpt of s.compactions || []) {
    const ct = new Date(cpt.ts).getTime();
    let best = 0;
    let bd = Infinity;
    tl.forEach((p, i) => {
      const dd = Math.abs(new Date(p.ts).getTime() - ct);
      if (dd < bd) { bd = dd; best = i; }
    });
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', x(best));
    line.setAttribute('x2', x(best));
    line.setAttribute('y1', 0);
    line.setAttribute('y2', VH);
    line.setAttribute('class', 'scrub-compact');
    svg.append(line);
  }
  box.append(svg);
  const cursor = el('div', 'scrub-cursor');
  box.append(cursor);
  const info = el('div', 'scrub-info');
  info.id = 'scrub-info';
  info.hidden = true;
  box.append(info);
  const liveBtn = el('button', 'scrub-live primary', '⏵ live');
  liveBtn.onclick = (e) => {
    e.stopPropagation();
    state.scrub = null;
    renderGauge(s);
    positionCursor();
    updateScrubActionMarker(s, false);
  };
  box.append(liveBtn);
  const positionCursor = () => {
    const on = state.scrub && state.scrub.id === s.id;
    cursor.hidden = !on;
    liveBtn.hidden = !on;
    if (on) cursor.style.left = ((state.scrub.i / (tl.length - 1)) * 100) + '%';
  };
  positionCursor();
  const setFromEvent = (ev) => {
    const rect = box.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    state.scrub = { id: s.id, i: Math.round(frac * (tl.length - 1)) };
    renderGauge(s);
    positionCursor();
    updateScrubActionMarker(s, false);
  };
  box.addEventListener('pointerdown', (e) => {
    if (e.target === liveBtn) return;
    box.setPointerCapture(e.pointerId);
    setFromEvent(e);
    const move = (ev) => setFromEvent(ev);
    const up = () => {
      box.removeEventListener('pointermove', move);
      updateScrubActionMarker(s, true); // reveal the action we landed on
    };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', up, { once: true });
  });
}

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
  renderCtxStatus();

  renderGauge(s);
  renderScrubber(s);

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
    const chev = el('span', 'chev', expanded ? '▾' : '▸');
    head.append(
      chev,
      tp,
      el('span', 'tt', `${t.ts ? fmtClock(t.ts) + ' · ' : ''}${t.actions.length} actions · +${fmtTok(t.fresh)} in · ${fmtTok(t.output)} out`),
    );
    // toggle in place (no re-render) so the collapse transition can play
    const toggle = () => {
      const open = turn.classList.contains('collapsed');
      state.turnToggles[key] = open;
      turn.classList.toggle('collapsed', !open);
      head.setAttribute('aria-expanded', String(open));
      chev.textContent = open ? '▾' : '▸';
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
      if (a.ts) row.dataset.ats = a.ts;
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
      const titleBits = [];
      if (a.genTokens != null) {
        titleBits.push(`~${fmtTok(a.genTokens)} output tokens to issue this call (payload + its share of the message’s thinking)`);
      }
      if (a.ts && (s.timeline || []).length >= 2) {
        time.classList.add('tclick');
        titleBits.push('click to scrub the context gauge to this moment');
        time.onclick = (e) => {
          e.stopPropagation(); // don't trigger the row's Optimize-focus click
          scrubToTs(s, a.ts, row.dataset.akey);
        };
      }
      if (titleBits.length) time.title = titleBits.join(' — ');
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
      const kSpan = el('span', null, (detail ? (open ? '▾ ' : '▸ ') : '') + k);
      r.append(kSpan, el('b', null, v));
      container.append(r);
      if (!detail) return;
      r.tabIndex = 0;
      r.setAttribute('role', 'button');
      r.setAttribute('aria-expanded', String(open));
      // detail always renders inside a fold wrapper; toggling flips the
      // fold in place (no re-render) so the collapse transition can play
      const fold = el('div', 'base-fold' + (open ? ' open' : ''));
      const clip = el('div', 'fold-clip');
      const box = el('div', 'base-detail');
      for (const line of detail().filter(Boolean)) box.append(el('div', null, line));
      clip.append(box);
      fold.append(clip);
      container.append(fold);
      const tgl = () => {
        const now = !fold.classList.contains('open');
        state.baseToggles[rowKey] = now;
        fold.classList.toggle('open', now);
        r.setAttribute('aria-expanded', String(now));
        kSpan.textContent = (now ? '▾ ' : '▸ ') + k;
      };
      r.onclick = tgl;
      r.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tgl(); }
      };
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
      `${fmtTok(g.impact)} re-cached after idle gaps (${g.count}% of input spend)` +
        (s.cacheEconomics && s.cacheEconomics.recacheUsd != null
          ? ` · ~${fmtUsd(s.cacheEconomics.recacheUsd)}` : ''),
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

  // plan generation: findings → the local claude CLI → an action plan file
  if (allSuggs.length > 0) {
    const pg = state.planGen[s.id];
    const bar = el('div', 'plan-bar');
    const planBtn = el('button', 'ctx-btn primary', 'generate plan');
    planBtn.title = 'Have your local claude CLI turn these findings into a prioritized optimization plan (billed to your account), saved under the project’s .claude\\context\\';
    planBtn.disabled = !!(pg && pg.running);
    planBtn.onclick = async () => {
      if (state.planGen[s.id] && state.planGen[s.id].running) return;
      state.planGen[s.id] = { running: true, msg: 'generating plan via local claude CLI — can take a minute…' };
      renderDetail();
      try {
        const res = await fetch(`/api/session/${s.id}/optimize-plan`, { method: 'POST' });
        const j = await res.json();
        state.planGen[s.id] = {
          running: false,
          msg: j.ok ? `saved → ${j.path}` : j.canceled ? 'canceled' : `failed: ${j.error}`,
        };
      } catch {
        state.planGen[s.id] = { running: false, msg: 'failed: collector unreachable' };
      }
      if (state.selected === s.id && state.view === 'session') renderDetail();
    };
    const planCancel = el('button', 'ctx-btn', 'cancel');
    planCancel.hidden = !(pg && pg.running);
    planCancel.onclick = () => {
      fetch(`/api/session/${s.id}/optimize-plan`, { method: 'DELETE' }).catch(() => {});
    };
    bar.append(planBtn, planCancel);
    if (pg && pg.msg) bar.append(el('span', 'mono ctx-status', pg.msg));
    suggRows.append(bar);
  }

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

  // cache economics — measured token flows priced at list rates
  const cacheWrap = $('cache-wrap');
  const cacheRows = $('cache-rows');
  cacheRows.replaceChildren();
  const ce = s.cacheEconomics;
  cacheWrap.hidden = !ce;
  if (ce) {
    const C = rowAdder(cacheRows);
    C.group('input side', ce.priceKnown
      ? `net ${fmtUsd(ce.netUsd)} ${ce.netUsd >= 0 ? 'saved' : 'lost'}`
      : fmtTok(ce.read + ce.write + ce.input));
    C.row('cache|hit', 'cache hit ratio', `${(ce.hitRatio * 100).toFixed(1)}%`, () => [
      `${fmtTok(ce.read)} read from cache · ${fmtTok(ce.write)} written · ${fmtTok(ce.input)} uncached input`,
      (ce.write5m || ce.write1h)
        ? `writes: ${fmtTok(ce.write5m)} at 5m TTL · ${fmtTok(ce.write1h)} at 1h TTL` +
          (ce.splitAssumed ? ' (part assumed 5m — older lines lack the split)' : '')
        : null,
      'Share of all input-side tokens served from the prompt cache instead of re-sent at full price.',
    ]);
    if (ce.priceKnown) {
      C.row('cache|saved', 'saved by caching', fmtUsd(ce.savedUsd), () => [
        `${fmtTok(ce.read)} cached reads billed at 0.1× the input price instead of 1×.`,
        'What the same tokens would have cost as plain input, minus what the cache reads actually cost.',
      ]);
      C.row('cache|premium', 'write premium paid', fmtUsd(ce.premiumUsd), () => [
        'Cache writes bill above plain input — 1.25× at 5m TTL, 2× at 1h — the surcharge to make content cacheable.',
        `Net effect this session: ${fmtUsd(ce.netUsd)} ${ce.netUsd >= 0 ? 'saved' : 'lost'}.`,
      ]);
      if (ce.recache > 0) {
        C.row('cache|recache', 'idle-gap re-writes', fmtUsd(ce.recacheUsd), () => [
          `${fmtTok(ce.recache)} tokens re-written after the cache expired — content this session had already paid for once.`,
          'Priced against the cache read it would have been had the entry stayed warm. Grouping interactions (or a fresh session per task) avoids this.',
        ]);
      }
    } else {
      C.row('cache|noprice', 'USD estimates unavailable', '', () => [
        `No list price on file for model "${s.model || 'unknown'}" — the token flows above are still measured.`,
      ]);
    }
  }

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

  // rows were just rebuilt — re-apply the scrub-position marker
  updateScrubActionMarker(s, false);
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

function renderTrends() {
  const box = $('trends-rows');
  box.replaceChildren();
  const h = state.trends;
  if (!h) {
    box.append(el('div', 'ds', 'loading…'));
    return;
  }
  if (!h.days || h.days.length === 0) {
    box.append(el('div', 'ds', 'no history yet — rollups accrue as sessions run'));
    return;
  }
  const group = (label, v) => {
    const g = el('div', 'base-group');
    g.append(el('span', null, label), el('b', null, v || ''));
    box.append(g);
  };
  const legend = (pairs) => {
    const l = el('div', 'trend-legend');
    for (const [cls, label] of pairs) {
      const sp = el('span');
      sp.append(el('i', 'swatch ' + cls), document.createTextNode(label));
      l.append(sp);
    }
    box.append(l);
  };
  const xLabels = (days) => {
    const lab = el('div', 'trend-labels');
    lab.append(el('span', null, days[0].date.slice(5)),
      el('span', null, days[days.length - 1].date.slice(5)));
    box.append(lab);
  };
  const chart = (days, maxVal, colFn, small) => {
    const c = el('div', 'trend-chart' + (small ? ' small' : ''));
    for (const d of days) {
      const col = el('div', 'tc-col');
      colFn(d, col, maxVal);
      c.append(col);
    }
    box.append(c);
  };
  const plural = (n) => `${n} session${n === 1 ? '' : 's'}`;

  // tokens per day, input under output
  const totalCost = h.days.reduce((n, d) => n + d.costUsd, 0);
  group('tokens per day', `${h.totalSessions} sessions` +
    (totalCost > 0 ? ` · $${totalCost.toFixed(2)}` : ''));
  const maxDay = Math.max(...h.days.map((d) => d.fresh + d.output), 1);
  chart(h.days, maxDay, (d, col, max) => {
    const seg = (v, cls) => {
      const sp = el('div', 'tc-seg ' + cls);
      sp.style.height = ((v / max) * 100) + '%';
      return sp;
    };
    if (d.output > 0) col.append(seg(d.output, 'tc-out'));
    if (d.fresh > 0) col.append(seg(d.fresh, 'tc-in'));
    col.title = `${d.date} — ${plural(d.sessions)} · in ${fmtTok(d.fresh)} · out ${fmtTok(d.output)}` +
      (d.costUsd > 0 ? ` · $${d.costUsd.toFixed(2)}${d.costSessions < d.sessions ? ` (${d.costSessions} of ${d.sessions})` : ''}` : '') +
      (d.compactions ? ` · ⟲${d.compactions}` : '');
  });
  legend([['tc-in', 'input (fresh)'], ['tc-out', 'output']]);
  xLabels(h.days);

  // base context per session per day — is the standing cost growing?
  const baseDays = h.days.filter((d) => d.baseAvg > 0);
  if (baseDays.length >= 2) {
    group('base context per session',
      `~${fmtTok(baseDays[0].baseAvg)} → ~${fmtTok(baseDays[baseDays.length - 1].baseAvg)}`);
    const maxBase = Math.max(...h.days.map((d) => d.baseAvg), 1);
    chart(h.days, maxBase, (d, col, max) => {
      if (d.baseAvg > 0) {
        const sp = el('div', 'tc-seg tc-base');
        sp.style.height = ((d.baseAvg / max) * 100) + '%';
        col.append(sp);
      }
      col.title = d.baseAvg > 0 ? `${d.date} — base ~${fmtTok(d.baseAvg)}/session` : d.date;
    }, true);
    xLabels(h.days);
  }

  // projects and models
  const barList = (items, name, meta, title) => {
    const max = Math.max(...items.map((x) => x.fresh + x.output), 1);
    for (const x of items) {
      const r = el('div', 'trend-row');
      const nm = el('span', 'dp', name(x));
      if (title) nm.title = title(x);
      const bar = el('span', 'tb');
      const fill = document.createElement('div');
      fill.style.width = Math.max(2, ((x.fresh + x.output) / max) * 100) + '%';
      bar.append(fill);
      r.append(nm, bar, el('span', 'tm', meta(x)));
      box.append(r);
    }
  };
  group('projects', String(h.projects.length));
  barList(h.projects,
    (p) => p.cwd.replace(/\//g, '\\').split('\\').slice(-2).join('\\'),
    (p) => `${fmtTok(p.fresh + p.output)} · ${plural(p.sessions)}` +
      (p.costUsd > 0 ? ` · $${p.costUsd.toFixed(2)}` : ''),
    (p) => p.cwd);
  group('models', String(h.models.length));
  barList(h.models,
    (m) => m.model,
    (m) => `${fmtTok(m.fresh + m.output)} · ${plural(m.sessions)}` +
      (m.costUsd > 0 ? ` · $${m.costUsd.toFixed(2)}` : ''));

  // cache economics across all rolled-up sessions
  const hc = h.cache;
  if (hc && (hc.read > 0 || hc.write > 0)) {
    group('cache economics', hc.pricedSessions > 0
      ? `net ${fmtUsd(hc.savedUsd - hc.premiumUsd)} saved`
      : '');
    const cacheStats = [
      ['hit ratio', `${(hc.hitRatio * 100).toFixed(1)}%`,
        'read ÷ (read + written + uncached input) across all sessions'],
      ['read from cache', `${fmtTok(hc.read)} · billed at 0.1×`],
      ['written to cache', `${fmtTok(hc.write)} · billed at 1.25–2×`],
      ['uncached input', fmtTok(hc.input)],
    ];
    if (hc.pricedSessions > 0) {
      cacheStats.push(
        ['saved by caching', fmtUsd(hc.savedUsd), `across ${plural(hc.pricedSessions)} with a known model price`],
        ['write premium paid', fmtUsd(hc.premiumUsd)]);
    }
    for (const [name, meta, title] of cacheStats) {
      const r = el('div', 'doc-row report-row');
      r.append(el('span', 'dp', name), el('span', 'ds', meta));
      if (title) r.title = title;
      box.append(r);
    }
  }
}

// ---- codebase map: circle packing with drag ----
//
// Each file is a circle (area ∝ tokens), attracted to its directory's
// anchor point and separated by pairwise collision — a small hand-rolled
// force simulation. Drag a circle to move it; dropping pins it in place
// and the rest of the flock packs around it. Double-click unpins.

let mapSim = null; // {raf} — the running animation frame, if any

function stopMapSim() {
  if (mapSim) {
    cancelAnimationFrame(mapSim.raf);
    mapSim = null;
  }
}

let graphCy = null; // cytoscape instance behind the map's graph mode
let graphRenderSeq = 0; // aborts deferred graph mounts that a re-render outdated

function destroyGraphCy() {
  if (graphCy) {
    try { graphCy.destroy(); } catch { /* already torn down */ }
    graphCy = null;
  }
}

const MAP_COLORS = [
  'var(--c-base)', 'var(--c-docsRead)', 'var(--c-output)', 'var(--c-agent)',
  'var(--c-search)', 'var(--c-conversation)', 'var(--c-codeRead)',
  'var(--c-toolOther)', 'var(--c-recache)', 'var(--c-attachments)',
];

// Shared preamble for the map and graph pages: both need the file-map report
// and a valid selected project. Renders the project picker into `projBox` and
// returns the selected project, or null (after writing a status) if the
// report isn't usable yet.
function mapPreamble(projBox, summary, rerender) {
  projBox.replaceChildren();
  const report = state.fileMap;
  if (!report) {
    summary.textContent = 'loading…';
    return null;
  }
  if (report.length === 0) {
    summary.textContent = 'no file reads in the loaded window';
    return null;
  }
  if (!state.mapProject || !report.some((p) => p.cwd === state.mapProject)) {
    state.mapProject = report[0].cwd;
  }
  for (const p of report) {
    const b = el('button', p.cwd === state.mapProject ? 'active' : '');
    b.textContent = p.cwd.replace(/\//g, '\\').split('\\').slice(-2).join('\\');
    b.title = `${p.cwd} — ${fmtTok(p.totalTokens)} read`;
    b.onclick = () => { state.mapProject = p.cwd; replayEntry(); rerender(); };
    projBox.append(b);
  }
  return report.find((p) => p.cwd === state.mapProject);
}

function renderMap() {
  stopMapSim();
  const canvas = $('map-canvas');
  const legendBox = $('map-legend');
  const summary = $('map-summary');
  canvas.replaceChildren();
  legendBox.replaceChildren();
  const proj = mapPreamble($('map-projects'), summary, renderMap);
  if (!proj) return;

  // group files by top-level directory relative to the project root
  const prefix = proj.cwd.replace(/\//g, '\\').replace(/\\+$/, '') + '\\';
  const groups = new Map();
  for (const f of proj.files) {
    if (f.tokens <= 0) continue;
    const norm = String(f.path).replace(/\//g, '\\');
    let rel;
    let top;
    if (norm.toLowerCase().startsWith(prefix.toLowerCase())) {
      rel = norm.slice(prefix.length);
      const cut = rel.indexOf('\\');
      top = cut < 0 ? '(root)' : rel.slice(0, cut);
    } else {
      rel = norm;
      top = '(outside project)';
    }
    const g = groups.get(top) || { name: top, value: 0, files: [] };
    g.value += f.tokens;
    g.files.push({ ...f, rel, value: f.tokens });
    groups.set(top, g);
  }
  const groupList = [...groups.values()].sort((a, b) => b.value - a.value);

  const W = canvas.clientWidth || 900;
  const H = 560;
  canvas.style.height = H + 'px';

  // build nodes — only the globally largest files get their own bubble;
  // everything below the cut merges into one tail bubble per directory,
  // which keeps the simulation calm enough to settle
  const MAX_BUBBLES = 90;
  const keep = new Set(
    groupList.flatMap((g) => g.files)
      .sort((a, b) => b.value - a.value)
      .slice(0, MAX_BUBBLES));
  const nodes = [];
  let totalValue = 0;
  groupList.forEach((g, gi) => {
    const kept = g.files.filter((f) => keep.has(f)).sort((a, b) => b.value - a.value);
    const tail = g.files.filter((f) => !keep.has(f));
    for (const f of kept) {
      nodes.push({ f, gi, group: g.name, value: f.value });
      totalValue += f.value;
    }
    if (tail.length > 0) {
      const tailValue = tail.reduce((n, f) => n + f.value, 0);
      nodes.push({
        f: {
          rel: `(${tail.length} more files)`,
          reads: tail.reduce((n, f) => n + f.reads, 0),
          tokens: tail.reduce((n, f) => n + f.tokens, 0),
          value: tailValue,
          sessions: 0,
          merged: true,
          tailFiles: tail.sort((a, b) => b.value - a.value),
        },
        gi,
        group: g.name,
        value: tailValue,
      });
      totalValue += tailValue;
    }
  });

  // circle areas fill ~36% of the canvas; anchors on a phyllotaxis spiral
  const scale = Math.sqrt((0.36 * W * H) / (Math.PI * Math.max(1, totalValue)));
  const anchors = groupList.map((g, i) => {
    if (i === 0 || groupList.length === 1) return { x: W / 2, y: H / 2 };
    const ang = i * 2.399963;
    const rad = (0.14 + 0.34 * Math.sqrt(i / groupList.length)) * Math.min(W, H);
    return {
      x: W / 2 + Math.cos(ang) * rad * Math.min(2, W / H),
      y: H / 2 + Math.sin(ang) * rad,
    };
  });
  // initial placement: a near-packed spiral around each group's anchor,
  // biggest bubble at the center — starts close to the settled layout
  const perGroup = new Map();
  for (const n of nodes) {
    n.r = Math.max(4, Math.sqrt(n.value) * scale);
    n.vx = 0;
    n.vy = 0;
    n.pinned = false;
    const list = perGroup.get(n.gi) || [];
    list.push(n);
    perGroup.set(n.gi, list);
  }
  for (const [gi, list] of perGroup) {
    const a = anchors[gi];
    let packedArea = 0;
    list.forEach((n, k) => {
      packedArea += Math.PI * n.r * n.r;
      if (k === 0) {
        n.x = a.x;
        n.y = a.y;
      } else {
        const ang = k * 2.399963;
        const rad = Math.sqrt(packedArea / Math.PI);
        n.x = a.x + Math.cos(ang) * rad;
        n.y = a.y + Math.sin(ang) * rad;
      }
      n.x = Math.min(W - n.r, Math.max(n.r, n.x));
      n.y = Math.min(H - n.r, Math.max(n.r, n.y));
    });
  }

  // DOM circles
  let dragging = null;
  let selected = null;
  let alpha = 1;
  const wake = (level) => {
    alpha = Math.max(alpha, level);
    if (!mapSim) mapSim = { raf: requestAnimationFrame(tick) };
  };
  const select = (n) => {
    if (selected) selected.el.classList.remove('selected');
    selected = n;
    if (n) n.el.classList.add('selected');
    renderMapDetail(n, proj);
  };
  for (const n of nodes) {
    const f = n.f;
    const cell = el('div', 'tm-cell');
    cell.style.width = n.r * 2 + 'px';
    cell.style.height = n.r * 2 + 'px';
    cell.style.background = MAP_COLORS[n.gi % MAP_COLORS.length];
    const name = f.merged ? f.rel : f.rel.split('\\').pop();
    if (n.r >= 24) cell.append(el('div', 'tm-name', name));
    if (n.r >= 34) cell.append(el('div', 'tm-tok', fmtTok(f.tokens)));
    cell.title = `${f.rel} — ${fmtTok(f.tokens)} tokens · click for details`;
    n.el = cell;
    cell.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      cell.setPointerCapture(e.pointerId);
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX;
      const sy = e.clientY;
      let moved = false;
      dragging = n;
      n.vx = 0;
      n.vy = 0;
      const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
        moved = true;
        cell.classList.add('dragging');
        n.x = ev.clientX - rect.left;
        n.y = ev.clientY - rect.top;
        wake(0.5);
      };
      const up = () => {
        cell.removeEventListener('pointermove', move);
        cell.classList.remove('dragging');
        dragging = null;
        if (moved) {
          n.pinned = true;
          cell.classList.add('pinned');
          wake(0.3);
        } else {
          select(n); // a plain click selects — details in the side panel
        }
      };
      cell.addEventListener('pointermove', move);
      cell.addEventListener('pointerup', up, { once: true });
    });
    cell.addEventListener('dblclick', () => {
      n.pinned = false;
      cell.classList.remove('pinned');
      wake(0.4);
    });
    canvas.append(cell);
  }
  renderMapDetail(null, proj);

  // legend — directory colors
  groupList.forEach((g, gi) => {
    const item = el('span');
    const sw = el('i', 'swatch');
    sw.style.background = MAP_COLORS[gi % MAP_COLORS.length];
    item.append(sw, document.createTextNode(`${g.name} ${fmtTok(g.value)}`));
    legendBox.append(item);
  });

  const draw = () => {
    for (const n of nodes) {
      n.el.style.transform = `translate(${n.x - n.r}px, ${n.y - n.r}px)`;
    }
  };

  // one physics step: anchor pull, pairwise separation, bounds.
  // During pre-settle the pull targets the directory anchor (clustering);
  // once settled, each node's own resting spot becomes its home, so a
  // drag only displaces local neighbors — no global rearrangement.
  let settled = false;
  const step = (withPull) => {
    if (withPull) {
      const pull = 0.02 * alpha;
      for (const n of nodes) {
        if (n === dragging || n.pinned) continue;
        const tx = settled ? n.hx : anchors[n.gi].x;
        const ty = settled ? n.hy : anchors[n.gi].y;
        n.vx = (n.vx + (tx - n.x) * pull) * 0.86;
        n.vy = (n.vy + (ty - n.y) * pull) * 0.86;
        n.x += n.vx;
        n.y += n.vy;
      }
    }
    // positional correction — big circles move less
    for (let iter = 0; iter < 2; iter++) {
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          const min = a.r + b.r + 1.5;
          const d2 = dx * dx + dy * dy;
          if (d2 >= min * min) continue;
          let d = Math.sqrt(d2);
          if (d < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d = Math.hypot(dx, dy); }
          const push = ((min - d) / d) * 0.5;
          const aFixed = a === dragging || a.pinned;
          const bFixed = b === dragging || b.pinned;
          if (aFixed && bFixed) continue;
          const aw = aFixed ? 0 : bFixed ? 1 : (b.r * b.r) / (a.r * a.r + b.r * b.r);
          const bw = bFixed ? 0 : aFixed ? 1 : 1 - aw;
          a.x -= dx * push * aw;
          a.y -= dy * push * aw;
          b.x += dx * push * bw;
          b.y += dy * push * bw;
        }
      }
    }
    for (const n of nodes) {
      if (n === dragging) continue;
      n.x = Math.min(W - n.r, Math.max(n.r, n.x));
      n.y = Math.min(H - n.r, Math.max(n.r, n.y));
    }
  };

  const tick = () => {
    step(true);
    draw();
    alpha *= 0.99;
    if (alpha > 0.005 || dragging) {
      mapSim = { raf: requestAnimationFrame(tick) };
    } else {
      mapSim = null;
    }
  };

  // settle entirely off-screen before the first paint: the untangling
  // happens in a synchronous burst (milliseconds), then the map appears
  // already at rest — the animation loop only runs when a drag wakes it.
  for (let i = 0; i < 300 && alpha > 0.02; i++) {
    step(true);
    alpha *= 0.985;
  }
  for (let i = 0; i < 60; i++) step(false); // collision-only polish
  for (const n of nodes) {
    n.hx = n.x; // the settled spot is now this node's personal home
    n.hy = n.y;
    n.vx = 0;
    n.vy = 0;
  }
  settled = true;
  alpha = 0;
  draw();

  summary.textContent =
    `${proj.fileCount} files · ${fmtTok(proj.totalTokens)} tokens read · ` +
    `${proj.sessions} session${proj.sessions === 1 ? '' : 's'}` +
    (nodes.length < proj.fileCount ? ` · largest ${Math.min(MAX_BUBBLES, proj.fileCount)} as bubbles, rest merged per directory` : '');
}

// Right-hand detail panel for the codebase map: filled by clicking a
// bubble; the placeholder doubles as the interaction hint.
function renderMapDetail(n, proj) {
  const box = $('map-detail');
  box.replaceChildren();
  const kv = (k, v) => {
    const r = el('div', 'md-row');
    r.append(el('span', null, k), el('b', null, v));
    return r;
  };
  if (!n) {
    box.append(el('div', 'md-hint',
      'Click a bubble for details.\n\nDrag to rearrange — dropping pins a bubble in place, double-click unpins it.'));
    return;
  }
  const f = n.f;
  const share = proj.totalTokens > 0 ? (f.tokens / proj.totalTokens) * 100 : 0;
  if (f.merged) {
    box.append(
      el('div', 'md-name', f.rel),
      el('div', 'md-path', `${n.group} — files below the bubble cut`),
      kv('tokens read', fmtTok(f.tokens)),
      kv('share of project', share.toFixed(1) + '%'),
      kv('reads', String(f.reads)),
      kv('files merged', String(f.tailFiles.length)),
    );
    const list = el('div', 'md-list');
    for (const t of f.tailFiles.slice(0, 15)) {
      list.append(kv(t.rel.split('\\').pop(), fmtTok(t.tokens)));
    }
    if (f.tailFiles.length > 15) {
      list.append(el('div', 'md-hint', `… and ${f.tailFiles.length - 15} more`));
    }
    box.append(list);
    return;
  }
  box.append(
    el('div', 'md-name', f.rel.split('\\').pop()),
    el('div', 'md-path', f.rel),
    kv('directory', n.group),
    kv('tokens read', fmtTok(f.tokens)),
    kv('share of project', share.toFixed(1) + '%'),
    kv('reads', String(f.reads)),
    kv('~ per read', fmtTok(Math.round(f.tokens / Math.max(1, f.reads)))),
    kv('sessions', String(f.sessions || 1)),
    kv('read by agents', f.agent ? 'yes' : 'no'),
  );
  if (f.reads >= 3) {
    box.append(el('div', 'md-hint',
      'Re-read several times — a focused doc covering this file could make re-checks cheaper (see Optimize).'));
  }
}

// Knowledge-graph page: modules as circles (area = source files), docs as
// squares, edges from the project's built knowledge graph. Layout and all
// interaction (pan, zoom, drag) are cytoscape's.
function renderGraphPage() {
  destroyGraphCy();
  const summary = $('graph-summary');
  $('graph-canvas').replaceChildren();
  $('graph-legend').replaceChildren();
  const proj = mapPreamble($('graph-projects'), summary, renderGraphPage);
  if (!proj) {
    renderGraphDetail(null, null);
    return;
  }
  renderGraphFor(proj.cwd);
}

function renderGraphFor(cwd) {
  const canvas = $('graph-canvas');
  const legendBox = $('graph-legend');
  const summary = $('graph-summary');
  const status = $('graph-status');
  const key = cwd.toLowerCase();
  const graph = state.graphs[key];
  status.textContent = '';
  status.classList.remove('stale');
  if (graph === undefined) {
    summary.textContent = 'loading graph…';
    fetchGraph(cwd);
    renderGraphDetail(null, null);
    return;
  }
  if (graph === null) {
    summary.textContent =
      'no graph for this project yet — build one (a few seconds; written to .claude\\context\\graph.json)';
    renderGraphDetail(null, null);
    return;
  }
  const m = graph.meta || {};
  status.textContent = `built ${String(m.builtAt || '').slice(0, 10)}` +
    (m.gitHead ? ` @ ${m.gitHead.slice(0, 8)}` : '') +
    (m.behind == null ? ' · age unknown'
      : m.behind === 0 ? ' · up to date'
        : ` · ${m.behind} commit${m.behind === 1 ? '' : 's'} behind`);
  if (m.behind > 0) status.classList.add('stale');

  // What fits on screen is picked by structural importance (import degree,
  // then size) — usage sizes and colors nodes but must NOT gate visibility,
  // or the view degrades into "files recent sessions touched". The path
  // filter shows matching nodes plus their direct import neighbors.
  const inner = (graph.edges || []).filter((e) => !String(e.to).startsWith('pkg:'));
  const docIds = new Set(graph.nodes.filter((n) => n.kind === 'doc').map((n) => n.id));
  const code = graph.nodes.filter((n) => n.kind === 'folder' || n.kind === 'file');
  const degree = new Map();
  for (const e of inner) {
    if (e.kind !== 'imports') continue;
    degree.set(e.from, (degree.get(e.from) || 0) + 1);
    degree.set(e.to, (degree.get(e.to) || 0) + 1);
  }
  const rank = (a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0) ||
    (b.files || 0) - (a.files || 0) || (b.tokensRead || 0) - (a.tokensRead || 0);
  const q = (state.graphFilter || '').trim().toLowerCase();
  let matchedIds = null;
  let keepArr;
  if (q) {
    matchedIds = new Set(code.filter((n) => n.id.toLowerCase().includes(q)).map((n) => n.id));
    const neigh = new Set(matchedIds);
    for (const e of inner) {
      if (e.kind !== 'imports') continue;
      if (matchedIds.has(e.from)) neigh.add(e.to);
      if (matchedIds.has(e.to)) neigh.add(e.from);
    }
    keepArr = code.filter((n) => neigh.has(n.id)).sort(rank);
  } else {
    keepArr = [...code].sort(rank);
  }
  const keep = new Map(keepArr.map((n) => [n.id, n]));
  const docKeep = new Map();
  for (const e of inner) {
    if (docIds.has(e.from) && keep.has(e.to) && !docKeep.has(e.from)) {
      docKeep.set(e.from, { id: e.from, kind: 'doc' });
    }
  }
  const has = (id) => keep.has(id) || docKeep.has(id);
  const allDrawn = inner.filter((e) => has(e.from) && has(e.to));
  // edge budget: layout cost is driven by edge count — over budget, keep
  // the heaviest import edges (doc edges always stay) and say what's hidden.
  // The budget grows with the node count so an "all nodes" view keeps a
  // proportionate share of its edges.
  const EDGE_MAX = Math.max(1200, Math.min(9000, keep.size * 3));
  let hiddenEdges = 0;
  let drawn = allDrawn;
  if (allDrawn.length > EDGE_MAX) {
    const docEdges = allDrawn.filter((e) => e.kind !== 'imports');
    const importEdges = allDrawn.filter((e) => e.kind === 'imports')
      .sort((a, b) => b.weight - a.weight)
      .slice(0, Math.max(100, EDGE_MAX - docEdges.length));
    hiddenEdges = allDrawn.length - importEdges.length - docEdges.length;
    drawn = [...importEdges, ...docEdges];
  }

  if (typeof cytoscape === 'undefined' || typeof dagre === 'undefined') {
    summary.textContent = 'vendor scripts missing (public\\vendor) — graph view unavailable';
    renderGraphDetail(null, null);
    return;
  }
  // colors resolved from CSS vars — cytoscape paints to its own canvas and
  // cannot evaluate var() strings
  const rootCss = getComputedStyle(document.documentElement);
  const cvar = (name) => rootCss.getPropertyValue(name).trim() || '#8899aa';
  const palette = MAP_COLORS.map((c) => cvar(c.slice(4, -1)));
  const tops = [...new Set([...keep.values()].map((n) => n.id.split('/')[0]))];
  const colorOf = (n) => palette[Math.max(0, tops.indexOf(n.id.split('/')[0])) % palette.length];
  const ink = cvar('--ink');
  const mutedC = cvar('--muted');
  const accent = cvar('--accent');
  const panel2 = cvar('--panel-2');
  const mono = cvar('--mono') || 'monospace';

  // full-width canvas fills the viewport below the detail strip
  const top = canvas.getBoundingClientRect().top;
  canvas.style.height = Math.max(600, Math.round(window.innerHeight - top - 90)) + 'px';
  const maxW = Math.max(2, ...drawn.filter((e) => e.kind === 'imports').map((e) => e.weight));
  const elems = [];
  for (const n of keep.values()) {
    elems.push({ data: {
      id: n.id,
      label: n.id === '.' ? '(root)' : n.id.split('/').pop(),
      size: Math.min(80, Math.max(22, 12 * Math.pow(n.files || 1, 0.25))),
      color: colorOf(n),
      kind: 'code',
      matched: matchedIds && matchedIds.has(n.id) ? 1 : 0,
    } });
  }
  for (const d of docKeep.values()) {
    elems.push({ data: { id: d.id, label: d.id.split('/').pop(), kind: 'doc' } });
  }
  drawn.forEach((e, i) => elems.push({ data: {
    id: 'ge' + i, source: e.from, target: e.to, kind: e.kind, weight: e.weight,
  } }));

  // cytoscape renders and handles all interaction (pan, zoom, drag);
  // cytoscape-dagre lays the import DAG out in left→right ranks
  // dagre's layered layout is worth a short pause on mid-size graphs but
  // freezes the tab on big ones — those get the banded top→bottom layout
  // (bandedPositions) with cheap haystack edges. The mount is deferred a
  // frame so the "laying out…" notice paints before the main thread blocks,
  // and the sequence counter aborts a stale mount if the view re-rendered.
  const heavy = keep.size + docKeep.size > 300 || drawn.length > 900;
  const huge = keep.size > 900; // full-codebase view: degrade gracefully
  let layout;
  if (heavy) {
    const posMap = bandedPositions(
      [...keep.values()], [...docKeep.values()], drawn, canvas.clientWidth || 900);
    layout = {
      name: 'preset',
      positions: (node) => posMap.get(node.id()) || { x: 0, y: 0 },
      fit: true,
      padding: 14,
    };
  } else {
    layout = { name: 'dagre', rankDir: 'TB', nodeSep: 18, rankSep: 85, edgeSep: 8, padding: 14 };
  }
  summary.textContent = `laying out ${keep.size + docKeep.size} nodes · ${drawn.length} edges…`;
  const seq = ++graphRenderSeq;
  setTimeout(() => {
    if (seq !== graphRenderSeq || state.view !== 'graph') return;
    graphCy = cytoscape({
      container: canvas,
      elements: elems,
      minZoom: huge ? 0.03 : 0.15,
      maxZoom: 3,
      wheelSensitivity: 0.2,
      // full-codebase view: labels appear only once zoomed in, edges hide
      // while panning, render at 1x — keeps thousands of nodes responsive
      ...(huge ? { pixelRatio: 1, textureOnViewport: true, hideEdgesOnViewport: true } : {}),
      style: [
        { selector: 'node[kind = "code"]',
          style: {
            width: 'data(size)',
            height: 'data(size)',
            'background-color': 'data(color)',
            'background-opacity': 0.9,
            label: 'data(label)',
            'font-size': 9,
            'font-family': mono,
            color: ink,
            'text-valign': 'center',
            'text-halign': 'center',
            'text-wrap': 'ellipsis',
            'text-max-width': 78,
            ...(huge ? { 'min-zoomed-font-size': 8 } : {}),
          } },
        { selector: 'node[kind = "doc"]',
          style: {
            shape: 'round-rectangle',
            width: 30,
            height: 20,
            'background-color': panel2,
            'border-width': 1.5,
            'border-color': accent,
            label: 'data(label)',
            'font-size': 8,
            'font-family': mono,
            color: ink,
            'text-valign': 'bottom',
            'text-margin-y': 4,
          } },
        { selector: 'edge',
          style: heavy
            ? { 'curve-style': 'haystack', 'haystack-radius': 0.3 }
            : { 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'arrow-scale': 0.75 } },
        { selector: 'edge[kind = "imports"]',
          style: {
            width: `mapData(weight, 1, ${maxW}, 1, 5)`,
            'line-color': mutedC,
            'target-arrow-color': mutedC,
            opacity: 0.45,
          } },
        { selector: 'edge[kind = "mentions"]',
          style: { width: 1.2, 'curve-style': 'bezier', 'line-style': 'dotted', 'line-color': accent, 'target-arrow-shape': 'none', opacity: 0.7 } },
        { selector: 'edge[kind = "observed"]',
          style: { width: 2.2, 'curve-style': 'bezier', 'line-style': 'dashed', 'line-color': accent, 'target-arrow-shape': 'none', opacity: 0.9 } },
        { selector: 'node[matched = 1]', style: { 'border-width': 2, 'border-color': accent } },
        { selector: 'node:selected', style: { 'border-width': 2, 'border-color': ink } },
        { selector: '.dimmed', style: { opacity: 0.1 } },
      ],
      layout,
    });
    // hover isolates a node's neighborhood — skipped on big graphs where
    // the per-hover class sweep itself would lag
    if (elems.length <= 1200) {
      graphCy.on('mouseover', 'node', (evt) => {
        const hood = evt.target.closedNeighborhood();
        graphCy.batch(() => graphCy.elements().not(hood).addClass('dimmed'));
      });
      graphCy.on('mouseout', 'node', () => {
        graphCy.batch(() => graphCy.elements().removeClass('dimmed'));
      });
    }
    graphCy.on('tap', 'node', (evt) => {
      const n = (graph.nodes || []).find((x) => x.id === evt.target.id());
      renderGraphDetail(n || null, graph);
    });
    graphCy.on('tap', (evt) => {
      if (evt.target === graphCy) renderGraphDetail(null, graph);
    });
    summary.textContent =
      `${keep.size} of ${code.length} modules · ${drawn.filter((e) => e.kind === 'imports').length} import edges` +
      (hiddenEdges > 0 ? ` (${hiddenEdges} weak edges hidden)` : '') +
      ` · ${docKeep.size} doc${docKeep.size === 1 ? '' : 's'} linked · granularity ${m.granularity}` +
      (heavy ? ' · banded layout — filter for the fully layered view' : '') +
      (q ? ` · filter "${q}": ${matchedIds.size} matched + import neighbors`
        : code.length > keep.size ? ` · showing the ${keep.size} most connected — filter to reach the rest` : '');
  }, 30);
  renderGraphDetail(null, graph);


  const leg = (cls, label) => {
    const item = el('span');
    item.append(el('i', 'swatch ' + cls), document.createTextNode(label));
    legendBox.append(item);
  };
  leg('sw-imports', 'imports');
  if (drawn.some((e) => e.kind === 'mentions')) leg('sw-mentions', 'doc mentions');
  if (drawn.some((e) => e.kind === 'observed')) leg('sw-observed', 'doc used with code');
  if (docKeep.size > 0) leg('sw-doc', 'doc');
}

// Fast vertical layout for big graphs: real dependency ranks via a Kahn
// pass (longest path), each wide rank wraps into rows, the whole graph
// flows top→bottom in bands. No crossing minimization — that's exactly
// what makes it instant where dagre freezes the tab.
function bandedPositions(codeNodes, docNodes, edges, W) {
  const ids = new Set(codeNodes.map((n) => n.id));
  const outAdj = new Map();
  const indeg = new Map();
  for (const id of ids) {
    outAdj.set(id, []);
    indeg.set(id, 0);
  }
  for (const e of edges) {
    if (e.kind !== 'imports' || !ids.has(e.from) || !ids.has(e.to)) continue;
    outAdj.get(e.from).push(e.to);
    indeg.set(e.to, indeg.get(e.to) + 1);
  }
  const rank = new Map();
  let queue = [...ids].filter((id) => indeg.get(id) === 0);
  queue.forEach((id) => rank.set(id, 0));
  while (queue.length > 0) {
    const next = [];
    for (const id of queue) {
      for (const t of outAdj.get(id)) {
        rank.set(t, Math.max(rank.get(t) || 0, rank.get(id) + 1));
        indeg.set(t, indeg.get(t) - 1);
        if (indeg.get(t) === 0) next.push(t);
      }
    }
    queue = next;
  }
  let maxRank = 0;
  for (const r of rank.values()) maxRank = Math.max(maxRank, r);
  for (const id of ids) {
    if (!rank.has(id)) rank.set(id, maxRank + 1); // cycle members: own band
  }
  const bands = new Map();
  for (const n of codeNodes) {
    const r = rank.get(n.id);
    if (!bands.has(r)) bands.set(r, []);
    bands.get(r).push(n);
  }
  const CELL = 34;
  const perRow = Math.max(8, Math.floor((W - 40) / CELL));
  const pos = new Map();
  let y = 30;
  for (const r of [...bands.keys()].sort((a, b) => a - b)) {
    // alphabetical = folder-adjacent, so directories cluster within a band
    const list = bands.get(r).sort((a, b) => a.id.localeCompare(b.id));
    list.forEach((n, i) => {
      pos.set(n.id, {
        x: 20 + (i % perRow) * CELL + CELL / 2,
        y: y + Math.floor(i / perRow) * CELL,
      });
    });
    y += Math.ceil(list.length / perRow) * CELL + 40; // gap between bands
  }
  for (const d of docNodes) {
    const t = edges.find((e) => e.from === d.id && pos.has(e.to));
    const p = t ? pos.get(t.to) : { x: W / 2, y: 10 };
    pos.set(d.id, { x: p.x + 18, y: p.y - 26 });
  }
  return pos;
}

// Detail strip for the graph page: a module's dependency lists and linked
// docs, or a doc's routed code areas with their evidence.
function renderGraphDetail(n, graph) {
  const box = $('graph-detail');
  box.replaceChildren();
  const kv = (k, v) => {
    const r = el('div', 'md-row');
    r.append(el('span', null, k), el('b', null, v));
    return r;
  };
  if (!n) {
    box.append(el('div', 'md-hint', graph
      ? 'Click a node for details. Drag nodes to rearrange, drag the background to pan, scroll to zoom. Hovering a node isolates its neighborhood.\n\nCircles are modules (area = source files), squares are docs. Solid arrows = imports (top → bottom), dotted = doc mentions its area, dashed = doc observed in use with that code.'
      : 'Build a knowledge graph to see module structure, doc links, and measured usage in one picture.\n\nThe graph is written to .claude\\context\\graph.json; a codemap.md orientation doc can be generated from it.'));
    return;
  }
  box.append(
    el('div', 'md-name', n.id === '.' ? '(root)' : n.id),
    el('div', 'md-path', n.kind === 'doc' ? 'doc' : `module · ${n.kind} granularity`),
  );
  if (n.kind !== 'doc') {
    if (n.files) box.append(kv('source files', String(n.files)));
    if (n.tokensRead) box.append(kv('tokens read', fmtTok(n.tokensRead)));
    if (n.reads) box.append(kv('reads', String(n.reads)));
  }
  const outs = [];
  const ins = [];
  const pkgs = [];
  const docs = [];
  for (const e of graph.edges || []) {
    if (e.from === n.id) {
      if (String(e.to).startsWith('pkg:')) pkgs.push(e);
      else if (e.kind === 'imports') outs.push(e);
      else docs.push(e);
    } else if (e.to === n.id && e.kind === 'imports') {
      ins.push(e);
    } else if (e.to === n.id) {
      docs.push(e);
    }
  }
  const section = (title, list, fmt) => {
    if (list.length === 0) return;
    box.append(el('div', 'md-path', title));
    const wrap = el('div', 'md-list');
    for (const e of list.sort((a, b) => b.weight - a.weight).slice(0, 8)) wrap.append(fmt(e));
    box.append(wrap);
  };
  section('imports from', outs, (e) => kv(e.to, String(e.weight)));
  section('imported by', ins, (e) => kv(e.from, String(e.weight)));
  section('external packages', pkgs, (e) => kv(e.to.slice(4), String(e.weight)));
  section(n.kind === 'doc' ? 'covers code in' : 'linked docs', docs, (e) => kv(
    n.kind === 'doc' ? e.to : e.from,
    e.kind === 'observed' ? `${e.sessions ?? e.weight} sess` : 'mention'));
}

async function fetchGraph(cwd) {
  const key = cwd.toLowerCase();
  if (state.graphFetching === key) return;
  state.graphFetching = key;
  try {
    const res = await fetch('/api/graph?cwd=' + encodeURIComponent(cwd));
    state.graphs[key] = res.ok ? await res.json() : null;
  } catch {
    state.graphs[key] = null; // collector restarting — shows the build hint
  }
  state.graphFetching = null;
  if (state.view === 'graph') renderGraphPage();
}

async function buildGraphNow(cwd) {
  if (state.graphBuilding) return;
  state.graphBuilding = true;
  $('graph-build').disabled = true;
  $('graph-status').textContent = 'building… (large repos take a few seconds)';
  try {
    const res = await fetch('/api/graph', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, granularity: $('graph-gran').value }),
    });
    const data = await res.json();
    if (res.ok) state.graphs[cwd.toLowerCase()] = data.graph;
    else $('graph-status').textContent = data.error || 'build failed';
  } catch {
    $('graph-status').textContent = 'build failed — is the collector running?';
  }
  state.graphBuilding = false;
  $('graph-build').disabled = false;
  if (state.view === 'graph') renderGraphPage();
}

async function fetchFileMap(force) {
  if (!force && Date.now() - state.fileMapFetched < 15000) return;
  state.fileMapFetched = Date.now();
  try {
    const res = await fetch('/api/filemap');
    if (res.ok) {
      state.fileMap = await res.json();
      if (state.view === 'map') renderMap();
      // the graph is an interactive view — a background refresh must not
      // recompute the layout and throw away the user's pan/zoom
      else if (state.view === 'graph' && !graphCy) renderGraphPage();
    }
  } catch { /* collector restarting */ }
}

async function fetchTrends(force) {
  if (!force && Date.now() - state.trendsFetched < 15000) return;
  state.trendsFetched = Date.now();
  try {
    const res = await fetch('/api/history');
    if (res.ok) {
      state.trends = await res.json();
      if (state.view === 'trends') renderTrends();
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

// ---- entrance choreography ----
// Opening a view (or a different session / project) briefly tags its page
// container with .enter, which lets the staggered child animations play.
// Live SSE re-renders inside an already-open view never replay them.
const ENTRY_HOSTS = {
  sessions: 'sessions-page', session: 'detail', docs: 'report', mcp: 'mcp-report',
  trends: 'trends-report', map: 'map-report', graph: 'graph-report', guide: 'guide-report',
};
let entryKey = null;
let entryTimer = null;
function replayEntry() {
  const n = $(ENTRY_HOSTS[state.view]);
  if (!n) return;
  n.classList.remove('enter');
  void n.offsetWidth; // reflow so re-adding the class restarts animations
  n.classList.add('enter');
  clearTimeout(entryTimer);
  entryTimer = setTimeout(() => n.classList.remove('enter'), 900);
}
function markEntry() {
  const key = state.view + (state.view === 'session' ? ':' + state.selected : '');
  if (key === entryKey) return;
  if (entryKey) {
    const prev = $(ENTRY_HOSTS[entryKey.split(':')[0]]);
    if (prev) prev.classList.remove('enter');
  }
  entryKey = key;
  replayEntry();
}

function render() {
  if (!state.pinned && state.sessions.length > 0) {
    state.selected = state.sessions[0].id;
  }
  markEntry();
  // a session detail belongs to the Sessions section — keep its nav item lit
  $('nav-sessions').classList.toggle('active', state.view === 'sessions' || state.view === 'session');
  $('nav-docs').classList.toggle('active', state.view === 'docs');
  $('nav-mcp').classList.toggle('active', state.view === 'mcp');
  $('nav-trends').classList.toggle('active', state.view === 'trends');
  $('nav-map').classList.toggle('active', state.view === 'map');
  $('nav-graph').classList.toggle('active', state.view === 'graph');
  $('nav-guide').classList.toggle('active', state.view === 'guide');
  $('sessions-page').hidden = state.view !== 'sessions';
  $('report').hidden = state.view !== 'docs';
  $('mcp-report').hidden = state.view !== 'mcp';
  $('trends-report').hidden = state.view !== 'trends';
  $('map-report').hidden = state.view !== 'map';
  $('graph-report').hidden = state.view !== 'graph';
  $('guide-report').hidden = state.view !== 'guide';
  if (state.view !== 'map') stopMapSim();
  if (state.view !== 'graph') destroyGraphCy();
  if (state.view !== 'session') {
    $('empty').hidden = true;
    $('detail').hidden = true;
    if (state.view === 'sessions') renderSessionsPage();
    else if (state.view === 'docs') renderReport();
    else if (state.view === 'mcp') renderMcpReport();
    else if (state.view === 'trends') renderTrends();
    // an already-mounted graph is interactive — background render() calls
    // (SSE list events) must not relayout it and drop the user's pan/zoom
    else if (state.view === 'graph') { if (!graphCy) renderGraphPage(); }
    else if (state.view === 'map') renderMap();
    // 'guide' is static content — nothing to render
  } else {
    renderDetail();
  }
}

// ---- context-file generation (runs the user's local claude CLI) ----

function renderCtxStatus() {
  const g = state.ctxGen[state.selected];
  $('ctx-status').textContent = g ? g.msg : '';
  $('ctx-btn').disabled = !!(g && g.running);
  $('ctx-cancel-btn').hidden = !(g && g.running);
}

$('ctx-btn').onclick = async () => {
  const id = state.selected;
  if (!id || (state.ctxGen[id] && state.ctxGen[id].running)) return;
  state.ctxGen[id] = { running: true, msg: 'generating via local claude CLI — can take a minute…' };
  renderCtxStatus();
  try {
    const res = await fetch(`/api/session/${id}/context-file`, { method: 'POST' });
    const j = await res.json();
    state.ctxGen[id] = {
      running: false,
      msg: j.ok ? `saved → ${j.path}` : j.canceled ? 'canceled' : `failed: ${j.error}`,
    };
  } catch {
    state.ctxGen[id] = { running: false, msg: 'failed: collector unreachable' };
  }
  renderCtxStatus();
};

$('ctx-cancel-btn').onclick = () => {
  const id = state.selected;
  if (!id || !(state.ctxGen[id] && state.ctxGen[id].running)) return;
  $('ctx-cancel-btn').disabled = true;
  // the pending POST resolves with {canceled:true} and updates the status
  fetch(`/api/session/${id}/context-file`, { method: 'DELETE' })
    .catch(() => {})
    .finally(() => { $('ctx-cancel-btn').disabled = false; });
};

// Keep the rail hover-driven after nav clicks: a focused button would hold
// it expanded (:focus-within) over the content the click revealed.
function wireNav(id, view, fetcher) {
  $(id).onclick = () => {
    state.view = view;
    if (fetcher) fetcher(true);
    render();
    $(id).blur();
  };
}
wireNav('nav-sessions', 'sessions', null);
wireNav('nav-docs', 'docs', fetchReport);
wireNav('nav-mcp', 'mcp', fetchMcpReport);
wireNav('nav-trends', 'trends', fetchTrends);
wireNav('nav-map', 'map', fetchFileMap);
wireNav('nav-graph', 'graph', fetchFileMap);
wireNav('nav-guide', 'guide', null);

$('back-btn').onclick = () => {
  state.view = 'sessions';
  render();
};

$('graph-build').onclick = () => { if (state.mapProject) buildGraphNow(state.mapProject); };
let graphFilterTimer = null;
$('graph-filter').addEventListener('input', () => {
  clearTimeout(graphFilterTimer);
  graphFilterTimer = setTimeout(() => {
    state.graphFilter = $('graph-filter').value;
    if (state.view === 'graph') renderGraphPage();
  }, 250);
});

window.addEventListener('resize', () => {
  if (state.view === 'map') renderMap();
  // relayout would discard the user's pan/zoom — just refit the viewport
  else if (state.view === 'graph' && graphCy) graphCy.resize();
});

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
    if (state.view === 'trends') fetchTrends(false);
    if (state.view === 'map' || state.view === 'graph') fetchFileMap(false);
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

// refresh "ago" stamps + live dots while the sessions page is visible
setInterval(() => { if (state.view === 'sessions') renderSessionsPage(); }, 30000);
