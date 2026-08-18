#!/usr/bin/env node
// Tokenscope collector: serves the visualizer UI, streams session updates
// over SSE, ingests optional hook events, and tails Claude Code transcripts.
//
//   node src/server.js [--port 4820] [--root <projects dir>] [--hours 48]
//                      [--data <rollup dir>]

import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { SessionWatcher, defaultRoot } from './watcher.js';
import { extractApiRequests } from './otel.js';
import { scanBaseContext, scanMcpConfig } from './basescan.js';
import { RollupStore, defaultDataDir } from './rollup.js';

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

  if (url.pathname === '/api/history') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rollups.history(
      [...store.sessions.values()].map((s) => s.rollupSummary()))));
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
