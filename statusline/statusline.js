// Tokenscope statusline for Claude Code.
//
// Configure in settings.json:
//   "statusLine": { "type": "command", "command": "node <path-to>/statusline/statusline.js" }
//
// Prints a compact status line and forwards the full snapshot to the local
// Tokenscope collector (fire-and-forget; harmless when the collector is off).

import http from 'node:http';

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let s = {};
  try { s = JSON.parse(raw); } catch { /* print a bare line below */ }

  try {
    const req = http.request({
      host: '127.0.0.1',
      port: 4820,
      path: '/status',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 300,
    });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.end(raw);
  } catch { /* collector offline */ }

  const parts = [];
  if (s.model && s.model.display_name) parts.push(s.model.display_name);
  const cw = s.context_window || {};
  if (typeof cw.used_percentage === 'number') parts.push(`ctx ${Math.round(cw.used_percentage)}%`);
  if (s.cost && typeof s.cost.total_cost_usd === 'number') {
    parts.push(`$${s.cost.total_cost_usd.toFixed(2)}`);
  }
  const rl = s.rate_limits || {};
  if (rl.five_hour && typeof rl.five_hour.used_percentage === 'number') {
    parts.push(`5h ${Math.round(rl.five_hour.used_percentage)}%`);
  }
  if (rl.seven_day && typeof rl.seven_day.used_percentage === 'number') {
    parts.push(`7d ${Math.round(rl.seven_day.used_percentage)}%`);
  }
  console.log(parts.join(' · ') || 'tokenscope');
});
