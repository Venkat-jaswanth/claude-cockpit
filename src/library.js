// Stored sessions: everything under ~/.claude/projects/<project>/<session-id>.jsonl.
// Only a few well-known fields are read (titles, first prompt, cwd, branch, cost) from
// the head and tail of each file, and results are cached by mtime.
import fs from 'node:fs';
import path from 'node:path';
import { BASE_CLAUDE_DIR } from './paths.js';
import { tokensFromModelUsage, readUsageDelta } from './tokens.js';
import { allMarks } from './marks.js';
import { spawn } from 'node:child_process';

const cache = new Map();
const gitRootCache = new Map();
const CHUNK = 256 * 1024;

// The nearest ancestor of `dir` that contains a .git entry; else null. Cached per dir.
function gitRoot(dir) {
  if (!dir) return null;
  if (gitRootCache.has(dir)) return gitRootCache.get(dir);
  let d = dir, root = null;
  for (let i = 0; i < 40 && d && d !== '/'; i++) {
    try { if (fs.existsSync(path.join(d, '.git'))) { root = d; break; } } catch {}
    const parent = path.dirname(d); if (parent === d) break; d = parent;
  }
  gitRootCache.set(dir, root);
  return root;
}

function messageText(msg) {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
  return '';
}

function parseTranscript(file, st, projectDirName) {
  const sessionId = path.basename(file, '.jsonl');
  const rec = { sessionId, file, projectDirName, cwd: null, gitBranch: null, title: null, customTitle: null, aiTitle: null, agentName: null, firstPrompt: null, lastPrompt: null, firstAt: null, lastAt: st.mtimeMs, costUSD: null, tokens: null, models: [], version: null, size: st.size };
  const fd = fs.openSync(file, 'r');
  try {
    const headLen = Math.min(st.size, CHUNK);
    const head = Buffer.alloc(headLen); fs.readSync(fd, head, 0, headLen, 0);
    let tail = null;
    if (st.size > headLen) { const tailLen = Math.min(st.size - headLen, CHUNK); tail = Buffer.alloc(tailLen); fs.readSync(fd, tail, 0, tailLen, st.size - tailLen); }
    const apply = o => {
      const t = o.type;
      if (o.cwd && !rec.cwd) rec.cwd = o.cwd;
      if (o.gitBranch && !rec.gitBranch) rec.gitBranch = o.gitBranch;
      if (o.version && !rec.version) rec.version = o.version;
      if (t === 'custom-title' && o.customTitle) rec.customTitle = o.customTitle;
      else if (t === 'ai-title' && o.aiTitle) rec.aiTitle = o.aiTitle;
      else if (t === 'agent-name' && o.agentName) rec.agentName = o.agentName;
      else if (t === 'last-prompt' && typeof o.lastPrompt === 'string') rec.lastPrompt = o.lastPrompt.slice(0, 200);
      else if (t === 'cost-state') { if (typeof o.totalCostUSD === 'number') rec.costUSD = o.totalCostUSD; if (o.modelUsage && typeof o.modelUsage === 'object') { rec.models = Object.keys(o.modelUsage); rec.tokens = tokensFromModelUsage(o.modelUsage); } }
      else if (t === 'user' && !o.isMeta && !o.isSidechain && o.message) {
        const txt = messageText(o.message).trim();
        if (txt && !txt.startsWith('<')) {
          if (!rec.firstPrompt) { rec.firstPrompt = txt.slice(0, 200); rec.firstAt = o.timestamp ? Date.parse(o.timestamp) || null : null; }
          rec.lastPromptSeen = txt.slice(0, 200);
        }
      }
    };
    const scan = (buf, skipFirst) => {
      const lines = buf.toString('utf8').split('\n');
      for (let i = skipFirst ? 1 : 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.charCodeAt(0) !== 123) continue;
        try { apply(JSON.parse(line)); } catch {}
      }
    };
    scan(head, false);
    if (tail) scan(tail, true);
  } finally { fs.closeSync(fd); }
  if (!rec.firstPrompt && !rec.customTitle && !rec.aiTitle) return null;
  if (!rec.tokens && st.size <= 64 * 1024 * 1024) {
    // No cost-state in the head or tail (typical for a session still running): sum the assistant usage directly.
    try { const r = readUsageDelta(file, 0, new Set()); if (r && r.delta.messages) { rec.tokens = { input: r.delta.input, output: r.delta.output, cacheRead: r.delta.cacheRead, cacheWrite: r.delta.cacheWrite }; if (r.costTotal != null) rec.costUSD = r.costTotal; } } catch {}
  }
  rec.lastPrompt = rec.lastPrompt || rec.lastPromptSeen || null;
  delete rec.lastPromptSeen;
  rec.title = rec.customTitle || rec.aiTitle || (rec.firstPrompt ? rec.firstPrompt.replace(/\s+/g, ' ').slice(0, 80) : null) || rec.agentName || sessionId.slice(0, 8);
  rec.baseTitle = rec.title;
  if (!rec.cwd) rec.cwd = projectDirName.replace(/^-/, '/').replace(/-/g, '/');
  return rec;
}

