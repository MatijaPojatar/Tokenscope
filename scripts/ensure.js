#!/usr/bin/env node
// Ensure the Tokenscope collector is running, then forward the hook event.
// Wired as a Claude Code SessionStart hook: the first session you open
// boots the collector detached, so it's never started manually.

import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = 4820;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function portUp() {
  return new Promise((resolve) => {
    const s = net.connect({ port: PORT, host: '127.0.0.1' });
    s.setTimeout(500);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', async () => {
  const up = await portUp();
  if (!up) {
    const child = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
      detached: true,
      stdio: 'ignore',
      cwd: root,
    });
    child.unref();
  }
  // Forward the hook event (best effort — the collector may still be booting;
  // the transcript tailer catches up regardless).
  setTimeout(() => {
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: '/event',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 1500,
    });
    req.on('error', () => process.exit(0));
    req.on('timeout', () => { req.destroy(); process.exit(0); });
    req.on('close', () => process.exit(0));
    req.end(raw);
  }, up ? 0 : 1500);
});
