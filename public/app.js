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
};

const $ = (id) => document.getElementById(id);
const catColor = (cat) => `var(--c-${cat})`;

function fmtTok(n) {
  if (n == null) return '–';
  if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k';
  return String(n);
}

function fmtAgo(ts) {
  if (!ts) return '';
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 90) return 'now';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
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
    item.onclick = () => { state.selected = s.id; state.pinned = true; render(); };
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

  // timeline — newest turn first
  const turnsBox = $('turns');
  turnsBox.replaceChildren();
  const turns = [...(s.turns || [])].reverse();
  const maxTok = Math.max(200, ...turns.flatMap((t) => t.actions.map((a) => a.tokens)));
  for (const t of turns) {
    const turn = el('div', 'turn');
    const head = el('div', 'turn-head');
    head.append(
      el('span', 'tp', '> ' + (t.prompt || '')),
      el('span', 'tt', `+${fmtTok(t.fresh)} in · ${fmtTok(t.output)} out`),
    );
    turn.append(head);
    for (const a of t.actions) {
      const row = el('div', 'arow');
      const label = el('span', 'al');
      const [tool, ...rest] = (a.label || a.name).split(' ');
      label.append(document.createTextNode(tool + ' '));
      label.append(el('em', null, rest.join(' ')));
      const bar = el('span', 'abar');
      const fill = document.createElement('div');
      fill.style.width = Math.max(1.5, (a.tokens / maxTok) * 100) + '%';
      fill.style.background = catColor(a.cat);
      bar.append(fill);
      row.append(label, bar, el('span', 'anum', '+' + fmtTok(a.tokens)));
      turn.append(row);
    }
    turnsBox.append(turn);
  }

  // docs leaderboard
  const docsBox = $('doc-rows');
  docsBox.replaceChildren();
  if (!s.docs || s.docs.length === 0) {
    docsBox.append(el('div', 'ds', 'no docs read yet'));
  }
  for (const d of s.docs || []) {
    const row = el('div', 'doc-row');
    const parts = d.path.replace(/\//g, '\\').split('\\');
    row.append(
      el('span', 'dp', parts.slice(-3).join('\\')),
      el('span', 'ds', `${d.reads}× · ${fmtTok(d.tokens)}`),
    );
    row.title = d.path;
    docsBox.append(row);
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

function render() {
  if (!state.pinned && state.sessions.length > 0) {
    state.selected = state.sessions[0].id;
  }
  renderList();
  renderDetail();
}

// ---- SSE ----

let hookFade;
const es = new EventSource('/events');
es.onmessage = (msg) => {
  const data = JSON.parse(msg.data);
  if (data.type === 'hello' || data.type === 'list') {
    state.sessions = data.sessions;
    for (const s of state.sessions) {
      if (!state.detail[s.id]) fetchDetail(s.id);
    }
    render();
  } else if (data.type === 'session') {
    state.detail[data.session.id] = data.session;
    if (data.session.id === state.selected) renderDetail();
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
