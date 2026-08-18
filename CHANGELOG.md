# Changelog

Notable changes to Tokenscope. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow [SemVer](https://semver.org).

## [Unreleased]

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
- **MCP & skills across sessions** — an `mcp` button (next to `docs`)
  opens a cross-session report: per-server calls, tokens, and session
  counts; per-skill uses and listing shares; and the dead-weight cohorts
  "configured · never called" and "paid in the listing · never used"
  aggregated over every loaded session.

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

[0.2.0]: https://github.com/MatijaPojatar/Tokenscope/releases/tag/v0.2.0
[0.1.0]: https://github.com/MatijaPojatar/Tokenscope/releases/tag/v0.1.0
