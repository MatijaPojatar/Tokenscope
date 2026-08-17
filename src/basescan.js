// Base-context disk scan: the files Claude Code loads into a session's base
// context live on disk, so we can list and size them per project even though
// the transcript reports the base only as one lump. CLAUDE.md files can
// @-import other files (which then load with them), so imports are followed
// recursively. Sizes are estimates; the system prompt and tool schemas stay
// a remainder.

import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Claude Code's project-dir naming: non-alphanumerics become '-'.
const sanitize = (p) => String(p).replace(/[^A-Za-z0-9]/g, '-');

// @path references in CLAUDE.md. False positives (emails, @scoped/packages)
// resolve to nonexistent files and are dropped by the existence check.
const IMPORT_RE = /(?:^|\s)@([^\s`'"<>()[\]]+)/g;

async function collect(out, label, p, cwd, depth, seen) {
  const norm = path.resolve(p);
  const key = norm.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  let st, text;
  try {
    st = await fsp.stat(norm);
    if (!st.isFile()) return;
    text = await fsp.readFile(norm, 'utf8');
  } catch {
    return;
  }
  out.push({
    label,
    path: norm,
    chars: text.length,
    lines: text.split('\n').length,
    mtime: st.mtimeMs,
  });
  if (depth >= 3 || !/\.(md|mdx)$/i.test(norm)) return;
  const dir = path.dirname(norm);
  for (const m of text.matchAll(IMPORT_RE)) {
    let target = m[1];
    if (target.startsWith('~')) target = path.join(os.homedir(), target.slice(1));
    else if (!path.isAbsolute(target)) target = path.join(dir, target);
    const rel = path.relative(cwd, target);
    const shown = rel.startsWith('..') ? target : rel;
    await collect(out, `↳ ${shown}`, target, cwd, depth + 1, seen);
  }
}

export async function scanBaseContext(cwd) {
  const home = os.homedir();
  const out = [];
  const seen = new Set();

  await collect(out, 'CLAUDE.md (project)', path.join(cwd, 'CLAUDE.md'), cwd, 0, seen);
  await collect(out, '.claude\\CLAUDE.md (project)', path.join(cwd, '.claude', 'CLAUDE.md'), cwd, 0, seen);
  await collect(out, 'CLAUDE.md (user)', path.join(home, '.claude', 'CLAUDE.md'), home, 0, seen);
  await collect(out, 'MEMORY.md (auto-memory)',
    path.join(home, '.claude', 'projects', sanitize(cwd), 'memory', 'MEMORY.md'), cwd, 3, seen);

  const rulesDir = path.join(cwd, '.claude', 'rules');
  try {
    const entries = await fsp.readdir(rulesDir, { recursive: true, withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.md')) {
        await collect(out, `.claude\\rules\\${e.name}`,
          path.join(e.parentPath || rulesDir, e.name), cwd, 2, seen);
      }
    }
  } catch { /* no rules dir */ }

  return out;
}