export function scanLibrary({ limit = 500 } = {}) {
  const root = path.join(BASE_CLAUDE_DIR, 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return []; }
  const out = [];
  for (const d of dirs) {
    const pdir = path.join(root, d.name);
    let files = [];
    try { files = fs.readdirSync(pdir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(pdir, f);
      let st; try { st = fs.statSync(file); } catch { continue; }
      if (st.size < 200) continue;
      const c = cache.get(file);
      if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) { if (c.rec) out.push(c.rec); continue; }
      let rec = null;
      try { rec = parseTranscript(file, st, d.name); } catch {}
      cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, rec });
      if (rec) out.push(rec);
    }
  }
  const marks = allMarks();
  for (const r of out) {
    const root = gitRoot(r.cwd);
    const m = marks[r.sessionId] || null;
    r.projectPath = m?.project ? null : (root || r.cwd || null);
    r.projectName = m?.project || (root ? path.basename(root) : (r.cwd ? path.basename(r.cwd) : 'unknown'));
    r.inRepo = !!root;
    r.star = !!m?.star; r.tags = m?.tags || []; r.note = m?.note || ''; r.archived = !!m?.archived;
    r.customName = m?.name || null;
    r.customProject = m?.project || null;
    r.autoTitle = r.baseTitle || r.title;
    r.title = m?.name || r.autoTitle;
  }
  out.sort((a, b) => b.lastAt - a.lastAt);
  return out.slice(0, limit);
}

export function findStored(sessionIdOrTitle) {
  const all = scanLibrary({ limit: 5000 });
  return all.find(r => r.sessionId === sessionIdOrTitle) || all.find(r => r.sessionId.startsWith(sessionIdOrTitle)) || all.find(r => r.customTitle === sessionIdOrTitle || r.aiTitle === sessionIdOrTitle) || null;
}

export function recentProjects(limit = 30) {
  const seen = new Map();
  for (const r of scanLibrary({ limit: 5000 })) {
    if (!r.cwd || seen.has(r.cwd)) continue;
    if (!fs.existsSync(r.cwd)) continue;
    seen.set(r.cwd, { cwd: r.cwd, lastAt: r.lastAt, sessions: 1 });
  }
  return [...seen.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, limit);
}


// Full-text search across stored transcripts. Uses grep for speed (streaming, handles GBs),
// then enriches each hit with the session's title/folder and a readable snippet.
export function searchTranscripts(query, { limit = 40, timeoutMs = 15000 } = {}) {
  return new Promise(resolve => {
    const q = String(query || '').trim();
    if (q.length < 2) return resolve([]);
    const root = path.join(BASE_CLAUDE_DIR, 'projects');
    const byId = new Map(scanLibrary({ limit: 5000 }).map(r => [r.sessionId, r]));
    const files = [];
    const grep = spawn('grep', ['-rilF', '--include=*.jsonl', '--', q, root], { timeout: timeoutMs });
    let buf = '';
    grep.stdout.on('data', d => { buf += d; });
    grep.on('close', async () => {
      for (const line of buf.split('\n')) { if (line.endsWith('.jsonl')) files.push(line); }
      // newest first by the library's lastAt when known
      files.sort((a, b) => (byId.get(path.basename(b, '.jsonl'))?.lastAt || 0) - (byId.get(path.basename(a, '.jsonl'))?.lastAt || 0));
      const out = [];
      for (const file of files.slice(0, limit)) {
        const sessionId = path.basename(file, '.jsonl');
        const rec = byId.get(sessionId) || { sessionId, title: sessionId.slice(0, 8), cwd: null, lastAt: null };
        out.push({ sessionId, title: rec.title, cwd: rec.cwd, projectName: rec.projectName, lastAt: rec.lastAt, star: rec.star, tags: rec.tags, snippet: snippetFor(file, q) });
      }
      resolve(out);
    });
    grep.on('error', () => resolve([]));
  });
}


import { execFileSync } from 'node:child_process';
function snippetFor(file, q) {
  try {
    const line = execFileSync('grep', ['-iF', '-m1', '--', q, file], { encoding: 'utf8', timeout: 4000 }).split('\n')[0] || '';
    let text = line;
    try { const o = JSON.parse(line); const m = o.message; text = typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.filter(b => b?.type === 'text').map(b => b.text).join(' ') : (o.lastPrompt || o.aiTitle || line); } catch {}
    text = String(text).replace(/\s+/g, ' ').trim();
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return text.slice(0, 160);
    const start = Math.max(0, i - 50);
    return (start > 0 ? '…' : '') + text.slice(start, i + q.length + 110).trim() + '…';
  } catch { return ''; }
}
