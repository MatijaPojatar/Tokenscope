import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractImports, makeResolver, collapseFolders, readTsconfig } from '../src/graph.js';

test('extractImports: all import forms, comments stripped', () => {
  const text = `
import React from 'react';
import { a, b as c } from './util';
import * as ns from "../lib/ns";
import './side-effect';
import type { T } from 'types-pkg';
import {
  multi,
  line,
} from './multi';
export { x } from './re';
export * from '@scope/pkg';
const d = require('legacy');
const lazy = () => import('./lazy');
// import ignored from 'commented';
/* import alsoIgnored from 'block'; */
const url = 'http://example.com'; // trailing comment survives the string
import styles from './foo.module.scss';
`;
  const got = new Set(extractImports(text));
  for (const want of ['react', './util', '../lib/ns', './side-effect', 'types-pkg',
    './multi', './re', '@scope/pkg', 'legacy', './lazy', './foo.module.scss']) {
    assert.ok(got.has(want), `missing ${want}`);
  }
  assert.ok(!got.has('commented'), 'line comment not stripped');
  assert.ok(!got.has('block'), 'block comment not stripped');
});

test('extractImports: export const from is not an import', () => {
  const got = extractImports(`export const from = 'nope'; const x = 1;`);
  assert.deepEqual(got, []);
});

// Regression: '/*' inside a glob string must not pair with '*/' in a later
// string and swallow the code between them.
test('extractImports: glob strings do not open comments', () => {
  const text = `
const a = 'src/**/*.js';
import real from './real';
const b = 'test/**/*.js';
`;
  assert.ok(new Set(extractImports(text)).has('./real'));
});

test('readTsconfig: JSONC with comments, trailing commas, glob paths', async () => {
  const file = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenscope-')), 'tsconfig.json');
  await fsp.writeFile(file, `{
  // line comment
  "compilerOptions": {
    "lib": [
      "dom",
      "ESNext",
    ],
    "baseUrl": "./src", /* block comment */
    "paths": {
      "config/*": ["config/*"]
    }
  },
  "exclude": ["node_modules/**/*", "build/**/*"]
}
`);
  const cfg = await readTsconfig(file);
  assert.ok(cfg, 'config parsed');
  assert.equal(cfg.baseUrl, path.join(path.dirname(file), 'src'));
  assert.equal(cfg.paths.length, 1);
  assert.equal(cfg.paths[0].prefix, 'config/');
});

const root = path.resolve('/proj');
const F = (p) => path.join(root, ...p.split('/'));
const files = [F('src/app.ts'), F('src/util/index.ts'), F('src/config/keys.ts'), F('src/comp/Btn.tsx')];
const cfg = {
  dir: root,
  baseUrl: F('src'),
  paths: [{ prefix: 'cfg/', exact: false, targets: [F('src/config') + path.sep] }],
};
const resolve = makeResolver(files, [cfg]);

test('resolver: relative to index file', () => {
  assert.deepEqual(resolve(F('src/app.ts'), './util'),
    { kind: 'internal', target: F('src/util/index.ts') });
});

test('resolver: explicit .js specifier finds .ts source', () => {
  assert.deepEqual(resolve(F('src/app.ts'), './util/index.js'),
    { kind: 'internal', target: F('src/util/index.ts') });
});

test('resolver: bare specifier through baseUrl', () => {
  assert.deepEqual(resolve(F('src/app.ts'), 'comp/Btn'),
    { kind: 'internal', target: F('src/comp/Btn.tsx') });
});

test('resolver: tsconfig paths prefix mapping', () => {
  assert.deepEqual(resolve(F('src/app.ts'), 'cfg/keys'),
    { kind: 'internal', target: F('src/config/keys.ts') });
});

test('resolver: bare specifier falls back to external package', () => {
  assert.deepEqual(resolve(F('src/app.ts'), 'react-dom/client'),
    { kind: 'external', target: 'react-dom' });
  assert.deepEqual(resolve(F('src/app.ts'), '@scope/pkg/deep/mod'),
    { kind: 'external', target: '@scope/pkg' });
});

test('resolver: asset imports are ignored, missing relatives unresolved', () => {
  assert.equal(resolve(F('src/app.ts'), './foo.scss').kind, 'ignored');
  assert.equal(resolve(F('src/app.ts'), './logo.svg').kind, 'ignored');
  assert.equal(resolve(F('src/app.ts'), './missing').kind, 'unresolved');
});

test('resolver: bundler query suffix and case-insensitive match', () => {
  assert.equal(resolve(F('src/app.ts'), './util?raw').kind, 'internal');
  assert.equal(resolve(F('src/app.ts'), './UTIL').kind, 'internal');
});

test('collapseFolders: deepest merge up to the node target', () => {
  const folders = new Map([['.', 1], ['a', 2], ['a/b', 3], ['a/b/c', 1], ['d', 5]]);
  const { canon, folders: live } = collapseFolders(folders, 3);
  assert.equal(live.size, 3);
  assert.equal(canon('a/b/c'), 'a');
  assert.equal(canon('a/b'), 'a');
  assert.equal(canon('d'), 'd');
  assert.equal(live.get('a'), 6); // 2 + 3 + 1 rolled up
});

test('collapseFolders: collapses fully to the root when asked', () => {
  const folders = new Map([['a', 1], ['b/c', 2]]);
  const { canon, folders: live } = collapseFolders(folders, 1);
  assert.equal(live.size, 1);
  assert.equal(canon('b/c'), '.');
  assert.equal(canon('a'), '.');
});
