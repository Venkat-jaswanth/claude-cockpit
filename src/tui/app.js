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

const projOf = s => (s.cwd ? path.basename(s.cwd) : 'unknown') || 'unknown';
const pctColor = p => p == null ? 'gray' : p >= 85 ? 'red' : p >= 60 ? 'yellow' : 'green';
const dotColor = s => s.status === 'busy' ? ACCENT : s.status === 'idle' ? 'green' : s.status === 'lost' || s.status === 'crashed' ? 'red' : 'yellow';
function ago(ts) { if (!ts) return ''; const m = Math.round((Date.now() - ts) / 60000); if (m < 1) return 'now'; if (m < 60) return m + 'm'; const h = Math.floor(m / 60); return h < 24 ? h + 'h' : Math.floor(h / 24) + 'd'; }
function resetsIn(iso) { if (!iso) return ''; const ms = new Date(iso).getTime() - Date.now(); if (ms <= 0) return 'reset'; const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m`; }

// A session that cockpit drives and is worth showing in the status: alive, or waiting to be resumed.
const shownSessions = st => (st?.sessions || []).filter(s => s.kind === 'claude' && s.managed && (s.alive || s.status === 'lost'));

function group(sessions, filter) {
  const f = filter.trim().toLowerCase();
  const list = f ? sessions.filter(s => (s.name || s.cs).toLowerCase().includes(f) || projOf(s).toLowerCase().includes(f)) : sessions;
  const map = new Map();
  for (const s of list) { const k = projOf(s); (map.get(k) || map.set(k, []).get(k)).push(s); }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([project, items]) => ({ project, items }));
}

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
  if (!live.length) return html`<${Text} color="gray">no seats logged in</${Text}>`;
  const best = live.slice().sort((a, b) => (a.usage.fiveHour?.pct ?? 999) - (b.usage.fiveHour?.pct ?? 999))[0];
  return html`<${Box} marginTop=${1}>
    <${Text} color="gray">seats  </${Text}>
    ${live.map((s, i) => { const p = s.usage.fiveHour?.pct; const r = resetsIn(s.usage.fiveHour?.resetsAt);
      return html`<${Box} key=${s.name}>
        ${i ? html`<${Text} color="gray">${'  ·  '}</${Text}>` : null}
        <${Text} bold=${s.name === best.name}>${s.name}</${Text}>
        <${Text} color="gray"> </${Text}>
        <${Text} color=${pctColor(p)}>${p == null ? '–' : p + '%'}</${Text}>
        ${r ? html`<${Text} color="gray"> ${r}</${Text}>` : null}
      </${Box}>`; })}
    <${Text} color=${ACCENT}>${'    ★ ' + best.name}</${Text}>
  </${Box}>`;
}

function Row({ s, selected }) {
  const nm = (s.name || s.cs);
  return html`<${Box}>
    <${Text} color=${ACCENT}>${selected ? '› ' : '  '}</${Text}>
    <${Text} color=${dotColor(s)}>${'● '}</${Text}>
    <${Box} width=${30}><${Text} color=${selected ? 'white' : undefined} bold=${selected} wrap="truncate-end">${nm}</${Text}></${Box}>
    <${Box} width=${12}><${Text} color="gray" wrap="truncate-end">${s.seat || '?'}</${Text}></${Box}>
    <${Box} width=${10}><${Text} color=${dotColor(s)}>${(s.status || '').replace('_', ' ')}</${Text}></${Box}>
    <${Box} width=${7}><${Text} color="gray">${(s.turns ?? 0) + 't'}</${Text}></${Box}>
    <${Box} width=${6}><${Text} color="gray">${ago(s.lastActivity)}</${Text}></${Box}>
    ${s.pendingHandoff ? html`<${Text} color="yellow">${'→ ' + s.pendingHandoff.to}</${Text}>` : null}
  </${Box}>`;
}

function App({ port, onDone }) {
  const { exit } = useApp();
  const [st, setSt] = useState(null);
  const [sel, setSel] = useState(0);
  const [filter, setFilter] = useState('');
  const [mode, setMode] = useState('list');      // list | rename | confirm | help | filter
  const [buf, setBuf] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let alive = true;
    const tick = async () => { try { const r = await request(port, 'GET', '/api/state'); if (alive) setSt(r.body); } catch {} };
    tick(); const id = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [port]);

  const groups = st ? group(shownSessions(st), mode === 'filter' ? buf : filter) : [];
  const flat = groups.flatMap(g => g.items);
  const cur = flat[Math.min(sel, flat.length - 1)] || null;
  useEffect(() => { if (sel > flat.length - 1) setSel(Math.max(0, flat.length - 1)); }, [flat.length]);

  const post = (p, body) => request(port, 'POST', p, body || {}).catch(() => {});
  const flash = m => { setMsg(m); setTimeout(() => setMsg(''), 2500); };

  useInput((input, key) => {
    if (mode === 'rename') {
      if (key.return) { const nm = buf.trim(); if (cur) { post(`/api/sessions/${encodeURIComponent(cur.cs)}/rename`, { name: nm }); if (cur.sessionId) post(`/api/marks/${encodeURIComponent(cur.sessionId)}`, { name: nm }); flash(nm ? 'renamed' : 'name cleared'); } setMode('list'); setBuf(''); }
      else if (key.escape) { setMode('list'); setBuf(''); }
      else if (key.backspace || key.delete) setBuf(b => b.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setBuf(b => b + input);
      return;
    }
    if (mode === 'filter') {
      if (key.return || key.escape) { setFilter(key.escape ? '' : buf); setMode('list'); setBuf(''); setSel(0); }
      else if (key.backspace || key.delete) setBuf(b => b.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setBuf(b => b + input);
      return;
    }
    if (mode === 'confirm') {
      if (input === 'y' && cur) { post(`/api/sessions/${encodeURIComponent(cur.cs)}/stop`); flash('stopping ' + (cur.name || cur.cs)); }
      setMode('list'); return;
    }
    if (mode === 'help') { setMode('list'); return; }
    // list mode
    if (key.ctrl && input === 'c') return onDone({ action: 'quit' });
    if (input === 'q') return onDone({ action: 'quit' });
    if (key.upArrow || input === 'k') return setSel(s => Math.max(0, s - 1));
    if (key.downArrow || input === 'j') return setSel(s => Math.min(flat.length - 1, s + 1));
    if (!cur) { if (input === '/') { setMode('filter'); setBuf(filter); } if (input === '?') setMode('help'); return; }
    if (key.return) return onDone({ action: 'attach', cs: cur.cs, label: cur.name || '' });
    if (input === 'o') { post(`/api/sessions/${encodeURIComponent(cur.cs)}/open-terminal`); flash('opened in Terminal'); }
    else if (input === 'x') setMode('confirm');
    else if (input === 'r') { setMode('rename'); setBuf(cur.name || ''); }
    else if (input === 'h') { post(`/api/sessions/${encodeURIComponent(cur.cs)}/handoff`, { toSeat: null }); flash('handing off ' + (cur.name || cur.cs)); }
    else if (input === '/') { setMode('filter'); setBuf(filter); }
    else if (input === '?') setMode('help');
  });

  if (!st) return html`<${Box} padding=${1}><${Text} color=${ACCENT}>⇄ connecting to the cockpit daemon…</${Text}></${Box}>`;

  const total = flat.length;
  return html`<${Box} flexDirection="column" padding=${1}>
    <${Logo} />
    <${Box} marginBottom=${1}>
      <${Text} bold>Status</${Text}>
      <${Text} color="gray">${`   ${total} session${total === 1 ? '' : 's'} across ${groups.length} project${groups.length === 1 ? '' : 's'}`}</${Text}>
      ${filter ? html`<${Text} color=${ACCENT}>${`   /${filter}`}</${Text}>` : null}
    </${Box}>

    ${total === 0 ? html`<${Text} color="gray">No running sessions. Start one with ${'`cockpit start`'}.</${Text}>`
      : groups.map(g => html`<${Box} key=${g.project} flexDirection="column" marginBottom=${1}>
          <${Text} color=${ACCENT} bold>${g.project} <${Text} color="gray">· ${g.items.length}</${Text}></${Text}>
          ${g.items.map(s => html`<${Row} key=${s.cs} s=${s} selected=${cur && s.cs === cur.cs} />`)}
        </${Box}>`)}

    ${mode === 'rename' ? html`<${Box} marginTop=${1}><${Text} color=${ACCENT}>rename › </${Text}><${Text}>${buf}</${Text}><${Text} color=${ACCENT}>▋</${Text}></${Box}>` : null}
    ${mode === 'filter' ? html`<${Box} marginTop=${1}><${Text} color=${ACCENT}>filter › </${Text}><${Text}>${buf}</${Text}><${Text} color=${ACCENT}>▋</${Text}></${Box}>` : null}
    ${mode === 'confirm' ? html`<${Box} marginTop=${1}><${Text} color="red">Stop ${cur ? (cur.name || cur.cs) : ''}? </${Text}><${Text} color="gray">y / n</${Text}></${Box}>` : null}
    ${mode === 'help' ? html`<${Box} flexDirection="column" marginTop=${1} borderStyle="round" borderColor=${ACCENT_DIM} paddingX=${1}>
        <${Text} bold color=${ACCENT}>Keys</${Text}>
        <${Text} color="gray">↑↓ / j k  move     ↵ attach     o open in Terminal</${Text}>
        <${Text} color="gray">r rename   x stop   h hand off   / filter   ? keys   q quit</${Text}>
      </${Box}>` : null}

    <${SeatBar} seats=${st.seats} />
    ${msg ? html`<${Box} marginTop=${1}><${Text} color=${ACCENT}>${'• ' + msg}</${Text}></${Box}>` : null}
    ${mode === 'list' ? html`<${Box} marginTop=${1}><${Text} color="gray">↵ attach · r rename · x stop · h hand off · o open · / filter · ? keys · q quit</${Text}></${Box}>` : null}
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

export async function startTui() {
  const cfg = loadConfig(); const port = portOf(cfg);
  if (!cfg.seats.length) { process.stderr.write('cockpit: no seats yet. Run `cockpit init` first.\n'); process.exit(1); }
  if (!(await ensureDaemon(port))) { process.stderr.write('cockpit: the daemon is not running.\n'); process.exit(1); }
  for (;;) {
    const r = await runApp(port);
    if (r && r.action === 'attach') { try { await attach(port, r.cs, { label: r.label || '' }); } catch {} continue; }
    break;
  }
  process.exit(0);
}
