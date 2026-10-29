// The cockpit TUI — a terminal-native control room, rendered with Ink. It talks to the same
// daemon the dashboard does (src/client.js) and is launched by `cockpit tui`.
import path from 'node:path';
import React, { useState, useEffect } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import htm from 'htm';
import { loadConfig, portOf } from '../config.js';
import { request } from '../client.js';
import { ensureDaemon } from '../daemonctl.js';
import { attach } from '../attach.js';

const html = htm.bind(React.createElement);
const ACCENT = '#5eead4';          // teal — cockpit's terminal accent (refined in the brand pass)
const ACCENT_DIM = '#2f6f69';

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
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([project, items]) => ({ project, items }));
}

const VERBS = [
  { name: 'status', hint: 'running sessions by project' },
  { name: 'projects', hint: 'browse every project' },
  { name: 'new', hint: 'start a session in this folder' },
  { name: 'usage', hint: 'account usage & limits' },
  { name: 'help', hint: 'keyboard reference' },
  { name: 'quit', hint: 'exit cockpit' },
];
function meter(pct, width = 18) { const n = Math.round(Math.max(0, Math.min(100, pct || 0)) / 100 * width); return '█'.repeat(n) + '░'.repeat(width - n); }
function burnText(s) { const b = s.burn; if (b && b.rising && b.etaMin != null && b.etaMin > 0 && b.etaMin <= 600) return `▲ ${b.perHour}%/h · ~${b.etaMin >= 60 ? Math.floor(b.etaMin / 60) + 'h' + (b.etaMin % 60) + 'm' : b.etaMin + 'm'} left`; return 'steady'; }

function Logo() {
  return html`<${Box} flexDirection="column" marginBottom=${1}>
    <${Box}>
      <${Text} color=${ACCENT} bold>${'⇄ cockpit'}</${Text}>
      <${Text} color="gray">${'   terminal control for many Claude Code seats'}</${Text}>
    </${Box}>
    <${Text} color=${ACCENT_DIM}>${'─'.repeat(64)}</${Text}>
  </${Box}>`;
}

function SeatBar({ seats }) {
  const live = (seats || []).filter(s => !s.disabled && s.usage?.loggedIn);
  if (!live.length) return html`<${Box} marginTop=${1}><${Text} color="gray">no seats logged in</${Text}></${Box}>`;
  const best = live.slice().sort((a, b) => (a.usage.fiveHour?.pct ?? 999) - (b.usage.fiveHour?.pct ?? 999))[0];
  return html`<${Box} marginTop=${1}>
    <${Text} color="gray">seats  </${Text}>
    ${live.map((s, i) => { const p = s.usage.fiveHour?.pct; const r = resetsIn(s.usage.fiveHour?.resetsAt);
      return html`<${Box} key=${s.name}>
        ${i ? html`<${Text} color="gray">${'  ·  '}</${Text}>` : null}
        <${Text} bold=${s.name === best.name}>${s.name}</${Text}>
        <${Text} color="gray"> </${Text}><${Text} color=${pctColor(p)}>${p == null ? '–' : p + '%'}</${Text}>
        ${r ? html`<${Text} color="gray"> ${r}</${Text}>` : null}
      </${Box}>`; })}
    <${Text} color=${ACCENT}>${'    ★ ' + best.name}</${Text}>
  </${Box}>`;
}

function Row({ s, selected }) {
  return html`<${Box}>
    <${Text} color=${ACCENT}>${selected ? '› ' : '  '}</${Text}>
    <${Text} color=${dotColor(s)}>${'● '}</${Text}>
    <${Box} width=${30}><${Text} color=${selected ? 'white' : undefined} bold=${selected} wrap="truncate-end">${s.name || s.cs}</${Text}></${Box}>
    <${Box} width=${12}><${Text} color="gray" wrap="truncate-end">${s.seat || '?'}</${Text}></${Box}>
    <${Box} width=${10}><${Text} color=${dotColor(s)}>${(s.status || '').replace('_', ' ')}</${Text}></${Box}>
    <${Box} width=${6}><${Text} color="gray">${(s.turns ?? 0) + 't'}</${Text}></${Box}>
    <${Box} width=${6}><${Text} color="gray">${ago(s.lastActivity)}</${Text}></${Box}>
    ${s.pendingHandoff ? html`<${Text} color="yellow">${'→ ' + s.pendingHandoff.to}</${Text}>` : null}
  </${Box}>`;
}

