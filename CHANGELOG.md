# Changelog

Notable changes to Tokenscope. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow [SemVer](https://semver.org).

## [0.7.0] — 2026-08-23

### Added

- **Knowledge graph.** A per-project graph built from static import
  structure (folder or file granularity; string-level extraction, tsconfig
  baseUrl/paths aware, zero dependencies), with docs linked to the code
  they cover — static `mentions` edges plus behavioral `observed` edges
  from real sessions — and measured usage overlaid on nodes. Saved to
  `<project>\.claude\context\graph.json` with a git-staleness stamp; a
  token-budgeted `codemap.md` orientation doc renders from the same
  artifact. Endpoints: `GET`/`POST /api/graph`, `POST /api/graph/codemap`.
- **Graph page.** A dedicated dashboard page rendering the graph with
  Cytoscape: dependencies flow top → bottom, docs sit beside the code they
  cover, hover isolates a neighborhood, a search box shows matches plus
  their import neighbors, and modules sessions actually read get an amber
  halo and size boost scaled by measured tokens. A build panel drives
  builds with a live phase-by-phase progress bar
  (`GET /api/graph/progress`); very large graphs fall back to a fast
  banded layout.
- **Graph query surface for Claude.** The `graph-nav` skill answers
  structure questions from the built graph instead of grep fan-outs:
  `impact` (transitive blast radius), `deps`, `path` (shortest import
  chain), `hot` (usage-ranked modules), doc routing, and a codemap
  `overview` — each a ~15-line, staleness-stamped answer via
  `GET /api/graph/query` or the offline CLI
  (`node src/graph.js <mode> <project> …`). Content search explicitly
  stays grep's job.
- **Homepage.** The new landing page: live-updating stat tiles (live
  sessions, sessions/tokens/cost in the 48h window, today's spend from
  rollups, 5h/7d rate-limit fill), cards linking into live sessions, and
  quick links to every page. The sidebar brand returns to it from
  anywhere.
- **Sessions page.** Sessions moved out of the sidebar onto their own
  page: a card grid with live dot, context-fill bar (warns amber past
  75%, red past 90%), model, cost, agent and compaction counts.
- **Guide page.** A built-in reference documenting how every feature
  works, one collapsible section per feature.

### Changed

- Sidebar reworked into an always-visible icon rail (expands on hover or
  keyboard focus) with pages for home, sessions, map, graph, trends, mcp,
  docs, and guide; the codebase map and knowledge graph split into
  separate pages, both full-width.
- Buttons redesigned app-wide: one recipe with a clear hierarchy —
  secondary buttons brighter, primary actions (context file, generate
  plan, build graph, live) always lit in accent and filling solid on
  hover; active chips and nav items marked in solid accent.
- Motion pass: pages fade up on navigation, staggered entrances gated to
  view opens (never replayed by live SSE re-renders), the context gauge
  glides between compositions via persistent segments, live dots pulse,
  collapsible sections and timeline turns ease open/closed (grid-rows
  technique; turns now toggle in place, preserving scroll), map bubbles
  pop in, trend columns grow from the baseline. A `prefers-reduced-motion`
  block collapses it all.

### Fixed

- A completed session-detail prefetch no longer paints the session
  overview over whichever page is open (first-load homepage bug).
- The `hidden` attribute now always wins over class-level `display`
  rules — previously a flex/grid class could keep "hidden" elements
  visible (stuck build-progress bar, section collapse).
- Collapsed timeline turns with long prompts no longer widen the grid
  track and overflow into the right column.

## [0.6.0] — 2026-08-18

### Added

- **Context-file generation.** A `context file` button in the session
  header has the locally installed `claude` CLI (headless `claude -p`,
  billed to the user's own account) turn a digest of the whole session —
  prompts in order, heaviest actions, files edited/read, docs, subagents,
  compaction summaries — into a handoff document, saved under the
  project's `.claude\context\session-<id>-<stamp>.md`. One generation per
  session at a time; 5-minute timeout; errors surface in the header, and
  a `cancel` button kills the running CLI (full process tree). Endpoints:
  `POST` / `DELETE /api/session/:id/context-file`.
- **Optimize-plan generation.** A `generate plan` button atop the Optimize
  panel feeds every finding — plus supporting facts (base files, unused
  skills, most-read files, cache waste, compactions) — to the same local
  CLI flow, producing a prioritized action plan (exact file edits, docs to
  write, skills to package, expected savings from the measured numbers)
  saved as `.claude\context\optimize-plan-<id>-<stamp>.md`. Shares the
  one-at-a-time/cancel machinery. Endpoints: `POST` / `DELETE
  /api/session/:id/optimize-plan`.

### Changed

- Action labels and turn prompts now wrap to multiple lines instead of
  truncating with an ellipsis — collapsed turns keep a compact one-line
  header, expanding reveals the full prompt. Capture caps raised to
  match: commands and agent prompts to 2000 chars (was 200/120), turn
  prompts to 2000 (was 240), Grep patterns to 400, agent descriptions
  to 300.
- The live action feed (real-time hook events) moved from the meta line
  into the title row, next to the session name and live dot.
- Slim theme-matched scrollbars everywhere (floating pill thumb;
  Firefox fallback via `scrollbar-color`).
- The sidebar header (brand + tab row) no longer scrolls — only the
  session list does — and the drawer's right padding widened so the
  list's scrollbar stays hidden while the drawer is collapsed.

## [0.5.0] — 2026-08-18

### Added

- **Context timeline scrubber.** A stacked-area strip under the gauge
  charts context size and composition across the whole session (one
  snapshot per API call, downsampled to ≤300 points). Click or drag to
  scrub — the gauge, legend, and counter time-travel to that moment
  (`⏱ 12:34:56` prefix); compactions appear as dashed ticks on the
  strip; `⏵ live` returns to the present. The scrubber and the
  per-action timeline are linked both ways: clicking an action's
  timestamp scrubs the gauge to that moment, and the scrubber marks the
  action call its position corresponds to — a dashed highlight on the
  row, the action's label in a chip on the strip, and (when a scrub
  ends) the row's turn expanded and scrolled into view. Hand-rolled SVG,
  zero dependencies.

- **Codebase map.** A `map` button opens a draggable bubble map per
  project: circle area = tokens spent reading that file, aggregated
  across every loaded session and agent (all Reads — code and docs —
  plus auto-injected nested CLAUDE.md; harness-internal spill files
  excluded). Bubbles cluster and color by top-level directory via a
  hand-rolled force simulation (anchor attraction + pairwise collision)
  — drag any bubble to rearrange, dropping pins it in place while the
  flock packs around it, double-click unpins. Only the ~90 largest files
  get their own bubble (the rest merge into one tail bubble per
  directory, keeping the simulation calm), and clicking a bubble opens
  its details in a side panel — path, tokens, share of project, reads,
  sessions, agent involvement; tail bubbles list their merged files.
  Name/token labels on larger bubbles, a directory legend and project
  selector below. Still zero dependencies. Served by `/api/filemap`.

## [0.4.0] — 2026-08-18

### Added

- **Cache economics.** A per-session ledger of the prompt cache, measured
  from usage and priced at list rates (`src/pricing.js`): hit ratio,
  reads (0.1×) vs writes with the 5m/1h TTL split from usage (1.25×/2×),
  dollars saved by caching vs the write premium paid, and the priced cost
  of idle-gap re-writes — which also now appears on the recache Optimize
  card. Cache fields join the rollup records, and the trends page totals
  saved/premium/hit-ratio across all rolled-up sessions. Models without a
  known list price fall back to token-only figures.

- **Rollup history & trends.** Compact per-session summaries (tokens,
  cost, base size, model, compactions, agent burn, output split) are
  appended to `~\.tokenscope\rollups.jsonl` — latest snapshot per session
  wins, the file is compacted on boot, and history accrues from install
  on, outliving the live tail window. A `trends` button opens the new
  page: tokens/cost per day (stacked input/output columns), average base
  context per session over time, and per-project / per-model totals —
  hand-rolled charts, still zero dependencies. `--data <dir>` overrides
  the rollup location.

### Changed

- The `trends` / `mcp` / `docs` buttons moved out of the brand row onto
  their own tab row in the sidebar, stretched evenly across its width.

## [0.3.0] — 2026-08-18

### Added

- **MCP server & skill cost attribution.** A new "MCP & skills" panel
  makes the standing tool surface visible:
  - the skill listing is parsed per skill and its measured injection cost
    prorated per entry — every session's price for each skill's presence;
  - skill invocations are counted from Skill tool calls and slash
    commands (results priced from usage); skills never used in the window
    are totaled, with the honest caveat that only invocations are
    observable;
  - MCP servers merge the configured roster (project `.mcp.json` and
    `~\.claude.json`, global and per-project) with observed
    `mcp__server__tool` calls — per-server call counts, result tokens,
    tools used, and a "configured · never called" dead-weight flag;
  - ToolSearch loads of deferred tool schemas are counted and priced;
  - an Optimize finding fires when a meaningful share of the listing
    belongs to never-used skills.
- Subagent MCP calls, skill uses, and ToolSearch loads merge into the
  parent session's panel.
- **MCP & skills across sessions** — an `mcp` button (next to `docs`)
  opens a cross-session report: per-server calls, tokens, and session
  counts; per-skill uses and listing shares; and the dead-weight cohorts
  "configured · never called" and "paid in the listing · never used"
  aggregated over every loaded session.
- **Agent ROI.** Each subagent is matched to the Agent/Task call that
  spawned it (join: the agent transcript's first prompt equals the call's
  `input.prompt`, tie-broken by end-time proximity) and shows what its
  result cost in the parent context next to what it burned in its own
  window — per-agent "returned · N:1 compression" in the Agents panel, a
  session-wide burned → returned total, and an Optimize finding when an
  agent returns ≥5k tokens instead of conclusions (clickable to its call
  in the timeline).
- **Output-side breakdown.** Session output tokens split into thinking,
  visible text, and tool-call payloads — as sub-rows in Session totals and
  in the output segment's gauge/legend tooltip. Text and tool-call sizes
  are measured from assistant content blocks (deduplicated by line uuid,
  since session resumes re-append old lines); thinking is the remainder of
  measured output tokens, as transcripts persist only thinking signatures.
  Every tool call in the timeline (session and agent) additionally shows
  `~X out` — the output spent issuing it: its payload estimate plus an
  even share of its API message's thinking remainder.

### Changed

- The expandable-row helper is shared by the base-context, compaction,
  and MCP & skills panels instead of being duplicated per panel.

## [0.2.0] — 2026-08-18

### Added

- **Compaction tracking.** Compaction boundaries are parsed from the
  transcript (`compact_boundary` + the flagged continuation summary) and
  surfaced everywhere they matter:
  - context size before → after, tokens of history dropped, trigger
    (auto/manual), and duration per event, deduplicated across session
    resumes;
  - what each compaction *cost*, measured from usage: the continuation
    summary plus the rebuilt context re-paid as fresh input;
  - markers in the timeline at each boundary, with the continuation
    summary shown as its own ⟲ turn;
  - a Compaction panel itemizing every event;
  - a "≈ N turns to a full window" forecast under the gauge, from the
    median per-turn burn rate of recent turns;
  - an Optimize finding when a session compacts repeatedly;
  - a ⟲ count in the sidebar session list.
- `TOKENSCOPE_HOURS` environment variable to override the backfill window
  when the collector is booted by the SessionStart hook.

### Changed

- The sidebar is now a hover drawer: collapsed to a thin rail so the
  session view gets the full window width, sliding open on hover or
  keyboard focus with a short close delay.
- Every right-column section (Base context, Optimize, Compaction, Docs
  leaderboard, Agents, Session totals) is collapsible from its header;
  choices persist across reloads. Cross-links reopen a closed section
  before jumping into it.

### Fixed

- The post-compaction context rewrite is now booked to its compaction
  event instead of being misattributed to the recache bucket (which
  inflated the recache total and its Optimize finding).

## [0.1.0] — 2026-08-17

Initial release.

- Collector that tails Claude Code session transcripts and settles each
  API call's fresh tokens against the material inserted since the
  previous call — exact per-turn, close per-action costs.
- Context gauge with composition (base, conversation, docs, code,
  search, agents, tool output, attachments, output, recache).
- Per-action timeline grouped into collapsible turns, with timestamps
  and execution durations.
- Base-context panel: disk-scanned CLAUDE.md with recursive `@`-imports,
  rules, auto-memory, system-prompt remainder, plus harness injections
  measured from usage.
- Optimize suggestions computed from actual token spend (expensive
  searches, re-read files, fat docs, heavy injections, always-loaded
  base files, idle-gap recaches, repeated commands), cross-linked with
  the timeline.
- Docs leaderboard per session and a cross-session docs report with a
  "loaded every session · never read or edited" dead-weight section.
- Subagent tracking: each agent's own context window, model, runtime,
  and tool calls; agent docs reads join the leaderboard.
- Statusline integration (session cost, exact window size, rate limits)
  and optional OpenTelemetry ingest for exact per-request USD cost.
- Claude Code plugin packaging: marketplace manifest, SessionStart
  auto-boot hook, real-time event hooks, `/tokenscope:dashboard` skill.

[0.7.0]: https://github.com/MatijaPojatar/Tokenscope/releases/tag/v0.7.0
[0.6.0]: https://github.com/MatijaPojatar/Tokenscope/releases/tag/v0.6.0
[0.5.0]: https://github.com/MatijaPojatar/Tokenscope/releases/tag/v0.5.0
[0.4.0]: https://github.com/MatijaPojatar/Tokenscope/releases/tag/v0.4.0
[0.3.0]: https://github.com/MatijaPojatar/Tokenscope/releases/tag/v0.3.0
[0.2.0]: https://github.com/MatijaPojatar/Tokenscope/releases/tag/v0.2.0
[0.1.0]: https://github.com/MatijaPojatar/Tokenscope/releases/tag/v0.1.0
