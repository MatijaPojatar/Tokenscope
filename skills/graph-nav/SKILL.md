---
description: Answer codebase structure questions from Tokenscope's knowledge graph instead of searching — what imports a module, blast radius of a change, shortest dependency chain, which docs cover an area, where sessions spend tokens. Use before grep/glob exploration for orientation, impact, dependency, or doc-routing questions. Not for content search (strings, regexes, symbols) — grep stays right for those.
---

# Graph navigation

Tokenscope maintains a per-project knowledge graph (`<project>\.claude\context\graph.json`):
module-level import structure, docs linked to the code they cover, and measured
token usage from real sessions. Querying it answers structure questions in
~15 lines that would otherwise take several grep fan-outs plus file reads.

## When to use it — and when not

Use the graph for **structure** questions:
- orientation: "what's the shape of this repo, where does X live" → `overview`
- blast radius: "what breaks if I change this module" → `impact`
- dependencies: "what does this module pull in" → `deps`
- connection: "how do A and B relate" → `path`
- doc routing: "which doc should I read before touching this" → `query` (docs lines)
- hot spots: "which modules do sessions actually spend tokens reading" → `hot`

Do NOT use it for **content** questions — finding a string, regex, symbol
definition, or error message. Grep is correct there. The graph is
module-level: it cannot answer "what calls this function".

## How to query

Primary path — the Tokenscope collector (always on localhost:4820):

```
curl -s -G "http://localhost:4820/api/graph/query" --data-urlencode "cwd=<absolute project path>" --data-urlencode "mode=<mode>" --data-urlencode "q=<path or name>"
```

Modes (`q` is a path fragment — `src/store`, `store.js`, and backslashes all work):

| mode       | args      | answers                                              |
|------------|-----------|------------------------------------------------------|
| `query`    | `q`       | everything known about matches: imports, importers, packages, docs |
| `impact`   | `q`       | who imports it, direct + transitive (blast radius)   |
| `deps`     | `q`       | what it imports, direct + transitive, plus packages  |
| `path`     | `q`, `b`  | shortest import chain between two modules            |
| `hot`      | —         | modules ranked by measured tokens read               |
| `overview` | —         | codemap-style orientation of the whole project       |

The first output line reports the graph's age. If it says **N commits behind**,
prefer rebuilding before trusting impact/deps answers (see below).

Fallback when the collector isn't running — the CLI. The plugin root is two
levels above this SKILL.md (it contains `src/graph.js`):

```
node "<plugin-root>/src/graph.js" impact <project> src/store.js
node "<plugin-root>/src/graph.js" path <project> src/app.js src/pricing.js
```

## No graph yet, or stale

Build (or rebuild) through the collector — this variant enriches the graph
with measured usage and doc links; a few seconds even on large repos:

```
curl -s -X POST http://localhost:4820/api/graph -H "Content-Type: application/json" -d "{\"cwd\":\"<absolute project path, JSON-escaped>\",\"granularity\":\"folder\"}"
```

Granularity: `folder` (default, compact orientation) or `file` (per-file
nodes — better for impact/path precision on repos you work in daily).
The user can also click **build graph** on the dashboard's graph page.

If the collector is down, `node "<plugin-root>/src/graph.js" <project> --out
"<project>/.claude/context/graph.json"` builds the structural graph, but
without usage weighting and doc links — prefer the POST.

## Reading the output

- `imported by (direct) / then transitively` — every module whose imports
  reach the target; the blast-radius count is the number to quote before a
  refactor.
- `doc: <path> (observed, N sessions)` — real sessions read this doc while
  working in that code; read it first. `(mentions)` means the doc names the
  path but no usage was observed.
- `~Nk tok read` — measured tokens sessions spent reading that module in the
  last 48h window; high numbers mean load-bearing code worth extra care.
- Long lists end with `+n more` — the graph has the full answer; narrow the
  query (or use `query` mode on a specific module) rather than assuming.
