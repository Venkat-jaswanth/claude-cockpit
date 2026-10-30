// The cockpit TUI — a terminal-native control room, rendered with Ink. It talks to the same
// daemon the dashboard does (src/client.js) and is launched by `cockpit tui`.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import React, { useState, useEffect } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import htm from 'htm';
import { loadConfig, portOf } from '../config.js';
import { request } from '../client.js';
import { ensureDaemon } from '../daemonctl.js';
import { attach } from '../attach.js';
import { claudeEnv } from '../seats.js';
import { CLAUDE_BIN } from '../paths.js';

const html = htm.bind(React.createElement);
const ACCENT = '#5eead4';          // teal — cockpit's terminal accent (refined in the brand pass)
const ACCENT_DIM = '#2f6f69';
const SEAT_COLORS = ['#5eead4', '#f0abfc', '#fca5a5', '#fcd34d', '#7dd3fc', '#c4b5fd', '#86efac', '#fdba74'];  // one stable colour per seat
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];  // braille spinner for "thinking"
const evColor = t => /error|exhausted|crash/.test(t) ? 'red' : /limit|handoff|threshold|recommend|queued|lost/.test(t) ? 'yellow' : /start|resumed|usage|arm|restore/.test(t) ? 'green' : 'gray';

function projOf(s) { const cwd = s.cwd || ''; if (/scratch-workspaces/.test(cwd)) return 'scratch'; return (cwd ? path.basename(cwd) : 'unknown') || 'unknown'; }
const pctColor = p => p == null ? 'gray' : p >= 85 ? 'red' : p >= 60 ? 'yellow' : 'green';
const dotColor = s => s.status === 'busy' ? ACCENT : s.status === 'idle' ? 'green' : s.status === 'lost' || s.status === 'crashed' ? 'red' : 'yellow';
function ago(ts) { if (!ts) return ''; const m = Math.round((Date.now() - ts) / 60000); if (m < 1) return 'now'; if (m < 60) return m + 'm'; const h = Math.floor(m / 60); return h < 24 ? h + 'h' : Math.floor(h / 24) + 'd'; }
function resetsIn(iso) { if (!iso) return ''; const ms = new Date(iso).getTime() - Date.now(); if (ms <= 0) return 'reset'; const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m`; }

const shownSessions = st => (st?.sessions || []).filter(s => s.kind === 'claude' && s.managed && (s.alive || s.status === 'lost'));
function group(sessions, filter) {
  const f = (filter || '').trim().toLowerCase();
  const list = f ? sessions.filter(s => (s.name || s.cs).toLowerCase().includes(f) || projOf(s).toLowerCase().includes(f)) : sessions;
  const map = new Map();
  for (const s of list) { const k = projOf(s); (map.get(k) || map.set(k, []).get(k)).push(s); }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([project, items]) => ({ project, items: items.sort((a, b) => (b.status === 'idle' ? 1 : 0) - (a.status === 'idle' ? 1 : 0)) }));  // needs-you first
}

const VERBS = [
  { name: 'status', hint: 'running sessions by project' },
  { name: 'projects', hint: 'browse every project' },
  { name: 'new', hint: 'start a session in this folder' },
  { name: 'usage', hint: 'account usage & limits' },
  { name: 'activity', hint: 'recent events log' },
  { name: 'ask', hint: 'chat with the cockpit assistant' },
  { name: 'help', hint: 'keyboard reference' },
  { name: 'quit', hint: 'exit cockpit' },
];
// The cockpit assistant: a chat that runs on one of the user's own seats, headless, no tools.
const BOT_DIR = path.join(os.homedir(), '.claude-cockpit', 'bot');
const BOT_SYS = "You are the assistant inside claude-cockpit, a tool for running many Claude Code sessions across several accounts (\"seats\") on one machine. Help the person operate it: explain its commands (status, projects, usage, handoff, new, attach, rename, ask), seats and accounts, the 5-hour usage limits and hand-offs, and setup. Talk like a helpful teammate over text — a few sentences, warm and concrete, no walls of text, no markdown headings. Give the exact command or steps; never claim to have done something yourself. If asked something unrelated, answer briefly and steer back to cockpit.";
function runBot(seat, message, convId) {
  return new Promise(resolve => {
    try { fs.mkdirSync(BOT_DIR, { recursive: true }); } catch {}
    const args = ['-p', message, '--output-format', 'json', '--append-system-prompt', BOT_SYS, '--permission-prompts', 'none'];
    if (convId) args.push('--resume', convId);
    // Use the same auth the daemon uses for this seat: a `base` seat must NOT set CLAUDE_CONFIG_DIR
    // (it logs in via the default location / Keychain); only profile seats point at their own dir.
    execFile(CLAUDE_BIN, args, { cwd: BOT_DIR, env: claudeEnv(seat), maxBuffer: 16 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
      const raw = String(stdout || '');
      if (!raw.trim()) return resolve({ ok: false, error: String((stderr || (err && err.message) || 'no response')).split('\n')[0].slice(0, 200) });
      try { const j = JSON.parse(raw); resolve({ ok: !j.is_error, text: (j.result || '').trim() || '(no reply)', id: j.session_id || convId, error: j.is_error ? (j.result || 'error') : null }); }
      catch { resolve({ ok: true, text: raw.trim(), id: convId }); }
    });
  });
}
function meter(pct, width = 18) { const n = Math.round(Math.max(0, Math.min(100, pct || 0)) / 100 * width); return '█'.repeat(n) + '░'.repeat(width - n); }
function burnText(s) { const b = s.burn; if (b && b.rising && b.etaMin != null && b.etaMin > 0 && b.etaMin <= 600) return `▲ ${b.perHour}%/h · ~${b.etaMin >= 60 ? Math.floor(b.etaMin / 60) + 'h' + (b.etaMin % 60) + 'm' : b.etaMin + 'm'} left`; return 'steady'; }
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
// Keep a long list inside the terminal: show a window of up to `max` rows that follows the cursor.
function windowed(items, cursor, max) {
  const n = items.length, m = Math.max(1, max);
  if (n <= m) return { slice: items, start: 0, above: 0, below: 0 };
  const start = Math.max(0, Math.min(cursor - Math.floor(m / 2), n - m));
  return { slice: items.slice(start, start + m), start, above: start, below: n - (start + m) };
}
const moreRow = (dir, n) => html`<${Box}><${Text} color=${ACCENT_DIM}>${'  ' + dir + ' ' + n + ' more'}</${Text}></${Box}>`;
// Sparkline of a seat's recent 5-hour % (daemon exposes pctTrend), normalised to its own range.
const SPK = '▁▂▃▄▅▆▇█';
function spark(arr, n = 8) {
  const a = (arr || []).filter(v => typeof v === 'number');
  if (a.length < 2) return '·'.repeat(n);
  const tail = a.slice(-n), lo = Math.min(...tail), hi = Math.max(...tail), rng = (hi - lo) || 1;
  const s = tail.map(v => SPK[Math.min(7, Math.floor((v - lo) / rng * 7.999))]).join('');
  return s.length < n ? SPK[0].repeat(n - s.length) + s : s;
}
// The big wordmark (ANSI Shadow), shown at the top of the home page when the terminal has room.
const HERO = [
  ' ██████╗ ██████╗  ██████╗██╗  ██╗██████╗ ██╗████████╗',
  '██╔════╝██╔═══██╗██╔════╝██║ ██╔╝██╔══██╗██║╚══██╔══╝',
  '██║     ██║   ██║██║     █████╔╝ ██████╔╝██║   ██║   ',
  '██║     ██║   ██║██║     ██╔═██╗ ██╔═══╝ ██║   ██║   ',
  '╚██████╗╚██████╔╝╚██████╗██║  ██╗██║     ██║   ██║   ',
  ' ╚═════╝ ╚═════╝  ╚═════╝╚═╝  ╚═╝╚═╝     ╚═╝   ╚═╝   ',
];

function Logo({ label }) {
  return html`<${Box} marginBottom=${1}>
    <${Text} color=${ACCENT} bold>${'❯ '}</${Text}><${Text} bold>${'cockpit'}</${Text}>
    <${Text} color="gray">${'   ' + (label || 'terminal control for many Claude Code seats')}</${Text}>
  </${Box}>`;
}

function SeatBar({ seats }) {
  const live = (seats || []).filter(s => !s.disabled && s.usage?.loggedIn);
  if (!live.length) return html`<${Box} marginTop=${1}><${Text} color="gray">no seats logged in</${Text}></${Box}>`;
  const best = live.slice().sort((a, b) => (a.usage.fiveHour?.pct ?? 999) - (b.usage.fiveHour?.pct ?? 999))[0];
  const col = n => SEAT_COLORS[Math.max(0, (seats || []).findIndex(x => x.name === n)) % SEAT_COLORS.length];
  return html`<${Box} marginTop=${1}>
    <${Text} color="gray">seats  </${Text}>
    ${live.map((s, i) => { const p = s.usage.fiveHour?.pct; const r = resetsIn(s.usage.fiveHour?.resetsAt);
      return html`<${Box} key=${s.name}>
        ${i ? html`<${Text} color="gray">${'  ·  '}</${Text}>` : null}
        <${Text} color=${col(s.name)} bold=${s.name === best.name}>${s.name}</${Text}>
        <${Text} color="gray"> </${Text}><${Text} color=${pctColor(p)}>${p == null ? '–' : p + '%'}</${Text}>
        ${r ? html`<${Text} color="gray"> ${r}</${Text}>` : null}
      </${Box}>`; })}
    <${Text} color=${ACCENT}>${'    ★ ' + best.name}</${Text}>
  </${Box}>`;
}

function Row({ s, selected, seatCol }) {
  return html`<${Box}>
    <${Text} color=${ACCENT}>${selected ? '› ' : '  '}</${Text}>
    <${Text} color=${dotColor(s)}>${'● '}</${Text}>
    <${Box} width=${30}><${Text} color=${selected ? 'white' : undefined} bold=${selected} wrap="truncate-end">${s.name || s.cs}</${Text}></${Box}>
    <${Box} width=${12}><${Text} color=${seatCol || 'gray'} wrap="truncate-end">${s.seat || '?'}</${Text}></${Box}>
    <${Box} width=${10}><${Text} color=${dotColor(s)}>${(s.status || '').replace('_', ' ')}</${Text}></${Box}>
    <${Box} width=${6}><${Text} color="gray">${(s.turns ?? 0) + 't'}</${Text}></${Box}>
    <${Box} width=${6}><${Text} color="gray">${ago(s.lastActivity)}</${Text}></${Box}>
    ${s.pendingHandoff ? html`<${Text} color="yellow">${'→ ' + s.pendingHandoff.to}</${Text}>` : null}
  </${Box}>`;
}

function App({ port, onDone, initial }) {
  const [st, setSt] = useState(null);
  const [lib, setLib] = useState(null);
  const [view, setView] = useState(initial?.view || 'status');     // status | projects
  const [sel, setSel] = useState(0);
  const [psel, setPsel] = useState(0);            // projects level-1 / level-2 cursor
  const [openProject, setOpenProject] = useState(initial?.openProject || null);
  const [filter, setFilter] = useState('');
  const [mode, setMode] = useState('list');       // list | rename | confirm | filter | cmd | help
  const [buf, setBuf] = useState('');
  const [msg, setMsg] = useState('');
  const [botMsgs, setBotMsgs] = useState([]);
  const [botBuf, setBotBuf] = useState('');
  const [botPending, setBotPending] = useState(false);
  const [botConvId, setBotConvId] = useState(null);
  const [connErr, setConnErr] = useState(false);
  const [usel, setUsel] = useState(0);            // usage view: selected seat
  const [tick, setTick] = useState(0);            // animation frame for the "thinking" spinner

  useEffect(() => {
    let alive = true;
    const tick = async () => { try { const r = await request(port, 'GET', '/api/state'); if (alive) { setSt(r.body); setConnErr(false); } } catch { if (alive) setConnErr(true); } };
    const tickLib = async () => { try { const r = await request(port, 'GET', '/api/library'); if (alive) setLib(r.body?.sessions || []); } catch {} };
    tick(); tickLib();
    const a = setInterval(tick, 2000), b = setInterval(tickLib, 8000);
    return () => { alive = false; clearInterval(a); clearInterval(b); };
  }, [port]);

  // Drive the "thinking" spinner only while a bot reply is in flight.
  useEffect(() => {
    if (!botPending) return;
    const id = setInterval(() => setTick(t => (t + 1) % 10000), 90);
    return () => clearInterval(id);
  }, [botPending]);

  const post = (p, body) => request(port, 'POST', p, body || {}).catch(() => {});
  const flash = m => { setMsg(m); setTimeout(() => setMsg(''), 2500); };
  // Leave the TUI to attach/resume/start a session, remembering where we were so we land
  // back on the same view (e.g. projects) when the session detaches with Ctrl-].
  const leave = (a) => onDone({ ...a, from: { view, openProject } });
  function submitBot() {
    const message = botBuf.trim(); if (!message || botPending) return;
    const logged = (st?.seats || []).filter(s => !s.disabled && s.usage?.loggedIn);
    const seat = logged.slice().sort((a, b) => (a.usage.fiveHour?.pct ?? 999) - (b.usage.fiveHour?.pct ?? 999))[0];
    setBotBuf(''); setBotMsgs(m => [...m, { role: 'you', text: message }]);
    if (!seat) { setBotMsgs(m => [...m, { role: 'bot', text: 'No logged-in account to run on — add or log in a seat first.' }]); return; }
    setBotPending(true);
    runBot(seat, message, botConvId).then(res => { setBotPending(false); setBotMsgs(m => [...m, { role: 'bot', text: res.ok ? res.text : '⚠ ' + (res.error || 'failed') }]); if (res.ok && res.id) setBotConvId(res.id); });
  }
  const liveBySid = new Map((st?.sessions || []).filter(s => s.alive).map(s => [s.sessionId, s]));
  const _liveSeats = (st?.seats || []).filter(s => !s.disabled && s.usage?.loggedIn);
  const bestName = _liveSeats.slice().sort((a, b) => (a.usage.fiveHour?.pct ?? 999) - (b.usage.fiveHour?.pct ?? 999))[0]?.name;
  const seatColOf = name => { const i = (st?.seats || []).findIndex(z => z.name === name); return SEAT_COLORS[(i < 0 ? 0 : i) % SEAT_COLORS.length]; };
  const usageSeats = (st?.seats || []).filter(s => !s.disabled);
  const curUsageSeat = usageSeats[Math.min(usel, usageSeats.length - 1)] || null;

  // ---- derived lists per view ----
  const groups = st ? group(shownSessions(st), mode === 'filter' ? buf : filter) : [];
  const flat = groups.flatMap(g => g.items);
  const cur = flat[Math.min(sel, flat.length - 1)] || null;

  const niceProj = r => { const n = r.projectName || ''; return (/scratch-workspaces/.test(r.cwd || '') || /^scratch-\d/.test(n)) ? 'scratch' : (n || 'unknown'); };
  const projList = (() => {
    const map = new Map();
    for (const r of (lib || [])) { const k = niceProj(r); const g = map.get(k) || { name: k, count: 0, lastAt: 0, cwd: r.cwd }; g.count++; g.lastAt = Math.max(g.lastAt, r.lastAt || 0); map.set(k, g); }
    return [...map.values()].sort((a, b) => b.lastAt - a.lastAt);
  })();
  const projSessions = openProject ? (lib || []).filter(r => niceProj(r) === openProject).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)) : [];
  const curProj = projList[Math.min(psel, projList.length - 1)] || null;
  const curProjSess = projSessions[Math.min(psel, projSessions.length - 1)] || null;

  useEffect(() => { if (sel > flat.length - 1) setSel(Math.max(0, flat.length - 1)); }, [flat.length]);

  function runCmd(raw) {
    const v = (raw || '').trim().toLowerCase(); setMode('list'); setBuf('');
    if (!v) return;
    const m = VERBS.find(x => x.name === v) || VERBS.find(x => x.name.startsWith(v));
    if (!m) return flash(`unknown command: ${v}`);
    if (m.name === 'status') { setView('status'); }
    else if (m.name === 'projects') { setView('projects'); setOpenProject(null); setPsel(0); }
    else if (m.name === 'usage') setView('usage');
    else if (m.name === 'activity') setView('activity');
    else if (m.name === 'new') leave({ action: 'new', cwd: process.cwd() });
    else if (m.name === 'ask') setView('bot');
    else if (m.name === 'help') setMode('help');
    else if (m.name === 'quit') onDone({ action: 'quit' });
  }

  useInput((input, key) => {
    // ---- text-entry modes ----
    if (mode === 'cmd') {
      if (key.return) return runCmd(buf);
      if (key.escape) { setMode('list'); setBuf(''); return; }
      if (key.backspace || key.delete) return setBuf(b => b.slice(0, -1));
      if (input && !key.ctrl && !key.meta) return setBuf(b => b + input);
      return;
    }
    if (mode === 'rename') {
      if (key.return) { const nm = buf.trim(); if (cur) { post(`/api/sessions/${encodeURIComponent(cur.cs)}/rename`, { name: nm }); if (cur.sessionId) post(`/api/marks/${encodeURIComponent(cur.sessionId)}`, { name: nm }); flash(nm ? 'renamed' : 'name cleared'); } setMode('list'); setBuf(''); return; }
      if (key.escape) { setMode('list'); setBuf(''); return; }
      if (key.backspace || key.delete) return setBuf(b => b.slice(0, -1));
      if (input && !key.ctrl && !key.meta) return setBuf(b => b + input);
      return;
    }
    if (mode === 'filter') {
      if (key.return || key.escape) { setFilter(key.escape ? '' : buf); setMode('list'); setBuf(''); setSel(0); return; }
      if (key.backspace || key.delete) return setBuf(b => b.slice(0, -1));
      if (input && !key.ctrl && !key.meta) return setBuf(b => b + input);
      return;
    }
    if (mode === 'confirm') { if (input === 'y' && cur) { post(`/api/sessions/${encodeURIComponent(cur.cs)}/stop`); flash('stopping ' + (cur.name || cur.cs)); } setMode('list'); return; }
    if (mode === 'help') { setMode('list'); return; }

    // ---- bot view: a chat, so keystrokes are the message ----
    if (view === 'bot') {
      if (key.ctrl && input === 'c') return onDone({ action: 'quit' });
      if (key.escape) { setView('status'); return; }
      if (key.return) return submitBot();
      if (key.backspace || key.delete) return setBotBuf(b => b.slice(0, -1));
      if (input && !key.ctrl && !key.meta) return setBotBuf(b => b + input);
      return;
    }

    // ---- global ----
    if (key.ctrl && input === 'c') return onDone({ action: 'quit' });
    if (input === ':') { setMode('cmd'); setBuf(''); return; }
    if (input === 'q') return onDone({ action: 'quit' });
    if (input === '?') return setMode('help');

    // ---- projects view ----
    if (view === 'projects') {
      if (openProject) {
        if (key.escape) { setOpenProject(null); setPsel(0); return; }
        if (key.upArrow || input === 'k') return setPsel(s => Math.max(0, s - 1));
        if (key.downArrow || input === 'j') return setPsel(s => Math.min(projSessions.length - 1, s + 1));
        if (key.return && curProjSess) { const live = liveBySid.get(curProjSess.sessionId); if (live) return leave({ action: 'attach', cs: live.cs, label: live.name || '' }); return leave({ action: 'resume', resumeId: curProjSess.sessionId, cwd: curProjSess.cwd, label: curProjSess.title || '' }); }
        return;
      }
      if (key.escape) { setView('status'); return; }
      if (key.upArrow || input === 'k') return setPsel(s => Math.max(0, s - 1));
      if (key.downArrow || input === 'j') return setPsel(s => Math.min(projList.length - 1, s + 1));
      if (key.return && curProj) { setOpenProject(curProj.name); setPsel(0); return; }
      return;
    }

    // ---- usage view ----
    if (view === 'usage') {
      if (key.escape) { setView('status'); return; }
      if (key.upArrow || input === 'k') return setUsel(x => Math.max(0, x - 1));
      if (key.downArrow || input === 'j') return setUsel(x => Math.min(usageSeats.length - 1, x + 1));
      if (input === 'r') { post('/api/probe-all'); flash('refreshing all seats…'); return; }
      if (curUsageSeat) {
        if (input === 'c') { post(`/api/seats/${encodeURIComponent(curUsageSeat.name)}/probe`); flash('checking ' + curUsageSeat.name); }
        else if (input === 'w') { post(`/api/seats/${encodeURIComponent(curUsageSeat.name)}/arm`); flash('arming ' + curUsageSeat.name); }
      }
      return;
    }
    // ---- activity view ----
    if (view === 'activity') { if (key.escape) setView('status'); return; }

    // ---- status view ----
    if (key.upArrow || input === 'k') return setSel(s => Math.max(0, s - 1));
    if (key.downArrow || input === 'j') return setSel(s => Math.min(flat.length - 1, s + 1));
    if (input === 'p') { setView('projects'); setOpenProject(null); setPsel(0); return; }
    if (input === 'u') { setView('usage'); return; }
    if (input === 'l') { setView('activity'); return; }
    if (input === 'a') { setView('bot'); return; }
    if (input === 'n') return leave({ action: 'new', cwd: process.cwd() });
    if (input === '/') { setMode('filter'); setBuf(filter); return; }
    if (!cur) return;
    // A lost session has no live PTY to attach to — resume it from its transcript instead.
    if (key.return) return leave((cur.alive && cur.status !== 'lost')
      ? { action: 'attach', cs: cur.cs, label: cur.name || '' }
      : { action: 'resume', resumeId: cur.sessionId, cwd: cur.cwd, label: cur.name || '' });
    if (input === 'o') { post(`/api/sessions/${encodeURIComponent(cur.cs)}/open-terminal`); flash('opened in Terminal'); }
    else if (input === 'x') setMode('confirm');
    else if (input === 'r') { setMode('rename'); setBuf(cur.name || ''); }
    else if (input === 'h') { post(`/api/sessions/${encodeURIComponent(cur.cs)}/handoff`, { toSeat: null }); flash('handing off ' + (cur.name || cur.cs)); }
  });

  const cols = process.stdout.columns || 100;
  const rows = process.stdout.rows || 30;
  const twoCol = cols >= 92;
  const viewLabel = { status: 'mission control', usage: 'usage', projects: 'projects', activity: 'activity', bot: 'assistant' }[view] || '';
  // The home page leads with the big wordmark when the terminal is tall and wide enough for it.
  const heroHome = view === 'status' && rows >= 30 && cols >= 54;
  // How many list rows fit without overflowing the window (overflow corrupts Ink's next repaint).
  const projMax = Math.max(4, rows - 12);
  const statusMax = Math.max(3, rows - (heroHome ? 18 : 12));

  if (!st) return html`<${Box} padding=${1} flexDirection="column">
    <${Text} color=${connErr ? 'red' : ACCENT}>${connErr ? '⚠ can’t reach the cockpit daemon' : '❯ connecting to the cockpit daemon…'}</${Text}>
    ${connErr ? html`<${Text} color="gray">Start it in a terminal:  cockpit daemon start</${Text}>` : null}
  </${Box}>`;

  // ---- render ----
  const footer = mode === 'cmd' ? null
    : view === 'projects'
      ? (openProject ? '↵ open · esc back · q quit' : '↵ open project · esc status · q quit')
      : view === 'usage'
        ? '↑↓ select · c check · w arm window · r refresh all · esc'
        : view === 'activity'
          ? 'esc status · q quit'
          : view === 'bot'
            ? 'type a message · ↵ send · esc leave'
            : '↵ attach · n new · r rename · x stop · h hand off · p projects · u usage · l log · a ask · : cmd · ?';

  return html`<${Box} flexDirection="column" padding=${1}>
    ${heroHome
      ? html`<${Box} flexDirection="column" marginBottom=${1}>
          ${HERO.map((ln, i) => html`<${Text} key=${i} color=${ACCENT} bold>${ln}</${Text}>`)}
        </${Box}>`
      : html`<${Logo} label=${viewLabel} />`}

    ${view === 'status' ? html`<${Box} flexDirection=${twoCol ? 'row' : 'column'}>
      <${Box} flexDirection="column" borderStyle="round" borderColor=${ACCENT_DIM} paddingX=${1} width=${twoCol ? 30 : undefined} marginRight=${twoCol ? 1 : 0} marginBottom=${twoCol ? 0 : 1}>
        <${Text} color=${ACCENT} bold>${'seats '}<${Text} color="gray">${'· ' + _liveSeats.length}</${Text}></${Text}>
        ${usageSeats.map(s => { const u = s.usage || {}, fh = u.fiveHour || {}, p = fh.pct, wk = (u.weekly || []).reduce((a, w) => Math.max(a, w.pct || 0), 0); const isBest = s.name === bestName;
          return html`<${Box} key=${s.name} flexDirection="column" marginTop=${1}>
            <${Box}><${Text} color=${seatColOf(s.name)} bold=${isBest}>${(((isBest ? '★ ' : '  ') + s.name).padEnd(13)).slice(0, 13)}</${Text}>${u.loggedIn ? html`<${Text} color=${pctColor(p)}>${' ' + meter(p, 10) + ' ' + (p == null ? '–' : p + '%')}</${Text}>` : html`<${Text} color="red"> offline</${Text}>`}</${Box}>
            ${u.loggedIn ? html`<${Text} color="gray">${'   resets ' + ((() => { const r = resetsIn(fh.resetsAt); return r && r !== 'reset' ? r : '—'; })()) + '  ·  wk ' + (wk ? wk + '%' : '–')}</${Text}>` : null}
            ${u.loggedIn ? html`<${Box}><${Text} color="gray">${'   '}</${Text}><${Text} color=${(s.burn && s.burn.rising) ? 'yellow' : 'gray'}>${burnText(s)}</${Text}></${Box}>` : null}
          </${Box}>`; })}
      </${Box}>
      <${Box} flexDirection="column" borderStyle="round" borderColor=${ACCENT_DIM} paddingX=${1} flexGrow=${1}>
        <${Box}><${Text} color=${ACCENT} bold>${'status '}</${Text}><${Text} color="gray">${`· ${flat.length} session${flat.length === 1 ? '' : 's'} · ${groups.length} project${groups.length === 1 ? '' : 's'}`}</${Text}>${filter ? html`<${Text} color=${ACCENT}>${`   /${filter}`}</${Text}>` : null}</${Box}>
        ${flat.length === 0 ? html`<${Box} marginTop=${1}><${Text} color="gray">No running sessions. Press n to start one, or p for projects.</${Text}></${Box}>`
          : (() => {
              const win = windowed(flat, Math.min(sel, flat.length - 1), statusMax);
              const out = []; let lastProj = null;
              win.slice.forEach(s => {
                const pj = projOf(s);
                if (pj !== lastProj) { lastProj = pj; out.push(html`<${Box} key=${'h:' + pj} marginTop=${1}><${Text} bold>${pj} <${Text} color="gray">${'· ' + flat.filter(x => projOf(x) === pj).length}</${Text}></${Text}></${Box}>`); }
                const on = cur && s.cs === cur.cs;
                out.push(html`<${Box} key=${s.cs}>
                  <${Text} color=${ACCENT}>${on ? '› ' : '  '}</${Text}>
                  <${Text} color=${dotColor(s)}>${'● '}</${Text}>
                  <${Box} width=${18} marginRight=${1}><${Text} color=${on ? 'white' : undefined} bold=${on} wrap="truncate-end">${s.name || s.cs}</${Text}></${Box}>
                  <${Box} width=${8} marginRight=${1}><${Text} color=${seatColOf(s.seat)} wrap="truncate-end">${s.seat || '?'}</${Text}></${Box}>
                  <${Box} width=${10}><${Text} color=${dotColor(s)}>${(s.status || '').replace('_', ' ')}</${Text}></${Box}>
                  <${Box} width=${5}><${Text} color="gray">${ago(s.lastActivity)}</${Text}></${Box}>
                  ${s.pendingHandoff ? html`<${Text} color="yellow">${'→ ' + s.pendingHandoff.to}</${Text}>` : null}
                </${Box}>`);
              });
              return html`<${Box} flexDirection="column">
                ${win.above ? moreRow('↑', win.above) : null}
                ${out}
                ${win.below ? moreRow('↓', win.below) : null}
              </${Box}>`;
            })()}
      </${Box}>
    </${Box}>` : null}

    ${view === 'projects' ? html`<${Box} flexDirection="column">
      <${Box} marginBottom=${1}><${Text} bold>Projects</${Text}><${Text} color="gray">${openProject ? `   ${openProject}` : `   ${projList.length} project${projList.length === 1 ? '' : 's'}`}</${Text}></${Box}>
      ${!lib ? html`<${Text} color="gray">loading…</${Text}>`
        : openProject ? (projSessions.length ? (() => {
            const c = Math.min(psel, projSessions.length - 1), win = windowed(projSessions, c, projMax);
            return html`<${Box} flexDirection="column">
              ${win.above ? moreRow('↑', win.above) : null}
              ${win.slice.map((r, i) => { const live = liveBySid.get(r.sessionId); const on = (win.start + i) === c;
                return html`<${Box} key=${r.sessionId}>
                  <${Text} color=${ACCENT}>${on ? '› ' : '  '}</${Text}>
                  <${Box} width=${44}><${Text} color=${on ? 'white' : undefined} bold=${on} wrap="truncate-end">${r.title || r.sessionId.slice(0, 8)}</${Text}></${Box}>
                  <${Box} width=${10}>${live ? html`<${Text} color="green">running</${Text}>` : html`<${Text} color="gray">stored</${Text}>`}</${Box}>
                  <${Text} color="gray">${ago(r.lastAt)}</${Text}>
                </${Box}>`; })}
              ${win.below ? moreRow('↓', win.below) : null}
            </${Box}>`;
          })() : html`<${Text} color="gray">no sessions in this project</${Text}>`)
        : (projList.length ? (() => {
            const c = Math.min(psel, projList.length - 1), win = windowed(projList, c, projMax);
            return html`<${Box} flexDirection="column">
              ${win.above ? moreRow('↑', win.above) : null}
              ${win.slice.map((pr, i) => { const on = (win.start + i) === c;
                return html`<${Box} key=${pr.name}>
                  <${Text} color=${ACCENT}>${on ? '› ' : '  '}</${Text}>
                  <${Box} width=${30}><${Text} color=${on ? 'white' : undefined} bold=${on} wrap="truncate-end">${pr.name}</${Text}></${Box}>
                  <${Box} width=${14}><${Text} color="gray">${pr.count + ' session' + (pr.count === 1 ? '' : 's')}</${Text}></${Box}>
                  <${Text} color="gray">${ago(pr.lastAt)}</${Text}>
                </${Box}>`; })}
              ${win.below ? moreRow('↓', win.below) : null}
            </${Box}>`;
          })() : html`<${Text} color="gray">no projects yet</${Text}>`)}
    </${Box}>` : null}

    ${view === 'usage' ? html`<${Box} flexDirection="column">
      <${Box} marginBottom=${1}><${Text} color="gray">${st.probing ? 'refreshing all seats…' : '5-hour windows · ↑↓ select · c check · w arm'}</${Text}></${Box}>
      ${chunk(usageSeats, twoCol ? 2 : 1).map((pair, ri) => html`<${Box} key=${ri}>
        ${pair.map((s, ci) => { const idx = ri * (twoCol ? 2 : 1) + ci; const on = idx === Math.min(usel, usageSeats.length - 1);
          const u = s.usage || {}, fh = u.fiveHour || {}, p = fh.pct, wk = (u.weekly || []).reduce((a, w) => Math.max(a, w.pct || 0), 0); const col = seatColOf(s.name), isBest = s.name === bestName;
          return html`<${Box} key=${s.name} flexDirection="column" borderStyle="round" borderColor=${on ? ACCENT : ACCENT_DIM} paddingX=${1} width=${twoCol ? 34 : undefined} marginRight=${twoCol ? 1 : 0} marginBottom=${1}>
            <${Box} justifyContent="space-between">
              <${Text} color=${col} bold=${isBest || on}>${(isBest ? '★ ' : '') + s.name}</${Text}>
              ${u.loggedIn ? html`<${Text} color=${pctColor(p)} bold>${p == null ? '–' : p + '%'}</${Text}>` : html`<${Text} color="red">offline</${Text}>`}
            </${Box}>
            ${u.loggedIn ? html`<${Text} color=${pctColor(p)}>${meter(p, twoCol ? 28 : 22)}</${Text}>` : null}
            ${u.loggedIn ? html`<${Box} justifyContent="space-between">
              <${Text} color="gray">${'resets ' + ((() => { const r = resetsIn(fh.resetsAt); return r && r !== 'reset' ? r : '—'; })())}</${Text}>
              ${s.probe?.running ? html`<${Text} color=${ACCENT}>checking…</${Text}>` : html`<${Text} color=${(s.burn && s.burn.rising) ? 'yellow' : 'gray'}>${burnText(s)}</${Text}>`}
            </${Box}>` : null}
            ${u.loggedIn ? html`<${Box} justifyContent="space-between">
              <${Box}><${Text} color="gray">trend </${Text}><${Text} color=${col}>${spark(s.pctTrend, 8)}</${Text}></${Box}>
              <${Text} color="gray">${'wk ' + (wk ? wk + '%' : '–')}</${Text}>
            </${Box}>` : null}
          </${Box}>`; })}
      </${Box}>`)}
    </${Box}>` : null}

    ${view === 'activity' ? html`<${Box} flexDirection="column">
      <${Box} marginBottom=${1}><${Text} bold>Activity</${Text}><${Text} color="gray">   recent events</${Text}></${Box}>
      ${(st.events || []).length === 0 ? html`<${Text} color="gray">Nothing yet.</${Text}>`
        : (st.events || []).slice(0, 20).map((e, i) => html`<${Box} key=${i}>
            <${Box} width=${7}><${Text} color="gray">${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</${Text}></${Box}>
            <${Box} width=${12}><${Text} color=${evColor(e.type)}>${e.type}</${Text}></${Box}>
            <${Text} wrap="truncate-end">${e.msg}</${Text}>
          </${Box}>`)}
    </${Box}>` : null}

    ${view === 'bot' ? html`<${Box} flexDirection="column">
      <${Box} marginBottom=${1}><${Text} bold>Assistant</${Text}><${Text} color="gray">${`   texting cockpit${bestName ? ' · on ' + bestName : ''}`}</${Text}></${Box}>
      ${botMsgs.length === 0 ? html`<${Text} color="gray">Ask me anything about cockpit — commands, accounts, hand-offs, usage, setup.</${Text}>`
        : botMsgs.slice(-10).map((mm, i) => html`<${Box} key=${i} flexDirection="column" marginBottom=${1}>
            <${Text} color=${mm.role === 'you' ? ACCENT : undefined} bold>${mm.role === 'you' ? 'you' : '❯ cockpit'}</${Text}>
            <${Text} wrap="wrap">${mm.text}</${Text}>
          </${Box}>`)}
      ${botPending ? html`<${Box} marginTop=${1}><${Text} color=${ACCENT}>${SPIN[tick % SPIN.length] + ' '}</${Text}><${Text} color="gray">cockpit is thinking${'.'.repeat(tick % 4)}</${Text}></${Box}>` : null}
      <${Box} marginTop=${1}><${Text} color=${ACCENT}>› </${Text}><${Text}>${botBuf}</${Text}><${Text} color=${ACCENT}>▋</${Text}></${Box}>
    </${Box}>` : null}

    ${mode === 'cmd' ? html`<${Box} marginTop=${1} flexDirection="column">
        <${Box}><${Text} color=${ACCENT}>cockpit › </${Text}><${Text}>${buf}</${Text}><${Text} color=${ACCENT}>▋</${Text}></${Box}>
        <${Box}>${VERBS.filter(v => !buf || v.name.startsWith(buf.trim().toLowerCase())).map((v, i) => html`<${Box} key=${v.name} marginRight=${2}><${Text} color=${ACCENT}>${v.name}</${Text}><${Text} color="gray"> ${v.hint}</${Text}></${Box}>`)}</${Box}>
      </${Box}>` : null}
    ${mode === 'rename' ? html`<${Box} marginTop=${1}><${Text} color=${ACCENT}>rename › </${Text}><${Text}>${buf}</${Text}><${Text} color=${ACCENT}>▋</${Text}></${Box}>` : null}
    ${mode === 'filter' ? html`<${Box} marginTop=${1}><${Text} color=${ACCENT}>filter › </${Text}><${Text}>${buf}</${Text}><${Text} color=${ACCENT}>▋</${Text}></${Box}>` : null}
    ${mode === 'confirm' ? html`<${Box} marginTop=${1}><${Text} color="red">Stop ${cur ? (cur.name || cur.cs) : ''}? </${Text}><${Text} color="gray">y / n</${Text}></${Box}>` : null}
    ${mode === 'help' ? html`<${Box} flexDirection="column" marginTop=${1} borderStyle="round" borderColor=${ACCENT_DIM} paddingX=${1}>
        <${Text} bold color=${ACCENT}>Keys</${Text}>
        <${Text} color="gray">↑↓ / j k move   ↵ attach/open   : command   / filter</${Text}>
        <${Text} color="gray">n new  r rename  x stop  h hand off  o terminal</${Text}>
        <${Text} color="gray">p projects  u usage  l activity log  a ask  q quit</${Text}>
      </${Box}>` : null}

    ${(view !== 'status' && view !== 'usage' && view !== 'bot') ? html`<${SeatBar} seats=${st.seats} />` : null}
    ${msg ? html`<${Box} marginTop=${1}><${Text} color=${ACCENT}>${'• ' + msg}</${Text}></${Box}>` : null}
    ${footer ? html`<${Box} marginTop=${1}><${Text} color="gray">${footer}</${Text}></${Box}>` : null}
  </${Box}>`;
}

function runApp(port, initial) {
  return new Promise(resolve => {
    let resolved = false;
    const done = r => { if (resolved) return; resolved = true; try { instance.unmount(); } catch {} resolve(r); };
    const instance = render(html`<${App} port=${port} onDone=${done} initial=${initial} />`, { exitOnCtrlC: false });
    instance.waitUntilExit().then(() => done(null)).catch(() => done(null));
  });
}

function termSize() { return { cols: process.stdout.columns || 120, rows: process.stdout.rows || 36 }; }

export async function startTui() {
  const cfg = loadConfig(); const port = portOf(cfg);
  if (!cfg.seats.length) { process.stderr.write('cockpit: no seats yet. Run `cockpit init` first.\n'); process.exit(1); }
  if (!(await ensureDaemon(port))) { process.stderr.write('cockpit: the daemon is not running.\n'); process.exit(1); }

  // Run the control room full-window: switch to the terminal's alternate screen so the TUI
  // owns the whole window, and restore the user's shell (and cursor) cleanly on exit. We drop
  // back to the normal screen while a session is attached, so a session behaves like plain claude.
  const out = process.stdout;
  const altEnter = () => { try { out.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H'); } catch {} };
  const altExit = () => { try { out.write('\x1b[?25h\x1b[?1049l'); } catch {} };
  let restored = false;
  const restore = () => { if (restored) return; restored = true; altExit(); };
  process.on('exit', restore);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { restore(); process.exit(0); });

  altEnter();
  let initial;  // the view to restore after a session detaches (so Ctrl-] lands you where you were)
  try {
    for (;;) {
      const r = await runApp(port, initial);
      if (r && r.action === 'attach') { altExit(); try { await attach(port, r.cs, { label: r.label || '' }); } catch {} altEnter(); initial = r.from; continue; }
      if (r && (r.action === 'resume' || r.action === 'new')) {
        altExit();
        try { const res = await request(port, 'POST', '/api/sessions', { resumeId: r.resumeId || undefined, cwd: r.cwd, ...termSize() }); if (res.status === 200 && res.body?.cs) await attach(port, res.body.cs, { label: r.label || '' }); else if (res.body?.error) process.stderr.write('cockpit: ' + res.body.error + '\n'); } catch {}
        altEnter();
        initial = r.from;
        continue;
      }
      break;
    }
  } finally {
    restore();
  }
  process.exit(0);
}
