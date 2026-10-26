// Token accounting from Claude Code transcripts. `assistant` lines carry message.usage and
// are repeated once per content block with the same message.id, so they are deduplicated.
// `cost-state` lines are Claude Code's own cumulative cost for the session.
import fs from 'node:fs';

export const EMPTY = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, cost: 0, turns: 0 });
export function add(a, b) {
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'messages', 'cost', 'turns']) a[k] = (a[k] || 0) + (b?.[k] || 0);
  return a;
}
export const totalTokens = t => (t?.input || 0) + (t?.output || 0) + (t?.cacheRead || 0) + (t?.cacheWrite || 0);

export function tokensFromModelUsage(modelUsage) {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const v of Object.values(modelUsage || {})) {
    t.input += v.inputTokens || 0; t.output += v.outputTokens || 0; t.cacheRead += v.cacheReadInputTokens || 0; t.cacheWrite += v.cacheCreationInputTokens || 0;
  }
  return t;
}

// Reads the transcript from `offset` to the last complete line. Returns the token delta,
// the new offset, and the latest cumulative cost Claude Code recorded (or null).
export function readUsageDelta(file, offset = 0, seen = new Set()) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  if (st.size <= offset) return { delta: EMPTY(), offset: Math.min(offset, st.size), costTotal: null, byModel: {} };
  const fd = fs.openSync(file, 'r');
  try {
    const len = st.size - offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    const complete = lastNl >= 0 ? text.slice(0, lastNl + 1) : '';
    const newOffset = offset + Buffer.byteLength(complete, 'utf8');
    const delta = EMPTY(); const byModel = {}; let costTotal = null;
    for (const line of complete.split('\n')) {
      if (!line || line.charCodeAt(0) !== 123) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'assistant') {
        const m = o.message; const u = m?.usage; if (!u) continue;
        const id = m.id || o.requestId || o.uuid;
        if (id) {
          if (seen.has(id)) continue;
          seen.add(id);
          if (seen.size > 20000) { const it = seen.values(); for (let i = 0; i < 10000; i++) seen.delete(it.next().value); }
        }
        const t = { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, messages: 1 };
        add(delta, t);
        const model = m.model || 'unknown';
        add(byModel[model] ||= EMPTY(), t);
      } else if (o.type === 'cost-state' && typeof o.totalCostUSD === 'number') {
        costTotal = o.totalCostUSD;
      }
    }
    return { delta, offset: newOffset, costTotal, byModel };
  } finally { fs.closeSync(fd); }
}

export function lastCostState(file) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const len = Math.min(st.size, 256 * 1024);
  if (!len) return null;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, st.size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('"cost-state"')) continue;
      try { const o = JSON.parse(line); if (o.type === 'cost-state' && typeof o.totalCostUSD === 'number') return o.totalCostUSD; } catch {}
    }
    return null;
  } finally { fs.closeSync(fd); }
}
