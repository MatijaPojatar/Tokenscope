// Minimal OTLP/HTTP JSON logs parser. Claude Code exports
// `claude_code.api_request` log events carrying exact per-request cost —
// we extract just those and ignore everything else.
//
// Opt-in on the Claude Code side (env, e.g. in settings.json):
//   CLAUDE_CODE_ENABLE_TELEMETRY=1
//   OTEL_LOGS_EXPORTER=otlp
//   OTEL_EXPORTER_OTLP_PROTOCOL=http/json
//   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4820/otel

function attrValue(v) {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  return undefined;
}

export function extractApiRequests(payload) {
  const out = [];
  for (const rl of payload.resourceLogs || []) {
    const resAttrs = {};
    for (const a of (rl.resource && rl.resource.attributes) || []) {
      resAttrs[a.key] = attrValue(a.value);
    }
    for (const sl of rl.scopeLogs || []) {
      for (const rec of sl.logRecords || []) {
        const attrs = {};
        for (const a of rec.attributes || []) attrs[a.key] = attrValue(a.value);
        const name = attrs['event.name'] || (rec.body && rec.body.stringValue) || '';
        if (!String(name).includes('api_request')) continue;
        let costUsd = Number(attrs.cost_usd);
        if (!costUsd && attrs.cost_usd_micros != null) {
          costUsd = Number(attrs.cost_usd_micros) / 1e6;
        }
        out.push({
          sessionId: attrs['session.id'] || resAttrs['session.id'],
          costUsd: costUsd || 0,
          model: attrs.model,
        });
      }
    }
  }
  return out;
}
