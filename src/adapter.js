// Transcript format adapter — the ONLY module that knows the shape of
// Claude Code's session JSONL. The format is internal to Claude Code and
// may change between releases; when it does, this file is the blast radius.
//
// parseLine(line) returns one of the normalized events below, or null for
// lines we don't care about (queue ops, file snapshots, unknown types).
//
//   { kind: 'api',          apiId, model, timestamp, isSidechain, promptId,
//                           usage: {input, cacheWrite, cacheRead, output},
//                           blocks: [{type:'tool_use', id, name, input} | {type, chars}] }
//   { kind: 'prompt',       text, chars, timestamp, promptId, isSidechain, cwd }
//   { kind: 'tool_results', results: [{toolUseId, chars}], timestamp, isSidechain }
//   { kind: 'attachment',   atype, chars, path, timestamp }
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
        } else {
          blocks.push({ type: b.type, chars: typeof b.text === 'string' ? b.text.length : 0 });
        }
      }
      return {
        kind: 'api',
        apiId: m.id,
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
      const text = textParts.join('\n');
      if (!text) return null;
      return {
        kind: 'prompt',
        text,
        chars: text.length,
        timestamp: e.timestamp,
        promptId: e.promptId,
        isSidechain: !!e.isSidechain,
        cwd: e.cwd,
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
