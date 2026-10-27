// Daemon-side session manager: every Claude Code session (and every seat login) runs in a
// pseudo-terminal owned by the daemon. Terminals and browser tabs are just viewers.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PKG_ROOT, CLAUDE_BIN, sleep } from './paths.js';
import { claudeEnv, ensureTrusted } from './seats.js';

const require = createRequire(import.meta.url);
let ptyLib = null;

// npm may skip node-pty's install script, which leaves its spawn helper without the
// executable bit; node-pty then fails with "posix_spawnp failed".
function ensureSpawnHelper() {
  try {
    const helper = path.join(PKG_ROOT, 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    if (fs.existsSync(helper) && !(fs.statSync(helper).mode & 0o111)) fs.chmodSync(helper, 0o755);
  } catch {}
}
export function loadPty() {
  if (ptyLib) return ptyLib;
  ensureSpawnHelper();
  ptyLib = require('node-pty');
  return ptyLib;
}

const BUFFER_MAX = 512 * 1024;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\r/g;
const LIMIT_RE = /usage limit reached|hit your (?:usage )?limit|reached your (?:usage )?limit|out of extra usage|limit reached[^\n]{0,60}resets/i;
const DETACH_HINT = '';

export function resumeSafeArgs(extra) {
  // Flags survive a resume; a trailing positional prompt must not be sent twice.
  return (extra || []).filter((a, i, arr) => a.startsWith('-') || (i > 0 && arr[i - 1].startsWith('-') && !arr[i - 1].includes('=')));
}

export class SessionManager {
  constructor({ port, onExit, onLimit, onRespawn, log }) {
    this.port = port;
    this.rt = new Map();      // cs -> { proc, buffer, viewers:Set<ws>, cols, rows, watch, lastHit }
    this.onExit = onExit; this.onLimit = onLimit; this.onRespawn = onRespawn;
    this.log = log || (() => {});
  }
  has(cs) { return this.rt.has(cs); }
  onOutput(cs, fn) { const rt = this.rt.get(cs); if (rt) rt.onOutput = fn; }
  viewerCount(cs) { return this.rt.get(cs)?.viewers.size || 0; }

  spawn(s, seat, { cols, rows } = {}) {
    const pty = loadPty();
    const rt = this.rt.get(s.cs) || { proc: null, buffer: '', viewers: new Set(), cols: 120, rows: 36, watch: '', lastHit: 0 };
    if (cols) rt.cols = cols;
    if (rows) rt.rows = rows;
    this.rt.set(s.cs, rt);
    let args;
    if (s.kind === 'login') args = ['auth', 'login'];
    else args = [
      ...(s.resume ? ['--resume', s.sessionId] : ['--session-id', s.sessionId]),
      ...(!s.resume && s.name ? ['-n', s.name] : []),
      ...(s.resume ? resumeSafeArgs(s.extra) : (s.extra || [])),
      // A prompt passed as a positional runs automatically and keeps the TUI interactive, used by
      // handoff auto-continue (on resume) and by scheduled runs (an initial task on a new session).
      ...(s.continuation ? [String(s.continuation)] : []),
    ];
    s.continuation = null; // one-shot: never repeat it on a later manual resume
    const env = claudeEnv(seat, { COCKPIT_SESSION: s.cs, COCKPIT_PORT: String(this.port) });
    const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : os.homedir();
    if (s.kind === 'claude') { try { ensureTrusted(seat, cwd); } catch {} }
    const proc = pty.spawn(CLAUDE_BIN, args, { name: 'xterm-256color', cols: rt.cols, rows: rt.rows, cwd, env });
    rt.proc = proc;
    s.pid = proc.pid; s.alive = true; s.endedAt = null; s.exitCode = null;
    s.status = s.kind === 'login' ? 'login' : 'starting';
    s.startedAt = s.startedAt || Date.now();
    s.lastActivity = Date.now();
    proc.onData(d => {
      rt.buffer = (rt.buffer + d);
      if (rt.buffer.length > BUFFER_MAX) rt.buffer = rt.buffer.slice(-BUFFER_MAX);
      this.broadcast(rt, { t: 'out', d });
      if (s.kind === 'claude') this.watch(s, rt, d);
      if (rt.onOutput) { try { rt.onOutput(d); } catch {} }
    });
    proc.onExit(({ exitCode }) => this.handleExit(s, exitCode));
    this.broadcast(rt, this.info(s));
    return s;
  }

  info(s) { return { t: 'info', cs: s.cs, name: s.name, seat: s.seat, status: s.status, alive: !!s.alive, kind: s.kind, cwd: s.cwd }; }

  watch(s, rt, chunk) {
    rt.watch = (rt.watch + String(chunk).replace(ANSI, '')).slice(-4000);
    if (Date.now() - rt.lastHit < 60000) return;
    const m = rt.watch.match(LIMIT_RE);
    if (m) { rt.lastHit = Date.now(); rt.watch = ''; this.onLimit?.(s, m[0]); }
  }

  handleExit(s, code) {
    const rt = this.rt.get(s.cs);
    if (rt) rt.proc = null;
    s.alive = false; s.pid = null;
    if (s.handoff?.inProgress && s.handoff.phase === 'exiting') {
      const h = s.handoff;
      h.phase = 'resuming';
      s.seat = h.to; s.resume = true;
      const banner = `\r\n\x1b[1;36m⇄ cockpit: ${h.from} → ${h.to}  (${h.reason}) · resuming the same session…\x1b[0m\r\n`;
      if (rt) { rt.buffer += banner; this.broadcast(rt, { t: 'out', d: banner }); }
      setTimeout(() => this.onRespawn?.(s), 250);
      return;
    }
    s.status = 'ended'; s.exitCode = code; s.endedAt = Date.now();
    if (rt) this.broadcast(rt, { t: 'exit', code });
    this.onExit?.(s, code);
  }

  async gracefulExit(s) {
    const rt = this.rt.get(s.cs);
    const c = rt?.proc; if (!c) return;
    const exited = ms => new Promise(resolve => { let done = false; const t = setTimeout(() => { if (!done) { done = true; resolve(false); } }, ms); const d = c.onExit(() => { if (!done) { done = true; clearTimeout(t); resolve(true); } }); });
    // Ctrl-C clears a half-typed draft on an idle prompt, Ctrl-U clears the line, then /exit.
    c.write('\x03'); await sleep(200);
    c.write('\x15/exit\r');
    if (await exited(4000)) return;
    for (let i = 0; i < 3; i++) { c.write('\x03'); await sleep(350); }
    if (await exited(3000)) return;
    try { c.kill('SIGTERM'); } catch {}
    if (await exited(2000)) return;
    try { c.kill('SIGKILL'); } catch {}
  }

  resendPrompt(s, prompt, delayMs) {
    const rt = this.rt.get(s.cs);
    const text = prompt.includes('\n') ? `\x1b[200~${prompt}\x1b[201~` : prompt;
    setTimeout(() => { try { rt?.proc?.write(text + '\r'); } catch {} }, delayMs);
  }

  write(s, data) { const rt = this.rt.get(s.cs); if (rt?.proc) { rt.proc.write(data); s.lastActivity = Date.now(); } }
  resize(s, cols, rows) {
    const rt = this.rt.get(s.cs); if (!rt) return;
    cols = Math.max(20, Math.min(500, Number(cols) || rt.cols)); rows = Math.max(5, Math.min(200, Number(rows) || rt.rows));
    rt.cols = cols; rt.rows = rows;
    try { rt.proc?.resize(cols, rows); } catch {}
  }
  async kill(s) {
    const rt = this.rt.get(s.cs); const c = rt?.proc; if (!c) return false;
    try { c.kill('SIGTERM'); } catch {}
    await sleep(2500);
    if (rt.proc === c) { try { c.kill('SIGKILL'); } catch {} }
    return true;
  }
  killNow(s) { const rt = this.rt.get(s.cs); const c = rt?.proc; if (c) { try { c.kill('SIGKILL'); } catch {} } }
  forget(cs) { const rt = this.rt.get(cs); if (!rt || rt.proc) return false; for (const v of rt.viewers) { try { v.close(); } catch {} } this.rt.delete(cs); return true; }

  attach(s, ws, cols, rows) {
    const rt = this.rt.get(s.cs); if (!rt) return false;
    rt.viewers.add(ws);
    if (cols && rows) this.resize(s, cols, rows);
    try {
      ws.send(JSON.stringify(this.info(s)));
      if (rt.buffer) ws.send(JSON.stringify({ t: 'out', d: rt.buffer }));
      if (!s.alive) ws.send(JSON.stringify({ t: 'exit', code: s.exitCode ?? null }));
    } catch {}
    ws.on('close', () => rt.viewers.delete(ws));
    return true;
  }
  broadcast(rt, msg) {
    if (!rt?.viewers.size) return;
    const data = JSON.stringify(msg);
    for (const v of rt.viewers) { if (v.readyState === 1) { try { v.send(data); } catch {} } }
  }
  broadcastInfo(s) { const rt = this.rt.get(s.cs); if (rt) this.broadcast(rt, this.info(s)); }
}
