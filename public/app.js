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
  view: 'session', // 'session' | 'docs' (cross-session report)
  rateLimits: null,
  report: [],
  reportFetched: 0,
  turnToggles: {}, // turn key -> expanded override (survives live re-renders)
  agentToggles: {}, // agent key -> expanded
  highlight: null, // {kind, subject} from a clicked Optimize entry
  suggExpanded: {}, // session id -> show all findings past the per-kind caps
};

// Does an action row belong to the clicked Optimize finding?
function actionMatches(hl, a) {
  if (!hl) return false;
  if (hl.kind === 'search') return a.cat === 'search' && a.label === hl.subject;
  if (hl.kind === 'reread') return a.label === 'Read ' + hl.subject;
  if (hl.kind === 'fatdoc') {
    if (a.cat !== 'docsRead') return false;
    const lp = a.label.replace(/^(Read|auto) /, '').replace(/\//g, '\\').toLowerCase();
    return lp.length > 0 && String(hl.subject).replace(/\//g, '\\').toLowerCase().endsWith(lp);
  }
  return false;
}

const turnKey = (sid, t) => `${sid}|${t.ts}|${(t.prompt || '').slice(0, 40)}`;

// Default per-kind display caps for the Optimize panel.
const SUGG_CAPS = { search: 4, reread: 3, fatdoc: 2, recache: 99 };
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

function fmtDur(startTs, endTs) {
  if (!startTs || !endTs) return '';
  const s = Math.max(0, (new Date(endTs) - new Date(startTs)) / 1000);
  if (s < 60) return Math.round(s) + 's';
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
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
      el('span', null, fmtAgo(s.lastActivity)),
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
    seg.title = `${label}: ${fmtTok(v)}`;
    gauge.append(seg);
    const li = el('span');
    const sw = el('i', 'swatch');
    sw.style.background = catColor(k);
    li.append(sw, document.createTextNode(`${label} ${fmtTok(v)}`));
    legend.append(li);
  }

  // Optimize findings indexed for cross-linking: calls belonging to a finding
  // get marked, and clicking one focuses its card in the Optimize panel.
  const allSuggs = s.suggestions || [];
  const findingFor = (a) =>
    allSuggs.find((g) => g.kind !== 'recache' && actionMatches(g, a)) || null;
  const focusFinding = (g) => {
    state.highlight = { kind: g.kind, subject: g.subject };
    if (!state.suggExpanded[s.id] && !cappedSuggs(allSuggs).includes(g)) {
      state.suggExpanded[s.id] = true; // card is past the caps — reveal it
    }
    renderDetail();
    requestAnimationFrame(() => {
      const active = document.querySelector('.sugg-item.active');
      if (active) active.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  // timeline — newest turn first
  const turnsBox = $('turns');
  turnsBox.replaceChildren();
  const turns = [...(s.turns || [])].reverse();
  const maxTok = Math.max(200, ...turns.flatMap((t) => t.actions.map((a) => a.tokens)));
  turns.forEach((t, i) => {
    const key = turnKey(s.id, t);
    const expanded = state.turnToggles[key] ?? (i === 0); // newest open by default
    const turn = el('div', 'turn' + (expanded ? '' : ' collapsed'));
    const head = el('div', 'turn-head');
    head.tabIndex = 0;
    head.setAttribute('role', 'button');
    head.setAttribute('aria-expanded', String(expanded));
    head.append(
      el('span', 'chev', expanded ? '▾' : '▸'),
      el('span', 'tp', '> ' + (t.prompt || '')),
      el('span', 'tt', `${t.actions.length} actions · +${fmtTok(t.fresh)} in · ${fmtTok(t.output)} out`),
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
    for (const a of t.actions) {
      const row = el('div', 'arow' + (actionMatches(state.highlight, a) ? ' hl' : ''));
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
      row.append(label, bar, el('span', 'anum', '+' + fmtTok(a.tokens)));
      actionsBox.append(row);
    }
    turn.append(actionsBox);
    turnsBox.append(turn);
  });

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
    const clickable = g.kind !== 'recache';
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

  // docs leaderboard
  const docsBox = $('doc-rows');
  docsBox.replaceChildren();
  if (!s.docs || s.docs.length === 0) {
    docsBox.append(el('div', 'ds', 'no docs read yet'));
  }
  for (const d of s.docs || []) {
    const row = el('div', 'doc-row');
    const name = el('span', 'dp', relPath(d.path, s.cwd));
    if (d.agent) name.append(el('i', 'abadge', 'A'));
    row.append(name, el('span', 'ds', `${d.reads}× · ${fmtTok(d.tokens)}`));
    row.title = d.path + (d.agent ? ' (read by a subagent)' : '');
    docsBox.append(row);
  }

  // agents — each runs in its own context window
  const agentsWrap = $('agents-wrap');
  const agentRows = $('agent-rows');
  agentRows.replaceChildren();
  const agents = s.agents || [];
  agentsWrap.hidden = agents.length === 0;
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
      el('span', 'ds', `${fmtTok(a.tokens)} · ${a.calls} calls`),
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
        fmtDur(a.started, a.ended),
        a.docsReads ? `${a.docsReads} docs reads` : null,
      ].filter(Boolean);
      item.append(el('div', 'agent-meta', metaBits.join(' · ')));
      const list = el('div', 'agent-actions');
      for (const x of a.actions || []) {
        const r = el('div', 'agent-action' + (actionMatches(state.highlight, x) ? ' hl' : ''));
        const found = findingFor(x);
        if (found) {
          r.classList.add('opt');
          r.title = 'Part of an Optimize finding — click to focus it';
          r.onclick = () => focusFinding(found);
        }
        const dot = el('i', 'adot');
        dot.style.background = catColor(x.cat);
        const lbl = el('span', 'aal', x.label);
        lbl.title = x.label;
        r.append(dot, lbl, el('span', 'anum', '+' + fmtTok(x.tokens)));
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
  for (const [k, v] of rows) {
    const r = el('div');
    r.append(el('span', null, k), el('b', null, v));
    totalsBox.append(r);
  }
}

function renderReport() {
  const box = $('report-rows');
  box.replaceChildren();
  if (state.report.length === 0) {
    box.append(el('div', 'ds', 'no docs read in the loaded window'));
  }
  for (const d of state.report) {
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

function render() {
  if (!state.pinned && state.sessions.length > 0) {
    state.selected = state.sessions[0].id;
  }
  renderList();
  $('docs-btn').classList.toggle('active', state.view === 'docs');
  if (state.view === 'docs') {
    $('empty').hidden = true;
    $('detail').hidden = true;
    $('report').hidden = false;
    renderReport();
  } else {
    $('report').hidden = true;
    renderDetail();
  }
}

$('docs-btn').onclick = () => {
  state.view = state.view === 'docs' ? 'session' : 'docs';
  if (state.view === 'docs') fetchReport(true);
  render();
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
