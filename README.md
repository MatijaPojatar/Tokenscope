# Tokenscope

A separate live window for Claude Code that shows what's in your session's
context, what every action costs in tokens, and which of your docs files earn
their keep.

It runs as a local web page next to your terminal and shows, for every session:

- **Context gauge** — how full the context window is and what it's made of
  (base system context, conversation, docs read, code read, search results,
  tool output, assistant output). A scrubber strip below it charts context
  size over the whole session as stacked areas — click or drag to
  time-travel the gauge to any moment (compactions show as dashed ticks),
  `⏵ live` snaps back to now.
- **Per-action cost** — every Read / Grep / Glob / Edit / agent call with the
  tokens it added to context, its timestamp, and its execution duration,
  grouped by prompt into collapsible turns.
- **Base context** — what every session pays at start, itemized: CLAUDE.md
  and the files it `@`-imports (followed recursively from disk), rules,
  MEMORY.md, and the system-prompt remainder — plus a second group for
  context the harness injects during the session (hook output, re-injected
  edited files, skill listings, reminders), measured from usage. Every row
  expands to sizes, dates, injection counts, and observed-use signals.
- **Optimize** — suggestions computed from actual token spend, seven kinds:
  expensive search patterns (→ document the concept), files re-read many
  times (→ summarize or split), fat docs (→ split), heavy harness injections
  (→ trim hook output), always-loaded base files (→ move out of `@`-imports),
  cache re-writes after idle gaps, and repeated commands (→ package as a
  skill or hook). Clicking a finding highlights its calls in the timeline,
  and clicking a flagged call focuses its finding. A `generate plan`
  button turns the findings into a prioritized action plan via your local
  `claude` CLI, saved under the project's `.claude\context\`.
- **Compaction** — every compaction event, measured from the transcript:
  context size before → after, tokens of history dropped, what the summary
  and the context rebuild re-paid, trigger and duration. Boundaries appear
  as markers in the timeline (with the continuation summary as its own ⟲
  turn), a panel itemizes each event, the gauge shows a "≈ N turns to a
  full window" forecast from the recent per-turn burn rate, and repeated
  compaction raises an Optimize finding. The rebuild is booked to its
  compaction, not misread as cache recache.
- **MCP & skills** — what the standing tool surface costs and whether it's
  used. The skill listing is split per skill and priced from measured usage
  (~its share of every session start), with invocation counts from Skill
  calls and slash commands; skills never used are totaled. MCP servers are
  itemized from configured rosters (`.mcp.json`, `~\.claude.json`) merged
  with observed `mcp__server__tool` calls — a configured server with zero
  calls is the flag. ToolSearch loads of deferred tool schemas are measured
  too. A never-used share of the listing raises an Optimize finding, and
  the `mcp` button aggregates servers and skills across every loaded
  session — with "configured · never called" and "paid in the listing ·
  never used" cohorts as the cross-session dead-weight signals.
