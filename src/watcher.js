// Session discovery and transcript tailing.
//
// Watches %USERPROFILE%\.claude\projects\ for *.jsonl session transcripts.
// Recent files are backfilled from the start, then tailed by byte offset as
// Claude Code appends to them. fs.watchFile (stat polling) is used rather
// than fs.watch — reliable on Windows and cheap at these file counts.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseLine } from './adapter.js';

const POLL_MS = 700;
const RESCAN_MS = 5000;

export const defaultRoot = () => path.join(os.homedir(), '.claude', 'projects');

class Tailer {
  constructor(file, onLine) {
    this.file = file;
    this.onLine = onLine;
    this.offset = 0;
    this.remainder = '';
    this.busy = false;
    this.again = false;
  }

  start() {
    this.read();
    fs.watchFile(this.file, { interval: POLL_MS }, (curr, prev) => {
      if (curr.size !== prev.size || curr.mtimeMs !== prev.mtimeMs) this.read();
    });
  }

  stop() {
    fs.unwatchFile(this.file);
  }

  async read() {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      const stat = await fsp.stat(this.file);
      if (stat.size < this.offset) { this.offset = 0; this.remainder = ''; } // truncated/rewritten
      while (this.offset < stat.size) {
        const fh = await fsp.open(this.file, 'r');
        try {
          const len = Math.min(stat.size - this.offset, 4 * 1024 * 1024);
          const buf = Buffer.alloc(len);
          const { bytesRead } = await fh.read(buf, 0, len, this.offset);
          if (bytesRead <= 0) break;
          this.offset += bytesRead;
          const chunk = this.remainder + buf.toString('utf8', 0, bytesRead);
          const lines = chunk.split('\n');
          this.remainder = lines.pop() ?? '';
          for (const line of lines) {
            const evt = parseLine(line);
            if (evt) this.onLine(evt);
          }
        } finally {
          await fh.close();
        }
      }
    } catch {
      // File may be mid-rotation or briefly locked; next poll retries.
    } finally {
      this.busy = false;
      if (this.again) { this.again = false; this.read(); }
    }
  }
}

export class SessionWatcher {
  /**
   * @param {string} root       projects directory to scan
   * @param {(sessionId: string, evt: object) => void} onEvent
   * @param {number} backfillHours  only sessions modified within this window are loaded
   */
  constructor(root, onEvent, backfillHours = 48) {
    this.root = root;
    this.onEvent = onEvent;
    this.backfillHours = backfillHours;
    this.tailers = new Map(); // file path -> Tailer
  }

  async start() {
    await this.scan();
    this.rescanTimer = setInterval(() => this.scan().catch(() => {}), RESCAN_MS);
  }

  stop() {
    clearInterval(this.rescanTimer);
    for (const t of this.tailers.values()) t.stop();
    this.tailers.clear();
  }

  async scan() {
    const cutoff = Date.now() - this.backfillHours * 3600 * 1000;
    let projectDirs = [];
    try {
      projectDirs = await fsp.readdir(this.root, { withFileTypes: true });
    } catch {
      return; // no projects dir yet
    }
    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(this.root, dir.name);
      let files = [];
      try {
        files = await fsp.readdir(dirPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const f of files) {
        // Subagent transcripts live in per-session subdirectories — phase 3.
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        const filePath = path.join(dirPath, f.name);
        if (this.tailers.has(filePath)) continue;
        let stat;
        try {
          stat = await fsp.stat(filePath);
        } catch {
          continue;
        }
        if (stat.mtimeMs < cutoff) continue;
        const sessionId = f.name.slice(0, -'.jsonl'.length);
        const tailer = new Tailer(filePath, (evt) => this.onEvent(sessionId, evt));
        this.tailers.set(filePath, tailer);
        tailer.start();
      }
    }
  }
}
