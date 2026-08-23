import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveNode, reachFrom, pathBetween, hotNodes, docsFor, answer,
} from '../src/graph.js';

// a → b → c ← d, e isolated; one package edge and two doc edges
const mkGraph = () => ({
  meta: { root: '/proj', granularity: 'file', builtAt: '2026-08-22T00:00:00.000Z' },
  nodes: [
    { id: 'src/a.js', kind: 'file', tokensRead: 900, reads: 2 },
    { id: 'src/b.js', kind: 'file', tokensRead: 40000, reads: 9 },
    { id: 'src/c.js', kind: 'file' },
    { id: 'src/d.js', kind: 'file', tokensRead: 1200, reads: 1 },
    { id: 'src/e.js', kind: 'file' },
    { id: 'pkg:react', kind: 'external' },
    { id: 'docs/b-notes.md', kind: 'doc' },
  ],
  edges: [
    { from: 'src/a.js', to: 'src/b.js', kind: 'imports', weight: 2 },
    { from: 'src/b.js', to: 'src/c.js', kind: 'imports', weight: 1 },
    { from: 'src/d.js', to: 'src/c.js', kind: 'imports', weight: 3 },
    { from: 'src/a.js', to: 'pkg:react', kind: 'imports', weight: 1 },
    { from: 'docs/b-notes.md', to: 'src/b.js', kind: 'mentions', weight: 1 },
    { from: 'docs/b-notes.md', to: 'src/b.js', kind: 'observed', weight: 2, sessions: 2 },
  ],
});

test('resolveNode: exact beats suffix beats substring; candidates surface ambiguity', () => {
  const g = mkGraph();
  assert.equal(resolveNode(g, 'src/b.js').node.id, 'src/b.js');
  assert.equal(resolveNode(g, 'b.js').node.id, 'src/b.js');
  assert.equal(resolveNode(g, 'B.JS').node.id, 'src/b.js'); // case-insensitive
  assert.equal(resolveNode(g, 'src\\c.js').node.id, 'src/c.js'); // backslashes tolerated
  const many = resolveNode(g, 'src');
  assert.ok(many.candidates.length > 1);
  assert.equal(resolveNode(g, 'nothere.ts').node, null);
});

test('reachFrom: importers by depth (blast radius) and dependencies', () => {
  const g = mkGraph();
  // who reaches c through imports: b and d directly, a via b
  assert.deepEqual(reachFrom(g, 'src/c.js', 'in'), [['src/b.js', 'src/d.js'], ['src/a.js']]);
  // what a depends on: b, then c — pkg edges excluded
  assert.deepEqual(reachFrom(g, 'src/a.js', 'out'), [['src/b.js'], ['src/c.js']]);
  assert.deepEqual(reachFrom(g, 'src/e.js', 'in'), []);
});

test('pathBetween: forward, reverse, and disconnected', () => {
  const g = mkGraph();
  assert.deepEqual(pathBetween(g, 'src/a.js', 'src/c.js'),
    { kind: 'forward', chain: ['src/a.js', 'src/b.js', 'src/c.js'] });
  assert.equal(pathBetween(g, 'src/c.js', 'src/a.js').kind, 'reverse');
  // a and d only connect ignoring direction (both reach c)
  assert.equal(pathBetween(g, 'src/a.js', 'src/d.js').kind, 'mixed');
  assert.equal(pathBetween(g, 'src/a.js', 'src/e.js'), null);
});

test('hotNodes: usage-ranked, zero-usage nodes dropped', () => {
  const ids = hotNodes(mkGraph()).map((n) => n.id);
  assert.deepEqual(ids, ['src/b.js', 'src/d.js', 'src/a.js']);
});

test('docsFor: observed evidence sorts before mentions', () => {
  const kinds = docsFor(mkGraph(), 'src/b.js').map((e) => e.kind);
  assert.deepEqual(kinds, ['observed', 'mentions']);
});

test('answer: impact names the blast radius and linked docs', () => {
  const out = answer(mkGraph(), 'impact', 'c.js').join('\n');
  assert.match(out, /src\/c\.js/);
  assert.match(out, /imported by \(direct\): src\/b\.js, src\/d\.js/);
  assert.match(out, /then transitively: src\/a\.js/);
  assert.match(out, /blast radius: 3 module\(s\)/);
});

test('answer: deps lists internal imports and packages', () => {
  const out = answer(mkGraph(), 'deps', 'a.js').join('\n');
  assert.match(out, /imports \(direct\): src\/b\.js/);
  assert.match(out, /then transitively: src\/c\.js/);
  assert.match(out, /packages: react/);
});

test('answer: path renders the chain; hot ranks by usage; misses stay calm', () => {
  const g = mkGraph();
  assert.match(answer(g, 'path', 'a.js', 'c.js').join('\n'),
    /src\/a\.js → src\/b\.js → src\/c\.js/);
  assert.match(answer(g, 'hot').join('\n'), /^src\/b\.js — ~40k tok read/);
  assert.match(answer(g, 'impact', 'zzz').join('\n'), /no node matches "zzz"/);
  assert.match(answer(g, 'impact', 'e.js').join('\n'), /nothing internal/);
});

test('answer: query mode reports imports, importers, packages, and docs', () => {
  const out = answer(mkGraph(), 'query', 'b.js').join('\n');
  assert.match(out, /imports → src\/c\.js \(1\)/);
  assert.match(out, /imported by ← src\/a\.js \(2\)/);
  assert.match(out, /docs: docs\/b-notes\.md \(observed, 2 sess\)/);
});
