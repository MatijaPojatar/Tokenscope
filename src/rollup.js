// Persistent per-session rollups. One JSONL file of compact session
// summaries, append-only; the last record per session id wins. This is
// what survives after a session leaves the live tail window, so trends
// can span weeks without re-parsing old transcripts.
//
// The file is compacted on boot when it holds many superseded snapshots.
// Concurrent instances sharing one file are tolerated (appends are small
// and line-atomic in practice) but not coordinated — point secondary
// instances at their own --data dir.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const pad = (n) => String(n).padStart(2, '0');

// Local calendar day of an ISO timestamp — the collector runs on the
// user's machine, so local days are the honest bucketing.
function localDay(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (isNaN(d)) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export class RollupStore {
  constructor(file) {
    this.file = file;
    this.latest = new Map(); // session id -> latest record
    this.lastSig = new Map(); // session id -> signature of last appended record
  }

  async load() {
    let lines = 0;
    try {
      const text = await fsp.readFile(this.file, 'utf8');
      for (const line of text.split('\n')) {
        if (line.length < 2) continue;
        lines += 1;
        try {
          const r = JSON.parse(line);
          if (r && r.id) this.latest.set(r.id, r);
        } catch { /* torn line from a crashed append — skip */ }
      }
    } catch {
      return; // no rollup file yet
    }
    if (lines > 2000 && lines > this.latest.size * 3) {
      try {
        const tmp = this.file + '.tmp';
        await fsp.writeFile(tmp,
          [...this.latest.values()].map((r) => JSON.stringify(r)).join('\n') + '\n');
        await fsp.rename(tmp, this.file);
      } catch { /* compaction is opportunistic */ }
    }
  }

  // Append a session snapshot unless nothing rollup-relevant changed.
  record(r) {
    if (!r || !r.id || !r.last) return;
    const sig = `${r.fresh}|${r.output}|${r.costUsd}|${r.last}`;
    if (this.lastSig.get(r.id) === sig) return;
    this.lastSig.set(r.id, sig);
    this.latest.set(r.id, r);
    fs.appendFile(this.file, JSON.stringify(r) + '\n', () => {});
  }

  // Aggregated history: per-day, per-project, per-model. `live` records
  // (current in-memory sessions) override their stored snapshots.
  history(live = []) {
    const map = new Map(this.latest);
    for (const r of live) if (r && r.id && r.last) map.set(r.id, r);

    const days = new Map();
    const projects = new Map();
    const models = new Map();
    for (const r of map.values()) {
      const day = localDay(r.last);
      if (!day) continue;
      const d = days.get(day) ||
        { date: day, sessions: 0, fresh: 0, output: 0, costUsd: 0, costSessions: 0, baseSum: 0, baseSessions: 0, compactions: 0 };
      d.sessions += 1;
      d.fresh += r.fresh || 0;
      d.output += r.output || 0;
      if (typeof r.costUsd === 'number') { d.costUsd += r.costUsd; d.costSessions += 1; }
      if (r.base > 0) { d.baseSum += r.base; d.baseSessions += 1; }
      d.compactions += r.compactions || 0;
      days.set(day, d);

      const pKey = (r.cwd || '(unknown)').toLowerCase();
      const p = projects.get(pKey) ||
        { cwd: r.cwd || '(unknown)', sessions: 0, fresh: 0, output: 0, costUsd: 0, last: null };
      p.sessions += 1;
      p.fresh += r.fresh || 0;
      p.output += r.output || 0;
      if (typeof r.costUsd === 'number') p.costUsd += r.costUsd;
      if (r.last && (!p.last || r.last > p.last)) p.last = r.last;
      projects.set(pKey, p);

      const mKey = r.model || '(unknown)';
      const m = models.get(mKey) || { model: mKey, sessions: 0, fresh: 0, output: 0, costUsd: 0 };
      m.sessions += 1;
      m.fresh += r.fresh || 0;
      m.output += r.output || 0;
      if (typeof r.costUsd === 'number') m.costUsd += r.costUsd;
      models.set(mKey, m);
    }

    // Continuous day axis (gaps as zero days), capped to the last 60.
    const sorted = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
    let filled = [];
    if (sorted.length > 0) {
      const cur = new Date(sorted[0].date + 'T00:00:00');
      const end = new Date(sorted[sorted.length - 1].date + 'T00:00:00');
      while (cur <= end) {
        const key = `${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}`;
        filled.push(days.get(key) ||
          { date: key, sessions: 0, fresh: 0, output: 0, costUsd: 0, costSessions: 0, baseSum: 0, baseSessions: 0, compactions: 0 });
        cur.setDate(cur.getDate() + 1);
      }
      filled = filled.slice(-60);
    }
    for (const d of filled) {
      d.baseAvg = d.baseSessions > 0 ? Math.round(d.baseSum / d.baseSessions) : 0;
      delete d.baseSum;
      delete d.baseSessions;
    }

    return {
      totalSessions: map.size,
      days: filled,
      projects: [...projects.values()]
        .sort((a, b) => (b.fresh + b.output) - (a.fresh + a.output)).slice(0, 20),
      models: [...models.values()]
        .sort((a, b) => (b.fresh + b.output) - (a.fresh + a.output)),
    };
  }
}

export const defaultDataDir = () =>
  path.join(process.env.USERPROFILE || process.env.HOME || '.', '.tokenscope');
