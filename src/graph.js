// Codebase knowledge graph: import-level structure scanned from disk with
// string-level extraction — no AST, no dependencies. File→file import edges
// are aggregated up to folder→folder at a node-count target, so the folder
// graph stays small enough to inject into context as an orientation map.
// This module is pure (disk in, graph out); usage weighting and doc linking
// are data-in data-out helpers here (overlayUsage, linkDocs) — the server
// feeds them measured session data and doc contents.
//
// Bare specifiers are resolved through the nearest tsconfig/jsconfig
// baseUrl and paths (prefix patterns only), so apps that import from a
// source root ('components/Foo' with baseUrl ./src) graph as internal
// edges, not phantom external packages.
//
//   node src/graph.js <path> [--granularity folder|file] [--max-nodes 40]
//                            [--out <file>] [--json]

import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const CODE_EXTS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
const INDEX_BASES = CODE_EXTS.map((e) => 'index' + e);
// .js specifiers may point at .ts sources (NodeNext-style explicit extensions).
const EXT_SWAPS = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'], '.jsx': ['.tsx'] };
const IGNORE_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'tmp']);
const MAX_FILES = 20000;

// ---------------------------------------------------------------- extraction

// String-aware comment stripper: comments are removed only outside ' " `
// strings, so a '/*' inside a glob string ("src/**/*.js", tsconfig paths)
// can never pair with a later '*/' and swallow real code between them.
// Strings themselves are preserved — import specifiers live in them.
// Regex literals are not tracked; a slash-heavy regex can leak or eat a
// line, which is accepted lexer-level noise.
export function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  let quote = null;
  while (i < n) {
    const c = text[i];
    if (quote) {
      out += c;
      if (c === '\\') { out += text[i + 1] || ''; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; i += 1; continue; }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      out += ' ';
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? n : end; // the newline itself is kept
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const IMPORT_RES = [
  /(?:^|[^\w$.])import\s*(?:[\w*{},\s$]+?from\s*)?['"]([^'"\n]+)['"]/g, // import x from '..' | import '..'
  /(?:^|[^\w$.])export\s+[\w*{},\s$]*?from\s*['"]([^'"\n]+)['"]/g,     // export .. from '..'
  /(?:^|[^\w$.])require\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,              // require('..')
  /(?:^|[^\w$.])import\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,               // dynamic import('..')
];

export function extractImports(text) {
  const src = stripComments(text);
  const out = new Set();
  for (const re of IMPORT_RES) {
    for (const m of src.matchAll(re)) out.add(m[1]);
  }
  return [...out];
}

// -------------------------------------------------------------------- walk

// Manual recursion so ignored trees (node_modules above all) are never
// entered — readdir({recursive}) would walk them first and filter later.
// Dot-directories are skipped wholesale (.git, .next, .claude, .cache, …).
export async function walkProject(root, { maxFiles = MAX_FILES } = {}) {
  const files = [];
  const tsconfigs = [];
  let capped = false;
  const stack = [path.resolve(root)];
  while (stack.length > 0 && !capped) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name.toLowerCase())) continue;
        stack.push(full);
      } else if (e.isFile()) {
        if (e.name === 'tsconfig.json' || e.name === 'jsconfig.json') tsconfigs.push(full);
        const ext = path.extname(e.name).toLowerCase();
        if (!CODE_EXTS.includes(ext) || e.name.endsWith('.d.ts')) continue;
        files.push(full);
        if (files.length >= maxFiles) { capped = true; break; }
      }
    }
  }
  return { files, tsconfigs, capped };
}

// ---------------------------------------------------------------- tsconfig

// Tolerant parse: real-world tsconfigs carry comments and trailing commas.
const parseJsonc = (text) => {
  const clean = stripComments(text).replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(clean);
};