function App({ port, onDone }) {
  const [st, setSt] = useState(null);
  const [lib, setLib] = useState(null);
  const [view, setView] = useState('status');     // status | projects
  const [sel, setSel] = useState(0);
  const [psel, setPsel] = useState(0);            // projects level-1 / level-2 cursor
  const [openProject, setOpenProject] = useState(null);
  const [filter, setFilter] = useState('');
  const [mode, setMode] = useState('list');       // list | rename | confirm | filter | cmd | help
  const [buf, setBuf] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let alive = true;
    const tick = async () => { try { const r = await request(port, 'GET', '/api/state'); if (alive) setSt(r.body); } catch {} };
    const tickLib = async () => { try { const r = await request(port, 'GET', '/api/library'); if (alive) setLib(r.body?.sessions || []); } catch {} };
    tick(); tickLib();
    const a = setInterval(tick, 2000), b = setInterval(tickLib, 8000);
    return () => { alive = false; clearInterval(a); clearInterval(b); };
  }, [port]);

  const post = (p, body) => request(port, 'POST', p, body || {}).catch(() => {});
  const flash = m => { setMsg(m); setTimeout(() => setMsg(''), 2500); };
  const liveBySid = new Map((st?.sessions || []).filter(s => s.alive).map(s => [s.sessionId, s]));
  const _liveSeats = (st?.seats || []).filter(s => !s.disabled && s.usage?.loggedIn);
  const bestName = _liveSeats.slice().sort((a, b) => (a.usage.fiveHour?.pct ?? 999) - (b.usage.fiveHour?.pct ?? 999))[0]?.name;

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
    else if (m.name === 'new') onDone({ action: 'new', cwd: process.cwd() });
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
        if (key.return && curProjSess) { const live = liveBySid.get(curProjSess.sessionId); if (live) return onDone({ action: 'attach', cs: live.cs, label: live.name || '' }); return onDone({ action: 'resume', resumeId: curProjSess.sessionId, cwd: curProjSess.cwd, label: curProjSess.title || '' }); }
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
      if (input === 'r') { post('/api/probe-all'); flash('refreshing all seats…'); return; }
      return;
    }

    // ---- status view ----
    if (key.upArrow || input === 'k') return setSel(s => Math.max(0, s - 1));
    if (key.downArrow || input === 'j') return setSel(s => Math.min(flat.length - 1, s + 1));
    if (input === 'p') { setView('projects'); setOpenProject(null); setPsel(0); return; }
    if (input === 'u') { setView('usage'); return; }
    if (input === 'n') return onDone({ action: 'new', cwd: process.cwd() });
    if (input === '/') { setMode('filter'); setBuf(filter); return; }
    if (!cur) return;
    if (key.return) return onDone({ action: 'attach', cs: cur.cs, label: cur.name || '' });
    if (input === 'o') { post(`/api/sessions/${encodeURIComponent(cur.cs)}/open-terminal`); flash('opened in Terminal'); }
    else if (input === 'x') setMode('confirm');
    else if (input === 'r') { setMode('rename'); setBuf(cur.name || ''); }
    else if (input === 'h') { post(`/api/sessions/${encodeURIComponent(cur.cs)}/handoff`, { toSeat: null }); flash('handing off ' + (cur.name || cur.cs)); }
  });

  if (!st) return html`<${Box} padding=${1}><${Text} color=${ACCENT}>⇄ connecting to the cockpit daemon…</${Text}></${Box}>`;

  // ---- render ----
  const footer = mode === 'cmd' ? null
    : view === 'projects'
      ? (openProject ? '↵ open · esc back · q quit' : '↵ open project · esc status · q quit')
      : view === 'usage'
        ? 'r refresh · esc status · q quit'
        : '↵ attach · n new · r rename · x stop · h hand off · p projects · u usage · : cmd · ? more';

  return html`<${Box} flexDirection="column" padding=${1}>
    <${Logo} />

    ${view === 'status' ? html`<${Box} flexDirection="column">
      <${Box} marginBottom=${1}>
        <${Text} bold>Status</${Text}>
        <${Text} color="gray">${`   ${flat.length} session${flat.length === 1 ? '' : 's'} · ${groups.length} project${groups.length === 1 ? '' : 's'}`}</${Text}>
        ${filter ? html`<${Text} color=${ACCENT}>${`   /${filter}`}</${Text}>` : null}
      </${Box}>
      ${flat.length === 0 ? html`<${Text} color="gray">No running sessions. Start one with ${'`cockpit start`'}, or press ${'p'} to browse projects.</${Text}>`
        : groups.map(g => html`<${Box} key=${g.project} flexDirection="column" marginBottom=${1}>
            <${Text} color=${ACCENT} bold>${g.project} <${Text} color="gray">· ${g.items.length}</${Text}></${Text}>
            ${g.items.map(s => html`<${Row} key=${s.cs} s=${s} selected=${cur && s.cs === cur.cs} />`)}
          </${Box}>`)}
    </${Box}>` : null}

    ${view === 'projects' ? html`<${Box} flexDirection="column">
      <${Box} marginBottom=${1}><${Text} bold>Projects</${Text}><${Text} color="gray">${openProject ? `   ${openProject}` : `   ${projList.length} project${projList.length === 1 ? '' : 's'}`}</${Text}></${Box}>
      ${!lib ? html`<${Text} color="gray">loading…</${Text}>`
        : openProject ? (projSessions.length ? projSessions.map((r, i) => { const live = liveBySid.get(r.sessionId); const on = i === Math.min(psel, projSessions.length - 1);
            return html`<${Box} key=${r.sessionId}>
              <${Text} color=${ACCENT}>${on ? '› ' : '  '}</${Text}>
              <${Box} width=${44}><${Text} color=${on ? 'white' : undefined} bold=${on} wrap="truncate-end">${r.title || r.sessionId.slice(0, 8)}</${Text}></${Box}>
              <${Box} width=${10}>${live ? html`<${Text} color="green">running</${Text}>` : html`<${Text} color="gray">stored</${Text}>`}</${Box}>
              <${Text} color="gray">${ago(r.lastAt)}</${Text}>
            </${Box}>`; }) : html`<${Text} color="gray">no sessions in this project</${Text}>`)
        : (projList.length ? projList.map((pr, i) => { const on = i === Math.min(psel, projList.length - 1);
            return html`<${Box} key=${pr.name}>
              <${Text} color=${ACCENT}>${on ? '› ' : '  '}</${Text}>
              <${Box} width=${30}><${Text} color=${on ? 'white' : undefined} bold=${on} wrap="truncate-end">${pr.name}</${Text}></${Box}>
              <${Box} width=${14}><${Text} color="gray">${pr.count + ' session' + (pr.count === 1 ? '' : 's')}</${Text}></${Box}>
              <${Text} color="gray">${ago(pr.lastAt)}</${Text}>
            </${Box}>`; }) : html`<${Text} color="gray">no projects yet</${Text}>`)}
    </${Box}>` : null}

    ${view === 'usage' ? html`<${Box} flexDirection="column">
      <${Box} marginBottom=${1}><${Text} bold>Usage</${Text}><${Text} color="gray">${st.probing ? '   refreshing…' : '   5-hour windows'}</${Text}></${Box}>
      ${(st.seats || []).filter(s => !s.disabled).map(s => { const u = s.usage || {}, fh = u.fiveHour || {}, p = fh.pct, wk = (u.weekly || []).reduce((a, w) => Math.max(a, w.pct || 0), 0);
        return html`<${Box} key=${s.name}>
          <${Box} width=${12}><${Text} bold=${s.name === bestName} wrap="truncate-end">${s.name}</${Text}></${Box}>
          ${!u.loggedIn ? html`<${Text} color="red">not logged in</${Text}>` : html`<${Box}>
            <${Text} color=${pctColor(p)}>${meter(p)}</${Text}>
            <${Box} width=${6}><${Text} color=${pctColor(p)}> ${p == null ? '–' : p + '%'}</${Text}></${Box}>
            <${Box} width=${16}><${Text} color="gray">resets ${(() => { const r = resetsIn(fh.resetsAt); return r && r !== 'reset' ? r : '—'; })()}</${Text}></${Box}>
            <${Box} width=${9}><${Text} color="gray">wk ${wk ? wk + '%' : '–'}</${Text}></${Box}>
            ${s.probe?.running ? html`<${Text} color=${ACCENT}>checking…</${Text}>` : html`<${Text} color=${(s.burn && s.burn.rising) ? 'red' : 'gray'}>${burnText(s)}</${Text}>`}
          </${Box}>`}
        </${Box}>`; })}
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
        <${Text} color="gray">p projects  u usage  ? keys  q quit</${Text}>
      </${Box}>` : null}

    <${SeatBar} seats=${st.seats} />
    ${msg ? html`<${Box} marginTop=${1}><${Text} color=${ACCENT}>${'• ' + msg}</${Text}></${Box}>` : null}
    ${footer ? html`<${Box} marginTop=${1}><${Text} color="gray">${footer}</${Text}></${Box}>` : null}
  </${Box}>`;
}

