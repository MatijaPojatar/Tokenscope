import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { overlayUsage, linkDocs, extractPathCandidates } from '../src/graph.js';
import { renderCodemap } from '../src/codemap.js';

const root = path.resolve('/proj');
const F = (p) => path.join(root, ...p.split('/'));

const mkGraph = () => ({
  meta: {
    root, granularity: 'folder', builtAt: '2026-08-21T00:00:00.000Z',
    gitHead: 'abcd1234ef', filesScanned: 10,
  },
  nodes: [
    { id: '.', kind: 'folder', files: 1 },
    { id: 'src', kind: 'folder', files: 5 },
    { id: 'src/components', kind: 'folder', files: 4 },
    { id: 'pkg:react', kind: 'external' },
  ],
  edges: [
    { from: 'src/components', to: 'src', kind: 'imports', weight: 7 },
    { from: 'src/components', to: 'pkg:react', kind: 'imports', weight: 4 },
  ],
});

test('overlayUsage: rolls file reads up to the nearest surviving folder', () => {
  const g = overlayUsage(mkGraph(), [{
    cwd: root,
    sessions: 3,
    files: [
      { path: F('src/components/deep/Btn.tsx'), tokens: 500, reads: 2 },
      { path: F('src/util.ts'), tokens: 100, reads: 1 },
      { path: path.resolve('/elsewhere/x.ts'), tokens: 9, reads: 1 }, // outside root
    ],
  }]);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get('src/components').tokensRead, 500);
  assert.equal(byId.get('src').tokensRead, 100);
  assert.equal(byId.get('.').tokensRead, undefined);
  assert.equal(g.meta.usage.sessions, 3);
});

test('overlayUsage: no matching project leaves the graph untouched', () => {
  const g = overlayUsage(mkGraph(), [{ cwd: path.resolve('/other'), sessions: 1, files: [] }]);
  assert.equal(g.meta.usage, undefined);
});

test('extractPathCandidates: backticks, bare paths, no URLs', () => {
  const got = new Set(extractPathCandidates(
    'See `src/components` and @.claude/arch.md plus https://x.com/y and `npm run dev`.'));
  assert.ok(got.has('src/components'));
  assert.ok(got.has('.claude/arch.md'));
  assert.ok(![...got].some((c) => c.includes('x.com')), 'URL leaked: ' + [...got]);
});

test('linkDocs: mentions resolve to folders and other docs, junk drops', () => {
  const g = linkDocs(mkGraph(), [
    { path: F('CLAUDE.md'), text: 'See `src/components` and @.claude/arch.md and/or nothing.' },
    { path: F('.claude/arch.md'), text: 'Details on src/components/Btn.tsx here.' },
  ]);
  const kinds = g.edges.filter((e) => e.kind === 'mentions')
    .map((e) => `${e.from} -> ${e.to}`).sort();
  assert.deepEqual(kinds, [
    '.claude/arch.md -> src/components', // file mention lands on its folder
    'CLAUDE.md -> .claude/arch.md',      // doc -> doc
    'CLAUDE.md -> src/components',
  ]);
  assert.ok(g.nodes.some((n) => n.kind === 'doc' && n.id === 'CLAUDE.md'));
  // 'and/or' resolves to nothing and must not create a root edge
  assert.ok(!g.edges.some((e) => e.to === '.'), 'junk mention landed on root');
});

test('linkDocs: observed edges need 2 sessions or heavy overlap', () => {
  const doc = { path: F('.claude/arch.md'), text: '' };
  const sess = (tok) => ({
    docs: [{ path: F('.claude/arch.md'), tokens: 200 }],
    files: [{ path: F('src/components/A.tsx'), tokens: tok }],
  });
  // two sessions -> kept, weight = session count
  const g2 = linkDocs(mkGraph(), [doc], [sess(5000), sess(3000)]);
  const e2 = g2.edges.find((e) => e.kind === 'observed');
  assert.ok(e2, 'two-session edge missing');
  assert.equal(e2.weight, 2);
  assert.equal(e2.tokens, 8000);
  // one light session -> dropped
  const g1 = linkDocs(mkGraph(), [doc], [sess(5000)]);
  assert.ok(!g1.edges.some((e) => e.kind === 'observed'));
  // one heavy session -> kept via the token threshold
  const gh = linkDocs(mkGraph(), [doc], [sess(15000)]);
  assert.ok(gh.edges.some((e) => e.kind === 'observed'));
});

test('renderCodemap: sections render and the budget trims', () => {
  let g = mkGraph();
  g = overlayUsage(g, [{ cwd: root, sessions: 2, files: [{ path: F('src/components/A.tsx'), tokens: 1500, reads: 1 }] }]);
  g = linkDocs(g, [{ path: F('.claude/arch.md'), text: 'about `src/components`' }]);
  const { text, tokens } = renderCodemap(g, { tokenBudget: 2000 });
  assert.ok(text.includes('## Modules'));
  assert.ok(text.includes('**src/components**'));
  assert.ok(text.includes('~2k tok read') || text.includes('1500'), 'usage missing: ' + text);
  assert.ok(text.includes('react'));
  assert.ok(text.includes('Docs routing'));
  assert.ok(text.includes('.claude/arch.md'));
  assert.ok(tokens <= 2000);
  // a huge synthetic graph must trim, and say so
  const big = mkGraph();
  for (let i = 0; i < 200; i += 1) {
    big.nodes.push({ id: `mod${i}`, kind: 'folder', files: i + 1 });
    big.edges.push({ from: `mod${i}`, to: 'src', kind: 'imports', weight: 1 });
  }
  const r = renderCodemap(big, { tokenBudget: 500 });
  assert.ok(r.text.includes('trimmed to fit'), 'no trim note');
});
