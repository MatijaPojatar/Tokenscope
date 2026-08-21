#!/usr/bin/env node
// Tokenscope collector: serves the visualizer UI, streams session updates
// over SSE, ingests optional hook events, and tails Claude Code transcripts.
//
//   node src/server.js [--port 4820] [--root <projects dir>] [--hours 48]
//                      [--data <rollup dir>]

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { SessionWatcher, defaultRoot } from './watcher.js';
import { extractApiRequests } from './otel.js';
import { scanBaseContext, scanMcpConfig } from './basescan.js';
import { RollupStore, defaultDataDir } from './rollup.js';
import { buildGraph, overlayUsage, linkDocs, gitBehind } from './graph.js';
import { renderCodemap } from './codemap.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(argOf('--port', 4820));
const ROOT = argOf('--root', defaultRoot());
const HOURS = Number(argOf('--hours', 48));
const DATA = argOf('--data', defaultDataDir());
const ROLLUP_MS = 60000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const store = new Store();
store.onBaseScan = async (s) => {
  try {
    s.baseFiles = await scanBaseContext(s.cwd);
    s.mcpConfigured = await scanMcpConfig(s.cwd);
    store.dirty.add(s.id);
  } catch { /* scan failed — panel shows totals only */ }
};
const watcher = new SessionWatcher(ROOT, (id, evt, agentId) => store.ingest(id, evt, agentId), HOURS);

// Persistent rollups: session summaries appended to <data>/rollups.jsonl so
// trends outlive the live tail window.
await fsp.mkdir(DATA, { recursive: true });
const rollups = new RollupStore(path.join(DATA, 'rollups.jsonl'));
await rollups.load();
const rollupTick = () => {
  for (const s of store.sessions.values()) {
    if (s.lastActivity) rollups.record(s.rollupSummary());
  }
};
setInterval(rollupTick, ROLLUP_MS);
setTimeout(rollupTick, 15000); // seed shortly after the boot backfill settles

// Generate a handoff context file for a session: pipe the session digest
// to the locally installed claude CLI (headless `claude -p`, billed to the
// user's own account) and write its answer under <project>\.claude\context.
const CTX_PROMPT = `You are generating a session context file for handoff.
Below is a structured digest of a Claude Code session: the user's prompts in
order, the heaviest tool actions per turn, files edited and read, docs used,
and subagents spawned. Write a concise markdown context document that would
let a fresh Claude Code session continue this work seamlessly.

Structure it as: ## Goal & scope, ## What was done (chronological, brief),
## Current state, ## Key files (each with why it matters), ## Decisions &
gotchas, ## Suggested next steps.

Be specific and use the file paths from the digest. Do not invent facts that
are not supported by the digest. Keep it under ~2500 words. Output ONLY the
markdown document — no preamble.`;

const PLAN_PROMPT = `You are writing an optimization plan for a Claude Code
project. Below is a digest of measured token-spend findings from one session,
plus supporting facts (base files, unused skills, most-read files, cache
waste). Produce a concrete, prioritized action plan that reduces context cost
in future sessions.

For each planned item: name the finding it addresses, spell out the exact
change — the file to edit or create with its path, what moves where (CLAUDE.md
trims or moves to on-demand docs, docs to write with a 3-5 bullet outline, a
skill to package with a short SKILL.md sketch, hook output to trim, plugins or
skills to disable, or workflow changes such as fresh sessions per task) — and
the expected saving using the measured numbers from the digest. Order by
impact. Do not invent facts not supported by the digest. Keep it under ~2000
words. Output ONLY the markdown plan — no preamble.`;

const ctxInFlight = new Map(); // session id -> {child, canceled}

// With shell:true the direct child is a shell shim — kill the whole tree
// so the actual claude process dies too.
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
}