// Extract baseUrl and single-'*' paths patterns; `extends` chains are not
// followed (baseUrl/paths usually live in the leaf config).
export async function readTsconfig(file) {
  let cfg;
  try {
    cfg = parseJsonc(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
  const dir = path.dirname(file);
  const opts = (cfg && cfg.compilerOptions) || {};
  const baseUrl = opts.baseUrl ? path.resolve(dir, opts.baseUrl) : null;
  const pathsRoot = baseUrl || dir;
  const paths = [];
  for (const [pattern, targets] of Object.entries(opts.paths || {})) {
    const star = pattern.indexOf('*');
    if (star >= 0 && star !== pattern.length - 1) continue; // only trailing-'*'
    paths.push({
      prefix: star >= 0 ? pattern.slice(0, -1) : pattern,
      exact: star < 0,
      targets: (Array.isArray(targets) ? targets : []).map((t) =>
        path.resolve(pathsRoot, t.replace(/\*$/, ''))),
    });
  }
  if (!baseUrl && paths.length === 0) return null;
  return { dir, baseUrl, paths };
}

// ---------------------------------------------------------------- resolver

// Resolution consults only the walked file set — no fs calls — so the
// resolver is pure and a nonexistent target can never become a node.
export function makeResolver(files, tsconfigs = []) {
  const index = new Map(); // lowercased abs path -> canonical abs path
  for (const f of files) index.set(f.toLowerCase(), f);

  const tryFile = (p) => {
    const base = path.resolve(p);
    const candidates = [base];
    const ext = path.extname(base).toLowerCase();
    if (ext && EXT_SWAPS[ext]) {
      const stem = base.slice(0, -ext.length);
      for (const swap of EXT_SWAPS[ext]) candidates.push(stem + swap);
    }
    if (!ext) for (const e of CODE_EXTS) candidates.push(base + e);
    for (const ib of INDEX_BASES) candidates.push(path.join(base, ib));
    for (const c of candidates) {
      const hit = index.get(c.toLowerCase());
      if (hit) return hit;
    }
    return null;
  };

  // Nearest config wins: longest directory prefix above the importing file.
  const configs = tsconfigs
    .filter(Boolean)
    .sort((a, b) => b.dir.length - a.dir.length);
  const dirKey = (d) => d.toLowerCase() + path.sep;
  const configFor = (file) => {
    const key = file.toLowerCase();
    return configs.find((c) => key.startsWith(dirKey(c.dir))) || null;
  };

  const packageName = (spec) => {
    const parts = spec.split('/');
    return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  };

  return (fromFile, rawSpec) => {
    const spec = rawSpec.split(/[?#]/)[0]; // bundler suffixes: ?raw, ?url, …
    if (!spec) return { kind: 'ignored' };
    const ext = path.extname(spec).toLowerCase();
    // Style/asset/json imports are real but not code edges.
    if (ext && !CODE_EXTS.includes(ext) && !EXT_SWAPS[ext]) return { kind: 'ignored' };

    if (spec.startsWith('.') || path.isAbsolute(spec)) {
      const abs = path.isAbsolute(spec) ? spec : path.resolve(path.dirname(fromFile), spec);
      const hit = tryFile(abs);
      return hit ? { kind: 'internal', target: hit } : { kind: 'unresolved', spec: rawSpec };
    }

    const cfg = configFor(fromFile);
    if (cfg) {
      for (const p of cfg.paths) {
        if (p.exact ? spec === p.prefix : spec.startsWith(p.prefix)) {
          const rest = p.exact ? '' : spec.slice(p.prefix.length);
          for (const t of p.targets) {
            const hit = tryFile(path.join(t, rest));
            if (hit) return { kind: 'internal', target: hit };
          }
        }
      }
      if (cfg.baseUrl) {
        const hit = tryFile(path.join(cfg.baseUrl, spec));
        if (hit) return { kind: 'internal', target: hit };
      }
    }
    return { kind: 'external', target: packageName(spec) };
  };
}

// -------------------------------------------------------------- file graph

export async function buildFileGraph(cwd, { maxFiles = MAX_FILES } = {}) {
  const root = path.resolve(cwd);
  const { files, tsconfigs, capped } = await walkProject(root, { maxFiles });
  const configs = [];
  for (const t of tsconfigs) {
    const c = await readTsconfig(t);
    if (c) configs.push(c);
  }
  const resolve = makeResolver(files, configs);

  const edges = new Map();      // 'from|to' -> weight (abs paths)
  const externals = new Map();  // 'fromFile|pkg' -> weight
  const unresolved = new Map(); // spec -> count
  const BATCH = 64;
  for (let i = 0; i < files.length; i += BATCH) {
    await Promise.all(files.slice(i, i + BATCH).map(async (file) => {
      let text;
      try {
        text = await fsp.readFile(file, 'utf8');
      } catch {
        return;
      }
      const seen = new Set(); // one edge per dependency, however often imported
      for (const spec of extractImports(text)) {
        const r = resolve(file, spec);
        if (r.kind === 'internal' && r.target !== file) {
          const key = file + '|' + r.target;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.set(key, (edges.get(key) || 0) + 1);
        } else if (r.kind === 'external') {
          externals.set(file + '|' + r.target, 1);
        } else if (r.kind === 'unresolved') {
          unresolved.set(r.spec, (unresolved.get(r.spec) || 0) + 1);
        }
      }
    }));
  }
  return { cwd: root, files, edges, externals, unresolved, capped, tsconfigCount: configs.length };
}

// ------------------------------------------------------- folder aggregation

const toRel = (root, p) => {
  const rel = path.relative(root, p).split(path.sep).join('/');
  return rel === '' ? '.' : rel;
};
const parentOf = (folder) => {
  const i = folder.lastIndexOf('/');
  return i < 0 ? '.' : folder.slice(0, i);
};
const depthOf = (folder) => (folder === '.' ? 0 : folder.split('/').length);

// Merge the deepest (then smallest) folders into their parents until the
// node-count target is met — the token budget implemented structurally.
// Returns canon: original folder -> surviving folder.
export function collapseFolders(folderFiles, maxNodes) {
  const live = new Map(folderFiles); // folder -> file count
  const alias = new Map();           // merged folder -> parent at merge time
  while (live.size > maxNodes) {
    let victim = null;
    for (const [f, n] of live) {
      if (f === '.') continue;
      if (!victim ||
        depthOf(f) > depthOf(victim[0]) ||
        (depthOf(f) === depthOf(victim[0]) && n < victim[1])) victim = [f, n];
    }
    if (!victim) break; // only '.' left
    const [f, n] = victim;
    const parent = parentOf(f);
    live.delete(f);
    live.set(parent, (live.get(parent) || 0) + n);
    alias.set(f, parent);
  }
  const canon = (folder) => {
    let f = folder;
    while (alias.has(f)) f = alias.get(f);
    return f;
  };
  return { canon, folders: live };
}

// ------------------------------------------------------------- build graph

export async function buildGraph(cwd, {
  granularity = 'folder', maxNodes = 40, maxFiles = MAX_FILES,
} = {}) {
  const fg = await buildFileGraph(cwd, { maxFiles });
  const root = fg.cwd;

  // nodeOf maps an absolute file to its node id in the chosen granularity;
  // both internal and external edge aggregation route through it.
  let nodeOf;
  let nodes;
  let edges;
  if (granularity === 'file') {
    nodeOf = (absFile) => toRel(root, absFile);
    nodes = fg.files.map((f) => ({ id: nodeOf(f), kind: 'file' }));
    edges = [...fg.edges].map(([key, weight]) => {
      const [from, to] = key.split('|');
      return { from: nodeOf(from), to: nodeOf(to), kind: 'imports', weight };
    });
  } else {
    const fileFolder = new Map(); // abs file -> original folder
    const folderFiles = new Map();
    for (const f of fg.files) {
      const folder = toRel(root, path.dirname(f));
      fileFolder.set(f, folder);
      folderFiles.set(folder, (folderFiles.get(folder) || 0) + 1);
    }
    const { canon, folders } = collapseFolders(folderFiles, maxNodes);
    nodeOf = (absFile) => canon(fileFolder.get(absFile));
    const agg = new Map();
    for (const [key, w] of fg.edges) {
      const [from, to] = key.split('|');
      const fa = nodeOf(from);
      const fb = nodeOf(to);
      if (fa === fb) continue;
      const k = fa + '|' + fb;
      agg.set(k, (agg.get(k) || 0) + w);
    }
    nodes = [...folders].map(([id, n]) => ({ id, kind: 'folder', files: n }));
    edges = [...agg].map(([key, weight]) => {
      const [from, to] = key.split('|');
      return { from, to, kind: 'imports', weight };
    });
  }

  // External packages: one edge per (node, package), weight = importing
  // files. Ids get a 'pkg:' prefix so a package can never collide with a
  // folder of the same name ('config', 'utils', …).
  const extAgg = new Map();
  for (const key of fg.externals.keys()) {
    const [file, pkg] = key.split('|');
    const k = nodeOf(file) + '|pkg:' + pkg;
    extAgg.set(k, (extAgg.get(k) || 0) + 1);
  }
  const extNames = new Set([...extAgg.keys()].map((k) => k.split('|')[1]));
  nodes.push(...[...extNames].sort().map((id) => ({ id, kind: 'external' })));
  edges.push(...[...extAgg].map(([key, weight]) => {
    const [from, to] = key.split('|');
    return { from, to, kind: 'imports', weight };
  }));

  const meta = {
    root,
    builtAt: new Date().toISOString(),
    gitHead: gitHead(root),
    granularity,
    maxNodes,
    filesScanned: fg.files.length,
    capped: fg.capped,
    tsconfigCount: fg.tsconfigCount,
    unresolvedTop: [...fg.unresolved].sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([spec, count]) => ({ spec, count })),
  };
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from));
  return { meta, nodes, edges };
}

// ---------------------------------------------------------- usage overlay

const relUnder = (root, p) => {
  const rel = path.relative(root, String(p));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
};

// Project-relative path -> graph node. Folder graphs walk up to the nearest
// surviving ancestor: collapse merges deepest-first, so that ancestor is
// exactly the canonical folder the path's edges were aggregated into.
// strict drops lookups that only land on the root — a junk string with a
// slash in it must not count as a reference to the whole repo.
function nodeLookup(graph) {
  const byId = new Map();
  for (const n of graph.nodes) {
    if (n.kind === 'folder' || n.kind === 'file') byId.set(n.id.toLowerCase(), n);
  }
  const isFile = graph.meta.granularity === 'file';
  return (rel, { strict = false } = {}) => {
    let key = String(rel).replace(/\/+$/, '').toLowerCase() || '.';
    if (isFile) return byId.get(key) || null;
    while (true) {
      const hit = byId.get(key);
      if (hit) return strict && hit.id === '.' && key !== rel.toLowerCase() ? null : hit;
      if (key === '.') return null;
      key = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '.';
    }
  };
}

const dirOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '.');

