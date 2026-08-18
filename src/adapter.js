// Transcript format adapter — the ONLY module that knows the shape of
// Claude Code's session JSONL. The format is internal to Claude Code and
// may change between releases; when it does, this file is the blast radius.
//
// parseLine(line) returns one of the normalized events below, or null for
// lines we don't care about (queue ops, file snapshots, unknown types).
//
//   { kind: 'api',          apiId, uuid, model, timestamp, isSidechain, promptId,
//                           usage: {input, cacheWrite, cacheRead, output},
//                           blocks: [{type:'tool_use', id, name, input} | {type, chars}] }
//   { kind: 'prompt',       text, chars, timestamp, promptId, isSidechain, cwd,
//                           isCompactSummary, commands? }
//   { kind: 'tool_results', results: [{toolUseId, chars}], timestamp, isSidechain }
//   { kind: 'attachment',   atype, chars, path, timestamp, skills? }
//   { kind: 'compaction',   uuid, timestamp, trigger, preTokens, postTokens, durationMs }
//   { kind: 'title',        title }

function contentChars(content) {
  if (content == null) return 0;
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    let n = 0;
    for (const block of content) {
      if (typeof block === 'string') n += block.length;
      else if (block && typeof block.text === 'string') n += block.text.length;
      else if (block) n += JSON.stringify(block).length;
    }
    return n;
  }
  return JSON.stringify(content).length;
}

// The skill_listing attachment is a text block of "- name: description"
// entries (descriptions may wrap onto continuation lines). Split it so each
// skill's share of the listing cost can be attributed.
function parseSkillListing(text) {
  if (typeof text !== 'string') return null;
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const m = /^- ([A-Za-z0-9_.:*-]+):\s/.exec(line);
    if (m) {
      cur = { name: m[1], chars: line.length + 1 };
      out.push(cur);
    } else if (cur) {
      cur.chars += line.length + 1;
    }
  }
  return out.length > 0 ? out : null;
}

function normalizeUsage(u) {
  if (!u) return null;
  return {
    input: u.input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    output: u.output_tokens || 0,
  };
}

export function parseLine(line) {
  if (!line || line.length < 2) return null;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return null;
  }

  try {
    if (e.type === 'assistant' && e.message) {
      const m = e.message;
      // Synthetic entries (queue placeholders etc.) carry no real API usage.
      if (!m.id || m.model === '<synthetic>') return null;
      const blocks = [];
      for (const b of m.content || []) {
        if (b.type === 'tool_use') {
          blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
        } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
          // Recent transcripts persist only the signature, not the thinking
          // text — chars stay 0 then and thinking is inferred from usage.
          blocks.push({ type: 'thinking', chars: typeof b.thinking === 'string' ? b.thinking.length : 0 });
        } else {
          blocks.push({ type: b.type, chars: typeof b.text === 'string' ? b.text.length : 0 });
        }
      }
      return {
        kind: 'api',
        apiId: m.id,
        uuid: e.uuid,
        model: m.model,
        timestamp: e.timestamp,
        isSidechain: !!e.isSidechain,
        promptId: e.promptId,
        usage: normalizeUsage(m.usage),
        blocks,
      };
    }

    if (e.type === 'user' && e.message) {
      const content = e.message.content;
      const results = [];
      const textParts = [];
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'tool_result') {
            results.push({ toolUseId: b.tool_use_id, chars: contentChars(b.content) });
          } else if (b.type === 'text' && typeof b.text === 'string') {
            textParts.push(b.text);
          }
        }
      } else if (typeof content === 'string') {
        textParts.push(content);
      }
      if (results.length > 0) {
        return { kind: 'tool_results', results, timestamp: e.timestamp, isSidechain: !!e.isSidechain };
      }
      // Editor/system wrappers around the real prompt are noise in labels.
      const text = textParts.join('\n')
        .replace(/<ide_selection>[\s\S]*?<\/ide_selection>\s*/g, '')
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '')
        .trim();
      if (!text) return null;
      // Slash-command invocations (skills and built-ins) are wrapped in
      // command-name tags — extract them so skill use can be counted.
      const commands = [...text.matchAll(/<command-name>\/?([^<\s]+)<\/command-name>/g)]
        .map((m) => m[1]);
      return {
        kind: 'prompt',
        text,
        chars: text.length,
        timestamp: e.timestamp,
        promptId: e.promptId,
        isSidechain: !!e.isSidechain,
        cwd: e.cwd,
        isCompactSummary: !!e.isCompactSummary,
        commands: commands.length > 0 ? commands : undefined,
      };
    }

    // Compaction boundary: the harness summarized the conversation and
    // rebuilt the context. compactMetadata carries measured pre/post sizes.
    if (e.type === 'system' && e.subtype === 'compact_boundary') {
      const m = e.compactMetadata || {};
      return {
        kind: 'compaction',
        uuid: e.uuid,
        timestamp: e.timestamp,
        trigger: m.trigger || 'auto',
        preTokens: m.preTokens || 0,
        postTokens: m.postTokens || 0,
        durationMs: m.durationMs || null,
      };
    }

    // Injected context (CLAUDE.md via nested_memory, skill listings, tool
    // deltas, reminders). Present on lines with an `attachment` key whether
    // or not e.type === 'attachment'.
    if (e.attachment && typeof e.attachment === 'object') {
      const a = e.attachment;
      const path = a.path || (a.content && typeof a.content === 'object' && a.content.path) || null;
      return {
        kind: 'attachment',
        atype: a.type || 'unknown',
        chars: contentChars(a.content) || JSON.stringify(a).length,
        path,
        timestamp: e.timestamp,
        skills: a.type === 'skill_listing' ? parseSkillListing(a.content) : undefined,
      };
    }

    if (e.type === 'ai-title' && e.aiTitle) {
      return { kind: 'title', title: e.aiTitle };
    }
  } catch {
    return null;
  }
  return null;
}
