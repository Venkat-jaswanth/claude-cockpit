// Claude Cockpit dashboard. Vanilla JS, hash-routed views, polling the local daemon.
const $ = s => document.querySelector(s);
const VIEWS = {
  overview: ['Overview', 'What needs you, what\'s running, and today at a glance'],
  seats: ['Seats', 'One isolated Claude Code login per account'],
  sessions: ['Sessions', 'Running now, or waiting to be resumed'],
  tasks: ['Tasks', 'Plan the work, launch it as a session, watch it run'],
  projects: ['Projects', 'Your projects, each with its tasks, live sessions and history'],
  workspace: ['Workspace', 'Watch and drive several live sessions side by side'],
  library: ['Library', 'Every stored conversation, grouped by folder. Star, tag, filter by project, and resume on any seat'],
  usage: ['Usage', 'Tokens booked to the seat that ran each turn; cost is Claude Code\'s own estimate'],
  activity: ['Activity', 'What the daemon did and why'],
  settings: ['Settings', 'Handoff policy and automation'],
  help: ['Help', 'How it works and the matching terminal commands'],
};
let state = null, library = [], projects = [], recentFolders = [], usage = null, allTags = [], libFilter = '', libGroup = 'folder', libStar = false, libTag = '', libProject = '', showArchived = false, view = 'overview', dirtyForms = new Set(), theme = 'auto', taskProjectFilter = '', tbComposerProject = '';
let deepResults = null, deepQuery = '', selected = new Set();
let openGroups = {}; try { openGroups = JSON.parse(localStorage.getItem('cockpit.groups') || '{}'); } catch {}
function saveGroups() { try { localStorage.setItem('cockpit.groups', JSON.stringify(openGroups)); } catch {} }
// Done column starts collapsed, so finished work stays tucked away; remembered per browser.
let tbDoneOpen = false; try { tbDoneOpen = localStorage.getItem('cockpit.tbDone') === '1'; } catch {}
function saveTbDone() { try { localStorage.setItem('cockpit.tbDone', tbDoneOpen ? '1' : '0'); } catch {} }
function hue(str) { let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360; return h; }
function applyTheme(t) { theme = ['light', 'dark'].includes(t) ? t : 'auto'; document.documentElement.dataset.theme = theme === 'auto' ? '' : theme; try { localStorage.setItem('cockpit.theme', theme); } catch {} }
(() => { let t = new URLSearchParams(location.search).get('theme'); try { t = t || localStorage.getItem('cockpit.theme'); } catch {} applyTheme(t || 'auto'); })();
let motion = 'full';
function applyMotion(m) { motion = m === 'reduced' ? 'reduced' : 'full'; document.documentElement.dataset.motion = motion === 'reduced' ? 'reduced' : ''; try { localStorage.setItem('cockpit.motion', motion); } catch {} }
(() => { let m; try { m = localStorage.getItem('cockpit.motion'); } catch {} applyMotion(m || 'full'); })();
// Accent presets. graphite (null) keeps the theme-aware monochrome default; others set [accent, soft, ink].
const ACCENTS = { graphite: null, indigo: ['#5a5af0', '#7474f6', '#ffffff'], blue: ['#0a84ff', '#3d9bff', '#ffffff'], emerald: ['#15a46e', '#1ec07f', '#ffffff'], amber: ['#d98a00', '#f0a622', '#1b1b1f'], rose: ['#e5484d', '#f06066', '#ffffff'] };
let accent = 'graphite';
function applyAccent(name) {
  accent = ACCENTS[name] !== undefined ? name : 'graphite';
  const r = document.documentElement.style, v = ACCENTS[accent];
  if (!v) { r.removeProperty('--accent'); r.removeProperty('--accent-soft'); r.removeProperty('--accent-ink'); }
  else { r.setProperty('--accent', v[0]); r.setProperty('--accent-soft', v[1]); r.setProperty('--accent-ink', v[2]); }
  try { localStorage.setItem('cockpit.accent', accent); } catch {}
}
(() => { let a; try { a = localStorage.getItem('cockpit.accent'); } catch {} applyAccent(a || 'graphite'); })();
// Terminal appearance presets, shared by the workspace panes and the standalone terminal view.
const TERM_THEMES = {
  Midnight: { background: '#0f1115', foreground: '#e6e6ea', cursor: '#e6e6ea', selectionBackground: 'rgba(120,120,170,.35)' },
  Graphite: { background: '#1b1b1e', foreground: '#f0f0f3', cursor: '#f0f0f3', selectionBackground: 'rgba(255,255,255,.18)' },
  Matrix: { background: '#001400', foreground: '#39ff14', cursor: '#39ff14', selectionBackground: 'rgba(57,255,20,.25)' },
  Cyberpunk: { background: '#0b0221', foreground: '#ff2fb9', cursor: '#00e5ff', selectionBackground: 'rgba(0,229,255,.25)' },
  Paper: { background: '#f7f7f4', foreground: '#1d1d1f', cursor: '#1d1d1f', selectionBackground: 'rgba(0,0,0,.12)' },
};
function termPrefs() { try { return { theme: 'Midnight', fontSize: 13, cursor: 'block', ...JSON.parse(localStorage.getItem('cockpit.term') || '{}') }; } catch { return { theme: 'Midnight', fontSize: 13, cursor: 'block' }; } }
function termXtermOptions() { const p = termPrefs(); return { cursorBlink: true, cursorStyle: p.cursor || 'block', fontSize: Number(p.fontSize) || 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', theme: TERM_THEMES[p.theme] || TERM_THEMES.Midnight, scrollback: 4000, allowProposedApi: true }; }
// Saved reusable commands/prompts (client-side), surfaced in Settings and the command palette.
function cmds() { try { return JSON.parse(localStorage.getItem('cockpit.cmds') || '[]'); } catch { return []; } }
function saveCmds(list) { try { localStorage.setItem('cockpit.cmds', JSON.stringify(list)); } catch {} }
// Project display aliases: rename a project's title without touching the folder it maps to.
function projAliases() { try { return JSON.parse(localStorage.getItem('cockpit.projAliases') || '{}'); } catch { return {}; } }
function saveProjAlias(base, title) { const a = projAliases(); const t = (title || '').trim(); if (t && t !== base) a[base] = t; else delete a[base]; try { localStorage.setItem('cockpit.projAliases', JSON.stringify(a)); } catch {} }
function aliasName(base) { return projAliases()[base] || base; }

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = p => (p || '').replace(/^\/Users\/[^/]+/, '~');
function ago(ts) { if (!ts) return ''; const m = Math.round((Date.now() - ts) / 60000); if (m < 1) return 'just now'; if (m < 60) return `${m} min ago`; const h = Math.floor(m / 60); if (h < 24) return `${h} h ${m % 60} min ago`; const d = Math.floor(h / 24); return d < 14 ? `${d} d ago` : new Date(ts).toLocaleDateString(); }
function until(iso) { if (!iso) return ''; const ms = new Date(iso).getTime() - Date.now(); if (ms <= 0) return null; const m = Math.round(ms / 60000); if (m >= 1440) { const d = Math.floor(m / 1440); const h = Math.floor((m % 1440) / 60); return `${d} d${h ? ` ${h} h` : ''}`; } return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; }
function resetsText(iso, what = '5-hour window') { const u = until(iso); if (!iso) return `no ${what} reading yet`; return u === null ? `${what} has reset` : `${what} resets in ${u}`; }
function resetsShort(iso) { const u = until(iso); return !iso ? '' : u === null ? 'has reset' : `resets in ${u}`; }
function fmtTok(n) { n = Number(n) || 0; if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k'; return String(n); }
function fmtCost(c) { c = Number(c) || 0; return c ? '$' + (c >= 100 ? c.toFixed(0) : c.toFixed(2)) : '–'; }
const tot = t => (t?.input || 0) + (t?.output || 0) + (t?.cacheRead || 0) + (t?.cacheWrite || 0);
const lvl = p => p == null ? 'unknown' : p >= 85 ? 'bad' : p >= 60 ? 'warn' : 'ok';
const seatPct = s => s?.usage?.fiveHour?.pct ?? null;
// A managed session that has stayed "busy" (mid-turn) this long with no turn boundary is probably
// stuck. lastActivity only moves on hook events, so this measures turn-start age: keep it generous.
const STALL_MIN = 25;
const isStalled = s => s.alive && s.managed && s.kind === 'claude' && s.status === 'busy' && s.lastActivity && (Date.now() - s.lastActivity) / 60000 >= STALL_MIN;
// Live git status for a session's folder, when the daemon has read it.
function gitInline(g) {
  if (!g || !g.branch) return '';
  let out = `⎇ ${esc(g.branch)}`;
  if (g.dirty) out += ' <span class="git-dirty" title="uncommitted changes">●</span>';
  if (g.ahead) out += ` <span title="commits ahead of upstream">↑${g.ahead}</span>`;
  if (g.behind) out += ` <span title="commits behind upstream">↓${g.behind}</span>`;
  return `<span class="git">${out}</span>`;
}

function toast(msg, kind = '') { const el = document.createElement('div'); el.className = `toast ${kind}`; el.textContent = msg; $('#toasts').appendChild(el); setTimeout(() => el.remove(), 3200); }
async function post(p, body) {
  const r = await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { toast(j.error || `Request failed (${r.status})`, 'bad'); throw new Error(j.error || 'failed'); }
  return j;
}
function seatOptions(exclude, label = 'Best seat') {
  return `<option value="">${label}</option>` + (state?.seats || []).filter(s => !s.disabled && s.name !== exclude).map(s => `<option value="${esc(s.name)}">${esc(s.name)} · ${seatPct(s) ?? '–'}%</option>`).join('');
}
async function openSession(cs, where) {
  if (where === 'browser') window.open(`/s/${encodeURIComponent(cs)}`, '_blank');
  else { await post(`/api/sessions/${encodeURIComponent(cs)}/open-terminal`); toast('Opened in Terminal'); }
}
async function startSession(body, where) {
  const j = await post('/api/sessions', body);
  await openSession(j.cs, where);
  setTimeout(load, 500);
}
// One rename, written to BOTH stores so the live session (keyed by cs) and the Library mark
// (keyed by sessionId) always agree — whichever page you rename from.
async function renameEverywhere({ cs, sessionId, name }) {
  const nm = (name || '').trim();
  if (cs) await post(`/api/sessions/${encodeURIComponent(cs)}/rename`, { name: nm });
  if (sessionId) await post(`/api/marks/${encodeURIComponent(sessionId)}`, { name: nm });
  setTimeout(() => { load(); loadSlow(); }, 200);
  return nm;
}
// Turn a name element into an in-place text field. Enter/blur saves, Esc cancels. `lock`/`unlock`
// pause the surrounding re-render so a background poll can't wipe the field mid-edit.
function inlineRename(nameEl, { current, onCommit, lock, unlock }) {
  if (!nameEl || nameEl.querySelector('input')) return;
  lock && lock();
  const input = document.createElement('input');
  input.className = 'rename-input'; input.value = current || ''; input.spellcheck = false;
  nameEl.replaceChildren(input); input.focus(); input.select();
  let done = false;
  const end = save => {
    if (done) return; done = true;
    const v = input.value.trim();
    nameEl.textContent = (save && v) ? v : (current || '');
    unlock && unlock();
    if (save) onCommit(v);
  };
  input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); end(true); } else if (e.key === 'Escape') { e.preventDefault(); end(false); } });
  input.addEventListener('blur', () => end(true));
  input.addEventListener('click', e => e.stopPropagation());
}
function bar(label, pct, right, cls) {
  const p = pct == null ? 0 : Math.min(100, pct);
  return `<div class="bar"><div class="lbl"><span>${esc(label)}</span><span>${esc(right || '')}</span></div><div class="track"><div class="fill ${cls || lvl(pct)}" style="width:${pct == null ? 100 : p}%"></div></div><span class="pct">${pct == null ? '–' : pct + '%'}</span></div>`;
}
function seatBadges(s) {
  const u = s.usage || {}, fh = u.fiveHour || {}, b = [];
  if (!u.loggedIn) b.push('<span class="badge bad">not logged in</span>');
  if (s.probe?.running) b.push('<span class="badge accent">checking…</span>');
  else if (fh.assumedReset) b.push('<span class="badge">window reset</span>');
  else if (!u.known) b.push('<span class="badge">no reading yet</span>');
  else if (u.stale) b.push(`<span class="badge" title="Press Check usage to refresh">reading is ${Math.round(u.ageMin)} min old</span>`);
  if (s.probe?.lastResult && !s.probe.lastResult.ok && !s.probe.running) b.push(`<span class="badge warn" title="${esc(s.probe.lastResult.reason)}">check failed</span>`);
  if (s.disabled) b.push('<span class="badge">disabled</span>');
  return b.join(' ');
}