// Fold measured per-file read tokens (the store's fileReport()) onto graph
// nodes: circle sizes for the UI, "~X tok read" for the codemap.
export function overlayUsage(graph, projects) {
  const root = graph.meta.root;
  const want = String(root).replace(/\//g, '\\').toLowerCase();
  const proj = (projects || []).find(
    (p) => String(p.cwd).replace(/\//g, '\\').toLowerCase() === want);
  if (!proj) return graph;
  const lookup = nodeLookup(graph);
  const isFile = graph.meta.granularity === 'file';
  for (const f of proj.files || []) {
    const rel = relUnder(root, f.path);
    if (!rel) continue;
    const node = lookup(isFile ? rel : dirOf(rel));
    if (!node) continue;
    node.tokensRead = (node.tokensRead || 0) + f.tokens;
    node.reads = (node.reads || 0) + f.reads;
  }
  graph.meta.usage = { sessions: proj.sessions, appliedAt: new Date().toISOString() };
  return graph;
}

// ------------------------------------------------------------ doc linking

// Path-like strings in a doc: backticked spans plus bare segment/segment
// tokens. Only candidates that resolve to a real graph node (or another
// doc) become edges — the existence check drops prose false positives.
export function extractPathCandidates(text) {
  const out = new Set();
  const res = [
    /`([^`\n]{2,120})`/g,
    /(?:^|[\s("'@])((?:\.{0,2}\/)?(?:[\w.-]+[\\/])+[\w.*-]+)/g,
  ];
  for (const re of res) {
    for (const m of text.matchAll(re)) {
      let c = m[1].trim().replace(/[.,;:!?)\]}'"]+$/, '');
      c = c.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
      if (!c || c.includes('://') || c.startsWith('..')) continue;
      out.add(c);
    }
  }
  return [...out];
}

// Add doc nodes and doc→code edges to a graph.
//   docs:  [{path, text}]           — the roster, contents read by caller
//   pairs: [{docs, files}]          — per matching session, mergedDocs()
//                                     and mergedFileReads() shapes
// 'mentions' edges are static (path named in the doc body); 'observed'
// edges are behavioral (doc read in sessions whose reads concentrated in
// that folder) and carry {sessions, tokens} as evidence.
export function linkDocs(graph, docs = [], pairs = []) {
  const root = graph.meta.root;
  const lookup = nodeLookup(graph);
  const docNodes = new Map(); // lowercased rel id -> node
  for (const d of docs) {
    const rel = relUnder(root, d.path);
    if (!rel || docNodes.has(rel.toLowerCase())) continue;
    docNodes.set(rel.toLowerCase(), { id: rel, kind: 'doc' });
  }

  const edges = new Map(); // 'from|to|kind' -> edge
  const bump = (from, to, kind) => {
    const key = from + '|' + to + '|' + kind;
    let e = edges.get(key);
    if (!e) {
      e = { from, to, kind, weight: 0 };
      edges.set(key, e);
    }
    e.weight += 1;
    return e;
  };

  for (const d of docs) {
    const rel = relUnder(root, d.path);
    if (!rel) continue;
    const docId = docNodes.get(rel.toLowerCase()).id;
    for (const cand of extractPathCandidates(d.text || '')) {
      const other = docNodes.get(cand.toLowerCase());
      if (other) {
        if (other.id !== docId) bump(docId, other.id, 'mentions');
        continue;
      }
      const n = lookup(cand, { strict: true });
      if (n) bump(docId, n.id, 'mentions');
    }
  }

  const MIN_FOLDER_TOKENS = 1000; // folder barely touched that session
  const isFile = graph.meta.granularity === 'file';
  for (const s of pairs) {
    const folderTok = new Map(); // node id -> tokens read there this session
    for (const f of s.files || []) {
      const rel = relUnder(root, f.path);
      if (!rel) continue;
      const n = lookup(isFile ? rel : dirOf(rel));
      if (n) folderTok.set(n.id, (folderTok.get(n.id) || 0) + f.tokens);
    }
    for (const doc of s.docs || []) {
      const rel = relUnder(root, doc.path);
      const dn = rel && docNodes.get(rel.toLowerCase());
      if (!dn) continue;
      for (const [fid, tok] of folderTok) {
        if (tok < MIN_FOLDER_TOKENS) continue;
        const e = bump(dn.id, fid, 'observed');
        e.sessions = (e.sessions || 0) + 1;
        e.tokens = (e.tokens || 0) + tok;
      }
    }
  }

  // One co-occurring session is noise; two, or one with heavy overlap, is
  // evidence. weight becomes the session count for observed edges.
  let mentions = 0;
  let observed = 0;
  for (const e of edges.values()) {
    if (e.kind === 'observed') {
      if (e.sessions < 2 && e.tokens < 10000) continue;
      e.weight = e.sessions;
      observed += 1;
    } else {
      mentions += 1;
    }
    graph.edges.push(e);
  }
  graph.nodes.push(...[...docNodes.values()].sort((a, b) => a.id.localeCompare(b.id)));
  graph.meta.docs = { count: docNodes.size, mentions, observed };
  return graph;
}

function gitHead(cwd) {
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ query

// Everything the graph knows about nodes matching `needle` — the on-demand
// reference lookup. A rendered view can only show a subset of a
// thousands-of-files graph; this answers precisely from the whole artifact.
export function queryGraph(graph, needle, { limit = 5 } = {}) {
  const q = String(needle).replace(/\\/g, '/').toLowerCase();
  const hits = graph.nodes
    .filter((n) => n.kind !== 'external' && n.id.toLowerCase().includes(q))
    .slice(0, limit);
  const byW = (a, b) => (b.weight || 0) - (a.weight || 0);
  return hits.map((n) => {
    const imports = [];
    const importedBy = [];
    const packages = [];
    const docs = [];
    for (const e of graph.edges || []) {
      if (e.from === n.id) {
        if (String(e.to).startsWith('pkg:')) packages.push({ id: e.to.slice(4), weight: e.weight });
        else if (e.kind === 'imports') imports.push({ id: e.to, weight: e.weight });
        else docs.push({ id: e.to, kind: e.kind, sessions: e.sessions });
      } else if (e.to === n.id) {
        if (e.kind === 'imports') importedBy.push({ id: e.from, weight: e.weight });
        else docs.push({ id: e.from, kind: e.kind, sessions: e.sessions });
      }
    }
    return {
      node: n,
      imports: imports.sort(byW),
      importedBy: importedBy.sort(byW),
      packages: packages.sort(byW),
      docs,
    };
  });
}

// Commits on HEAD since the graph was built — the staleness signal. null
// means "age unknown" (no git, unknown sha): shown as such, never silence.
export function gitBehind(cwd, head) {
  if (!head) return null;
  try {
    const r = spawnSync('git', ['rev-list', '--count', head + '..HEAD'],
      { cwd, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) return null;
    const n = Number(r.stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------- CLI

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const args = process.argv.slice(2);
  const argOf = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };

  // query mode: answer from an already-built artifact.
  //   node src/graph.js query <project> <path-or-name> [--limit 5]
  if (args[0] === 'query') {
    const project = args[1];
    const needle = args[2];
    if (!project || !needle) {
      console.error('usage: node src/graph.js query <project> <path-or-name> [--limit 5]');
      process.exit(2);
    }
    const file = path.join(project, '.claude', 'context', 'graph.json');
    let graph;
    try {
      graph = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {
      console.error(`no graph at ${file} — build one first (dashboard "build graph" or POST /api/graph)`);
      process.exit(1);
    }
    const results = queryGraph(graph, needle, { limit: Number(argOf('--limit', 5)) });
    if (results.length === 0) {
      console.log(`no nodes match "${needle}" (granularity: ${graph.meta.granularity})`);
    }
    for (const r of results) {
      const n = r.node;
      console.log(`${n.id}  [${n.kind}]` +
        (n.files ? `  ${n.files} files` : '') +
        (n.tokensRead ? `  ~${n.tokensRead} tok read` : ''));
      const line = (label, list, fmt) => {
        if (list.length === 0) return;
        console.log(`  ${label} ` + list.slice(0, 12).map(fmt).join(', ') +
          (list.length > 12 ? `, +${list.length - 12} more` : ''));
      };
      line('imports ->', r.imports, (x) => `${x.id} (${x.weight})`);
      line('imported by <-', r.importedBy, (x) => `${x.id} (${x.weight})`);
      line('packages:', r.packages, (x) => x.id);
      line('docs:', r.docs, (x) =>
        `${x.id} (${x.kind}${x.sessions ? `, ${x.sessions} sess` : ''})`);
    }
    process.exit(0);
  }
  const target = args.find((a) => !a.startsWith('--') && a !== argOf('--granularity') &&
    a !== argOf('--max-nodes') && a !== argOf('--out')) || '.';
  const opts = {
    granularity: argOf('--granularity', 'folder'),
    maxNodes: Number(argOf('--max-nodes', 40)),
  };
  const t0 = Date.now();
  const graph = await buildGraph(target, opts);
  const ms = Date.now() - t0;
  const out = argOf('--out', null);
  if (out) {
    await fsp.mkdir(path.dirname(path.resolve(out)), { recursive: true });
    await fsp.writeFile(out, JSON.stringify(graph, null, 1) + '\n');
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(graph, null, 2));
  } else {
    const m = graph.meta;
    console.log(`scanned ${m.filesScanned} files${m.capped ? ' (CAPPED)' : ''} in ${ms}ms — ` +
      `${m.tsconfigCount} tsconfig(s), git ${m.gitHead ? m.gitHead.slice(0, 8) : 'n/a'}`);
    const inner = graph.nodes.filter((n) => n.kind !== 'external').length;
    const ext = graph.nodes.length - inner;
    const innerEdges = graph.edges.filter((e) => !e.to.startsWith('pkg:')).length;
    console.log(`graph [${m.granularity}]: ${inner} ${m.granularity} nodes + ${ext} externals, ` +
      `${innerEdges} internal edges + ${graph.edges.length - innerEdges} external`);
    if (m.unresolvedTop.length > 0) {
      console.log('top unresolved specifiers:');
      for (const u of m.unresolvedTop) console.log(`  ${u.count.toString().padStart(4)}  ${u.spec}`);
    }
    if (out) console.log(`wrote ${out}`);
  }
}
