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

## Layout

```
src/server.js       HTTP + SSE + static + hook ingest
src/watcher.js      session discovery + transcript tailing
src/adapter.js      transcript JSONL parsing — the ONLY format-aware module
src/attribution.js  usage-delta attribution engine
src/store.js        session store + SSE broadcast
public/             the visualizer UI
```

The transcript format is internal to Claude Code and can change between
releases. When it does, fix `src/adapter.js`; nothing else knows the format.