- **Docs leaderboard** — which `.md` files (project `.claude\` docs and
  auto-injected CLAUDE.md included) were read, how often, and what they
  cost. Each doc expands to every individual use — time, tokens, and the
  prompt or agent it served — with click-to-jump into the timeline. Base
  files with no observed use are flagged separately.
- **Agents** — subagents spawned by a session, each with its own context
  window: model, runtime, tokens, and the full list of its tool calls with
  per-call costs. Agent docs reads join the leaderboard, marked `A`. Each
  agent also shows its ROI: tokens burned in its own window vs. what its
  result added to the parent's context (matched via the spawning call's
  prompt), with a per-session compression total and an Optimize finding
  when an agent returns a fat payload instead of conclusions.
- **Codebase map** — the `map` button renders a draggable bubble map of
  each project: circle area = tokens spent reading that file across every
  loaded session and agent, clustered and colored by top-level directory
  via a small force simulation. Drag bubbles to rearrange (drop pins,
  double-click unpins). Shows at a glance where Claude "lives" in the
  repo and which fat files keep getting re-read. Hand-rolled physics,
  zero dependencies.
- **Docs across sessions** — the `docs` button aggregates every doc read by
  any session or agent in the loaded window, plus a "loaded every session ·
  never read or edited" section: the strongest observable dead-weight signal
  for `@`-imported docs.
- **Output breakdown** — session output split into thinking, visible text,
  and tool-call payloads. Text and tool sizes are measured from content
  blocks; thinking is the remainder of the usage's output tokens, since
  recent transcripts persist only thinking signatures, not the text. Every
  tool call in the timeline also shows `~X out`: what it cost to issue —
  its payload plus an even share of its API message's thinking.
- **Context file** — a `context file` button in the session header pipes a
  digest of the whole session (prompts, heaviest actions, files edited and
  read, docs, subagents, compaction summaries) to your locally installed
  `claude` CLI in headless mode and saves the resulting handoff document
  under the project's `.claude\context\`. Paste or `@`-reference it to
  seed a fresh session. Runs on your machine, billed to your own account.
- **Cost & rate limits** — session USD cost and account rate-limit fill, fed
  by the statusline integration below.
- **Cache economics** — a per-session ledger of the prompt cache, measured
  from usage: hit ratio, tokens read (billed 0.1×) vs written (1.25× at 5m
  TTL, 2× at 1h — the split comes from usage), dollars saved by caching vs
  the write premium paid, and the priced cost of idle-gap re-writes. The
  trends page totals the ledger across all rolled-up sessions. Prices come
  from a small list-price table per model; unknown models fall back to
  token-only figures.
- **Trends** — the `trends` button charts rolled-up history: tokens and
  cost per day, per-project and per-model totals, and average base context
  per session over time. Compact session summaries are appended to
  `~\.tokenscope\rollups.jsonl` (latest snapshot per session wins), so
  history accrues from install on and outlives the live session window —
  still zero dependencies.

Zero dependencies. Node 18+.

## Install

**As a Claude Code plugin** (no clone needed) — the repo is its own
marketplace:

```
/plugin marketplace add MatijaPojatar/Tokenscope
/plugin install tokenscope@tokenscope
```

Run `/reload-plugins` if the install summary asks for it. The plugin ships
a `SessionStart` hook that boots the collector automatically (detached,
first session of the day starts it), real-time event hooks, and a
`/tokenscope:dashboard` skill that starts it on demand and hands you the
URL. Nothing else to configure.

To pre-enable it for a whole team, add to that repo's
`.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "tokenscope": { "source": { "source": "github", "repo": "MatijaPojatar/Tokenscope" } }
  },
  "enabledPlugins": { "tokenscope@tokenscope": true }
}
```

**From a clone** — auto-start by adding a `SessionStart` hook to
`settings.json`:

```json
{ "type": "command", "async": true, "command": "node <path-to-tokenscope>/scripts/ensure.js" }
```

or run it manually:

## Run

```
node src/server.js
```

Open http://localhost:4820. Sessions active in the last 48 hours are loaded
automatically; new activity streams in live.

Options:

```
node src/server.js --port 4820 --hours 48 --root %USERPROFILE%\.claude\projects --data %USERPROFILE%\.tokenscope
```

## How it works

The collector tails Claude Code's session transcripts
(`%USERPROFILE%\.claude\projects\<project>\<session>.jsonl`) and settles each
API call's fresh tokens (`input_tokens + cache_creation_input_tokens`) against
the material inserted since the previous call — the user prompt, tool results,
and injected attachments — prorated by size. `cache_read_input_tokens` is the
already-paid prefix. That yields exact per-turn costs and close per-action
costs without any configuration.

Base-context files are sized by a disk scan of the session's project
(CLAUDE.md with its `@`-imports followed recursively, `.claude\rules`,
auto-memory). One honest limitation: in-context *use* of loaded content is
not logged anywhere — Reads, edits, and load counts are the observable
signals, and the UI says so wherever it matters.

Optionally, Claude Code hooks can POST real-time events to `/event` for
instant "action happening now" signals (see `hooks/settings-snippet.json`).
Tokenscope works without them — hooks only reduce latency.

## Optional integrations

**Statusline** (recommended): session cost, exact context-window size, and
rate limits — plus a useful status line in the terminal itself:

```json
"statusLine": {
  "type": "command",
  "command": "node <path-to-tokenscope>/statusline/statusline.js"
}
```

**OpenTelemetry** (exact per-request USD cost): add to `env` in settings.json —
`CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp`,
`OTEL_EXPORTER_OTLP_PROTOCOL=http/json`,
`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4820/otel`. Only enable while
the collector runs; the exporter logs warnings when its endpoint is down.

## Layout

```
src/server.js            HTTP + SSE + static + hook/status/OTel ingest
src/watcher.js           session + subagent discovery, transcript tailing
src/adapter.js           transcript JSONL parsing — the ONLY format-aware module
src/attribution.js       usage-delta attribution engine, suggestions (sessions + agents)
src/basescan.js          base-context disk scan, follows CLAUDE.md @-imports
src/store.js             session store + SSE broadcast + cross-session docs report
src/rollup.js            persistent session rollups + trends aggregation
src/pricing.js           model list prices + cache billing multipliers
src/otel.js              minimal OTLP/HTTP JSON logs parser
statusline/statusline.js Claude Code statusline: prints a line, feeds the collector
public/                  the visualizer UI
```

The transcript format is internal to Claude Code and can change between
releases. When it does, fix `src/adapter.js`; nothing else knows the format.
