// User-applied metadata on sessions that cockpit stores on its own side (Claude Code's
// transcripts are read-only to us): a star, free-form tags, a short note, an archived flag,
// and an optional project override. Keyed by Claude Code session id so it survives handoffs
// and resumes (which keep the same id). Persisted to ~/.claude-cockpit/marks.json.
import { HOME, readJson, writeJson } from './paths.js';
import path from 'node:path';

const FILE = path.join(HOME, 'marks.json');
let store = null;

function load() { if (!store) store = readJson(FILE, { sessions: {} }) || { sessions: {} }; if (!store.sessions) store.sessions = {}; return store; }
let timer = null;
function persist() { if (timer) return; timer = setTimeout(() => { timer = null; try { writeJson(FILE, store); } catch {} }, 300); }

export function getMark(sessionId) { return load().sessions[sessionId] || null; }
export function allMarks() { return load().sessions; }

export function setMark(sessionId, patch = {}) {
  const s = load();
  const cur = s.sessions[sessionId] || { star: false, tags: [], note: '', archived: false, project: null, name: null };
  if (typeof patch.star === 'boolean') cur.star = patch.star;
  if (typeof patch.archived === 'boolean') cur.archived = patch.archived;
  if (typeof patch.note === 'string') cur.note = patch.note.slice(0, 500);
  if (patch.name !== undefined) cur.name = (patch.name && String(patch.name).trim()) ? String(patch.name).trim().slice(0, 120) : null;
  if (patch.project !== undefined) cur.project = patch.project ? String(patch.project).slice(0, 80) : null;
  if (Array.isArray(patch.tags)) cur.tags = [...new Set(patch.tags.map(t => String(t).trim().slice(0, 40)).filter(Boolean))].slice(0, 12);
  if (patch.addTag) { cur.tags = [...new Set([...(cur.tags || []), String(patch.addTag).trim().slice(0, 40)].filter(Boolean))].slice(0, 12); }
  if (patch.removeTag) { cur.tags = (cur.tags || []).filter(t => t !== patch.removeTag); }
  cur.updatedAt = Date.now();
  s.sessions[sessionId] = cur;
  persist();
  return cur;
}

export function knownTags() {
  const set = new Map();
  for (const m of Object.values(load().sessions)) for (const t of (m.tags || [])) set.set(t, (set.get(t) || 0) + 1);
  return [...set.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }));
}

// alias: daemon imports allTags
export const allTags = knownTags;