function runApp(port) {
  return new Promise(resolve => {
    let resolved = false;
    const done = r => { if (resolved) return; resolved = true; try { instance.unmount(); } catch {} resolve(r); };
    const instance = render(html`<${App} port=${port} onDone=${done} />`, { exitOnCtrlC: false });
    instance.waitUntilExit().then(() => done(null)).catch(() => done(null));
  });
}

function termSize() { return { cols: process.stdout.columns || 120, rows: process.stdout.rows || 36 }; }

export async function startTui() {
  const cfg = loadConfig(); const port = portOf(cfg);
  if (!cfg.seats.length) { process.stderr.write('cockpit: no seats yet. Run `cockpit init` first.\n'); process.exit(1); }
  if (!(await ensureDaemon(port))) { process.stderr.write('cockpit: the daemon is not running.\n'); process.exit(1); }
  for (;;) {
    const r = await runApp(port);
    if (r && r.action === 'attach') { try { await attach(port, r.cs, { label: r.label || '' }); } catch {} continue; }
    if (r && (r.action === 'resume' || r.action === 'new')) {
      try { const res = await request(port, 'POST', '/api/sessions', { resumeId: r.resumeId || undefined, cwd: r.cwd, ...termSize() }); if (res.status === 200 && res.body?.cs) await attach(port, res.body.cs, { label: r.label || '' }); else if (res.body?.error) process.stderr.write('cockpit: ' + res.body.error + '\n'); } catch {}
      continue;
    }
    break;
  }
  process.exit(0);
}
