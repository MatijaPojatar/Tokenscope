# Tokenscope

A separate live window for Claude Code that shows what's in your session's
context, what every action costs in tokens, and which of your docs files earn
their keep.

It runs as a local web page next to your terminal and shows, for every session:

- **Context gauge** — how full the context window is and what it's made of
  (base system context, conversation, docs read, code read, search results,
  tool output, assistant output).
- **Per-action cost** — every Read / Grep / Glob / Edit / agent call with the
  tokens it added to context, grouped by prompt.
- **Docs leaderboard** — which `.md` files (including auto-injected CLAUDE.md)
  were read, how often, and what they cost — so you can see whether Claude
  finds the right docs and what that search costs.
- **Agents** — subagents spawned by a session, each with its own context
  window: tokens used, calls made, docs read (their docs reads join the
  leaderboard, marked `A`).
- **Docs across sessions** — the `docs` button shows every doc read by any
  session or agent in the loaded window: reads, tokens, session count. The
  fastest way to spot docs that never get read.
- **Cost & rate limits** — session USD cost and account rate-limit fill, fed
  by the statusline integration below.

Zero dependencies. Node 18+.

## Run

```
node src/server.js
```

Open http://localhost:4820. Sessions active in the last 48 hours are loaded
automatically; new activity streams in live.

Options:

```
node src/server.js --port 4820 --hours 48 --root %USERPROFILE%\.claude\projects
```

## How it works

The collector tails Claude Code's session transcripts
(`%USERPROFILE%\.claude\projects\<project>\<session>.jsonl`) and settles each
API call's fresh tokens (`input_tokens + cache_creation_input_tokens`) against
the material inserted since the previous call — the user prompt, tool results,
and injected attachments — prorated by size. `cache_read_input_tokens` is the
already-paid prefix. That yields exact per-turn costs and close per-action
costs without any configuration.

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
src/attribution.js       usage-delta attribution engine (sessions + agents)
src/store.js             session store + SSE broadcast + docs report
src/otel.js              minimal OTLP/HTTP JSON logs parser
statusline/statusline.js Claude Code statusline: prints a line, feeds the collector
public/                  the visualizer UI
```

The transcript format is internal to Claude Code and can change between
releases. When it does, fix `src/adapter.js`; nothing else knows the format.
