---
description: Start the Tokenscope dashboard (live context and token-usage visualizer) and give the user its URL. Use when the user asks to open, start, or check Tokenscope.
---

# Tokenscope dashboard

Tokenscope is a local web dashboard showing what's in each Claude Code
session's context, what every action costs in tokens, the base-context
breakdown, and optimization suggestions.

To start it:

1. Check whether the collector is already running: an HTTP GET to
   `http://localhost:4820/api/sessions` succeeds when it is.
2. If it is not running, run the launcher bundled with this plugin. The
   plugin root is the directory two levels above this SKILL.md file
   (it contains `scripts/ensure.js` and `src/server.js`):

   ```
   node "<plugin-root>/scripts/ensure.js"
   ```

   (Pipe empty stdin or just run it; it starts the collector detached on
   port 4820 and exits.)
3. Tell the user the dashboard is available at **http://localhost:4820**.
   Sessions from the last 48 hours are loaded automatically and new
   activity streams in live.

The collector keeps running after this session ends. It reads only local
Claude Code transcripts and serves only on localhost.