function runClaudeToFile(s, dataDir, holder, prompt, payload, filePrefix) {
  return new Promise((resolve, reject) => {
    const cwdOk = s.cwd && fs.existsSync(s.cwd);
    const child = spawn('claude', ['-p'], {
      shell: true, // claude is a .cmd shim on Windows
      cwd: cwdOk ? s.cwd : undefined,
      windowsHide: true,
    });
    holder.child = child;
    let out = '';
    let err = '';
    const killer = setTimeout(() => {
      killTree(child);
      reject(new Error('claude CLI timed out after 5 minutes'));
    }, 300000);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => {
      clearTimeout(killer);
      reject(new Error('could not run the claude CLI (is it on PATH?): ' + e.message));
    });
    child.on('close', async (code) => {
      clearTimeout(killer);
      if (holder.canceled) {
        reject(new Error('canceled'));
        return;
      }
      if (code !== 0 || !out.trim()) {
        reject(new Error('claude CLI failed' + (err.trim() ? ': ' + err.trim().slice(0, 300) : ` (exit ${code})`)));
        return;
      }
      try {
        const dir = path.join(cwdOk ? s.cwd : dataDir, '.claude', 'context');
        await fsp.mkdir(dir, { recursive: true });
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
        const file = path.join(dir, `${filePrefix}-${s.id.slice(0, 8)}-${stamp}.md`);
        await fsp.writeFile(file, out.trim() + '\n');
        resolve({ ok: true, path: file, bytes: out.trim().length });
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.end(prompt + '\n\n---\n\n' + payload);
  });
}

// Doc roster for graph linking: base-context files (CLAUDE.md + @-imports)
// plus every .claude markdown, minus generated context artifacts. Contents
// are read here; the graph helpers stay pure.
async function docsRoster(cwd) {
  const seen = new Map(); // lowercased abs path -> {path, text}
  const add = async (p) => {
    const key = path.resolve(p).toLowerCase();
    if (seen.has(key)) return;
    try {
      seen.set(key, { path: path.resolve(p), text: await fsp.readFile(p, 'utf8') });
    } catch { /* unreadable — skip */ }
  };
  for (const f of await scanBaseContext(cwd)) {
    if (/\.(md|mdx)$/i.test(f.path)) await add(f.path);
  }
  const dir = path.join(cwd, '.claude');
  try {
    const entries = await fsp.readdir(dir, { recursive: true, withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !/\.(md|mdx)$/i.test(e.name)) continue;
      const full = path.join(e.parentPath || dir, e.name);
      if (/[\\/]context[\\/]/i.test(full)) continue; // our own output
      await add(full);
    }
  } catch { /* no .claude dir */ }
  return [...seen.values()];
}

// Per-session (docs read, files read) pairs for a project — the evidence
// behind observed doc→folder edges.
function graphPairs(cwd) {
  const want = String(cwd).replace(/\//g, '\\').toLowerCase();
  const out = [];
  for (const s of store.sessions.values()) {
    if (!s.cwd || String(s.cwd).replace(/\//g, '\\').toLowerCase() !== want) continue;
    out.push({ docs: s.mergedDocs(), files: s.mergedFileReads() });
  }
  return out;
}

const graphFile = (cwd) => path.join(cwd, '.claude', 'context', 'graph.json');
const graphInFlight = new Set(); // normalized cwds with a build running

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': tokenscope\n\n');
    store.subscribe(res);
    return;
  }

  if (url.pathname === '/api/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(store.sessionList()));
    return;
  }

  if (url.pathname === '/api/docs') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(store.docsReport()));
    return;
  }

  if (url.pathname === '/api/mcpskills') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(store.mcpSkillsReport()));
    return;
  }

  if (url.pathname === '/api/filemap') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(store.fileReport()));
    return;
  }

  if (url.pathname === '/api/history') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rollups.history(
      [...store.sessions.values()].map((s) => s.rollupSummary()))));
    return;
  }

  // Knowledge graph: build (POST) writes <cwd>\.claude\context\graph.json —
  // static import structure + usage overlay + doc links; GET returns the
  // saved artifact. Codemap renders the graph into a token-budgeted
  // markdown orientation map next to it.
  if (url.pathname === '/api/graph' && req.method === 'GET') {
    const cwd = url.searchParams.get('cwd') || '';
    try {
      const graph = JSON.parse(await fsp.readFile(graphFile(cwd), 'utf8'));
      graph.meta.behind = gitBehind(cwd, graph.meta.gitHead); // response-only
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(graph));
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"no graph built for this project yet"}');
    }
    return;
  }

  if (url.pathname === '/api/graph' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { /* handled below */ }
    const cwd = body.cwd && fs.existsSync(body.cwd) ? path.resolve(body.cwd) : null;
    if (!cwd) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"cwd missing or not a directory"}');
      return;
    }
    const key = cwd.toLowerCase();
    if (graphInFlight.has(key)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end('{"error":"a graph build for this project is already running"}');
      return;
    }
    graphInFlight.add(key);
    try {
      const graph = await buildGraph(cwd, {
        granularity: body.granularity === 'file' ? 'file' : 'folder',
        maxNodes: Number(body.maxNodes) > 0 ? Number(body.maxNodes) : 40,
      });
      overlayUsage(graph, store.fileReport());
      linkDocs(graph, await docsRoster(cwd), graphPairs(cwd));
      const file = graphFile(cwd);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, JSON.stringify(graph, null, 1) + '\n');
      graph.meta.behind = 0; // response-only, never persisted
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: file, graph }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String((e && e.message) || e) }));
    } finally {
      graphInFlight.delete(key);
    }
    return;
  }

  if (url.pathname === '/api/graph/codemap' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { /* handled below */ }
    const cwd = body.cwd || '';
    let graph;
    try {
      graph = JSON.parse(await fsp.readFile(graphFile(cwd), 'utf8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"no graph for this project — build it first"}');
      return;
    }
    try {
      const budget = Number(body.tokenBudget) > 0 ? Number(body.tokenBudget) : 2000;
      const { text, tokens } = renderCodemap(graph, { tokenBudget: budget });
      const file = path.join(cwd, '.claude', 'context', 'codemap.md');
      await fsp.writeFile(file, text);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: file, tokens }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String((e && e.message) || e) }));
    }
    return;
  }

  // Context-file and optimize-plan generation share one flow: build a
  // digest, run the local claude CLI headlessly, write the result under
  // the project's .claude\context. One generation per session at a time.
  const genMatch = url.pathname.match(/^\/api\/session\/(.+)\/(context-file|optimize-plan)$/);
  if (genMatch && req.method === 'POST') {
    const [, id, kind] = genMatch;
    const s = store.sessions.get(id);
    if (!s) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"unknown session"}');
      return;
    }
    if (ctxInFlight.has(id)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end('{"error":"a generation for this session is already running"}');
      return;
    }
    let prompt;
    let payload;
    let prefix;
    if (kind === 'optimize-plan') {
      if ((s.suggestions() || []).length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"no Optimize findings for this session yet"}');
        return;
      }
      prompt = PLAN_PROMPT;
      payload = s.optimizeDigest();
      prefix = 'optimize-plan';
    } else {
      prompt = CTX_PROMPT;
      payload = s.contextDigest();
      prefix = 'session';
    }
    const holder = { child: null, canceled: false };
    ctxInFlight.set(id, holder);
    try {
      const result = await runClaudeToFile(s, DATA, holder, prompt, payload, prefix);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      const msg = String((e && e.message) || e);
      res.writeHead(holder.canceled ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(holder.canceled ? { canceled: true } : { error: msg }));
    } finally {
      ctxInFlight.delete(id);
    }
    return;
  }

  if (genMatch && req.method === 'DELETE') {
    const holder = ctxInFlight.get(genMatch[1]);
    res.writeHead(holder ? 200 : 404, { 'Content-Type': 'application/json' });
    if (holder) {
      holder.canceled = true;
      killTree(holder.child);
      res.end('{"ok":true}');
    } else {
      res.end('{"error":"no generation running for this session"}');
    }
    return;
  }

  if (url.pathname.startsWith('/api/session/')) {
    const id = url.pathname.slice('/api/session/'.length);
    const s = store.sessions.get(id);
    res.writeHead(s ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(s ? JSON.stringify(s.toJSON()) : '{"error":"unknown session"}');
    return;
  }

  // Hook ingest: Claude Code hooks POST their stdin JSON here. Real-time
  // "action happening now" signals ahead of the transcript catching up.
  if (url.pathname === '/event' && req.method === 'POST') {
    const body = await readBody(req);
    res.writeHead(204).end();
    try {
      const evt = JSON.parse(body);
      store.broadcast({ type: 'hook', event: {
        name: evt.hook_event_name,
        sessionId: evt.session_id,
        tool: evt.tool_name || null,
        ts: Date.now(),
      } });
    } catch { /* malformed hook payload — ignore */ }
    return;
  }

  // Statusline forwarder: exact context-window size, session cost, rate limits.
  if (url.pathname === '/status' && req.method === 'POST') {
    const body = await readBody(req);
    res.writeHead(204).end();
    try {
      store.applyStatus(JSON.parse(body));
    } catch { /* malformed snapshot — ignore */ }
    return;
  }

  // OTLP/HTTP JSON logs: exact per-request cost from claude_code.api_request.
  if (url.pathname === '/otel' && req.method === 'POST') {
    const body = await readBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}'); // OTLP expects a JSON success envelope
    try {
      store.applyOtelEvents(extractApiRequests(JSON.parse(body)));
    } catch { /* not OTLP JSON — ignore */ }
    return;
  }

  await serveStatic(res, url.pathname);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`tokenscope collector on http://localhost:${PORT}`);
  console.log(`watching ${ROOT} (sessions active within ${HOURS}h)`);
  watcher.start();
});