/* ---------- views ---------- */
// The seat to reach for right now: logged in, enabled, most 5-hour headroom (lowest pct).
// Seats with no reading yet rank last, since we can't vouch for their headroom.
function bestSeat() {
  const cand = (state.seats || []).filter(s => !s.disabled && s.usage?.loggedIn);
  if (!cand.length) return null;
  return cand.slice().sort((a, b) => (seatPct(a) ?? 999) - (seatPct(b) ?? 999))[0];
}
// The attention queue: one ranked list of everything that can act on, drawn from state.
// Severity order: bad (blocking) > warn (needs a decision) > go (ready for you) > info.
function attnItems() {
  const items = [], push = (sev, ico, title, sub, action, cs) => items.push({ sev, ico, title, sub, action, cs });
  // bad: a seat you can't use at all
  for (const s of state.seats) if (!s.disabled && s.usage && !s.usage.loggedIn)
    push('bad', '!', `${esc(s.name)} is not logged in`, 'This seat cannot run or report usage until you sign in.', `<button class="btn sm" data-act="login" data-seat="${esc(s.name)}">Log in</button>`);
  // bad: a session whose process exited unexpectedly
  for (const s of state.sessions.filter(x => x.status === 'crashed'))
    push('bad', '⚠', `${esc(s.name || s.cs)} crashed`, `Exited unexpectedly on ${esc(s.seat || '?')}${s.exitCode ? ` (code ${s.exitCode})` : ''}. Resume to pick up where it left off, or dismiss it.`, `<button class="btn sm primary" data-act="restore" data-cs="${esc(s.cs)}">Resume</button><button class="btn sm ghost" data-act="forget" data-cs="${esc(s.cs)}">Dismiss</button>`, s.cs);
  // warn: sessions dropped by a daemon restart
  for (const s of state.sessions.filter(x => x.status === 'lost'))
    push('warn', '↻', `${esc(s.name || s.cs)} stopped when the daemon restarted`, `${esc(short(s.cwd || ''))} · was on ${esc(s.seat || '?')}`, `<button class="btn sm primary" data-act="restore" data-cs="${esc(s.cs)}">Resume</button><button class="btn sm ghost" data-act="forget" data-cs="${esc(s.cs)}">Dismiss</button>`, s.cs);
  // warn: a usage check that failed
  for (const s of state.seats) if (s.probe?.lastResult && !s.probe.lastResult.ok && !s.probe.running)
    push('warn', '?', `Could not read usage for ${esc(s.name)}`, esc(s.probe.lastResult.reason || 'the check did not finish'), `<button class="btn sm" data-act="probe" data-seat="${esc(s.name)}">Try again</button>`);
  // warn: a seat almost out of its 5-hour window
  for (const s of state.seats) { const p = seatPct(s); if (!s.disabled && s.usage?.loggedIn && p != null && p >= 85 && !s.usage.fiveHour?.assumedReset)
    push('warn', '▲', `${esc(s.name)} is nearly out (${p}%)`, resetsText(s.usage.fiveHour?.resetsAt), ''); }
  // warn: a session stuck busy far longer than a turn usually runs
  for (const s of state.sessions.filter(isStalled)) {
    const mins = Math.round((Date.now() - s.lastActivity) / 60000);
    push('warn', '◴', `${esc(s.name || s.cs)} has been busy ${mins} min`, `No turn has finished on ${esc(s.seat || '?')} in a while. It may be on a long task, or stuck.`, `<button class="btn sm" data-act="term" data-cs="${esc(s.cs)}">Open</button><button class="btn sm danger" data-act="stop" data-cs="${esc(s.cs)}">Stop</button>`, s.cs);
  }
  // warn: nowhere fresh left to go
  const usable = state.seats.filter(s => !s.disabled && s.usage?.loggedIn);
  if (usable.length >= 2 && usable.every(s => { const p = seatPct(s); return p != null && p >= 80; }))
    push('warn', '◆', 'Every seat is running low', 'All logged-in seats are past 80%. Consider pausing, or waiting for the next reset.', '');
  // go: a session finished its turn and is waiting on you (the key "needs input" signal)
  const idle = state.sessions.filter(s => s.alive && s.managed && s.kind === 'claude' && s.status === 'idle' && !s.pendingHandoff).sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  for (const s of idle)
    push('go', '✓', `${esc(s.name || s.cs)} is ready for you`, `Finished its turn on ${esc(s.seat || '?')} · ${ago(s.lastActivity)}`, `<button class="btn sm primary" data-act="term" data-cs="${esc(s.cs)}">Open</button><button class="btn sm" data-act="handoff" data-cs="${esc(s.cs)}" title="Move to the seat with the most headroom">Hand off</button><button class="btn sm danger" data-act="stop" data-cs="${esc(s.cs)}" title="Finished with it? Stop now — you can still resume it later">Stop</button>`, s.cs);
  // info: a queued handoff waiting for the turn to end
  for (const s of state.sessions.filter(x => x.pendingHandoff))
    push('', '→', `${esc(s.name || s.cs)}: handoff to ${esc(s.pendingHandoff.to)} queued`, 'Will move when the current turn ends.', '', s.cs);
  // info: a scheduled run about to fire
  for (const j of (state.jobs || []).filter(j => j.status === 'queued' && j.at && j.at - Date.now() < 15 * 60e3))
    push('', '◷', `Scheduled: ${esc(j.name || j.prompt || 'session')} starts ${until(j.at) ? 'in ' + until(j.at) : 'now'}`, `${esc(short(j.cwd || ''))}${j.seat ? ' · ' + esc(j.seat) : ' · best seat'}`, `<button class="btn sm ghost" data-cancel="${esc(j.id)}">Cancel</button>`);
  const rank = { bad: 0, warn: 1, go: 2, '': 3 };
  return items.sort((a, b) => rank[a.sev] - rank[b.sev]);
}
// ---- Overview sections (all real data, rendered at final values; motion plays on view-enter) ----
const fmtDur = m => { m = Math.max(0, Math.round(m)); if (m < 60) return m + 'm'; const h = Math.floor(m / 60); const r = m % 60; return r ? `${h}h ${r}m` : `${h}h`; };
// Time until a seat's 5-hour window is exhausted, preferring the daemon's measured burn rate.
function runwayFor(s) {
  const b = s.burn, fh = s.usage?.fiveHour || {};
  if (b && b.rising && b.etaMin != null) return { text: '≈ ' + fmtDur(b.etaMin), sub: `${b.perHour}%/h`, kind: lvl(fh.pct) };
  if (fh.pct != null) return { text: 'steady', sub: fh.pct + '% used', kind: lvl(fh.pct) };
  return { text: '—', sub: 'no reading yet', kind: 'unknown' };
}
const QUICK = [
  { icon: '✓', name: 'Fix failing tests', text: 'Run the test suite, then fix whatever is failing until everything passes. Explain each fix briefly.' },
  { icon: '⤢', name: 'Review my changes', text: 'Review my uncommitted changes for bugs, edge cases, and clarity. Summarise what they do and flag anything risky.' },
  { icon: '✎', name: 'Write missing docs', text: 'Find the parts of this project that lack documentation and add clear, concise docs and comments.' },
  { icon: '◎', name: 'Explain this project', text: 'Give me a tour of this codebase: the structure, the main modules, and how they fit together.' },
];
function ovQuickLaunch() {
  const best = bestSeat(), mine = cmds();
  // Your own saved commands drive this. When you have none, show the built-ins as starters to launch or replace.
  const items = mine.length ? mine.map((c, i) => ({ icon: '»', name: c.name, text: c.text, i })) : QUICK.map(q => ({ ...q, sample: true }));
  const cards = items.slice(0, 11).map(it => `<button class="card qcard lift${it.sample ? ' sample' : ''}" data-qltext="${esc(it.text)}">
      ${it.i != null ? `<span class="ql-del" data-ql-del="${it.i}" title="Remove this command">×</span>` : ''}
      <span class="qi">${it.icon}</span><span class="qt">${esc(it.name)}</span>
      <span class="badge">→ ${esc(best ? best.name : 'best seat')}</span></button>`).join('');
  const add = `<button class="card qcard qadd" data-ql-add><span class="qi">+</span><span class="qt">New command</span><span class="tiny muted">save a prompt you reuse</span></button>`;
  return `<div class="section"><div class="card-head"><h2>Quick launch</h2><a class="tiny" data-ql-add href="#/settings">Manage</a></div>
    <div class="grid auto ql-grid">${cards}${add}</div>${mine.length ? '' : '<div class="tiny muted" style="margin-top:8px">Examples — add your own and these make way.</div>'}</div>`;
}
// One merged per-account section: a usage ring, readiness, reset countdown and runway — no
// separate Capacity / Window-resets / Runway cards saying overlapping things.
function ovAccounts() {
  const seats = state.seats.filter(s => !s.disabled && s.usage?.loggedIn);
  if (!seats.length) return '';
  const ready = seats.filter(s => { const p = seatPct(s); return p != null && p < 60; }).length;
  const cards = seats.map(s => {
    const fh = s.usage.fiveHour || {}, p = fh.pct, c = p == null ? 'faint' : lvl(p), r = runwayFor(s);
    const reset = (!fh.resetsAt || fh.assumedReset || until(fh.resetsAt) === null) ? 'no active window' : 'resets in ' + until(fh.resetsAt);
    const run = r.kind === 'unknown' ? '' : (r.text === 'steady' ? 'steady' : r.text + ' left');
    const badge = p == null ? '<span class="badge">no reading</span>' : p >= 85 ? '<span class="badge bad">low</span>' : p >= 60 ? '<span class="badge warn">busy</span>' : '<span class="badge ok">ready</span>';
    return `<div class="card acct lift">
      <span class="ring" style="--p:${p ?? 0};--c:var(--${c})" data-label="${p == null ? '–' : p + '%'}"></span>
      <div class="acct-info"><div class="acct-top"><span class="acct-name">${esc(s.name)}</span>${badge}</div>
        <div class="acct-sub">${reset}${run ? ' · ' + run : ''}</div></div>
    </div>`;
  }).join('');
  const weekly = seats.filter(s => (s.usage.weekly || []).length).map(s => { const w = s.usage.weekly.find(x => x.active) || s.usage.weekly[0]; return `${esc(s.name)} ${w.pct ?? '–'}%`; });
  return `<div class="section"><div class="card-head"><h2>Accounts</h2><span class="tiny muted">${ready} of ${seats.length} ready · usage, resets and runway</span></div>
    <div class="grid auto acct-grid">${cards}</div>${weekly.length ? `<div class="tiny muted" style="margin-top:10px">Weekly — ${weekly.join(' · ')}</div>` : ''}</div>`;
}
function ovToday() {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const now = Date.now(), sess = state.sessions.filter(s => s.kind === 'claude' && s.managed && s.startedAt && s.startedAt >= dayStart.getTime());
  if (!sess.length) return `<div class="section"><div class="card-head"><h2>Today</h2><span class="tiny muted">every session on one timeline</span></div><div class="card flat empty">No sessions yet today. They'll line up here as you start them.</div></div>`;
  const start = Math.min(Math.min(...sess.map(s => s.startedAt)), now - 3 * 3600e3), span = Math.max(1, now - start);
  const seats = [...new Set(sess.map(s => s.seat || '—'))];
  const lanes = seats.map(seat => { const blocks = sess.filter(s => (s.seat || '—') === seat).map(s => {
      const a = Math.max(start, s.startedAt), b = Math.min(now, s.endedAt || now), left = (a - start) / span * 100, w = Math.max(2, (b - a) / span * 100);
      const cls = s.alive ? (s.status === 'busy' ? 'busy' : '') : 'done';
      return `<div class="gblock ${cls}" style="left:${left.toFixed(1)}%;width:${w.toFixed(1)}%" title="${esc(s.name || s.cs)} · ${s.alive ? 'started ' + ago(s.startedAt) : 'ended ' + ago(s.endedAt)}">${esc(s.name || s.cs)}</div>`; }).join('');
    return `<div class="glane"><span class="nm">${esc(seat)}</span><div class="gtrack">${blocks}</div></div>`; }).join('');
  const ticks = []; for (let i = 0; i < 4; i++) ticks.push(`<span>${new Date(start + span * i / 4).toLocaleTimeString([], { hour: 'numeric' })}</span>`); ticks.push('<span>now</span>');
  return `<div class="section"><div class="card-head"><h2>Today</h2><span class="tiny muted">every session on one timeline</span></div>
    <div class="card"><div class="gantt">${lanes}</div><div class="gaxis"><span></span><div class="ticks">${ticks.join('')}</div></div></div></div>`;
}
function vOverview() {
  if (!state.seats.length) return onboarding();
  const live = state.sessions.filter(s => s.alive && s.kind === 'claude' && s.managed);
  const attn = attnItems();
  // Each session shows in exactly one place: if it is in the attention queue (ready, stalled,
  // crashed, queued handoff, …) it is not also listed under "Running now".
  const attnCs = new Set(attn.map(a => a.cs).filter(Boolean));
  const running = live.filter(s => !attnCs.has(s.cs));
  const outside = state.sessions.filter(s => s.alive && s.kind === 'claude' && !s.managed);
  const t = usage?.today?.total;
  const best = bestSeat(); const bp = best ? seatPct(best) : null;
  const chip = s => { const p = seatPct(s); return `<div class="seatchip ${s.disabled ? 'off' : ''}"><span class="ring sm" style="--p:${p ?? 0};--c:var(--${lvl(p) === 'unknown' ? 'faint' : lvl(p)})" data-label="${p == null ? '–' : p + '%'}"></span><span class="sc-name">${esc(s.name)}</span></div>`; };
  const attnShown = attn.slice(0, 10), attnMore = attn.length - attnShown.length;
  const attnHtml = attn.length
    ? `<div class="attn">${attnShown.map(a => `<div class="attn-item ${a.sev}"><div class="ai-ico">${a.ico}</div><div class="grow"><div class="ai-title">${a.title}</div><div class="ai-sub">${a.sub}</div></div><div class="actions">${a.action}</div></div>`).join('')}${attnMore > 0 ? `<div class="attn-more tiny muted">+${attnMore} more</div>` : ''}</div>`
    : `<div class="card flat attn-clear"><span class="ok">●</span> All clear. Nothing needs you right now.</div>`;
  const runHtml = running.length
    ? `<div class="sessgrid">${running.map(s => `<div class="sesscard">
        <div class="sc-head"><span class="dot ${esc(s.status)}"></span><span class="sc-name grow">${esc(s.name || s.cs)}</span><span class="badge">${esc(s.seat)}</span>${s.worktree ? '<span class="badge" title="isolated git worktree">worktree</span>' : ''}${isStalled(s) ? '<span class="badge warn">stalled?</span>' : ''}</div>
        <div class="sc-path mono tiny muted">${esc(short(s.cwd || ''))}${s.git && s.git.branch ? ` · ${gitInline(s.git)}` : ''}</div>
        <div class="sc-foot"><span class="sc-meta">${s.turns || 0} turns · ${ago(s.lastActivity)}</span><div class="actions"><button class="btn sm" data-act="term" data-cs="${esc(s.cs)}">Open</button><button class="btn sm" data-act="handoff" data-cs="${esc(s.cs)}" title="Move to the seat with the most headroom">Hand off</button></div></div>
      </div>`).join('')}</div>`
    : live.length
      ? `<div class="card flat empty">Every live session is waiting on you — see <b>Needs you</b> above.</div>`
      : `<div class="card flat empty big">Nothing running yet. Press <b>New session</b> to start one, or resume a conversation from <a href="#/library">Projects</a>.</div>`;
  const outsideNote = outside.length ? `<div class="tiny muted" style="margin-top:10px">${outside.length} Claude session${outside.length === 1 ? '' : 's'} running outside cockpit (started with plain <code>claude</code>). <a href="#/sessions">Show</a></div>` : '';
  const budget = usage?.budgetMonthlyUSD || 0, monthCost = usage?.month?.total?.cost || 0;
  const budgetMini = budget > 0 ? `<div style="margin-top:14px">${bar('This month', Math.min(100, Math.round(monthCost / budget * 100)), `${fmtCost(monthCost)} of ${fmtCost(budget)}`, monthCost / budget >= 1 ? 'bad' : monthCost / budget >= 0.8 ? 'warn' : 'ok')}</div>` : '';
  return `
    <div class="section"><div class="card ov-status">
      <div class="ov-sum"><b>${state.seats.length}</b> seat${state.seats.length === 1 ? '' : 's'} · <b>${running.length}</b> running${best ? ` <span class="ov-best"><span class="ring sm" style="--p:${bp ?? 0};--c:var(--${lvl(bp) === 'unknown' ? 'faint' : lvl(bp)})" data-label="${bp == null ? '–' : bp + '%'}"></span>best now: ${esc(best.name)}</span>` : ''}</div>
      <div class="seatchips">${state.seats.map(chip).join('')}<a href="#/seats" class="btn sm ghost">Manage</a></div>
    </div></div>
    <div class="section"><div class="card-head"><h2>Needs you${attn.length ? ` <span class="badge warn">${attn.length}</span>` : ''}</h2></div>${attnHtml}</div>
    <div class="section"><div class="card-head"><h2>Running now <span class="badge">${running.length}</span></h2><a href="#/sessions" class="tiny">All sessions</a></div>${runHtml}${outsideNote}</div>
    ${ovQuickLaunch()}
    ${ovAccounts()}
    ${ovToday()}
    <div class="grid cols-2">
      <div class="card flat"><div class="card-head"><h2>Today</h2><a href="#/usage" class="tiny">Usage</a></div>
        <div class="statrow">
          <div class="stat"><div class="s-val" data-count="${tot(t)}" data-countfmt="tok">${fmtTok(tot(t))}</div><div class="s-lbl">tokens today</div></div>
          <div class="stat"><div class="s-val" data-count="${t?.cost || 0}" data-countfmt="cost">${fmtCost(t?.cost)}</div><div class="s-lbl">cost today</div></div>
          <div class="stat"><div class="s-val" data-count="${tot(usage?.week?.total)}" data-countfmt="tok">${fmtTok(tot(usage?.week?.total))}</div><div class="s-lbl">7-day tokens</div></div>
        </div>${budgetMini}
      </div>
      <div class="card flat"><div class="card-head"><h2>Latest activity</h2><a href="#/activity" class="tiny">All</a></div><div class="events">${events(state.events.slice(0, 6))}</div></div>
    </div>`;
}
function onboarding() {
  return `<div class="card" style="max-width:640px"><h2 style="margin-bottom:6px">Welcome</h2><p class="muted" style="margin:0 0 16px">Nothing is set up yet. Three steps in a terminal, then everything else happens here.</p>
    <div class="steps">
      <div class="step"><div><b>Adopt your current login as the first seat.</b><div class="muted tiny">Installs the hooks and starts the daemon.</div><code>cockpit init --name &lt;your-name&gt;</code></div></div>
      <div class="step"><div><b>Keep the daemon alive across reboots.</b><code>cockpit daemon install</code></div></div>
      <div class="step"><div><b>Add the other accounts.</b><div class="muted tiny">Back here: Seats → Add seat. A Terminal window opens with Claude's login.</div></div></div>
    </div></div>`;
}
function vSeats() {
  const cards = state.seats.map(s => {
    const u = s.usage || {}, fh = u.fiveHour || {};
    const active = fh.resetsAt && !fh.assumedReset && new Date(fh.resetsAt).getTime() > Date.now();
    const burn = s.burn;
    const burnLine = burn && burn.rising && burn.etaMin != null
      ? `<div class="burn ${burn.etaMin < 60 ? 'hot' : ''}">▲ ${burn.perHour}%/h · ~${burn.etaMin >= 60 ? Math.floor(burn.etaMin/60)+'h '+(burn.etaMin%60)+'m' : burn.etaMin+'m'} to limit</div>`
      : '';
    const weekly = (u.weekly || []).map(w => bar(w.label, w.pct, resetsShort(w.resetsAt))).join('');
    return `<div class="card seat ${s.disabled ? 'disabled' : ''}">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:start"><div style="min-width:0"><div class="name">${esc(s.name)}</div><div class="who">${esc(u.email || s.email || '')}${s.plan ? ` · ${esc(s.plan)}` : ''}${s.kind === 'base' ? ' · ~/.claude' : ''}</div></div></div>
      <div class="meta">${seatBadges(s)}</div>
      ${bar('5-hour window', fh.pct, resetsShort(fh.resetsAt))}
      ${burnLine}
      ${weekly}
      <div class="sessline">
        <span class="slabel">Sessions</span>
        <span class="scount ${s.activeSessions ? 'on' : ''}" title="Running inside cockpit: you can attach to these and hand them off">● ${s.activeSessions || 0} cockpit</span>
        <span class="scount normal ${s.outsideSessions ? 'on' : ''}" title="Plain 'claude' you ran in your own terminals on this account. Cockpit can't attach to or hand these off; they still use the account's quota.">○ ${s.outsideSessions || 0} normal</span>
      </div>
      <div class="foot"><span>${u.fetchedAt ? `reading from ${ago(u.fetchedAt)}` : ''}</span></div>
      <div class="actions">
        ${u.loggedIn && !active ? `<button class="btn sm" data-act="arm" data-seat="${esc(s.name)}" ${s.arm?.running ? 'disabled' : ''} title="Send a tiny cheap message now to start this seat's 5-hour window, so it resets sooner relative to when you actually begin work">${s.arm?.running ? 'Arming…' : 'Start window'}</button>` : ''}
        <button class="btn sm" data-act="probe" data-seat="${esc(s.name)}" ${s.probe?.running || !u.loggedIn ? 'disabled' : ''}>${s.probe?.running ? 'Checking…' : 'Check now'}</button>
        <button class="btn sm" data-act="login" data-seat="${esc(s.name)}">${u.loggedIn ? 'Re-login' : 'Log in'}</button>
        <button class="btn sm" data-act="toggle" data-seat="${esc(s.name)}" data-disabled="${s.disabled ? 0 : 1}">${s.disabled ? 'Enable' : 'Disable'}</button>
        ${s.kind === 'base' ? '' : `<button class="btn sm danger" data-act="remove" data-seat="${esc(s.name)}">Remove</button>`}
      </div>
    </div>`;
  }).join('');
  return `<div class="section"><div class="grid auto">${cards || '<div class="empty big">No seats yet. Run <code>cockpit init</code> once in a terminal.</div>'}</div></div>
    <div class="card"><div class="card-head"><h2>Add a seat</h2></div><p class="muted tiny" style="margin:0 0 10px">A Terminal window opens with Claude's login. Sign in with that teammate's account; the seat is ready when the window says so.</p>
      <form class="inline-form" id="addSeat"><input name="name" placeholder="seat name, e.g. priya" pattern="[A-Za-z0-9_-]{1,24}" required><button class="btn primary" type="submit">Add seat &amp; log in</button><button class="btn" type="button" id="addSeatBrowser">Log in in browser instead</button></form></div>`;
}
function sessionRow(s) {
  let actions = '';
  if (s.kind === 'login') actions = s.alive ? `<button class="btn sm" data-act="term" data-cs="${esc(s.cs)}">Open</button>` : '';
  else if (s.managed && s.alive) actions = `<button class="btn sm" data-act="term" data-cs="${esc(s.cs)}">Open in Terminal</button><button class="btn sm" data-act="web" data-cs="${esc(s.cs)}">View</button><select class="sel sm" data-pick="${esc(s.cs)}">${seatOptions(s.seat)}</select><button class="btn sm" data-act="handoff" data-cs="${esc(s.cs)}">Hand off</button><button class="btn sm danger" data-act="stop" data-cs="${esc(s.cs)}">Stop</button>`;
  else if (s.managed && !s.alive) actions = `<select class="sel sm" data-pick="${esc(s.cs)}">${seatOptions(null)}</select><button class="btn sm primary" data-act="restore" data-cs="${esc(s.cs)}">Resume in Terminal</button><button class="btn sm ghost" data-act="forget" data-cs="${esc(s.cs)}">Forget</button>`;
  return `<tr>
    <td><div style="font-weight:500"><span class="srow-name"${s.managed ? ` data-cs="${esc(s.cs)}" data-sid="${esc(s.sessionId || '')}" data-cur="${esc(s.name || '')}" title="Double-click to rename"` : ''}>${esc(s.name || s.cs)}</span>${s.managed ? '' : ' <span class="badge">outside cockpit</span>'}${s.worktree ? ' <span class="badge" title="isolated git worktree">worktree</span>' : ''}${s.managed ? ` <button class="iconbtn" data-ren-btn title="Rename this session">✎</button>` : ''}</div><div class="tiny muted mono">${esc(short(s.cwd || ''))}${s.git && s.git.branch ? ` · ${gitInline(s.git)}` : ''}</div></td>
    <td>${esc(s.seat || '?')}${s.handoffs?.length ? `<div class="tiny muted">was ${esc(s.handoffs[s.handoffs.length - 1].from)}</div>` : ''}</td>
    <td><span class="dot ${esc(s.status)}"></span>${esc(s.status.replace('_', ' '))}${s.pendingHandoff ? ` <span class="badge warn">→ ${esc(s.pendingHandoff.to)} queued</span>` : ''}${s.viewers ? `<div class="tiny muted">${s.viewers} window${s.viewers === 1 ? '' : 's'} open</div>` : ''}</td>
    <td class="r">${s.turns ?? 0}</td><td class="r">${s.handoffs?.length ?? 0}</td>
    <td class="muted">${ago(s.lastActivity)}</td>
    <td><div class="actions">${actions}</div></td></tr>`;
}
function vSessions() {
  const running = state.sessions.filter(s => s.alive && s.managed);
  const outside = state.sessions.filter(s => s.alive && !s.managed);
  const lost = state.sessions.filter(s => s.status === 'lost');
  const ended = state.sessions.filter(s => !s.alive && s.status === 'ended' && s.managed).slice(0, 10);
  const table = rows => `<div class="tablewrap"><table><thead><tr><th>Session</th><th>Seat</th><th>Status</th><th class="r">Turns</th><th class="r">Handoffs</th><th>Last activity</th><th></th></tr></thead><tbody>${rows.map(sessionRow).join('')}</tbody></table></div>`;
  const queued = (state.jobs || []).filter(j => j.status === 'queued');
  const schedBlock = queued.length ? `<div class="card section"><div class="card-head"><h2>Scheduled <span class="badge">${queued.length}</span></h2><span class="tiny muted">Will start automatically on the freshest seat at the given time.</span></div><div class="tablewrap"><table><thead><tr><th>Task</th><th>Folder</th><th>Seat</th><th>Starts</th><th></th></tr></thead><tbody>${queued.map(j => `<tr><td>${esc(j.name || j.prompt || 'session')}</td><td class="tiny mono">${esc(short(j.cwd || ''))}</td><td>${esc(j.seat || 'best')}</td><td class="muted">${new Date(j.at).toLocaleString()}</td><td><button class="btn sm danger" data-cancel="${esc(j.id)}">Cancel</button></td></tr>`).join('')}</tbody></table></div></div>` : '';
  return `
    ${schedBlock}
    <div class="card section"><div class="card-head"><h2>Cockpit sessions <span class="badge">${running.length}</span></h2><span class="tiny muted">Open shows the live session in a Terminal window. Ctrl-] inside it detaches; the session keeps running.</span></div>${running.length ? table(running) : '<div class="empty">None started from cockpit. Press <b>New session</b> or resume one from the Library.</div>'}</div>
    ${lost.length ? `<div class="card section"><div class="card-head"><h2>Needs resuming <span class="badge warn">${lost.length}</span></h2><span class="tiny muted">These were running when the daemon restarted.</span></div>${table(lost)}</div>` : ''}
    ${outside.length ? `<div class="card section flat"><div class="card-head"><h2>Other Claude sessions on this machine <span class="badge">${outside.length}</span></h2><span class="tiny muted">Started with plain <code>claude</code>, seen through their hooks. Visible for usage accounting; cockpit can't attach to or hand these off.</span></div>${table(outside)}</div>` : ''}
    ${ended.length ? `<div class="card section flat"><div class="card-head"><h2>Recently ended</h2></div>${table(ended)}</div>` : ''}`;
}
function groupKey(r) { return libGroup === 'flat' ? 'All conversations' : libGroup === 'folder' ? (r.cwd || 'unknown') : (r.projectName + '\u0000' + (r.projectPath || '')); }
function tagChips(r) {
  return (r.tags || []).map(t => `<span class="tag" data-tag="${esc(t)}">${esc(t)}<b data-untag="${esc(r.sessionId)}" data-tagval="${esc(t)}" title="Remove tag">×</b></span>`).join('')
    + `<button class="tag add" data-addtag="${esc(r.sessionId)}" title="Add a tag">+ tag</button>`;
}
function libRow(r, liveIds) {
  return `<div class="lrow ${selected.has(r.sessionId) ? 'sel' : ''}">
    <input type="checkbox" class="lcheck" data-check="${esc(r.sessionId)}" ${selected.has(r.sessionId) ? 'checked' : ''} aria-label="Select">
    <button class="star ${r.star ? 'on' : ''}" data-star="${esc(r.sessionId)}" data-on="${r.star ? 1 : 0}" title="${r.star ? 'Unstar' : 'Star'}">${r.star ? '★' : '☆'}</button>
    <div class="grow" style="min-width:0">
      <div class="title"><span class="lrow-name" data-sid="${esc(r.sessionId)}" data-cur="${esc(r.customName || r.title)}" title="Double-click to rename">${esc(r.title)}</span>${r.customName ? ' <span class="badge" title="Renamed; original: ' + esc(r.autoTitle || '') + '">renamed</span>' : ''}${liveIds.has(r.sessionId) ? ' <span class="badge ok">running</span>' : ''} <button class="iconbtn" data-rename="${esc(r.sessionId)}" title="Rename this session">✎</button><button class="iconbtn" data-project="${esc(r.sessionId)}" data-cur="${esc(r.customProject || '')}" title="Move to a project">⊞</button>${r.customProject ? ` <span class="badge" title="Manually placed in this project">in ${esc(r.customProject)}</span>` : ''}</div>
      <div class="tiny muted" title="${esc(r.lastPrompt || r.firstPrompt || '')}">${esc((r.lastPrompt || r.firstPrompt || '').replace(/\s+/g, ' ').slice(0, 110))}</div>
      <div class="tags">${tagChips(r)}${r.gitBranch ? `<span class="tiny muted" style="margin-left:4px">${esc(r.gitBranch)}</span>` : ''}</div>
    </div>
    <div class="lmeta tiny muted"><div>${ago(r.lastAt)}</div><div title="in ${fmtTok(r.tokens?.input)} · out ${fmtTok(r.tokens?.output)} · cache ${fmtTok((r.tokens?.cacheRead||0)+(r.tokens?.cacheWrite||0))}">${r.tokens ? fmtTok(tot(r.tokens)) + ' tok' : ''}${r.costUSD != null ? ' · ' + fmtCost(r.costUSD) : ''}</div></div>
    <div class="actions nowrap"><select class="sel sm" data-pick="${esc(r.sessionId)}">${seatOptions(null)}</select><button class="btn sm primary" data-act="resume" data-id="${esc(r.sessionId)}" data-cwd="${esc(r.cwd)}">Resume</button><button class="btn sm ghost" data-act="resume-web" data-id="${esc(r.sessionId)}" data-cwd="${esc(r.cwd)}" title="Open in a browser tab">↗</button></div>
  </div>`;
}
function vLibrary() {
  const q = libFilter.trim().toLowerCase();
  const liveIds = new Set(state.sessions.filter(s => s.alive).map(s => s.sessionId));
  let rows = library.filter(r => showArchived ? true : !r.archived);
  if (libStar) rows = rows.filter(r => r.star);
  if (libTag) rows = rows.filter(r => (r.tags || []).includes(libTag));
  if (q) rows = rows.filter(r => [r.title, r.cwd, r.firstPrompt, r.lastPrompt, r.gitBranch, r.projectName, ...(r.tags||[])].some(v => v && String(v).toLowerCase().includes(q)));
  const lp = libProject ? (projects || []).find(p => p.id === libProject) : null;
  if (libProject && !lp) libProject = '';                                   // project was deleted; drop the stale filter
  if (lp && lp.folder) rows = rows.filter(r => r.cwd === lp.folder || r.projectPath === lp.folder);
  const starred = rows.filter(r => r.star);
  const groups = new Map();
  for (const r of rows) { const k = groupKey(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const ordered = [...groups.entries()].map(([k, list]) => ({ k, list, lastAt: Math.max(...list.map(r => r.lastAt)), tokens: list.reduce((a, r) => a + tot(r.tokens), 0), cost: list.reduce((a, r) => a + (r.costUSD || 0), 0) })).sort((a, b) => b.lastAt - a.lastAt);
  const filtering = !!(q || libStar || libTag);
  const groupCard = (g, idx) => {
    const sample = g.list[0];
    const name = libGroup === 'folder' ? short(sample.cwd) : libGroup === 'flat' ? 'All conversations' : aliasName(sample.projectName);
    const pathLine = libGroup === 'project' ? short(sample.projectPath || sample.cwd) : '';
    const open = (g.k in openGroups) ? openGroups[g.k] : (filtering ? true : idx === 0);
    const h = hue(name || 'x');
    const starCount = g.list.filter(r => r.star).length;
    // If this folder/repo is a named project, link to it in the Projects hub.
    const groupFolder = libGroup === 'folder' ? sample.cwd : (sample.projectPath || sample.cwd);
    const np = (projects || []).find(p => p.folder && (p.folder === groupFolder || p.folder === sample.cwd || p.folder === sample.projectPath));
    const projChip = np ? `<span class="pproj" role="button" tabindex="0" data-projjump="${esc(np.id)}" title="Open “${esc(np.name)}” in Projects"><span class="pproj-dot" style="background:${esc(np.color || 'var(--accent)')}"></span>${esc(np.name)} →</span>` : '';
    return `<div class="pcard ${open ? 'open' : ''}">
      <button class="phead" data-group="${esc(encodeURIComponent(g.k))}" aria-expanded="${open}">
        <span class="pchev" aria-hidden="true">▸</span>
        <span class="pdot" style="background:hsl(${h} 48% 52%)"></span>
        <span class="pname">${esc(name)}${sample.inRepo && libGroup === 'project' ? ' <span class="badge">repo</span>' : ''}${(libGroup === 'project' && aliasName(sample.projectName) !== sample.projectName) ? ' <span class="badge" title="Renamed from ' + esc(sample.projectName) + '">renamed</span>' : ''}</span>
        ${libGroup === 'project' ? `<span class="iconbtn" role="button" tabindex="0" data-projrename="${esc(sample.projectName)}" title="Rename this project">✎</span>` : ''}
        ${pathLine ? `<span class="ppath tiny muted">${esc(pathLine)}</span>` : ''}
        ${projChip}
        <span class="pmeta tiny muted">${starCount ? `<span class="pmeta-star">★ ${starCount}</span> · ` : ''}${fmtTok(g.tokens)} tok${g.cost ? ' · ' + fmtCost(g.cost) : ''} · ${ago(g.lastAt)}</span>
        <span class="pcount" title="${g.list.length} conversation${g.list.length === 1 ? '' : 's'}">${g.list.length}</span>
      </button>
      ${open ? `<div class="pbody">${g.list.slice(0, 60).map(r => libRow(r, liveIds)).join('')}</div>` : ''}
    </div>`;
  };
  const tagBar = allTags.length ? `<div class="tagbar">${allTags.map(t => `<button class="tag ${libTag === t.tag ? 'on' : ''}" data-filtertag="${esc(t.tag)}">${esc(t.tag)} <span class="muted">${t.count}</span></button>`).join('')}${libTag ? '<button class="tag clear" data-filtertag="">clear</button>' : ''}</div>` : '';
  const bulkBar = selected.size ? `<div class="bulkbar">
      <span class="bulkcount">${selected.size} selected</span>
      <button class="btn sm" data-bulk="star">★ Star</button>
      <button class="btn sm" data-bulk="unstar">Unstar</button>
      <button class="btn sm" data-bulk="tag">Tag…</button>
      <button class="btn sm" data-bulk="project">Move to project…</button>
      <button class="btn sm" data-bulk="archive">Archive</button>
      <button class="btn sm" data-bulk="unarchive">Unarchive</button>
      <button class="btn sm danger" data-bulk="delete">Delete…</button>
      <span class="spacer"></span>
      <button class="btn sm ghost" data-bulk="clear">Clear</button>
    </div>` : '';
  let body;
  if (deepResults) {
    const rowsHtml = deepResults.length ? deepResults.map(r => `<div class="lrow ${selected.has(r.sessionId) ? 'sel' : ''}">
        <input type="checkbox" class="lcheck" data-check="${esc(r.sessionId)}" ${selected.has(r.sessionId) ? 'checked' : ''} aria-label="Select">
        <button class="star ${r.star ? 'on' : ''}" data-star="${esc(r.sessionId)}" data-on="${r.star ? 1 : 0}">${r.star ? '★' : '☆'}</button>
        <div class="grow" style="min-width:0"><div class="title">${esc(r.title)}</div><div class="tiny muted snip">${esc(r.snippet || '')}</div><div class="tiny muted mono">${esc(short(r.cwd || ''))}${r.projectName ? ' · ' + esc(r.projectName) : ''}</div></div>
        <div class="lmeta tiny muted">${ago(r.lastAt)}</div>
        <div class="actions nowrap"><select class="sel sm" data-pick="${esc(r.sessionId)}">${seatOptions(null)}</select><button class="btn sm primary" data-act="resume" data-id="${esc(r.sessionId)}" data-cwd="${esc(r.cwd || '')}">Resume</button></div>
      </div>`).join('') : '<div class="empty big">No conversations contain that text.</div>';
    body = `<div class="card"><div class="card-head"><h2>Found inside conversations · "${esc(deepQuery)}" <span class="badge">${deepResults.length}</span></h2><button class="btn sm" id="deepClear">← Back to projects</button></div>${rowsHtml}</div>`;
  } else {
    body = ordered.length ? ordered.map(groupCard).join('') : '<div class="empty big">No conversations match. Try clearing filters.</div>';
  }
  return `<div class="card flat" style="padding:12px 14px;margin-bottom:14px">
      <div class="toolbar">
        <input class="inp" id="libSearch" placeholder="Filter by title/folder/tag; press ↵ to search inside conversations" value="${esc(libFilter)}">
        <button class="btn sm" id="deepBtn" title="Search the full text of every stored conversation">Search contents</button>
        <div class="seg" id="libGroupSeg">
          ${[['folder', 'Folder'], ['project', 'Repo'], ['flat', 'All']].map(([g, lbl]) => `<button class="${libGroup === g ? 'on' : ''}" data-group-mode="${g}">${lbl}</button>`).join('')}
        </div>
        ${(projects || []).some(p => p.folder) ? `<select class="sel sm" id="libProjectSel" title="Filter to a project"><option value="">All projects</option>${projects.filter(p => p.folder).map(p => `<option value="${esc(p.id)}"${libProject === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}
        ${(!deepResults && libGroup !== 'flat' && ordered.length > 1) ? (() => { const allOpen = ordered.every((g, i) => (g.k in openGroups) ? openGroups[g.k] : (filtering ? true : i === 0)); return `<button class="btn sm" id="libExpand">${allOpen ? 'Collapse all' : 'Expand all'}</button>`; })() : ''}
        <button class="btn sm ${libStar ? 'primary' : ''}" id="libStarBtn">★ Starred</button>
        <button class="btn sm ${showArchived ? 'primary' : ''}" id="libArchBtn" title="Show archived too">Archived</button>
        <span class="spacer"></span>
        <span class="tiny muted">${deepResults ? deepResults.length + ' found' : rows.length + ' of ' + library.length}</span>
      </div>
      ${tagBar}
      ${bulkBar}
    </div>
    ${body}`;
}
function kpi(label, t, sub) {
  return `<div class="card kpi"><div class="lbl">${esc(label)}</div><div class="val">${fmtTok(tot(t))}<small>tokens</small></div><div class="sub">in ${fmtTok(t?.input)} · out ${fmtTok(t?.output)} · cache ${fmtTok((t?.cacheRead || 0) + (t?.cacheWrite || 0))}</div><div class="sub">${t?.turns ? `${t.turns} turns · ` : ''}cost ${fmtCost(t?.cost)}${sub ? ` · ${esc(sub)}` : ''}</div></div>`;
}
// The "usage check" panel: each seat's live 5-hour + weekly limit reading, with a Check button.
function usageLimits() {
  const seats = (state?.seats || []).filter(s => !s.disabled);
  if (!seats.length) return '';
  const probing = !!state.probing;
  const rows = seats.map(s => {
    const u = s.usage || {}, fh = u.fiveHour || {}, p = fh.pct;
    const wk = (u.weekly || []).reduce((a, w) => Math.max(a, w.pct || 0), 0);
    const checking = !!s.probe?.running;
    const reset = fh.assumedReset ? 'window reset' : (fh.resetsAt && until(fh.resetsAt) ? 'resets ' + until(fh.resetsAt) : '');
    const burn = (s.burn && s.burn.rising && s.burn.etaMin != null && s.burn.etaMin > 0 && s.burn.etaMin <= 600) ? `▲ ${s.burn.perHour}%/h · ~${fmtDur(s.burn.etaMin)}` : '';
    const age = u.loggedIn ? (u.fetchedAt ? (u.stale ? `reading ${Math.round(u.ageMin)}m old` : `checked ${Math.round(u.ageMin)}m ago`) : 'no reading yet') : '';
    const meta = [reset, wk ? `wk ${wk}%` : '', burn, age].filter(Boolean).join('  ·  ');
    return `<div class="ulim">
      <div class="ulim-name">${esc(s.name)}</div>
      ${!u.loggedIn ? '<div class="ulim-bar"><span class="badge bad">not logged in</span></div><div class="ulim-meta"></div>'
        : `<div class="ulim-bar"><div class="track"><div class="fill ${lvl(p)}" style="width:${p == null ? 0 : Math.min(100, p)}%"></div></div><span class="ulim-pct num">${p == null ? '–' : p + '%'}</span></div>
           <div class="ulim-meta tiny muted">${esc(meta)}</div>`}
      <button class="btn sm" data-act="probe" data-seat="${esc(s.name)}" ${checking || !u.loggedIn ? 'disabled' : ''}>${checking ? 'Checking…' : 'Check'}</button>
    </div>`;
  }).join('');
  return `<div class="card section"><div class="card-head"><h2>Account limits${probing ? ' <span class="badge accent">checking…</span>' : ''}</h2><button class="btn sm primary" id="btnCheckAllUsage" ${probing ? 'disabled' : ''}>${probing ? 'Checking…' : 'Check all'}</button></div>
    <div class="ulim-list">${rows}</div>
    <div class="tiny muted" style="margin-top:10px">The 5-hour window is Claude Code's rolling limit. “Check” opens Claude briefly on a seat to refresh the reading — no prompt is sent.</div></div>`;
}
function vUsage() {
  if (!usage) return '<div class="empty big">Loading…</div>';
  const storedTok = library.reduce((a, r) => a + tot(r.tokens), 0), storedCost = library.reduce((a, r) => a + (r.costUSD || 0), 0);
  const days = usage.byDay || []; const max = Math.max(1, ...days.map(tot)); const maxIdx = days.reduce((bi, d, i) => tot(d) > tot(days[bi]) ? i : bi, 0);
  const chart = `<div class="bars">${days.map((d, i) => { const v = tot(d); const h = Math.round(v / max * 100); return `<div class="bcol" title="${esc(d.day)}: ${fmtTok(v)} tokens, ${d.turns} turns, cost ${fmtCost(d.cost)}">${v && (i === maxIdx || i === days.length - 1) ? `<span class="blabel">${fmtTok(v)}</span>` : ''}<div class="b ${i === days.length - 1 ? 'today' : ''}" style="height:${Math.max(v ? 3 : 0, h)}%"></div><span class="bday">${d.day.slice(5).replace('-', '/')}</span></div>`; }).join('')}</div>`;
  const seats = Object.entries(usage.week.seats || {}).sort((a, b) => tot(b[1]) - tot(a[1])); const smax = Math.max(1, ...seats.map(([, t]) => tot(t)));
  const bySeat = seats.length ? seats.map(([n, t]) => `<div class="hbar"><span class="hname">${esc(n)}</span><div class="track"><div class="fill" style="width:${Math.round(tot(t) / smax * 100)}%"></div></div><span class="hval">${fmtTok(tot(t))} · ${fmtCost(t.cost)}</span></div>`).join('') : '<div class="empty">Tokens appear after the first turn of a cockpit session.</div>';
  const top = (usage.topSessions || []).map(x => `<tr><td><div style="font-weight:500">${esc(x.name || x.cs)}</div><div class="tiny muted mono">${esc(short(x.cwd || ''))}</div></td><td>${esc(x.seat || '')}</td><td class="r">${x.turns}</td><td class="r">${fmtTok(x.input)}</td><td class="r">${fmtTok(x.output)}</td><td class="r">${fmtTok(x.cacheRead)}</td><td class="r">${fmtTok(x.cacheWrite)}</td><td class="r">${fmtCost(x.cost)}</td></tr>`).join('');
  const budget = usage.budgetMonthlyUSD || 0;
  const monthCost = usage.month?.total?.cost || 0;
  const budgetBar = budget > 0 ? (() => { const p = Math.min(100, Math.round(monthCost / budget * 100)); const lv = p >= 100 ? 'bad' : p >= 80 ? 'warn' : 'ok'; return `<div class="card section"><div class="card-head"><h2>This month's budget</h2><span class="tiny muted">${fmtCost(monthCost)} of ${fmtCost(budget)} · ${fmtTok(tot(usage.month?.total))} tokens</span></div>${bar('Spend this month', p, p >= 100 ? 'over budget' : `${100 - p}% left`, lv)}</div>`; })() : '';
  return `<div class="usage-top"><h2 class="muted" style="margin-bottom:10px">Usage</h2><button class="btn sm" id="csvExport">Export CSV</button></div>
    ${usageLimits()}
    ${budgetBar}
    <div class="grid cols-4 section">${kpi('Today', usage.today.total)}${kpi('Last 7 days', usage.week.total)}${kpi('This month', usage.month?.total || {}, budget ? `budget ${fmtCost(budget)}` : '')}
      <div class="card kpi"><div class="lbl">All stored transcripts</div><div class="val">${fmtTok(storedTok)}<small>tokens</small></div><div class="sub">${library.length} conversations</div><div class="sub">cost ${fmtCost(storedCost)} · Claude Code's per-session totals</div></div></div>
    <div class="grid wide-left section"><div class="card"><h3>Last 14 days · total tokens per day</h3><div class="chart">${chart}</div></div><div class="card"><h3>Last 7 days · by seat</h3>${bySeat}</div></div>
    <div class="card"><h3>Top sessions · last 7 days</h3><div class="tablewrap"><table><thead><tr><th>Session</th><th>Seat</th><th class="r">Turns</th><th class="r">Input</th><th class="r">Output</th><th class="r">Cache read</th><th class="r">Cache write</th><th class="r">Cost</th></tr></thead><tbody>${top || '<tr><td colspan="8" class="empty">Nothing counted this week yet.</td></tr>'}</tbody></table></div></div>`;
}
function events(list) { return list.length ? list.map(e => `<div class="ev"><span class="t">${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><span class="k ${esc(e.type)}">${esc(e.type)}</span><span>${esc(e.msg)}</span></div>`).join('') : '<div class="empty">Nothing yet.</div>'; }
function vActivity() { return `<div class="card"><div class="events">${events(state.events)}</div></div>`; }
function vSettings() {
  const c = state.config; const tp = termPrefs();
  return `<form class="card form" id="settings">
    <h3>Handoff</h3>
    <label class="field"><span>Mode</span><select name="mode"><option value="auto" ${c.handoff.mode === 'auto' ? 'selected' : ''}>Auto · move sessions between turns when a seat runs low</option><option value="ask" ${c.handoff.mode === 'ask' ? 'selected' : ''}>Ask · notify me, I press Hand off</option><option value="off" ${c.handoff.mode === 'off' ? 'selected' : ''}>Off · never move anything automatically</option></select></label>
    <div class="field-row"><label class="field"><span>Hand off when the seat is past</span><input name="thresholdPct" type="number" min="50" max="100" value="${c.handoff.thresholdPct}"></label><label class="field"><span>Only if the other seat has at least this much more room (%)</span><input name="minGainPct" type="number" min="0" max="100" value="${c.handoff.minGainPct}"></label></div>
    <label class="field inline"><input name="autoContinue" type="checkbox" ${c.handoff.autoContinue !== false ? 'checked' : ''}><span>After a handoff, automatically continue the work (no need to type "continue")</span></label>
    <label class="field"><span>Continuation message sent after a handoff between turns</span><input name="continueMessage" value="${esc(c.handoff.continueMessage || 'Please continue where you left off.')}"></label>
    <h3 style="margin-top:8px">Usage checks</h3>
    <label class="field"><span>Re-check idle seats automatically</span><select name="autoCheckMin"><option value="0" ${!c.autoCheckMin ? 'selected' : ''}>Only when I press Check usage</option><option value="30" ${c.autoCheckMin == 30 ? 'selected' : ''}>Every 30 minutes</option><option value="60" ${c.autoCheckMin == 60 ? 'selected' : ''}>Every hour</option><option value="180" ${c.autoCheckMin == 180 ? 'selected' : ''}>Every 3 hours</option></select></label>
    <h3 style="margin-top:8px">Cost budget</h3>
    <label class="field"><span>Monthly budget (USD) <span class="muted">(0 = off; warns on the Usage page when this month's spend crosses it)</span></span><input name="budgetMonthlyUSD" type="number" min="0" step="1" value="${c.budgetMonthlyUSD || 0}"></label>
    <h3 style="margin-top:8px">Appearance</h3>
    <label class="field"><span>Theme</span><select name="theme"><option value="auto" ${theme === 'auto' ? 'selected' : ''}>Match the system</option><option value="light" ${theme === 'light' ? 'selected' : ''}>Light</option><option value="dark" ${theme === 'dark' ? 'selected' : ''}>Dark</option></select></label>
    <label class="field"><span>Motion</span><select name="motion"><option value="full" ${motion === 'full' ? 'selected' : ''}>Full</option><option value="reduced" ${motion === 'reduced' ? 'selected' : ''}>Reduced (fewer animations)</option></select></label>
    <div class="field"><span>Accent</span><div class="swatches">${Object.keys(ACCENTS).map(n => `<button type="button" class="swatch ${accent === n ? 'on' : ''}" data-accent="${n}" title="${n[0].toUpperCase() + n.slice(1)}"${ACCENTS[n] ? ` style="background:${ACCENTS[n][0]}"` : ''}>${ACCENTS[n] ? '' : '<span class="sw-g"></span>'}</button>`).join('')}</div></div>
    <h3 style="margin-top:8px">Terminal</h3>
    <div class="field-row"><label class="field"><span>Color theme</span><select name="termTheme">${Object.keys(TERM_THEMES).map(n => `<option value="${n}" ${tp.theme === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label><label class="field"><span>Font size</span><input name="termSize" type="number" min="9" max="22" value="${tp.fontSize}"></label></div>
    <label class="field"><span>Cursor</span><select name="termCursor">${['block', 'bar', 'underline'].map(cu => `<option value="${cu}" ${tp.cursor === cu ? 'selected' : ''}>${cu[0].toUpperCase() + cu.slice(1)}</option>`).join('')}</select></label>
    <h3 style="margin-top:8px">Notifications</h3>
    <label class="field inline"><input name="notifications" type="checkbox" ${c.notifications ? 'checked' : ''}><span>macOS notifications for handoffs, limits and recommendations</span></label>
    <label class="field inline"><input id="browserNotify" type="checkbox" ${notifyEnabled() ? 'checked' : ''}><span>Desktop notifications in this browser when a session finishes its turn or crashes</span></label>
    <div><button class="btn primary" type="submit">Save</button></div></form>
    <div class="card" style="margin-top:14px"><div class="card-head"><h2>Custom commands</h2></div>
      <p class="muted tiny" style="margin:0 0 10px">Reusable prompts you run often. Start a new session prewired with one, or run it from the command palette (⌘K).</p>
      <div class="list">${cmds().map((cc, i) => `<div class="row"><div class="grow" style="min-width:0"><div class="title">${esc(cc.name)}</div><div class="sub mono">${esc(cc.text)}</div></div><div class="actions"><button class="btn sm" data-cmd-run="${i}">New session</button><button class="btn sm danger" data-cmd-del="${i}">Delete</button></div></div>`).join('') || '<div class="empty">No commands yet. Add one below.</div>'}</div>
      <div class="inline-form" style="margin-top:10px"><input id="cmdName" placeholder="name, e.g. run tests"><input id="cmdText" placeholder="prompt, e.g. run the full test suite and fix failures"><button class="btn" id="cmdAdd" type="button">Add</button></div>
    </div>`;
}
function vHelp() {
  return `<div class="grid cols-2"><div class="card prose"><h3>How it works</h3><ol>
      <li>Every account is a <b>seat</b>: its own Claude Code login, isolated from the others. Projects, memory, plugins and history are shared.</li>
      <li>Claude Code keeps a cached usage reading per account and refreshes it while it runs. Cockpit only reads that file, never your tokens. <b>Check usage</b> opens Claude Code on an idle seat for a few seconds, asks it for <code>/usage</code>, and closes it. No prompt is sent.</li>
      <li>Sessions started here run inside the cockpit daemon. A Terminal window is only a view: close it and the session keeps running; reopen it from Sessions.</li>
      <li>Between turns, if the seat is past the threshold and another seat has more room, the session is exited and resumed with the same id on the other seat. If a limit hits mid-turn, the interrupted prompt is sent again.</li>
      <li>Any stored conversation on this laptop can be resumed on any seat from the Library.</li></ol>
      <h3>Policy</h3><p><b>Auto</b> moves sessions by itself. <b>Ask</b> only notifies; you press Hand off. <b>Off</b> never moves anything automatically. Change it in Settings.</p>
      <h3>Terms</h3><p class="muted">Anthropic's consumer terms treat using someone else's account as account sharing, and Team seats are per named user. Rotating one person's session across teammates' seats is this team's choice, with that risk.</p></div>
    <div class="card prose"><h3>In a terminal</h3><table class="cmds">
      <tr><td><code>cockpit start</code></td><td>Claude Code in this folder on the freshest seat</td></tr>
      <tr><td><code>cockpit start --seat priya -n api</code></td><td>pin a seat, name the session</td></tr>
      <tr><td><code>cockpit resume &lt;id or title&gt;</code></td><td>resume a stored session on the best seat</td></tr>
      <tr><td><code>cockpit attach [name]</code></td><td>re-enter a running session</td></tr>
      <tr><td><code>Ctrl-]</code></td><td>detach; the session keeps running</td></tr>
      <tr><td><code>cockpit handoff [name] --to bob</code></td><td>move a session now, or after its current turn</td></tr>
      <tr><td><code>cockpit usage</code></td><td>refresh every seat's 5-hour reading now</td></tr>
      <tr><td><code>cockpit status</code></td><td>seats, usage, sessions</td></tr>
      <tr><td><code>cockpit seat add &lt;name&gt;</code></td><td>log another account in as a seat</td></tr>
      <tr><td><code>cockpit daemon install</code></td><td>keep the daemon alive across reboots</td></tr></table>
      <p class="muted">Inside Claude Code nothing changes: same keys, same /commands. A handoff shows one cyan line, then the same conversation continues.</p></div></div>`;
}

/* ---------- render & wiring ---------- */
function exportCsv() {
  if (!usage) return;
  const rows = [['date', 'tokens', 'input', 'output', 'cacheRead', 'cacheWrite', 'turns', 'costUSD']];
  for (const d of usage.byDay || []) rows.push([d.day, tot(d), d.input, d.output, d.cacheRead, d.cacheWrite, d.turns, (d.cost || 0).toFixed(2)]);
  rows.push([]); rows.push(['top sessions (7d)', 'seat', 'turns', 'input', 'output', 'cacheRead', 'cacheWrite', 'costUSD']);
  for (const x of usage.topSessions || []) rows.push([(x.name || x.cs || '').replace(/,/g, ' '), x.seat || '', x.turns, x.input, x.output, x.cacheRead, x.cacheWrite, (x.cost || 0).toFixed(2)]);
  const csv = rows.map(r => r.join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a'); a.href = url; a.download = `cockpit-usage-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(url);
  toast('CSV downloaded');
}
async function deepSearch(q) {
  if (!q || q.length < 2) { deepResults = null; deepQuery = ''; render(); return; }
  deepQuery = q; toast('Searching inside conversations…');
  try { const r = await fetch('/api/search?q=' + encodeURIComponent(q)); deepResults = (await r.json()).results || []; }
  catch { deepResults = []; }
  render();
}
async function bulkAction(kind) {
  const ids = [...selected];
  if (kind === 'clear') { selected.clear(); render(); return; }
  if (!ids.length) return;
  try {
    if (kind === 'star') await post('/api/marks-batch', { sessionIds: ids, patch: { star: true } });
    else if (kind === 'unstar') await post('/api/marks-batch', { sessionIds: ids, patch: { star: false } });
    else if (kind === 'archive') await post('/api/marks-batch', { sessionIds: ids, patch: { archived: true } });
    else if (kind === 'unarchive') await post('/api/marks-batch', { sessionIds: ids, patch: { archived: false } });
    else if (kind === 'tag') { const t = prompt(`Tag ${ids.length} session(s) with:`); if (!t || !t.trim()) return; await post('/api/marks-batch', { sessionIds: ids, patch: { addTag: t.trim() } }); }
    else if (kind === 'project') { const p = prompt(`Move ${ids.length} session(s) to project (blank = back to auto):`); if (p === null) return; await post('/api/marks-batch', { sessionIds: ids, patch: { project: p.trim() } }); }
    else if (kind === 'delete') { if (!confirm(`Permanently delete ${ids.length} stored conversation(s)? This removes the transcript files and cannot be undone.`)) return; const j = await post('/api/library/delete', { sessionIds: ids }); toast(`Deleted ${j.deleted || 0}`); }
    selected.clear();
    await loadSlow();
    if (deepResults) await deepSearch(deepQuery);
    if (kind !== 'delete') toast(`Updated ${ids.length}`);
  } catch {}
}
let lastSig = null, lastRenderedView = null;
// A compact signature of exactly what the current view renders. When it is unchanged we skip
// rebuilding #content, so the 3s poll no longer flickers the page or steals focus, and it lets
// entrance motion play only when something actually changed, never on every poll.
function renderSig() {
  const seats = (state?.seats || []).map(s => [s.name, s.disabled, s.activeSessions, s.outsideSessions, s.usage?.fiveHour?.pct, s.usage?.loggedIn, !!s.probe?.running, Math.round((s.usage?.weekly || []).reduce((a, w) => a + (w.pct || 0), 0)), s.usage?.fetchedAt, s.usage?.fiveHour?.assumedReset, s.probe?.lastResult ? !!s.probe.lastResult.ok : 2]);
  const sess = (state?.sessions || []).map(s => [s.cs, s.status, s.seat, s.turns, s.handoffs?.length, s.viewers, s.alive, !!s.pendingHandoff, isStalled(s), s.git && [s.git.branch, s.git.dirty, s.git.ahead, s.git.behind].join(':'), !!s.worktree]);
  const ev = (state?.events || [])[0]?.at;
  const base = { view, dirty: [...dirtyForms], seats, sess, ev, probing: state?.probing, jobs: (state?.jobs || []).map(j => [j.id, j.status, j.at]),
    cfg: state?.config && [state.config.handoff?.mode, state.config.handoff?.thresholdPct, state.config.notifications, state.config.autoCheckMin] };
  if (view === 'usage') base.usage = usage && [usage.today?.total, usage.week?.total, usage.month?.total, usage.budgetMonthlyUSD, usage.all?.total, (usage.byDay || []).map(d => d.input + d.output + d.cacheRead + d.cacheWrite)];
  if (view === 'library') base.lib = { f: [libFilter, libGroup, libStar, libTag, libProject, showArchived], sel: selected.size, deep: deepResults ? deepResults.length : -1, dq: deepQuery, g: openGroups, pj: (projects || []).map(p => [p.id, p.name, p.folder, p.color]), rows: library.map(r => [r.sessionId, r.title, r.star, (r.tags || []).join(','), r.projectName, r.archived, Math.round(tot(r.tokens) / 1e5)]) };
  if (view === 'overview') base.ov = [library.length, usage && tot(usage.today?.total), usage && (usage.today?.total?.cost || 0), usage && tot(usage.week?.total), usage && (usage.month?.total?.cost || 0), usage && usage.budgetMonthlyUSD];
  if (view === 'tasks') { base.tasks = (state?.tasks || []).map(t => [t.id, t.status, t.order, t.title, t.project, t.projectId, t.seat, t.archived, t.autoKick, t.worktree, t.live && [t.live.status, t.live.needsYou, t.live.plan && (t.live.plan.done + '/' + t.live.plan.total), t.live.cost && Math.round(t.live.cost.usd)]]); base.tpf = taskProjectFilter; base.tcp = tbComposerProject; base.tbd = tbDoneOpen; }
  if (view === 'projects' || view === 'tasks') base.projects = (projects || []).map(p => [p.id, p.name, p.folder, (p.tags || []).join(','), p.color, p.openTasks, p.totalTasks, p.live]);
  if (view === 'projects') { base.psess = (state?.sessions || []).map(s => [s.cs, s.projectId, s.cwd, s.alive, s.status]); base.plib = (library || []).map(r => [r.sessionId, r.cwd, r.projectName, r.lastAt]); base.prf = (recentFolders || []).map(r => r.cwd); }
  return JSON.stringify(base);
}
// Count a number up to its target on view entrance. Elements opt in with data-count (raw value)
// and data-countfmt (tok | cost | int). Skipped for reduced-motion and the nomotion test flag.
function animateCounts(scope) {
  if (/\bnomotion\b/.test(location.search)) return;
  try { if (matchMedia('(prefers-reduced-motion: reduce)').matches) return; } catch {}
  scope.querySelectorAll('[data-count]').forEach(el => {
    const to = Number(el.dataset.count) || 0; if (!to) return;
    const fmt = el.dataset.countfmt || 'int';
    const fmtv = v => fmt === 'tok' ? fmtTok(v) : fmt === 'cost' ? fmtCost(v) : String(Math.round(v));
    const t0 = performance.now(), dur = 560;
    const tick = now => { const p = Math.min(1, (now - t0) / dur); el.textContent = fmtv(to * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(tick); else el.textContent = fmtv(to); };
    requestAnimationFrame(tick);
  });
}
// ---- Tasks board -------------------------------------------------------------
const TB_COLS = [['backlog', 'Backlog'], ['ready', 'Ready'], ['inprogress', 'In progress'], ['done', 'Done']];
const TB_DONE_PREVIEW = 3;   // Done shows this many most-recent cards; the rest hide behind a dropdown
function tbSeatOptions(cur) { return '<option value="">no seat</option>' + (state?.seats || []).filter(s => !s.disabled).map(s => `<option value="${esc(s.name)}"${cur === s.name ? ' selected' : ''}>${esc(s.name)}</option>`).join(''); }
function tbPlan(plan) {
  if (!plan || !plan.items || !plan.items.length) return '';
  const rows = plan.items.map(i => { const st = i.state === 'completed' ? 'done' : (i.state === 'in_progress' ? 'active' : ''); return `<div class="tb-todo ${st}"><span class="tb-box">${i.state === 'completed' ? '✓' : ''}</span><span class="tb-tx">${esc(i.text)}</span></div>`; }).join('');
  return `<div class="tb-planbox"><div class="tb-plan-h"><span>Plan</span><span class="num">${plan.done}/${plan.total}</span></div>${rows}</div>`;
}
// Board motion (ported from the Depth mockup): rAF springs animate from the live value,
// take the finger's release velocity, and are interruptible — no CSS transitions on moving cards.
function tbReduce() { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } }
function tbSpring2D(node, x0, y0, o, done) {
  let x = x0, y = y0, vx = o.vx || 0, vy = o.vy || 0; const k = o.k || 440, c = o.c || 34; let last = performance.now(), raf;
  node.style.willChange = 'transform'; node.style.transform = `translate(${x}px,${y}px)`;
  const step = t => {
    const dt = Math.min(0.05, (t - last) / 1000); last = t;
    vx += (-k * x - c * vx) * dt; x += vx * dt; vy += (-k * y - c * vy) * dt; y += vy * dt;
    node.style.transform = `translate(${x}px,${y}px)`;
    if (Math.hypot(x, y) < 0.4 && Math.hypot(vx, vy) < 0.5) { node.style.transform = ''; node.style.willChange = ''; done && done(); return; }
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return { stop() { cancelAnimationFrame(raf); node.style.willChange = ''; } };
}
function tbPulse(n) { if (!n || tbReduce()) return; try { n.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.04)' }, { transform: 'scale(1)' }], { duration: 440, easing: 'cubic-bezier(.22,1,.36,1)' }); } catch {} }
// FLIP: capture card positions, then after a rebuild glide every card from where it was.
function tbCapture() { const m = new Map(); document.querySelectorAll('#content .tb-card').forEach(n => m.set(n.dataset.id, n.getBoundingClientRect())); return m; }
function tbPlay(first) {
  if (tbReduce()) return;
  document.querySelectorAll('#content .tb-card').forEach(n => {
    const a = n.getBoundingClientRect(), b = first.get(n.dataset.id);
    if (b) { const dx = b.left - a.left, dy = b.top - a.top; if (dx || dy) tbSpring2D(n, dx, dy, { k: 380, c: 30 }); }
    else { try { n.animate([{ opacity: 0, transform: 'translateY(8px) scale(.95)' }, { opacity: 1, transform: 'none' }], { duration: 440, easing: 'cubic-bezier(.34,1.56,.64,1)' }); } catch {} n.classList.add('tb-justadded'); setTimeout(() => n.classList.remove('tb-justadded'), 900); }
  });
}
// Run a status-changing action, then reconcile with one rebuild and glide the cards into their new slots.
async function tbMutate(fn) {
  const first = tbCapture();
  dirtyForms.add('tasks');              // freeze the board while the server catches up (poll renders bail)
  try { await fn(); } catch {}
  dirtyForms.delete('tasks');
  await load();                         // authoritative rebuild
  tbPlay(first);
}
function tbCard(t) {
  const live = t.live, running = live && live.alive, needs = live && live.needsYou;
  const cost = live && live.cost ? `<span class="tb-cost">$<b>${(live.cost.usd || 0).toFixed(2)}</b> · ${fmtTok(live.cost.tokens)}</span>` : '';
  let right = '';
  if (t.status === 'done') right = '<span class="badge ok">✓ done</span>';
  else if (needs) right = '<span class="badge warn">● needs you</span>';
  else if (running) right = '<span class="badge accent">● running</span>';
  const actionable = t.status !== 'done' && !running;
  const launch = actionable ? `<button class="btn sm primary" data-tact="launch" data-id="${t.id}">▶ Launch</button>` : '';
  const body = (live && live.plan) ? tbPlan(live.plan) : (t.desc ? `<div class="tb-desc">${esc(t.desc)}</div>` : '');
  const seat = t.seat ? `<span class="tb-av">${esc(t.seat.slice(0, 2))}</span>${esc(t.seat)}` : '<span class="muted">no seat</span>';
  return `<article class="tb-card" data-id="${t.id}" data-status="${t.status}">
    <div class="tb-top"><span class="tb-tag">#${esc(t.project || '—')}</span>${right}</div>
    <div class="tb-title">${esc(t.title || 'Untitled')}</div>
    ${body}
    <div class="tb-foot"><div class="tb-meta"><span class="tb-seat">${seat}</span>${cost ? '<span class="muted">·</span>' + cost : ''}</div>${launch}<button class="btn ghost sm tb-chev" data-tact="expand" data-id="${t.id}">⌄</button></div>
    <div class="tb-detail" data-detail="${t.id}" hidden>
      <label class="tb-row"><span>Folder</span><input class="inp sm" data-field="cwd" data-id="${t.id}" list="tbProjects" value="${esc(t.cwd || '')}" placeholder="/Users/you/project"></label>
      <label class="tb-row"><span>Seat</span><select class="sel sm" data-field="seat" data-id="${t.id}">${tbSeatOptions(t.seat)}</select></label>
      <textarea class="inp sm tb-ta" data-field="desc" data-id="${t.id}" placeholder="Description — becomes the opening prompt when auto-start is on">${esc(t.desc || '')}</textarea>
      <label class="tb-check"><input type="checkbox" data-field="autoKick" data-id="${t.id}" ${t.autoKick !== false ? 'checked' : ''}> Auto-start from description</label>
      <label class="tb-check"><input type="checkbox" data-field="worktree" data-id="${t.id}" ${t.worktree ? 'checked' : ''}> Run in an isolated worktree</label>
      <div class="tb-detail-actions">
        ${running ? `<button class="btn sm" data-tact="attach" data-cs="${esc(live.cs)}">Attach</button><button class="btn sm danger" data-tact="stop" data-cs="${esc(live.cs)}">Stop</button>` : ''}
        ${t.status !== 'done' ? `<button class="btn sm" data-tact="done" data-id="${t.id}">Mark done</button>` : `<button class="btn sm" data-tact="reopen" data-id="${t.id}">Re-open</button>`}
        <button class="btn sm ghost danger" data-tact="delete" data-id="${t.id}">Delete</button>
      </div>
    </div>
  </article>`;
}
function vTasks() {
  let tasks = state?.tasks || [];
  const fp = (taskProjectFilter && (projects || []).some(p => p.id === taskProjectFilter)) ? taskProjectFilter : '';
  if (taskProjectFilter && !fp) taskProjectFilter = '';            // project was deleted; drop the stale filter
  if (fp) tasks = tasks.filter(t => t.projectId === fp);
  const composerDefault = fp || tbComposerProject;
  const cols = TB_COLS.map(([key, label]) => {
    const items = tasks.filter(t => t.status === key).sort((a, b) => (a.order || 0) - (b.order || 0));
    const cards = items.map(tbCard).join('');
    if (key === 'done') {
      // Show the most recently finished few; the rest tuck away behind a "Show N more" dropdown.
      const recent = items.slice().sort((a, b) => (b.completedAt || b.updatedAt || b.order || 0) - (a.completedAt || a.updatedAt || a.order || 0));
      const shown = tbDoneOpen ? recent : recent.slice(0, TB_DONE_PREVIEW);
      const hidden = recent.length - shown.length;
      const dcards = shown.map(tbCard).join('') || '<div class="tb-empty"></div>';
      const chev = '<svg class="tb-more-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
      const more = recent.length > TB_DONE_PREVIEW ? `<button type="button" class="tb-done-more" data-tb-done aria-expanded="${tbDoneOpen}">${tbDoneOpen ? 'Show less' : `Show ${hidden} more`}${chev}</button>` : '';
      return `<div class="tb-col tbc-done" data-status="${key}"><div class="tb-colhead"><span class="tb-colname">${label}</span><span class="tb-colcount num">${items.length}</span></div><div class="tb-cards" data-drop="${key}">${dcards}</div>${more}</div>`;
    }
    const folderSvg = '<svg class="tb-add-ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
    const add = key === 'backlog' ? `<form class="tb-add" id="tbAdd" autocomplete="off">
      <input class="tb-add-title" name="ttitle" placeholder="Add a task…" aria-label="Task title" autocomplete="off" spellcheck="false">
      <div class="tb-add-row">
        <label class="tb-add-proj" title="Link this task to a project">${folderSvg}<select class="tb-add-sel" name="tproj" aria-label="Project">${projectOptionsHtml(composerDefault)}</select><span class="tb-add-caret" aria-hidden="true">▾</span></label>
        <button class="tb-add-btn" type="submit" aria-label="Add task" disabled>Add</button>
      </div>
    </form>` : '';
    return `<div class="tb-col" data-status="${key}"><div class="tb-colhead"><span class="tb-colname">${label}</span><span class="tb-colcount num">${items.length}</span></div><div class="tb-cards" data-drop="${key}">${cards || '<div class="tb-empty"></div>'}${add}</div></div>`;
  }).join('');
  const sp = fp ? selectedProject(fp) : null;
  const filterBar = sp ? `<div class="tb-filter"><span class="muted">Showing</span><span class="tag"><span class="proj-dot sm" style="background:${esc(sp.color || 'var(--accent)')}"></span>${esc(sp.name)}</span><button class="btn sm ghost" id="tbClearFilter">Show all ✕</button></div>` : '';
  const folders = [...new Set([...(recentFolders || []).map(r => r.cwd), ...(projects || []).map(p => p.folder).filter(Boolean)])];
  return `<datalist id="tbProjects">${folders.map(c => `<option value="${esc(c)}">`).join('')}</datalist>${filterBar}<div class="tb-board">${cols}</div>`;
}
function wireTasks(el) {
  const byId = id => (state?.tasks || []).find(t => t.id === id) || null;
  const clr = el.querySelector('#tbClearFilter'); if (clr) clr.onclick = () => { taskProjectFilter = ''; lastSig = null; render(); };
  // Reveal / hide the older done cards. Rebuilds the board, then staggers the newly shown cards in.
  const doneToggle = el.querySelector('[data-tb-done]');
  if (doneToggle) doneToggle.onclick = () => {
    const opening = !tbDoneOpen;
    tbDoneOpen = opening; saveTbDone(); lastSig = null; render();
    if (opening && !tbReduce()) requestAnimationFrame(() => {
      [...document.querySelectorAll('#content .tbc-done .tb-card')].slice(TB_DONE_PREVIEW).forEach((n, i) => {
        try { n.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 340, delay: i * 50, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' }); } catch {}
      });
    });
  };
  const prevSib = n => { let p = n.previousElementSibling; while (p && !p.classList.contains('tb-card')) p = p.previousElementSibling; return p; };
  const nextSib = n => { let p = n.nextElementSibling; while (p && !p.classList.contains('tb-card')) p = p.nextElementSibling; return p; };
  const updateCounts = () => el.querySelectorAll('.tb-col').forEach(col => { const c = col.querySelector('.tb-colcount'); if (c) c.textContent = col.querySelectorAll('.tb-cards .tb-card').length; });

  const toggleDetail = id => {
    const d = el.querySelector(`[data-detail="${id}"]`); if (!d) return;
    const card = el.querySelector(`.tb-card[data-id="${id}"]`), open = d.hidden;
    d.hidden = !open; if (card) card.classList.toggle('tb-expanded', open);
    if (open && !tbReduce()) { try { const h = d.scrollHeight; d.animate([{ height: '0px', opacity: 0 }, { height: h + 'px', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)' }); } catch {} }
  };

  el.querySelectorAll('[data-tact]').forEach(b => b.onclick = async ev => {
    ev.stopPropagation();
    const act = b.dataset.tact, id = b.dataset.id, cs = b.dataset.cs;
    if (act === 'expand') return toggleDetail(id);
    if (act === 'launch') { tbPulse(el.querySelector(`.tb-card[data-id="${id}"]`)); return tbMutate(async () => { await post(`/api/tasks/${id}/launch`); toast('Launching — Claude is starting on it'); }); }
    if (act === 'done') return tbMutate(() => post(`/api/tasks/${id}`, { status: 'done' }));
    if (act === 'reopen') return tbMutate(() => post(`/api/tasks/${id}`, { status: 'ready' }));
    if (act === 'delete') {
      if (!confirm('Delete this task? This cannot be undone.')) return;
      const card = el.querySelector(`.tb-card[data-id="${id}"]`);
      if (card && !tbReduce()) { try { card.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(.96)' }], { duration: 160, easing: 'ease-in' }); } catch {} }
      return tbMutate(() => post(`/api/tasks/${id}/delete`));
    }
    try {
      if (act === 'attach') await openSession(cs, 'browser');
      else if (act === 'stop') { await post(`/api/sessions/${cs}/stop`); toast('Session stopped'); }
    } catch {}
    setTimeout(load, 250);
  });

  el.querySelectorAll('[data-field]').forEach(f => {
    f.onchange = async () => { const body = {}; body[f.dataset.field] = f.type === 'checkbox' ? f.checked : f.value; try { await post(`/api/tasks/${f.dataset.id}`, body); } catch {} };
  });

  const add = el.querySelector('#tbAdd');
  if (add) {
    const titleEl = add.querySelector('[name=ttitle]');
    const btn = add.querySelector('.tb-add-btn');
    const sync = () => { if (btn) btn.disabled = !titleEl.value.trim(); };
    const projSel = add.querySelector('[name=tproj]');
    const submitAdd = async () => {
      const title = titleEl.value.trim(); if (!title) return;
      const projectId = projSel && projSel.value && projSel.value !== '__new__' ? projSel.value : null;
      titleEl.value = ''; sync();
      await tbMutate(() => post('/api/tasks', { title, projectId }));
      toast(`Added “${title}” to Backlog`);
      // Keep the flow going: refocus the fresh composer so you can brain-dump a backlog.
      const again = el.querySelector('#tbAdd [name=ttitle]'); if (again) { again.focus(); dirtyForms.add('tasks'); }
    };
    // Project picker: remember the pick across adds; "+ New project…" opens the dialog, keeping any typed title.
    if (projSel) {
      let prev = projSel.value;
      const remember = () => { if (projSel.value !== '__new__') prev = projSel.value; };
      projSel.addEventListener('focus', remember); projSel.addEventListener('mousedown', remember);
      projSel.addEventListener('change', () => {
        if (projSel.value === '__new__') {
          projSel.value = prev;
          const keep = titleEl.value;
          openNewProject(pr => {
            tbComposerProject = pr.id; dirtyForms.delete('tasks'); lastSig = null; render();
            const t = el.querySelector('#tbAdd [name=ttitle]');
            if (t) { t.value = keep; t.focus(); if (keep.trim()) { dirtyForms.add('tasks'); const btn = el.querySelector('#tbAdd .tb-add-btn'); if (btn) btn.disabled = false; } }
          });
        } else { prev = projSel.value; tbComposerProject = projSel.value; }
      });
    }
    // Freeze poll-driven rebuilds while composing, so a background refresh can't wipe what you type.
    titleEl.addEventListener('input', () => { dirtyForms.add('tasks'); sync(); });
    add.addEventListener('focusin', () => dirtyForms.add('tasks'));
    add.addEventListener('focusout', () => { if (!titleEl.value.trim()) dirtyForms.delete('tasks'); });
    // Enter commits even where the browser wouldn't implicitly submit; stop it bubbling to global keys.
    titleEl.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); submitAdd(); } else if (e.key === 'Escape') { e.preventDefault(); titleEl.value = ''; sync(); titleEl.blur(); } });
    add.onsubmit = ev => { ev.preventDefault(); submitAdd(); };
    sync();
  }

  // --- spring drag: 1:1 tracking, live reflow under the finger, velocity handoff on drop ---
  let drag = null;
  const phBefore = ph => { let n = ph.nextElementSibling; while (n && !n.classList.contains('tb-card')) n = n.nextElementSibling; return n || null; };
  // position:fixed is viewport-relative only when no ancestor forms a containing block.
  // A transform/filter/perspective/will-change/contain/backdrop-filter on any ancestor re-roots it
  // to that ancestor, so our viewport coords would land offset. Measure that origin and subtract it.
  const cbOrigin = node => {
    for (let p = node.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.transform !== 'none' || cs.perspective !== 'none' || (cs.filter && cs.filter !== 'none')
        || (cs.backdropFilter && cs.backdropFilter !== 'none')
        || (cs.willChange && /transform|filter|perspective/.test(cs.willChange))
        || (cs.contain && /\b(paint|layout|strict|content)\b/.test(cs.contain))) {
        const r = p.getBoundingClientRect(); return { x: r.left, y: r.top };
      }
    }
    return { x: 0, y: 0 };
  };
  const insertPh = (list, before) => {
    if (before) return list.insertBefore(drag.ph, before);
    const anchor = list.querySelector('.tb-add') || list.querySelector('.tb-empty');
    if (anchor) list.insertBefore(drag.ph, anchor); else list.appendChild(drag.ph);
  };
  const transY = n => { const m = /translate\([^,]+,\s*(-?[\d.]+)px\)/.exec(n.style.transform || ''); return m ? parseFloat(m[1]) : 0; };
  const computeTarget = (x, y) => {
    const lists = Array.from(el.querySelectorAll('.tb-cards')); let list = null;
    for (const l of lists) { const cr = l.closest('.tb-col').getBoundingClientRect(); if (x >= cr.left && x <= cr.right) { list = l; break; } }
    if (!list) { let best = Infinity; for (const l of lists) { const r = l.getBoundingClientRect(), d = Math.abs((r.left + r.right) / 2 - x); if (d < best) { best = d; list = l; } } }
    if (!list) return null;
    // Measure each sibling at its RESTING position (rect minus its live spring offset), so a card
    // that is still gliding from a previous reflow doesn't skew — or empty out — the insertion test.
    const cards = Array.from(list.querySelectorAll('.tb-card')).filter(n => n !== drag.el);
    let before = null;
    for (const c of cards) { const r = c.getBoundingClientRect(), restTop = r.top - transY(c); if (y < restTop + r.height / 2) { before = c; break; } }
    return { list, before };
  };
  const reflowTo = (list, before) => {
    const oldList = drag.ph.parentNode, lists = (oldList && oldList !== list) ? [oldList, list] : [list], nodes = [];
    lists.forEach(l => l.querySelectorAll('.tb-card').forEach(n => { if (n !== drag.el) nodes.push(n); }));
    const first = nodes.map(n => n.getBoundingClientRect());
    nodes.forEach(n => { if (n._spring) { n._spring.stop(); n._spring = null; } n.style.transform = ''; });
    insertPh(list, before);
    if (tbReduce()) return;
    const last = nodes.map(n => n.getBoundingClientRect());
    nodes.forEach((n, i) => { const dx = first[i].left - last[i].left, dy = first[i].top - last[i].top; if (dx || dy) n._spring = tbSpring2D(n, dx, dy, { k: 520, c: 36 }, () => { n._spring = null; }); });
  };
  const begin = () => {
    const card = drag.el, ph = document.createElement('div'); ph.className = 'tb-ph'; ph.style.height = drag.h + 'px'; drag.ph = ph;
    card.after(ph);                       // leave a placeholder where the card was
    try { card.getAnimations().forEach(a => a.cancel()); } catch {}   // drop any entrance/spring animation so it can't fight the drag transform
    document.body.appendChild(card);     // reparent out of the board: fixed is now viewport-relative no matter what any ancestor's transform does mid-drag
    drag.cb = cbOrigin(card);            // normally {0,0}; still compensates if body/html ever forms a containing block
    if (!tbReduce()) { try { ph.animate([{ height: '0px', opacity: 0 }, { height: drag.h + 'px', opacity: 1 }], { duration: 200, easing: 'cubic-bezier(.22,1,.36,1)' }); } catch {} }
    card.classList.add('tb-dragging');
    Object.assign(card.style, { position: 'fixed', zIndex: '1000', width: drag.w + 'px', margin: '0', pointerEvents: 'none', left: (drag.sx - drag.offX - drag.cb.x) + 'px', top: (drag.sy - drag.offY - drag.cb.y) + 'px', transform: 'scale(1.03)' });
    dirtyForms.add('tasks');            // hold the board still for the whole gesture
  };
  const onMove = e => {
    if (!drag) return;
    if (!drag.moved) { if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 6) return; drag.moved = true; begin(); drag.lastX = e.clientX; }
    const tt = Math.max(-4, Math.min(4, (e.clientX - (drag.lastX != null ? drag.lastX : e.clientX)) * 0.7)); drag.lastX = e.clientX;
    drag.tilt += (tt - drag.tilt) * 0.35;
    drag.el.style.left = (e.clientX - drag.offX - drag.cb.x) + 'px'; drag.el.style.top = (e.clientY - drag.offY - drag.cb.y) + 'px'; drag.el.style.transform = `scale(1.03) rotate(${drag.tilt.toFixed(2)}deg)`;
    drag.hist.push({ x: e.clientX, y: e.clientY, t: performance.now() }); if (drag.hist.length > 6) drag.hist.shift();
    const tgt = computeTarget(e.clientX, e.clientY);
    if (tgt && !(drag.ph.parentNode === tgt.list && phBefore(drag.ph) === tgt.before)) reflowTo(tgt.list, tgt.before);
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    if (!drag) return;
    if (!drag.moved) { const id = drag.t; drag = null; return toggleDetail(id); }
    const card = drag.el, ph = drag.ph, h = drag.hist, id = card.dataset.id; let vx = 0, vy = 0;
    if (h.length >= 2) { const a = h[h.length - 1], b = h[0], dt = Math.max(16, a.t - b.t); vx = (a.x - b.x) / dt * 1000; vy = (a.y - b.y) / dt * 1000; }
    card.style.transform = ''; const relRect = card.getBoundingClientRect();
    card.classList.remove('tb-dragging'); card.removeAttribute('style');
    if (ph && ph.parentNode) ph.replaceWith(card);
    const list = card.closest('.tb-cards'), status = list ? list.dataset.drop : (byId(id)?.status || 'backlog');
    const p = prevSib(card), n = nextSib(card), po = p && byId(p.dataset.id) ? byId(p.dataset.id).order : null, no = n && byId(n.dataset.id) ? byId(n.dataset.id).order : null;
    const order = (po != null && no != null) ? (po + no) / 2 : (po != null ? po + 1 : (no != null ? no - 1 : Date.now()));
    card.dataset.status = status; updateCounts();
    const slot = card.getBoundingClientRect(), dx = relRect.left - slot.left, dy = relRect.top - slot.top;
    const finalize = async () => { try { await post(`/api/tasks/${id}`, { status, order }); } catch {} dirtyForms.delete('tasks'); load(); };
    if (tbReduce()) finalize(); else tbSpring2D(card, dx, dy, { vx, vy, k: 440, c: 34 }, finalize);
    drag = null;
  };
  el.querySelectorAll('.tb-card').forEach(card => card.addEventListener('pointerdown', e => {
    if (e.button != null && e.button !== 0) return;
    if (e.target.closest('button, a, input, select, textarea, label, .tb-detail')) return;
    const r = card.getBoundingClientRect();
    drag = { t: card.dataset.id, el: card, offX: e.clientX - r.left, offY: e.clientY - r.top, w: r.width, h: r.height, sx: e.clientX, sy: e.clientY, moved: false, ph: null, tilt: 0, lastX: null, hist: [{ x: e.clientX, y: e.clientY, t: performance.now() }] };
    try { card.setPointerCapture(e.pointerId); } catch {}
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp, { once: true });
  }));
}
/* ---------- Projects ---------- */
function selectedProject(id) { return (projects || []).find(p => p.id === id) || null; }
const baseName = f => (f || '').replace(/\/+$/, '').split('/').pop() || f || '';
// A folder's stored conversations (full history from the library), newest first.
function convsFor(folder) { if (!folder) return []; return (library || []).filter(r => r.cwd === folder || r.projectPath === folder).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)); }
// Sessions cockpit is tracking as alive, for this project (by id) or folder.
function liveFor(folder, pid) { return (state?.sessions || []).filter(s => s.kind !== 'probe' && s.alive && ((pid && s.projectId === pid) || (folder && s.cwd === folder))); }
// Rows shown under a project/folder: live sessions first (openable), then recent past conversations.
function activityRows(folder, pid) {
  const live = liveFor(folder, pid), convs = convsFor(folder);
  const liveIds = new Set(live.map(s => s.sessionId));
  const past = convs.filter(c => !liveIds.has(c.sessionId)).slice(0, Math.max(0, 3 - live.length));
  if (!live.length && !past.length) return '';
  const ctx = pid ? `data-pact="reveal" data-pid="${esc(pid)}"` : `data-pact="reveal" data-folder="${esc(folder || '')}"`;
  const liveHtml = live.slice(0, 4).map(s => `<button class="proj-live-row" data-pact="open" data-cs="${esc(s.cs)}" title="Open this live session"><span class="dot ${s.status === 'idle' ? 'starting' : 'busy'}"></span><span class="proj-live-nm">${esc(s.name || short(s.cwd || '') || s.cs)}</span><span class="muted">${esc(s.seat || '')}</span></button>`).join('');
  const pastHtml = past.map(c => `<button class="proj-live-row" ${ctx} title="Show all sessions"><span class="dot"></span><span class="proj-live-nm">${esc(c.title || c.sessionId.slice(0, 8))}</span><span class="muted">${esc(ago(c.lastAt))}</span></button>`).join('');
  return `<div class="proj-live">${liveHtml}${pastHtml}</div>`;
}
// Options for a project <select>: "No project", every project, then the "+ New project…" sentinel.
function projectOptionsHtml(selId, noneLabel = 'No project') {
  const valid = (projects || []).some(p => p.id === selId) ? selId : '';
  const opts = (projects || []).map(p => `<option value="${esc(p.id)}"${p.id === valid ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
  return `<option value=""${!valid ? ' selected' : ''}>${noneLabel}</option>${opts}<option value="__new__">+ New project…</option>`;
}
// Wire a project <select> so the sentinel opens the create dialog and the result gets selected. Returns nothing.
function wireProjectSelect(sel, onPick) {
  let prev = sel.value;
  const remember = () => { if (sel.value !== '__new__') prev = sel.value; };
  sel.addEventListener('focus', remember); sel.addEventListener('mousedown', remember);
  sel.addEventListener('change', () => {
    if (sel.value === '__new__') {
      sel.value = prev;
      openNewProject(pr => { if (![...sel.options].some(o => o.value === pr.id)) sel.add(new Option(pr.name, pr.id), sel.options[sel.options.length - 1]); sel.value = pr.id; prev = pr.id; onPick && onPick(pr); });
    } else { prev = sel.value; onPick && onPick(selectedProject(sel.value)); }
  });
}

// --- New / Edit project dialog (shared by the hub, the Tasks composer, and New Session) ---
const projScrim = $('#projScrim'), projForm = $('#newProject');
let projFolderMode = 'existing', projEditingId = null, projDoneCb = null;
function setProjFolderMode(mode) {
  projFolderMode = mode;
  $('#projFolderMode').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.fm === mode));
  const wrap = $('#projFolderWrap'), inp = projForm.pfolder, hint = $('#projFolderHint');
  if (mode === 'none') { wrap.style.display = 'none'; }
  else { wrap.style.display = ''; inp.placeholder = mode === 'new' ? '~/code/new-project' : '~/code/existing-project'; hint.textContent = mode === 'new' ? "I'll create this folder if it doesn't exist." : 'Point at a folder that already exists.'; }
}
function openProjectDialog({ project = null, prefill = null, onDone = null } = {}) {
  projEditingId = project ? project.id : null; projDoneCb = onDone;
  projForm.reset();
  $('#projFolders').innerHTML = (recentFolders || []).map(r => `<option value="${esc(short(r.cwd))}">`).join('');
  $('#projTitle').textContent = project ? 'Edit project' : 'New project';
  $('#projSubmit').textContent = project ? 'Save' : 'Create project';
  if (project) {
    projForm.pname.value = project.name || ''; projForm.ptags.value = (project.tags || []).join(', ');
    if (project.folder) { setProjFolderMode('existing'); projForm.pfolder.value = short(project.folder); } else setProjFolderMode('none');
  } else if (prefill) {
    projForm.pname.value = prefill.name || ''; setProjFolderMode('existing'); if (prefill.folder) projForm.pfolder.value = short(prefill.folder);
  } else setProjFolderMode('existing');
  projScrim.hidden = false; setTimeout(() => { projForm.pname.focus(); projForm.pname.select(); }, 30);
}
function openNewProject(cb) { openProjectDialog({ onDone: cb }); }
function closeProjectDialog() { projScrim.hidden = true; projDoneCb = null; projEditingId = null; }
$('#projClose').onclick = closeProjectDialog; $('#projCancel').onclick = closeProjectDialog;
projScrim.addEventListener('click', e => { if (e.target === projScrim) closeProjectDialog(); });
$('#projFolderMode').querySelectorAll('button').forEach(b => b.onclick = () => setProjFolderMode(b.dataset.fm));
projForm.addEventListener('submit', async ev => {
  ev.preventDefault();
  const name = projForm.pname.value.trim(); if (!name) return projForm.pname.focus();
  const body = { name };
  if (projFolderMode === 'none') body.folder = '';
  else { const f = projForm.pfolder.value.trim(); body.folder = f; if (f) body.createFolder = projFolderMode === 'new'; }
  body.tags = projForm.ptags.value.split(',').map(s => s.trim()).filter(Boolean);
  try {
    const j = projEditingId ? await post(`/api/projects/${projEditingId}`, body) : await post('/api/projects', body);
    const cb = projDoneCb, editing = projEditingId; closeProjectDialog();
    if (j.project && !projects.some(p => p.id === j.project.id)) projects = [...projects, j.project];
    toast(editing ? 'Project saved' : `Project “${name}” created`);
    await load(); loadSlow();
    if (cb && j.project) cb(j.project);
  } catch {}
});
window.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !projScrim.hidden) { ev.stopPropagation(); closeProjectDialog(); } else if (ev.key === 'Escape' && projDrawerEl && !projDrawerEl.hidden) { ev.stopPropagation(); closeProjDrawer(); } });

// --- Project sessions drawer: slides in from the right, staggers its rows into view. ---
let projDrawerEl = null;
function ensureProjDrawer() {
  if (projDrawerEl) return projDrawerEl;
  const scrim = document.createElement('div');
  scrim.className = 'drawer-scrim'; scrim.hidden = true;
  scrim.innerHTML = '<aside class="drawer" role="dialog" aria-modal="true" aria-label="Project sessions"><div class="drawer-inner"></div></aside>';
  document.body.appendChild(scrim);
  scrim.addEventListener('click', e => { if (e.target === scrim) closeProjDrawer(); });
  projDrawerEl = scrim; return scrim;
}
function closeProjDrawer() {
  if (!projDrawerEl || projDrawerEl.hidden) return;
  const panel = projDrawerEl.querySelector('.drawer');
  if (tbReduce()) { projDrawerEl.hidden = true; return; }
  projDrawerEl.classList.remove('open');
  let done = false; const finish = () => { if (done) return; done = true; projDrawerEl.hidden = true; };
  panel.addEventListener('transitionend', finish, { once: true }); setTimeout(finish, 440);
}
function openProjDrawer({ pid = null, folder = null } = {}) {
  const pr = pid ? selectedProject(pid) : null;
  const f = pr ? pr.folder : folder;
  const name = pr ? pr.name : baseName(f || '');
  const color = pr ? (pr.color || 'var(--accent)') : 'var(--faint)';
  const live = liveFor(f, pid);
  const liveIds = new Set(live.map(s => s.sessionId));
  const convs = convsFor(f).filter(c => !liveIds.has(c.sessionId));
  const scrim = ensureProjDrawer(), inner = scrim.querySelector('.drawer-inner');
  const liveHtml = live.length ? `<div class="drawer-sec"><div class="drawer-sec-h">Live now</div>${live.map(s => `<button class="drawer-row" data-dopen="${esc(s.cs)}"><span class="dot ${s.status === 'idle' ? 'starting' : 'busy'}"></span><span class="drawer-row-main"><span class="drawer-row-t">${esc(s.name || short(s.cwd || '') || s.cs)}</span><span class="drawer-row-m">${esc(s.seat || 'best seat')} · ${esc(s.status)}</span></span><span class="drawer-row-go">Open ›</span></button>`).join('')}</div>` : '';
  const histHtml = convs.length ? `<div class="drawer-sec"><div class="drawer-sec-h">History <span class="muted">${convs.length}</span></div>${convs.slice(0, 60).map(c => `<button class="drawer-row" data-dresume="${esc(c.sessionId)}" data-dcwd="${esc(c.cwd || f || '')}"><span class="dot"></span><span class="drawer-row-main"><span class="drawer-row-t">${esc(c.title || c.sessionId.slice(0, 8))}</span><span class="drawer-row-m">${esc(ago(c.lastAt))}${c.cwd && c.cwd !== f ? ' · ' + esc(short(c.cwd)) : ''}</span></span><span class="drawer-row-go">Resume ›</span></button>`).join('')}</div>` : '';
  const empty = (!live.length && !convs.length) ? '<div class="drawer-empty">No sessions or conversations here yet. Launch one from a task, or start a New session.</div>' : '';
  inner.innerHTML = `
    <div class="drawer-head"><div class="drawer-title"><span class="proj-dot" style="background:${esc(color)}"></span><span>${esc(name)}</span></div><button class="btn ghost sm" data-dclose aria-label="Close">✕</button></div>
    ${f ? `<div class="drawer-folder mono">${esc(short(f))}</div>` : ''}
    <div class="drawer-body">${liveHtml}${histHtml}${empty}</div>
    <div class="drawer-foot"><button class="btn sm" ${pid ? `data-dlib-proj="${esc(pid)}"` : `data-dlib-folder="${esc(f || '')}"`}>Open in Library →</button></div>`;
  inner.querySelector('[data-dclose]').onclick = closeProjDrawer;
  inner.querySelectorAll('[data-dopen]').forEach(b => b.onclick = async () => { try { await openSession(b.dataset.dopen, 'browser'); } catch {} });
  inner.querySelectorAll('[data-dresume]').forEach(b => b.onclick = async () => { try { await startSession({ resumeId: b.dataset.dresume, cwd: b.dataset.dcwd || undefined }, 'browser'); closeProjDrawer(); } catch {} });
  const lib = inner.querySelector('[data-dlib-proj],[data-dlib-folder]');
  if (lib) lib.onclick = () => { if (lib.dataset.dlibProj) { libProject = lib.dataset.dlibProj; libFilter = ''; } else { libFilter = lib.dataset.dlibFolder; libProject = ''; } closeProjDrawer(); lastSig = null; location.hash = '#/library'; };
  scrim.hidden = false;
  requestAnimationFrame(() => {
    scrim.classList.add('open');
    if (!tbReduce()) inner.querySelectorAll('.drawer-row').forEach((r, i) => { try { r.animate([{ opacity: 0, transform: 'translateX(16px)' }, { opacity: 1, transform: 'none' }], { duration: 380, delay: 60 + i * 34, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' }); } catch {} });
  });
}

function vProjects() {
  const list = projects || [];
  const head = `<div class="proj-head"><div><h2 class="proj-h">Projects</h2><div class="muted">Tasks, live sessions and history, in one place</div></div><button class="btn primary" id="projNew">+ New project</button></div>`;
  const cards = list.map(p => {
    const convs = convsFor(p.folder).length;
    const tags = (p.tags || []).map(t => `<span class="tag sm">${esc(t)}</span>`).join('');
    const done = Math.max(0, (p.totalTasks || 0) - (p.openTasks || 0));
    return `<article class="proj-card" data-pid="${esc(p.id)}">
      <span class="proj-bar" style="background:${esc(p.color || 'var(--accent)')}"></span>
      <div class="proj-main">
        <div class="proj-name-row"><span class="proj-dot" style="background:${esc(p.color || 'var(--accent)')}"></span><span class="proj-name">${esc(p.name)}</span><span class="tb-sp"></span><button class="proj-ic-btn" data-pact="edit" data-pid="${esc(p.id)}" title="Edit project" aria-label="Edit project">✎</button><button class="proj-ic-btn danger" data-pact="delete" data-pid="${esc(p.id)}" title="Delete project" aria-label="Delete project">✕</button></div>
        <div class="proj-folder">${p.folder ? `<span class="mono">${esc(short(p.folder))}</span>` : '<span class="muted">No folder · chosen at launch</span>'}</div>
        ${tags ? `<div class="proj-tags">${tags}</div>` : ''}
        <div class="proj-stats"><span><b>${p.openTasks || 0}</b> open</span><span><b>${done}</b> done</span><span class="${p.live ? 'proj-livecount' : ''}"><b>${p.live || 0}</b> live</span>${p.folder ? `<span><b>${convs}</b> chat${convs === 1 ? '' : 's'}</span>` : ''}</div>
        ${activityRows(p.folder, p.id)}
        <div class="proj-actions"><button class="btn sm" data-pact="tasks" data-pid="${esc(p.id)}">Tasks</button><button class="btn sm" data-pact="session" data-pid="${esc(p.id)}">New session</button><button class="btn sm ghost" data-pact="reveal" data-pid="${esc(p.id)}">Sessions</button></div>
      </div>
    </article>`;
  }).join('');

  // Folders that already have conversation history but aren't a named project yet — promote any to a project.
  const createdFolders = new Set(list.map(p => p.folder).filter(Boolean));
  const autoFolders = (recentFolders || []).filter(r => r.cwd && !createdFolders.has(r.cwd)).slice(0, 24);
  const folderCards = autoFolders.map(r => {
    const convs = convsFor(r.cwd).length, live = liveFor(r.cwd, null).length;
    return `<article class="proj-card proj-card-folder" data-folder="${esc(r.cwd)}">
      <span class="proj-bar" style="background:var(--line-strong)"></span>
      <div class="proj-main">
        <div class="proj-name-row"><span class="proj-dot" style="background:var(--faint)"></span><span class="proj-name">${esc(baseName(r.cwd))}</span><span class="tb-sp"></span></div>
        <div class="proj-folder"><span class="mono">${esc(short(r.cwd))}</span></div>
        <div class="proj-stats"><span><b>${convs}</b> chat${convs === 1 ? '' : 's'}</span>${live ? `<span class="proj-livecount"><b>${live}</b> live</span>` : ''}</div>
        ${activityRows(r.cwd, null)}
        <div class="proj-actions"><button class="btn sm" data-pact="save-folder" data-folder="${esc(r.cwd)}">+ Save as project</button><button class="btn sm ghost" data-pact="reveal" data-folder="${esc(r.cwd)}">Sessions</button><button class="btn sm ghost" data-pact="sess-folder" data-folder="${esc(r.cwd)}">New session</button></div>
      </div>
    </article>`;
  }).join('');

  if (!list.length && !autoFolders.length) return `${head}<div class="empty big proj-empty"><div class="proj-empty-ic">▦</div><div class="proj-empty-t">No projects yet</div><div class="muted" style="max-width:440px">Create a project to group its tasks, live sessions and history. A project can point at a folder, or stay folder-free so you pick one at launch.</div><button class="btn primary" id="projNew2">+ New project</button></div>`;

  const projectsBlock = list.length ? `<div class="proj-grid">${cards}</div>`
    : `<div class="proj-hint">No named projects yet. Save a folder below as a project, or <button class="linklike" id="projNew2">create one</button>.</div>`;
  const foldersBlock = autoFolders.length ? `<div class="proj-subhead"><h3>Folders with history</h3><span class="muted">From your past sessions. Save any as a project to track its tasks here too.</span></div><div class="proj-grid">${folderCards}</div>` : '';
  return `${head}${projectsBlock}${foldersBlock}`;
}
function wireProjects(el) {
  const openNew = () => openProjectDialog({ onDone: () => {} });
  const n1 = el.querySelector('#projNew'); if (n1) n1.onclick = openNew;
  const n2 = el.querySelector('#projNew2'); if (n2) n2.onclick = openNew;
  el.querySelectorAll('[data-pact]').forEach(b => b.onclick = async ev => {
    ev.stopPropagation();
    const act = b.dataset.pact, pid = b.dataset.pid, cs = b.dataset.cs, folder = b.dataset.folder, p = selectedProject(pid);
    if (act === 'open' && cs) { try { await openSession(cs, 'browser'); } catch {} return; }
    if (act === 'tasks') { taskProjectFilter = pid; lastSig = null; location.hash = '#/tasks'; return; }
    if (act === 'session') { openSheet(); setTimeout(() => { const s = $('#nsProject'); if (s) { s.value = pid; s.dispatchEvent(new Event('change', { bubbles: true })); } }, 40); return; }
    if (act === 'reveal') return openProjDrawer({ pid: pid || null, folder: folder || null });
    if (act === 'edit' && p) return openProjectDialog({ project: p, onDone: () => {} });
    if (act === 'delete' && p) { if (!confirm(`Delete project “${p.name}”? Its tasks and the folder on disk are kept — they just lose the project link.`)) return; try { await post(`/api/projects/${pid}/delete`); toast('Project deleted'); await load(); loadSlow(); } catch {} return; }
    // Folder cards (history folders not yet a named project)
    if (act === 'save-folder' && folder) return openProjectDialog({ prefill: { name: baseName(folder), folder }, onDone: () => {} });
    if (act === 'sess-folder' && folder) { openSheet(); setTimeout(() => { if (nsForm.cwd) nsForm.cwd.value = short(folder); }, 40); return; }
  });
}

function render() {
  if (!state) return;
  if (Array.isArray(state.projects)) projects = state.projects;   // keep the project list + counts fresh each poll
  const [title, sub] = VIEWS[view] || VIEWS.overview;
  $('#viewTitle').textContent = title; $('#viewSub').textContent = sub;
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.view === view));
  const running = state.sessions.filter(s => s.alive && s.kind === 'claude' && s.managed).length;
  $('#cSeats').textContent = state.seats.length || ''; $('#cSessions').textContent = running || ''; $('#cLibrary').textContent = library.length || '';
  { const tEl = $('#cTasks'); if (tEl) tEl.textContent = (state.tasks || []).filter(t => t.status !== 'done').length || ''; }
  { const pEl = $('#cProjects'); if (pEl) pEl.textContent = (projects || []).length || ''; }
  const attnN = state.seats.length ? attnItems().length : 0; const cAttn = $('#cAttn'); if (cAttn) { cAttn.textContent = attnN || ''; cAttn.className = 'count' + (attnN ? ' attn' : ''); }
  $('#brandSub').textContent = `${state.seats.length} seat${state.seats.length === 1 ? '' : 's'} · ${running} running`;
  $('#daemonLine').textContent = `daemon up ${Math.round(state.uptime / 60000)} min · v${state.version}`;
  $('#btnCheckAll').disabled = !!state.probing; $('#btnCheckAll').textContent = state.probing ? 'Checking…' : 'Check usage';
  if (dirtyForms.has(view)) return;
  const sig = renderSig();
  if (sig === lastSig) return;          // nothing the view shows has changed, leave the DOM alone
  const viewChanged = view !== lastRenderedView;
  if (viewChanged && lastRenderedView === 'workspace' && view !== 'workspace') wsCtl.teardown();
  lastSig = sig; lastRenderedView = view;
  if (view === 'workspace') {
    if (viewChanged) { $('#content').innerHTML = '<div class="empty big" style="padding:64px">Loading workspace…</div>'; ensureXterm().then(() => { if (view === 'workspace') wsCtl.build($('#content')); }); }
    else if (wsCtl.built) wsCtl.update();
    return;
  }
  const fn = { overview: vOverview, seats: vSeats, sessions: vSessions, tasks: vTasks, projects: vProjects, library: vLibrary, usage: vUsage, activity: vActivity, settings: vSettings, help: vHelp }[view] || vOverview;
  const el = $('#content');
  const focus = document.activeElement?.id;
  el.innerHTML = fn();
  // Stagger entrance only when you navigate to a view, not on data refreshes.
  if (viewChanged && !/\bnomotion\b/.test(location.search)) { el.classList.remove('view-enter'); void el.offsetWidth; el.classList.add('view-enter'); }
  if (focus === 'libSearch') { const i = $('#libSearch'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
  wire(el);
  if (view === 'tasks') wireTasks(el);
  if (view === 'projects') wireProjects(el);
  if (viewChanged) { animateCounts(el); animateEnter(el); }
}
// One-time entrance draw for the Today timeline bars, on navigation only.
function animateEnter(scope) {
  if (/\bnomotion\b/.test(location.search)) return;
  try { if (matchMedia('(prefers-reduced-motion: reduce)').matches) return; } catch {}
  scope.querySelectorAll('.gblock').forEach((b, i) => { b.style.transition = 'none'; b.style.transform = 'scaleX(0)'; void b.getBoundingClientRect(); b.style.transition = ''; b.style.transitionDelay = (i % 8) * 45 + 'ms'; requestAnimationFrame(() => { b.style.transform = 'scaleX(1)'; setTimeout(() => { b.style.transitionDelay = ''; }, 760); }); });
}
function wire(el) {
  el.querySelectorAll('button[data-act]').forEach(b => b.onclick = async () => {
    const act = b.dataset.act, cs = b.dataset.cs, seat = b.dataset.seat;
    const pick = key => el.querySelector(`select[data-pick="${key}"]`)?.value || null;
    try {
      if (act === 'term') await openSession(cs, 'terminal');
      if (act === 'web') await openSession(cs, 'browser');
      if (act === 'handoff') { const j = await post(`/api/sessions/${cs}/handoff`, { toSeat: pick(cs) }); toast(j.queued ? `Handoff to ${j.to} queued until this turn ends` : `Handing off to ${j.to}`); }
      if (act === 'stop') { if (confirm('Stop this session? You can resume it later from Sessions or the Library.')) { await post(`/api/sessions/${cs}/stop`); toast('Session stopped'); } }
      if (act === 'restore') { await post(`/api/sessions/${cs}/restore`, { seat: pick(cs) }); await openSession(cs, 'terminal'); }
      if (act === 'forget') await post(`/api/sessions/${cs}/forget`);
      if (act === 'resume' || act === 'resume-web') await startSession({ resumeId: b.dataset.id, cwd: b.dataset.cwd, seat: pick(b.dataset.id) }, act === 'resume-web' ? 'browser' : 'terminal');
      if (act === 'probe') { await post(`/api/seats/${encodeURIComponent(seat)}/probe`); toast(`Checking ${seat}…`); }
      if (act === 'login') { const j = await post(`/api/seats/${encodeURIComponent(seat)}/login`); await openSession(j.cs, 'terminal'); }
      if (act === 'toggle') await post(`/api/seats/${encodeURIComponent(seat)}`, { disabled: b.dataset.disabled === '1' });
      if (act === 'remove') { if (confirm(`Remove seat ${seat}? Its profile folder is kept on disk.`)) { await post(`/api/seats/${encodeURIComponent(seat)}/remove`, { purge: false }); toast(`Seat ${seat} removed`); } }
    } catch {}
    setTimeout(load, 300);
  });
  const addSeat = el.querySelector('#addSeat');
  if (addSeat) {
    addSeat.addEventListener('submit', async ev => { ev.preventDefault(); const name = addSeat.name.value.trim(); const j = await post('/api/seats', { name }); addSeat.reset(); toast(`Seat ${name} created, log in in the Terminal window`); if (j.cs) await openSession(j.cs, 'terminal'); load(); });
    el.querySelector('#addSeatBrowser').onclick = async () => { const name = addSeat.name.value.trim(); if (!name) return addSeat.name.focus(); const j = await post('/api/seats', { name }); addSeat.reset(); if (j.cs) await openSession(j.cs, 'browser'); load(); };
  }
  const search = el.querySelector('#libSearch');
  if (search) {
    search.addEventListener('input', ev => { libFilter = ev.target.value; render(); });
    search.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); deepSearch(search.value.trim()); } });
  }
  const deepBtn = el.querySelector('#deepBtn'); if (deepBtn) deepBtn.onclick = () => deepSearch((el.querySelector('#libSearch')?.value || '').trim());
  const deepClear = el.querySelector('#deepClear'); if (deepClear) deepClear.onclick = () => { deepResults = null; deepQuery = ''; render(); };
  el.querySelectorAll('[data-check]').forEach(c => c.onchange = () => { c.checked ? selected.add(c.dataset.check) : selected.delete(c.dataset.check); render(); });
  el.querySelectorAll('[data-bulk]').forEach(b => b.onclick = () => bulkAction(b.dataset.bulk));
  el.querySelectorAll('[data-cancel]').forEach(b => b.onclick = async () => { await post(`/api/schedule/${encodeURIComponent(b.dataset.cancel)}/cancel`); toast('Scheduled run cancelled'); load(); });
  const csv = el.querySelector('#csvExport'); if (csv) csv.onclick = exportCsv;
  const bcau = el.querySelector('#btnCheckAllUsage'); if (bcau) bcau.onclick = () => post('/api/probe-all').then(() => toast('Checking all seats…')).catch(() => {});
  el.querySelectorAll('[data-group]').forEach(b => b.onclick = () => { const k = decodeURIComponent(b.dataset.group); const idx = [...el.querySelectorAll('[data-group]')].indexOf(b); const filtering = !!(libFilter.trim() || libStar || libTag); const cur = (k in openGroups) ? openGroups[k] : (filtering ? true : idx === 0); openGroups[k] = !cur; saveGroups(); render(); });
  const expAll = el.querySelector('#libExpand'); if (expAll) expAll.onclick = () => { const keys = [...el.querySelectorAll('[data-group]')].map(b => decodeURIComponent(b.dataset.group)); const anyClosed = keys.some((k, i) => !((k in openGroups) ? openGroups[k] : (!!(libFilter.trim() || libStar || libTag) ? true : i === 0))); keys.forEach(k => openGroups[k] = anyClosed); saveGroups(); render(); };
  el.querySelectorAll('[data-group-mode]').forEach(b => b.onclick = () => { libGroup = b.dataset.groupMode; render(); });
  const projSel = el.querySelector('#libProjectSel'); if (projSel) projSel.onchange = () => { libProject = projSel.value; render(); };
  el.querySelectorAll('[data-projjump]').forEach(b => { const go = e => { e.stopPropagation(); location.hash = '#/projects'; }; b.onclick = go; b.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') go(e); }; });
  const starBtn = el.querySelector('#libStarBtn'); if (starBtn) starBtn.onclick = () => { libStar = !libStar; render(); };
  const archBtn = el.querySelector('#libArchBtn'); if (archBtn) archBtn.onclick = () => { showArchived = !showArchived; render(); };
  el.querySelectorAll('[data-filtertag]').forEach(b => b.onclick = () => { libTag = b.dataset.filtertag; render(); });
  el.querySelectorAll('[data-tag]').forEach(b => b.onclick = ev => { if (ev.target.dataset.untag) return; libTag = b.dataset.tag; render(); });
  el.querySelectorAll('[data-star]').forEach(b => b.onclick = async () => { await post(`/api/marks/${encodeURIComponent(b.dataset.star)}`, { star: b.dataset.on !== '1' }); await loadSlow(); });
  el.querySelectorAll('[data-untag]').forEach(b => b.onclick = async ev => { ev.stopPropagation(); await post(`/api/marks/${encodeURIComponent(b.dataset.untag)}`, { removeTag: b.dataset.tagval }); await loadSlow(); });
  el.querySelectorAll('[data-addtag]').forEach(b => b.onclick = async () => { const t = prompt('Add a tag (e.g. "release", "bug", "client-x"):'); if (t && t.trim()) { await post(`/api/marks/${encodeURIComponent(b.dataset.addtag)}`, { addTag: t.trim() }); await loadSlow(); } });
  const startSRename = span => inlineRename(span, { current: span.dataset.cur, lock: () => dirtyForms.add('sessions'), unlock: () => dirtyForms.delete('sessions'), onCommit: v => renameEverywhere({ cs: span.dataset.cs, sessionId: span.dataset.sid, name: v }).then(nm => toast(nm ? 'Renamed' : 'Name cleared')) });
  el.querySelectorAll('.srow-name[data-cs]').forEach(span => span.ondblclick = () => startSRename(span));
  el.querySelectorAll('[data-ren-btn]').forEach(b => b.onclick = () => { const span = b.closest('td')?.querySelector('.srow-name[data-cs]'); if (span) startSRename(span); });
  const startLibRename = span => inlineRename(span, { current: span.dataset.cur, lock: () => dirtyForms.add('library'), unlock: () => dirtyForms.delete('library'), onCommit: v => { const sid = span.dataset.sid, live = (state?.sessions || []).find(x => x.sessionId === sid && x.alive); renameEverywhere({ cs: live?.cs, sessionId: sid, name: v }).then(nm => toast(nm ? 'Renamed' : 'Original title restored')); } });
  el.querySelectorAll('.lrow-name[data-sid]').forEach(span => span.ondblclick = () => startLibRename(span));
  el.querySelectorAll('[data-rename]').forEach(b => b.onclick = () => { const span = b.closest('.title')?.querySelector('.lrow-name[data-sid]'); if (span) startLibRename(span); });
  el.querySelectorAll('[data-projrename]').forEach(b => b.onclick = e => { e.stopPropagation(); const base = b.dataset.projrename, cur = aliasName(base); const t = prompt(`Rename project "${base}" to (blank = original name):`, cur === base ? '' : cur); if (t === null) return; saveProjAlias(base, t); render(); });
  el.querySelectorAll('[data-project]').forEach(b => b.onclick = async () => {
    const existing = [...new Set(library.map(r => r.projectName).filter(Boolean))].sort();
    const hint = existing.length ? '\n\nExisting projects:\n• ' + existing.slice(0, 20).join('\n• ') : '';
    const name = prompt('Move this session to a project (type a name; blank = back to auto-group by repo/folder):' + hint, b.dataset.cur || '');
    if (name === null) return;
    await post(`/api/marks/${encodeURIComponent(b.dataset.project)}`, { project: name.trim() });
    toast(name.trim() ? `Moved to "${name.trim()}"` : 'Back to auto-grouping');
    await loadSlow();
  });
  el.querySelectorAll('[data-cmd-del]').forEach(b => b.onclick = () => { const l = cmds(); l.splice(+b.dataset.cmdDel, 1); saveCmds(l); render(); });
  el.querySelectorAll('[data-cmd-run]').forEach(b => b.onclick = () => { const c = cmds()[+b.dataset.cmdRun]; if (c) { openSheet(); setTimeout(() => { if (nsForm.prompt) { nsForm.prompt.value = c.text; nsForm.prompt.focus(); } }, 60); } });
  el.querySelectorAll('[data-qltext]').forEach(b => b.onclick = () => { openSheet(); setTimeout(() => { if (nsForm.prompt) { nsForm.prompt.value = b.dataset.qltext; nsForm.prompt.focus(); } }, 60); });
  el.querySelectorAll('[data-ql-del]').forEach(b => b.onclick = e => { e.stopPropagation(); const l = cmds(); l.splice(+b.dataset.qlDel, 1); saveCmds(l); render(); });
  el.querySelectorAll('[data-ql-add]').forEach(b => b.onclick = e => { e.preventDefault(); setView('settings'); setTimeout(() => { const i = $('#cmdName'); if (i) { i.scrollIntoView({ block: 'center' }); i.focus(); } }, 90); });
  const cmdAdd = el.querySelector('#cmdAdd'); if (cmdAdd) cmdAdd.onclick = () => { const n = el.querySelector('#cmdName').value.trim(), t = el.querySelector('#cmdText').value.trim(); if (!n || !t) return; const l = cmds(); l.push({ name: n, text: t }); saveCmds(l); render(); };
  const settings = el.querySelector('#settings');
  if (settings) {
    settings.addEventListener('input', () => dirtyForms.add('settings'));
    settings.querySelectorAll('[data-accent]').forEach(b => b.onclick = () => { applyAccent(b.dataset.accent); settings.querySelectorAll('[data-accent]').forEach(x => x.classList.toggle('on', x === b)); });
    const saveTerm = () => { try { localStorage.setItem('cockpit.term', JSON.stringify({ theme: settings.termTheme.value, fontSize: Number(settings.termSize.value) || 13, cursor: settings.termCursor.value })); } catch {} if (view === 'workspace' && wsCtl.built) wsCtl.applyAppearance(); };
    ['termTheme', 'termSize', 'termCursor'].forEach(n => { const e2 = settings.querySelector(`[name="${n}"]`); if (e2) e2.addEventListener('change', saveTerm); });
    const bn = settings.querySelector('#browserNotify');
    if (bn) bn.addEventListener('change', async () => {
      if (bn.checked) { let perm = typeof Notification !== 'undefined' ? Notification.permission : 'denied'; if (perm === 'default') perm = await Notification.requestPermission(); if (perm !== 'granted') { bn.checked = false; try { localStorage.setItem('cockpit.notify', '0'); } catch {} return toast('Your browser blocked notifications', 'bad'); } try { localStorage.setItem('cockpit.notify', '1'); } catch {} toast('Desktop notifications on'); }
      else { try { localStorage.setItem('cockpit.notify', '0'); } catch {} toast('Desktop notifications off'); }
    });
    settings.addEventListener('submit', async ev => { ev.preventDefault(); const f = ev.target; applyTheme(f.theme.value); applyMotion(f.motion.value); await post('/api/config', { handoff: { mode: f.mode.value, thresholdPct: Number(f.thresholdPct.value), minGainPct: Number(f.minGainPct.value), autoContinue: f.autoContinue.checked, continueMessage: f.continueMessage.value.trim() || 'Please continue where you left off.' }, notifications: f.notifications.checked, autoCheckMin: Number(f.autoCheckMin.value), budgetMonthlyUSD: Number(f.budgetMonthlyUSD.value) || 0 }); dirtyForms.delete('settings'); toast('Settings saved'); load(); });
  }
}
function setView(v) { view = VIEWS[v] ? v : 'overview'; try { localStorage.setItem('cockpit.view', view); } catch {} window.scrollTo(0, 0); render(); }
window.addEventListener('hashchange', () => setView(location.hash.replace(/^#\//, '')));

/* new-session sheet */
const sheet = $('#sheetScrim'), nsForm = $('#newSession');
function openSheet() {
  $('#nsSeat').innerHTML = seatOptions(null);
  $('#nsProject').innerHTML = projectOptionsHtml('');
  $('#projects').innerHTML = (recentFolders || []).map(r => `<option value="${esc(r.cwd)}">${esc(short(r.cwd))}</option>`).join('');
  if (!nsForm.cwd.value && recentFolders[0]) nsForm.cwd.value = recentFolders[0].cwd;
  sheet.hidden = false; nsForm.cwd.focus(); nsForm.cwd.select();
}
function closeSheet() { sheet.hidden = true; }
$('#btnNew').onclick = openSheet; $('#sheetClose').onclick = closeSheet;
sheet.addEventListener('click', ev => { if (ev.target === sheet) closeSheet(); });
window.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !sheet.hidden) closeSheet(); if (ev.key === 'n' && !sheet.hidden === false && !/input|select|textarea/i.test(document.activeElement?.tagName || '')) openSheet(); });
const nsBody = () => ({ cwd: nsForm.cwd.value.trim(), projectId: (nsForm.projectId?.value && nsForm.projectId.value !== '__new__') ? nsForm.projectId.value : null, seat: nsForm.seat.value || null, name: nsForm.name.value.trim() || null, extra: nsForm.extra.value.trim() ? nsForm.extra.value.trim().split(/\s+/) : [], prompt: nsForm.prompt.value.trim() || null, worktree: !!nsForm.worktree?.checked, branch: (nsForm.branch?.value || '').trim() || null });
// Picking a project fills the folder from it (editable); the sentinel opens the create dialog.
wireProjectSelect($('#nsProject'), pr => { if (pr && pr.folder) nsForm.cwd.value = short(pr.folder); });
function nsWhenAt() {
  const v = nsForm.when.value;
  if (v === 'now') return null;
  if (v === 'reset') { const times = (state?.seats || []).map(s => s.usage?.fiveHour?.resetsAt).filter(Boolean).map(t => new Date(t).getTime()).filter(t => t > Date.now()); return times.length ? Math.min(...times) : Date.now(); }
  return Date.now() + Number(v);
}
async function nsSubmit(where) {
  const body = nsBody();
  if (!body.cwd) return nsForm.cwd.focus();
  const at = nsWhenAt();
  if (at == null) { try { await startSession(body, where); closeSheet(); } catch {} return; }
  try { const j = await post('/api/schedule', { ...body, at }); toast(`Scheduled for ${new Date(at).toLocaleString()}`); closeSheet(); load(); } catch {}
}
nsForm.addEventListener('submit', ev => { ev.preventDefault(); nsSubmit('terminal'); });
$('#nsBrowser').onclick = () => nsSubmit('browser');
nsForm.when && nsForm.when.addEventListener('change', () => { const sched = nsForm.when.value !== 'now'; $('#nsSubmit').textContent = sched ? 'Schedule' : 'Open in Terminal'; $('#nsBrowser').style.display = sched ? 'none' : ''; });
nsForm.worktree && nsForm.worktree.addEventListener('change', () => { const w = $('#nsBranchWrap'); if (w) w.style.display = nsForm.worktree.checked ? '' : 'none'; });
$('#btnCheckAll').onclick = async () => { await post('/api/probe-all'); toast('Checking every idle seat, a few seconds each'); load(); };

/* data */
async function load() {
  try {
    const r = await fetch('/api/state'); state = await r.json();
    render(); maybeNotify();
  } catch { $('#brandSub').textContent = 'daemon unreachable'; $('#daemonLine').textContent = 'In a terminal: cockpit daemon start'; }
}
// Browser desktop notifications when a managed session finishes its turn (or crashes).
let prevStatus = {}, notifySeeded = false;
function notifyEnabled() { try { return localStorage.getItem('cockpit.notify') === '1'; } catch { return false; } }
function maybeNotify() {
  const on = notifyEnabled() && typeof Notification !== 'undefined' && Notification.permission === 'granted';
  for (const s of (state?.sessions || []).filter(x => x.managed && x.kind === 'claude')) {
    const prev = prevStatus[s.cs];
    if (on && notifySeeded && prev && prev !== s.status) {
      try {
        if (s.status === 'idle' && prev === 'busy') new Notification(`${s.name || s.cs} is ready for you`, { body: `Finished its turn on ${s.seat || '?'}`, tag: 'ck-' + s.cs });
        else if (s.status === 'crashed' && prev !== 'crashed') new Notification(`${s.name || s.cs} crashed`, { body: `On ${s.seat || '?'} — resume it from cockpit`, tag: 'ck-' + s.cs });
      } catch {}
    }
    prevStatus[s.cs] = s.status;
  }
  notifySeeded = true;
}
async function loadSlow() {
  try {
    const [l, p, u] = await Promise.all([fetch('/api/library').then(r => r.json()), fetch('/api/projects').then(r => r.json()), fetch('/api/usage').then(r => r.json())]);
    library = l.sessions || []; projects = p.projects || projects; recentFolders = p.recent || []; usage = u; allTags = l.tags || [];
    if (state) render();
  } catch {}
}
try { view = VIEWS[location.hash.replace(/^#\//, '')] ? location.hash.replace(/^#\//, '') : (localStorage.getItem('cockpit.view') || 'overview'); } catch {}
if (!VIEWS[view]) view = 'overview';
load(); loadSlow();
setInterval(load, 3000); setInterval(loadSlow, 15000);

/* ---------- Command palette (⌘K / Ctrl-K) ---------- */
(function cmdk() {
  const scrim = document.createElement('div');
  scrim.className = 'cmdk-scrim'; scrim.hidden = true;
  scrim.innerHTML = `<div class="cmdk" role="dialog" aria-label="Command palette">
    <input class="cmdk-input" placeholder="Search seats, sessions, projects, or jump to a view…" autocomplete="off" spellcheck="false">
    <ul class="cmdk-list"></ul>
    <div class="cmdk-foot"><span>↑↓ move</span><span>↵ run</span><span>esc close</span></div>
  </div>`;
  document.body.appendChild(scrim);
  const input = scrim.querySelector('.cmdk-input');
  const list = scrim.querySelector('.cmdk-list');
  let items = [], active = 0, open = false;

  function commands() {
    const c = [];
    for (const [id, [title]] of Object.entries(VIEWS)) c.push({ label: `Go to ${title}`, hint: 'view', run: () => setView(id) });
    c.push({ label: 'New session', hint: 'start', kbd: true, run: () => openSheet() });
    c.push({ label: 'Check usage · all seats', hint: 'usage', run: () => post('/api/probe-all').then(() => toast('Checking all seats…')) });
    c.push({ label: 'Arm 5-hour window · all idle seats', hint: 'usage', run: () => post('/api/arm-all').then(() => toast('Arming idle seats…')) });
    for (const s of (state?.seats || [])) {
      const u = s.usage || {}, fh = u.fiveHour || {};
      const active = fh.resetsAt && !fh.assumedReset && new Date(fh.resetsAt).getTime() > Date.now();
      c.push({ label: `Check usage · ${s.name}`, hint: `seat · ${fh.pct ?? '–'}%`, run: () => post(`/api/seats/${encodeURIComponent(s.name)}/probe`).then(() => toast(`Checking ${s.name}…`)) });
      if (u.loggedIn && !active) c.push({ label: `Start 5-hour window · ${s.name}`, hint: 'seat', run: () => post(`/api/seats/${encodeURIComponent(s.name)}/arm`).then(() => toast(`Arming ${s.name}…`)) });
      c.push({ label: `Log in · ${s.name}`, hint: 'seat', run: () => post(`/api/seats/${encodeURIComponent(s.name)}/login`).then(j => j.cs && openSession(j.cs, 'terminal')) });
    }
    for (const s of (state?.sessions || []).filter(x => x.alive && x.managed && x.kind === 'claude')) {
      c.push({ label: `Open · ${s.name || s.cs}`, hint: `session · ${s.seat}`, run: () => openSession(s.cs, 'terminal') });
      c.push({ label: `Hand off · ${s.name || s.cs}`, hint: 'session', run: () => post(`/api/sessions/${s.cs}/handoff`, {}).then(j => toast(j.queued ? `Queued → ${j.to}` : `→ ${j.to}`)) });
      c.push({ label: `Stop · ${s.name || s.cs}`, hint: 'session', run: () => post(`/api/sessions/${s.cs}/stop`).then(() => toast('Stopped')) });
    }
    for (const r of (library || []).slice(0, 40)) c.push({ label: `Resume · ${r.title}`, hint: `${r.projectName || ''}`, run: () => startSession({ resumeId: r.sessionId, cwd: r.cwd }, 'terminal') });
    for (const cm of cmds()) c.push({ label: `Run: ${cm.name}`, hint: 'command', run: () => { openSheet(); setTimeout(() => { if (nsForm.prompt) nsForm.prompt.value = cm.text; }, 60); } });
    return c;
  }
  // subsequence fuzzy score: all query chars appear in order; prefer contiguous + early matches
  function score(q, text) {
    if (!q) return 1; const t = text.toLowerCase(); let ti = 0, s = 0, streak = 0;
    for (const ch of q.toLowerCase()) { const i = t.indexOf(ch, ti); if (i < 0) return -1; s += (i === ti ? 2 + streak : 1); streak = (i === ti ? streak + 1 : 0); ti = i + 1; }
    return s - t.length * 0.01;
  }
  function refresh() {
    const q = input.value.trim();
    items = commands().map(c => ({ c, s: score(q, c.label + ' ' + (c.hint || '')) })).filter(x => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 40).map(x => x.c);
    if (active >= items.length) active = Math.max(0, items.length - 1);
    list.innerHTML = items.length ? items.map((c, i) => `<li class="${i === active ? 'on' : ''}" data-i="${i}"><span class="cmdk-lbl">${esc(c.label)}</span><span class="cmdk-hint">${esc(c.hint || '')}</span></li>`).join('') : '<li class="cmdk-empty">No matches</li>';
    const on = list.querySelector('li.on'); if (on) on.scrollIntoView({ block: 'nearest' });
    list.querySelectorAll('li[data-i]').forEach(li => { li.onmouseenter = () => { active = +li.dataset.i; paint(); }; li.onclick = () => run(+li.dataset.i); });
  }
  function paint() { list.querySelectorAll('li[data-i]').forEach(li => li.classList.toggle('on', +li.dataset.i === active)); const on = list.querySelector('li.on'); if (on) on.scrollIntoView({ block: 'nearest' }); }
  function run(i) { const c = items[i]; if (!c) return; close(); try { c.run(); } catch (e) { toast(e.message || 'failed', 'bad'); } }
  function show() { open = true; scrim.hidden = false; input.value = ''; active = 0; refresh(); setTimeout(() => input.focus(), 20); }
  function close() { open = false; scrim.hidden = true; }
  input.addEventListener('input', () => { active = 0; refresh(); });
  scrim.addEventListener('click', e => { if (e.target === scrim) close(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(active); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  window.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); open ? close() : show(); }
  });
  const chip = document.createElement('button');
  chip.className = 'btn cmdk-chip'; chip.type = 'button';
  chip.innerHTML = '<span>Search</span><kbd>⌘K</kbd>';
  chip.onclick = () => show();
  const bar = document.querySelector('.topbar-actions'); if (bar) bar.insertBefore(chip, bar.firstChild);
  if (/\bcmdk\b/.test(location.search)) setTimeout(show, 300); // for capture/testing
})();

/* ---------- Multi-session workspace (tabs + split panes) ---------- */
// xterm is only needed here, so it is loaded on first open rather than on every dashboard load.
let xtermLoading = null;
function ensureXterm() {
  if (window.Terminal && window.FitAddon && window.WebLinksAddon) return Promise.resolve();
  if (xtermLoading) return xtermLoading;
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/vendor/xterm.css'; document.head.appendChild(css);
  const js = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  xtermLoading = js('/vendor/xterm.js').then(() => Promise.all([js('/vendor/addon-fit.js'), js('/vendor/addon-search.js'), js('/vendor/addon-web-links.js')]));
  return xtermLoading;
}
// One live terminal bound to one session, speaking the same WS protocol as terminal.js.
class WsPane {
  constructor(cs, node, endedAtMount) { this.cs = cs; this.node = node; this.endedAtMount = !!endedAtMount; this.ended = false; this.term = null; this.fit = null; this.ws = null; }
  mount() {
    const body = this.node.querySelector('.wp-term');
    this.term = new Terminal(termXtermOptions());
    this.fit = new FitAddon.FitAddon(); this.term.loadAddon(this.fit); this.term.open(body);
    try { if (window.WebLinksAddon) this.term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => window.open(uri, '_blank', 'noopener'))); } catch {}
    try { if (window.SearchAddon) { this.search = new SearchAddon.SearchAddon(); this.term.loadAddon(this.search); } } catch {}
    body.style.background = (TERM_THEMES[termPrefs().theme] || TERM_THEMES.Midnight).background;
    this.term.onData(d => { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'in', d })); });
    this.term.onResize(({ cols, rows }) => { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'rs', cols, rows })); });
    requestAnimationFrame(() => { this.fitNow(); if (this.endedAtMount) this.markEnded(); else this.connect(); });
  }
  connect() {
    this.ended = false;
    this.ws = new WebSocket(`ws://${location.host}/ws/${encodeURIComponent(this.cs)}?cols=${this.term.cols}&rows=${this.term.rows}`);
    this.ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch { return; } if (m.t === 'out') this.term.write(m.d); else if (m.t === 'exit') this.markEnded(m.code); };
    this.ws.onclose = () => { if (!this.ended) this.markEnded(); };
    // A resize nudge right after connecting asks Claude Code to repaint its TUI into the fresh view.
    setTimeout(() => { try { this.fit.fit(); } catch {} }, 120);
  }
  fitNow() { try { this.fit && this.fit.fit(); } catch {} }
  applyAppearance() {
    if (!this.term) return;
    const p = termPrefs(), th = TERM_THEMES[p.theme] || TERM_THEMES.Midnight;
    this.term.options.fontSize = Number(p.fontSize) || 13;
    this.term.options.cursorStyle = p.cursor || 'block';
    this.term.options.theme = th;
    const body = this.node.querySelector('.wp-term'); if (body) body.style.background = th.background;
    this.fitNow();
  }
  markEnded(code) { this.ended = true; const o = this.node.querySelector('.wp-ended'); if (o) { o.hidden = false; if (code != null) { const c = o.querySelector('.wp-ended-code'); if (c) c.textContent = 'exit ' + code; } } }
  dispose() { try { this.ws && this.ws.close(); } catch {} try { this.term && this.term.dispose(); } catch {} }
}
// Each seat gets a stable colour, used on the workspace rail and each pane's left edge.
const SEAT_COLORS = ['#5eead4', '#f0abfc', '#fca5a5', '#fcd34d', '#7dd3fc', '#c4b5fd', '#86efac', '#fdba74'];
function seatColor(name) { const seats = state?.seats || []; let i = seats.findIndex(s => s.name === name); if (i < 0) { i = 0; for (const ch of String(name || '')) i += ch.charCodeAt(0); } return SEAT_COLORS[Math.abs(i) % SEAT_COLORS.length]; }
function railProj(s) { const cwd = s.cwd || ''; if (/scratch-workspaces/.test(cwd)) return 'scratch'; return cwd ? (cwd.replace(/\/+$/, '').split('/').pop() || 'unknown') : 'unknown'; }
const wsCtl = {
  panes: new Map(), order: [], layout: 'auto', filter: 'all', focus: null, editingCs: null,
  colFr: [], rowFr: [], handles: [], _cols: 0, _rows: 0, _vsig: '', MINROW: 240,
  built: false, rootEl: null, grid: null, bar: null, barSig: '',
  load() { try { const s = JSON.parse(localStorage.getItem('cockpit.ws') || '{}'); this.order = Array.isArray(s.order) ? s.order : []; this.layout = s.layout || 'auto'; this.filter = s.filter || 'all'; this.colFr = Array.isArray(s.colFr) ? s.colFr : []; this.rowFr = Array.isArray(s.rowFr) ? s.rowFr : []; } catch {} },
  save() { try { localStorage.setItem('cockpit.ws', JSON.stringify({ order: this.order, layout: this.layout, filter: this.filter, colFr: this.colFr, rowFr: this.rowFr })); } catch {} },
  running() { return (state?.sessions || []).filter(s => s.alive && s.managed && s.kind === 'claude'); },
  runningIds() { return this.running().map(s => s.cs); },
  sessOf(cs) { return (state?.sessions || []).find(x => x.cs === cs); },
  // Does a session pass the current filter? working = mid-turn; needs = finished its turn or ended.
  matches(cs) { const s = this.sessOf(cs); if (this.filter === 'working') return !!(s && s.alive && s.status === 'busy'); if (this.filter === 'needs') return !s || !s.alive || s.status === 'idle'; return true; },
  visibleOrder() { return this.order.filter(cs => this.matches(cs)); },
  computeCols(n) { if (!n) return 1; if (this.layout !== 'auto') return Math.min(Number(this.layout), n); return n <= 1 ? 1 : n <= 4 ? 2 : 3; },
  build(contentEl) {
    this.load();
    const aliveIds = new Set(this.running().map(s => s.cs));
    if (!this.order.length) this.order = this.runningIds().slice(0, 4);
    else this.order = this.order.filter(cs => aliveIds.has(cs));   // the workspace holds only running sessions
    contentEl.innerHTML = `<div class="ws"><div class="ws-bar" id="wsBar"></div><div class="ws-body"><div class="ws-rail" id="wsRail"></div><div class="ws-grid" id="wsGrid"></div></div></div>`;
    this.rootEl = contentEl.querySelector('.ws'); this.bar = contentEl.querySelector('#wsBar'); this.grid = contentEl.querySelector('#wsGrid'); this.rail = contentEl.querySelector('#wsRail');
    this.wireRoot(); this.refreshBar(); this.refreshRail(); this.renderGrid(); this.built = true;
    if (this._onKey) document.removeEventListener('keydown', this._onKey, true);
    this._onKey = e => {   // Alt+1..9 focuses a pane; Alt+0 / Esc exits focus — Alt avoids clashing with the terminals
      if (view !== 'workspace' || !this.built) return;
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.key >= '1' && e.key <= '9') { const cs = this.order[+e.key - 1]; if (cs) { e.preventDefault(); this.setFocus(this.focus === cs ? null : cs); } }
      else if (e.altKey && e.key === '0' && this.focus) { e.preventDefault(); this.setFocus(null); }
    };
    document.addEventListener('keydown', this._onKey, true);
  },
  // The left rail lists every running session grouped by project, needs-you first, coloured by seat.
  railSigNow() { const seats = (state?.seats || []).map(z => z.name + (z.usage?.fiveHour?.pct ?? '')).join(','); return this.running().map(s => s.cs + s.status + s.seat + (s.name || '')).join(',') + '|' + this.order.join(',') + '|' + (this.focus || '') + '|' + seats + '|' + [...(this._railCollapsed || [])].join(','); },
  railHtml() {
    const running = this.running();
    const live = (state?.seats || []).filter(z => !z.disabled && z.usage?.loggedIn);
    const best = live.slice().sort((a, b) => (seatPct(a) ?? 999) - (seatPct(b) ?? 999))[0];
    const head = `<div class="rail-top"><span class="rail-head tiny muted">Running · ${running.length}</span>${best ? `<span class="rail-best tiny" title="freshest account"><span class="rail-dot" style="background:${seatColor(best.name)}"></span>${esc(best.name)} ${seatPct(best) ?? '–'}%</span>` : ''}</div>`;
    if (!running.length) return head + '<div class="rail-empty tiny muted">No running sessions yet. Press New session.</div>';
    const groups = new Map();
    for (const s of running) { const k = railProj(s); (groups.get(k) || groups.set(k, []).get(k)).push(s); }
    const open = new Set(this.order); const collapsed = this._railCollapsed || (this._railCollapsed = new Set());
    let out = head;
    for (const [proj, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      items.sort((a, b) => (b.status === 'idle' ? 1 : 0) - (a.status === 'idle' ? 1 : 0));   // finished-turn sessions first
      const isCol = collapsed.has(proj), unopened = items.filter(s => !open.has(s.cs)).length;
      out += `<div class="rail-proj" data-rail-proj="${esc(proj)}"><span class="rail-chev">${isCol ? '▸' : '▾'}</span>${esc(proj)}<span class="muted"> · ${items.length}</span>${unopened ? `<span class="rail-addall" role="button" data-rail-addall="${esc(proj)}" title="Open all ${unopened} here">+${unopened}</span>` : ''}</div>`;
      if (isCol) continue;
      for (const s of items) {
        const inGrid = open.has(s.cs), ready = s.status === 'idle';
        out += `<div class="rail-item${inGrid ? ' in' : ''}${this.focus === s.cs ? ' focused' : ''}" data-rail="${esc(s.cs)}" title="${inGrid ? 'Focus in workspace' : 'Add to workspace'}">
          <span class="rail-dot" style="background:${seatColor(s.seat)}"></span>
          <span class="rail-name">${esc(s.name || s.cs)}</span>
          ${ready ? '<span class="rail-ready" title="finished its turn — needs you">●</span>' : ''}
          <span class="rail-acts">
            <span class="rail-act" role="button" data-rail-act="rename" data-cs="${esc(s.cs)}" title="Rename">✎</span>
            <span class="rail-act" role="button" data-rail-act="handoff" data-cs="${esc(s.cs)}" title="Hand off to the freshest seat">⇄</span>
            <span class="rail-act danger" role="button" data-rail-act="stop" data-cs="${esc(s.cs)}" title="Stop">✕</span>
          </span>
        </div>`;
      }
    }
    return out;
  },
  refreshRail() { if (!this.rail) return; this.railSig = this.railSigNow(); this.rail.innerHTML = this.railHtml(); },
  railAction(act, cs) {
    if (act === 'rename') { const s = this.sessOf(cs), name = prompt('Rename this session (leave blank to use the default):', s?.name || ''); if (name === null) return; renameEverywhere({ cs, sessionId: s?.sessionId, name }).then(nm => toast(nm ? 'Renamed' : 'Name cleared')).catch(() => {}); return; }
    if (act === 'handoff') return post(`/api/sessions/${encodeURIComponent(cs)}/handoff`, { toSeat: null }).then(j => toast(j.queued ? `Queued → ${j.to}` : `→ ${j.to}`)).catch(() => {});
    if (act === 'stop') { if (confirm('Stop this session? You can resume it later from Sessions or Projects.')) post(`/api/sessions/${encodeURIComponent(cs)}/stop`).then(() => toast('Session stopped')).catch(() => {}); }
  },
  wireRoot() {
    this.rootEl.addEventListener('click', e => {
      if (!e.target.closest('.wp-menu') && !e.target.closest('[data-wp="menu"]')) this.closeMenus();
      const lb = e.target.closest('[data-ws-layout]'); if (lb) return this.setLayout(lb.dataset.wsLayout);
      const fb = e.target.closest('[data-ws-filter]'); if (fb) return this.setFilter(fb.dataset.wsFilter);
      if (e.target.closest('[data-ws-addall]')) return this.addAll();
      if (e.target.closest('[data-ws-new]')) return openSheet();
      if (e.target.closest('[data-ws-unfocus]')) return this.setFocus(null);
      const ra = e.target.closest('[data-rail-act]'); if (ra) { e.stopPropagation(); return this.railAction(ra.dataset.railAct, ra.dataset.cs); }
      const raa = e.target.closest('[data-rail-addall]'); if (raa) { e.stopPropagation(); return this.addAllIn(raa.dataset.railAddall); }
      const rp = e.target.closest('[data-rail-proj]'); if (rp) { const p = rp.dataset.railProj, c = this._railCollapsed || (this._railCollapsed = new Set()); c.has(p) ? c.delete(p) : c.add(p); return this.refreshRail(); }
      const ri = e.target.closest('[data-rail]'); if (ri) { const cs = ri.dataset.rail; return this.order.includes(cs) ? this.setFocus(this.focus === cs ? null : cs) : this.addPane(cs); }
      const wp = e.target.closest('[data-wp]'); if (wp) { const cs = wp.closest('.wp')?.dataset.cs; if (cs) this.paneAction(wp.dataset.wp, cs); }
    });
    this.rootEl.addEventListener('change', e => { const a = e.target.closest('[data-ws-add]'); if (a && a.value) { const v = a.value; a.value = ''; this.addPane(v); } });
    this.rootEl.addEventListener('pointerdown', e => { const g = e.target.closest('[data-wp-grip]'); if (g) { const cs = g.closest('.wp')?.dataset.cs; if (cs) this.startPaneDrag(cs, e); } });
    this.rootEl.addEventListener('dblclick', e => { const nm = e.target.closest('.wp-name'); if (nm) { const cs = nm.closest('.wp')?.dataset.cs; if (cs) this.renamePane(cs); } });
  },
  renamePane(cs) {
    const pane = this.panes.get(cs), nameEl = pane && pane.node.querySelector('.wp-name'); if (!nameEl) return;
    const s = this.sessOf(cs);
    inlineRename(nameEl, { current: s?.name || '', lock: () => { this.editingCs = cs; }, unlock: () => { this.editingCs = null; }, onCommit: v => renameEverywhere({ cs, sessionId: s?.sessionId, name: v }).then(nm => toast(nm ? 'Renamed' : 'Name cleared')).catch(() => {}) });
  },
  // Drag a pane by its grip to a new slot. Nodes are re-ordered in place, so terminals keep their connection.
  startPaneDrag(cs, e) {
    e.preventDefault(); const src = this.panes.get(cs); if (!src || this.focus) return;
    const sx = e.clientX, sy = e.clientY; let started = false, ghost = null, target = null, after = false;
    const begin = () => { started = true; ghost = document.createElement('div'); ghost.className = 'wp-ghost'; ghost.textContent = this.sessOf(cs)?.name || cs; document.body.appendChild(ghost); src.node.classList.add('wp-dragging-src'); document.body.classList.add('ws-reordering'); };
    const clearDrop = () => this.panes.forEach(p => p.node.classList.remove('wp-drop-before', 'wp-drop-after'));
    const move = ev => {
      if (!started) { if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 6) return; begin(); }  // small threshold, so a click isn't a drag
      ghost.style.left = ev.clientX + 'px'; ghost.style.top = ev.clientY + 'px';
      const el = document.elementFromPoint(ev.clientX, ev.clientY), node = el && el.closest('.wp'); clearDrop();
      if (node && node.dataset.cs !== cs && !node.classList.contains('wp-hidden')) { const r = node.getBoundingClientRect(); after = ev.clientY > r.top + r.height / 2; node.classList.add(after ? 'wp-drop-after' : 'wp-drop-before'); target = node.dataset.cs; } else target = null;
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (!started) return;
      if (ghost) ghost.remove(); src.node.classList.remove('wp-dragging-src'); document.body.classList.remove('ws-reordering'); clearDrop();
      if (target && target !== cs) this.reorder(cs, target, after);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  },
  reorder(srcCs, targetCs, after) {
    const arr = this.order.filter(x => x !== srcCs); let ti = arr.indexOf(targetCs); if (ti < 0) return;
    arr.splice(after ? ti + 1 : ti, 0, srcCs); this.order = arr; this.save();
    // Re-append existing pane nodes in the new order (keeps each terminal alive), then the gutters on top.
    for (const c of this.order) { const p = this.panes.get(c); if (p) this.grid.appendChild(p.node); }
    for (const h of this.handles) this.grid.appendChild(h);
    this.colFr = []; this.rowFr = []; this.applyTracks(); this.fitAll();
  },
  barHtml() {
    const running = this.running(), open = new Set(this.order), addable = running.filter(s => !open.has(s.cs));
    const layoutSeg = `<div class="ws-cluster"><span class="ws-lbl">Layout</span><div class="seg">${['auto', '1', '2', '3', '4'].map(l => `<button class="${this.layout === l ? 'on' : ''}" data-ws-layout="${l}">${l === 'auto' ? 'Auto' : l}</button>`).join('')}</div></div>`;
    const filterSeg = `<div class="ws-cluster"><span class="ws-lbl">Show</span><div class="seg">${[['all', 'All'], ['working', 'Working'], ['needs', 'Needs you']].map(([k, t]) => `<button class="${this.filter === k ? 'on' : ''}" data-ws-filter="${k}">${t}</button>`).join('')}</div></div>`;
    const add = addable.length ? `<select class="sel sm" data-ws-add><option value="">Add a session…</option>${addable.map(s => `<option value="${esc(s.cs)}">${esc(s.name || s.cs)} · ${esc(s.seat)}</option>`).join('')}</select>` : '';
    const addAll = addable.length ? `<button class="btn sm" data-ws-addall>Add all (${addable.length})</button>` : '';
    const unfocus = this.focus ? `<button class="btn sm" data-ws-unfocus>Exit focus</button>` : '';
    return `${layoutSeg}${filterSeg}${unfocus}<span class="spacer"></span>${add}${addAll}<span class="tiny muted">${this.order.length} open · ${running.length} running</span><button class="btn sm primary" data-ws-new>New session</button>`;
  },
  barSigNow() { return this.runningIds().join(',') + '|' + this.order.join(',') + '|' + this.layout + '|' + this.filter + '|' + (this.focus || ''); },
  refreshBar() { this.barSig = this.barSigNow(); if (this.bar) this.bar.innerHTML = this.barHtml(); },
  paneHtml(cs) {
    const s = (state?.sessions || []).find(x => x.cs === cs) || { cs, name: cs, seat: '?', status: 'lost' };
    const seat = (state?.seats || []).find(z => z.name === s.seat); const p = seat ? seatPct(seat) : null;
    return `<div class="wp st-${esc(s.status || 'idle')}" data-cs="${esc(cs)}" style="--seatcol:${seatColor(s.seat)}">
      <div class="wp-head">
        <span class="wp-grip" data-wp-grip title="Drag to rearrange"><i></i><i></i><i></i><i></i><i></i><i></i></span>
        <span class="wp-num" title="Alt+number to focus"></span>
        <span class="dot ${esc(s.status || 'idle')}"></span>
        <span class="wp-name" title="Double-click to rename">${esc(s.name || cs)}</span>
        <span class="wp-seat"><span class="ring xs" style="--p:${p ?? 0};--c:var(--${lvl(p) === 'unknown' ? 'faint' : lvl(p)})"></span>${esc(s.seat || '?')}${p != null ? ` ${p}%` : ''}</span>
        <span class="wp-spacer"></span>
        <button class="btn sm" data-wp="handoff" title="Move to the freshest seat">Hand off</button>
        <button class="iconbtn" data-wp="pop" title="Open in Terminal app">⇱</button>
        <button class="iconbtn" data-wp="max" title="Maximize">⤢</button>
        <span class="wp-close-wrap">
          <button class="iconbtn" data-wp="menu" title="Remove or stop">✕</button>
          <div class="wp-menu" hidden>
            <button data-wp="hide">Hide from workspace<small>keeps the session running</small></button>
            <button class="danger" data-wp="stop">Stop session<small>ends it — resume later from Sessions</small></button>
          </div>
        </span>
      </div>
      <div class="wp-term"></div>
      <div class="wp-ended" hidden><div><b>Session ended</b> <span class="muted wp-ended-code"></span></div><button class="btn sm primary" data-wp="resume">Resume</button></div>
    </div>`;
  },
  emptyNode() {
    const n = this.running().length;
    const d = document.createElement('div'); d.className = 'ws-empty card flat';
    d.innerHTML = `<div><b>Nothing in the workspace yet.</b><div class="muted" style="margin-top:6px;max-width:460px">Add a running session to watch and drive it here, or start a new one. Open several across different accounts to run them side by side.</div></div>${n ? `<button class="btn" data-ws-addall>Add ${n} running session${n === 1 ? '' : 's'}</button>` : `<button class="btn primary" data-ws-new>New session</button>`}`;
    return d;
  },
  makeNode(cs) { const d = document.createElement('div'); d.innerHTML = this.paneHtml(cs).trim(); return d.firstElementChild; },
  renderGrid() {
    this.grid.innerHTML = ''; this.handles = []; this._cols = this._rows = 0;
    if (!this.order.length) { this.grid.classList.add('is-empty'); this.grid.appendChild(this.emptyNode()); this.rootEl.classList.remove('focus'); return; }
    this.grid.classList.remove('is-empty');
    for (const cs of this.order) { const node = this.makeNode(cs); this.grid.appendChild(node); const alive = !!(state?.sessions || []).find(x => x.cs === cs && x.alive); const pane = new WsPane(cs, node, !alive); this.panes.set(cs, pane); pane.mount(); }
    this.rootEl.classList.toggle('focus', !!this.focus); this.refreshAll(); this.applyTracks(); this.fitAll();
  },
  // Lay out the visible panes into resizable fr-based tracks, and (re)place the drag gutters.
  applyTracks() {
    if (!this.grid || this.grid.classList.contains('is-empty')) { this.clearHandles(); return; }
    const vis = [];
    for (const cs of this.order) { const pane = this.panes.get(cs); if (!pane) continue; const show = this.focus ? cs === this.focus : this.matches(cs); pane.node.classList.toggle('wp-hidden', !show); if (show) vis.push(cs); }
    this._visCache = vis;
    if (this.focus) { this.grid.style.height = this.fillHeight() + 'px'; this.grid.style.gridTemplateColumns = '1fr'; this.grid.style.gridTemplateRows = '1fr'; this.clearHandles(); return; }
    const n = vis.length; if (!n) { this.grid.style.height = ''; this.clearHandles(); return; }
    const cols = this.computeCols(n), rows = Math.ceil(n / cols);
    if (this.colFr.length !== cols) this.colFr = Array(cols).fill(1);
    if (this.rowFr.length !== rows) this.rowFr = Array(rows).fill(1);
    // The grid fills the viewport; rows share that height, so resizing one row shrinks its neighbour
    // rather than pushing panes off-screen. With many rows it grows past the viewport and the page scrolls.
    this.grid.style.height = Math.max(this.fillHeight(), rows * this.MINROW + (rows - 1) * 12) + 'px';
    this.grid.style.gridTemplateColumns = this.colFr.map(f => f.toFixed(4) + 'fr').join(' ');
    this.grid.style.gridTemplateRows = this.rowFr.map(f => f.toFixed(4) + 'fr').join(' ');
    if (cols !== this._cols || rows !== this._rows) { this._cols = cols; this._rows = rows; this.buildHandles(cols, rows); }
    this.positionHandles();
  },
  fillHeight() { const top = this.grid ? this.grid.getBoundingClientRect().top : 160; return Math.max(320, Math.round(window.innerHeight - top - 24)); },
  clearHandles() { for (const h of this.handles) h.remove(); this.handles = []; this._cols = this._rows = 0; },
  buildHandles(cols, rows) {
    this.clearHandles(); this._cols = cols; this._rows = rows;
    for (let i = 1; i < cols; i++) this.handles.push(this.makeHandle('col', i));
    for (let j = 1; j < rows; j++) this.handles.push(this.makeHandle('row', j));
  },
  makeHandle(kind, idx) { const h = document.createElement('div'); h.className = 'ws-gutter ' + kind; h.dataset.kind = kind; h.dataset.idx = idx; h.innerHTML = '<span class="grip"><i></i><i></i><i></i></span>'; this.grid.appendChild(h); this.attachGutter(h); return h; },
  visNodeAt(r, c) { const cs = (this._visCache || [])[r * this._cols + c]; const p = cs && this.panes.get(cs); return p ? p.node : null; },
  positionHandles() {
    if (!this.handles.length || !this.grid) return; const gap = 12;
    const base = this.visNodeAt(0, 0); const rowMid = base ? base.offsetHeight / 2 : 120, colMid = base ? base.offsetWidth / 2 : 160;
    for (const h of this.handles) { const kind = h.dataset.kind, idx = +h.dataset.idx, grip = h.firstElementChild;
      if (kind === 'col') { const n = this.visNodeAt(0, idx); if (!n) { h.style.display = 'none'; continue; } h.style.display = ''; h.style.left = (n.offsetLeft - gap / 2) + 'px'; h.style.top = '0'; h.style.width = gap + 'px'; h.style.height = this.grid.clientHeight + 'px'; if (grip) { grip.style.left = gap / 2 + 'px'; grip.style.top = rowMid + 'px'; } }
      else { const n = this.visNodeAt(idx, 0); if (!n) { h.style.display = 'none'; continue; } h.style.display = ''; h.style.top = (n.offsetTop - gap / 2) + 'px'; h.style.left = '0'; h.style.height = gap + 'px'; h.style.width = this.grid.clientWidth + 'px'; if (grip) { grip.style.top = gap / 2 + 'px'; grip.style.left = colMid + 'px'; } } }
  },
  attachGutter(h) {
    h.addEventListener('pointerdown', e => {
      e.preventDefault(); const kind = h.dataset.kind, idx = +h.dataset.idx;
      h.setPointerCapture(e.pointerId); h.classList.add('dragging'); document.body.classList.add('ws-dragging-' + kind);
      let move;
      if (kind === 'col') {
        // Columns share a fixed width: dragging redistributes fr between the two adjacent columns.
        const a = this.visNodeAt(0, idx - 1), b = this.visNodeAt(0, idx);
        if (!a || !b) { h.classList.remove('dragging'); document.body.classList.remove('ws-dragging-' + kind); try { h.releasePointerCapture(e.pointerId); } catch {} return; }
        const startX = e.clientX, aPx0 = a.offsetWidth, totalPx = aPx0 + b.offsetWidth;
        const totalFr = this.colFr[idx - 1] + this.colFr[idx], minPx = Math.max(140, Math.min(260, totalPx * 0.22));
        move = ev => { const aPx = Math.max(minPx, Math.min(totalPx - minPx, aPx0 + (ev.clientX - startX)));
          this.colFr[idx - 1] = totalFr * aPx / totalPx; this.colFr[idx] = totalFr - this.colFr[idx - 1];
          this.grid.style.gridTemplateColumns = this.colFr.map(f => f.toFixed(4) + 'fr').join(' '); this.positionHandles(); };
      } else {
        // Rows share the grid height: dragging redistributes fr between the two adjacent rows.
        const a = this.visNodeAt(idx - 1, 0), b = this.visNodeAt(idx, 0);
        if (!a || !b) { h.classList.remove('dragging'); document.body.classList.remove('ws-dragging-' + kind); try { h.releasePointerCapture(e.pointerId); } catch {} return; }
        const startY = e.clientY, aPx0 = a.offsetHeight, totalPx = aPx0 + b.offsetHeight;
        const totalFr = this.rowFr[idx - 1] + this.rowFr[idx], minPx = Math.min(this.MINROW, totalPx * 0.3);
        move = ev => { const aPx = Math.max(minPx, Math.min(totalPx - minPx, aPx0 + (ev.clientY - startY)));
          this.rowFr[idx - 1] = totalFr * aPx / totalPx; this.rowFr[idx] = totalFr - this.rowFr[idx - 1];
          this.grid.style.gridTemplateRows = this.rowFr.map(f => f.toFixed(4) + 'fr').join(' '); this.positionHandles(); };
      }
      const up = () => { h.classList.remove('dragging'); document.body.classList.remove('ws-dragging-' + kind); try { h.releasePointerCapture(e.pointerId); } catch {} h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); this.save(); this.fitAll(); };
      h.addEventListener('pointermove', move); h.addEventListener('pointerup', up);
    });
  },
  addPane(cs) {
    if (this.panes.has(cs)) return;
    if (!this.order.length) { this.grid.innerHTML = ''; this.grid.classList.remove('is-empty'); }
    this.order.push(cs); this.save();
    const node = this.makeNode(cs); this.grid.appendChild(node);
    const alive = !!(state?.sessions || []).find(x => x.cs === cs && x.alive); const pane = new WsPane(cs, node, !alive); this.panes.set(cs, pane); pane.mount();
    this.refreshBar(); this.refreshRail(); this.refreshPane(cs); this.applyTracks(); this.fitAll();
  },
  addAll() { for (const s of this.running()) if (!this.panes.has(s.cs)) this.addPane(s.cs); },
  addAllIn(proj) { for (const s of this.running()) if (railProj(s) === proj && !this.panes.has(s.cs)) this.addPane(s.cs); },
  removePane(cs) {
    const pane = this.panes.get(cs); if (pane) { pane.dispose(); pane.node.remove(); this.panes.delete(cs); }
    this.order = this.order.filter(x => x !== cs); this.save();
    if (this.focus === cs) { this.focus = null; this.rootEl.classList.remove('focus'); }
    if (!this.order.length) { this.clearHandles(); this.grid.classList.add('is-empty'); this.grid.appendChild(this.emptyNode()); } else this.applyTracks();
    this.refreshBar(); this.refreshRail(); this.fitAll();
  },
  closeMenus() { this.panes.forEach(p => { const m = p.node.querySelector('.wp-menu'); if (m) m.hidden = true; }); },
  setLayout(l) { this.layout = l; this.colFr = []; this.rowFr = []; this.save(); this.applyTracks(); this.refreshBar(); this.fitAll(); },
  setFilter(f) { this.filter = f; this.colFr = []; this.rowFr = []; this.save(); this.applyTracks(); this.refreshBar(); this.fitAll(); },
  setFocus(cs) { this.focus = cs; this.rootEl.classList.toggle('focus', !!cs); this.refreshAll(); this.applyTracks(); this.refreshBar(); this.refreshRail(); this.fitAll(); },
  paneAction(action, cs) {
    if (action === 'menu') { const pane = this.panes.get(cs); if (!pane) return; const m = pane.node.querySelector('.wp-menu'); const open = m && m.hidden; this.closeMenus(); if (m && open) m.hidden = false; return; }
    if (action === 'max') return this.setFocus(this.focus === cs ? null : cs);
    if (action === 'hide') return this.removePane(cs);
    if (action === 'stop') { this.closeMenus(); return post(`/api/sessions/${encodeURIComponent(cs)}/stop`).then(() => { toast('Session stopped'); this.removePane(cs); }).catch(() => {}); }
    if (action === 'pop') return post(`/api/sessions/${encodeURIComponent(cs)}/open-terminal`).then(() => toast('Opened in Terminal')).catch(() => {});
    if (action === 'handoff') return post(`/api/sessions/${encodeURIComponent(cs)}/handoff`, { toSeat: null }).then(j => toast(j.queued ? `Queued → ${j.to}` : `→ ${j.to}`)).catch(() => {});
    if (action === 'resume') return post(`/api/sessions/${encodeURIComponent(cs)}/restore`, {}).then(() => { toast('Resuming…'); const pane = this.panes.get(cs); if (pane) { const o = pane.node.querySelector('.wp-ended'); if (o) o.hidden = true; pane.connect(); } setTimeout(load, 500); }).catch(() => {});
  },
  refreshPane(cs) {
    const pane = this.panes.get(cs); if (!pane) return; const node = pane.node;
    const s = (state?.sessions || []).find(x => x.cs === cs); const status = s?.status || (pane.ended ? 'ended' : 'idle');
    node.className = 'wp st-' + status + (this.focus === cs ? ' focused' : '') + (node.classList.contains('wp-hidden') ? ' wp-hidden' : '');
    if (s) node.style.setProperty('--seatcol', seatColor(s.seat));
    const num = node.querySelector('.wp-num'); if (num) num.textContent = this.order.indexOf(cs) + 1;
    const dot = node.querySelector('.dot'); if (dot) dot.className = 'dot ' + status;
    const nm = node.querySelector('.wp-name'); if (nm && s && this.editingCs !== cs) nm.textContent = s.name || cs;
    const seat = s ? (state?.seats || []).find(z => z.name === s.seat) : null; const p = seat ? seatPct(seat) : null;
    const se = node.querySelector('.wp-seat'); if (se) se.innerHTML = `<span class="ring xs" style="--p:${p ?? 0};--c:var(--${lvl(p) === 'unknown' ? 'faint' : lvl(p)})"></span>${esc(s?.seat || '?')}${p != null ? ` ${p}%` : ''}`;
    const mx = node.querySelector('[data-wp="max"]'); if (mx) mx.textContent = this.focus === cs ? '❏' : '⤢';
    if (s && !s.alive && !pane.ended) pane.markEnded();
  },
  refreshAll() { for (const cs of this.order) this.refreshPane(cs); },
  fitAll() { requestAnimationFrame(() => { this.panes.forEach(p => p.fitNow()); this.positionHandles(); }); setTimeout(() => { this.panes.forEach(p => p.fitNow()); this.positionHandles(); }, 280); },
  applyAppearance() { this.panes.forEach(p => p.applyAppearance()); },
  update() {
    if (!this.built) return;
    // Keep only running sessions: a pane whose session ended or was lost drops out automatically.
    for (const cs of [...this.order]) { const s = this.sessOf(cs); if (!s || !s.alive) this.removePane(cs); }
    if (this.barSigNow() !== this.barSig) this.refreshBar();
    if (this.railSigNow() !== this.railSig) this.refreshRail();
    this.refreshAll();
    const vsig = this.visibleOrder().join(',') + '|' + (this.focus || '') + '|' + this.layout + '|' + this.filter;
    if (vsig !== this._vsig) { this._vsig = vsig; this.applyTracks(); this.fitAll(); }
  },
  teardown() { this.closeMenus(); this.clearHandles(); if (this._onKey) { document.removeEventListener('keydown', this._onKey, true); this._onKey = null; } this.panes.forEach(p => p.dispose()); this.panes.clear(); this.built = false; this.rootEl = this.grid = this.bar = this.rail = null; }
};
window.addEventListener('resize', () => { if (view === 'workspace' && wsCtl.built) { wsCtl.applyTracks(); wsCtl.fitAll(); } });
