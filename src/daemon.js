#!/usr/bin/env node
// The cockpit daemon: the one long-lived process.
//
// Responsibilities:
//   - owns every managed session in a node-pty PTY, so a session outlives the window or tab
//     that views it (attach/detach over WebSocket);
//   - serves the dashboard (web/) and the JSON API on 127.0.0.1 only, rejecting cross-origin
//     browser requests;
//   - polls each seat's cached usage on an interval and records a burn-rate history;
//   - receives Claude Code's hook pings and, when handoff is enabled, moves a session to a
//     seat with more headroom between turns;
//   - runs scheduled jobs and books token usage to the seat that ran each turn.
//
// It is intentionally restart-safe: managed sessions it can't re-adopt after a restart are
// marked 'lost' and can be resumed; it never writes into Claude Code's own transcripts.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { HOME, STATE_FILE, PID_FILE, WEB_DIR, PKG_ROOT, PROFILES_DIR, CLAUDE_BIN, ensureHome, readJson, writeJson, BASE_CLAUDE_DIR } from './paths.js';
import { loadConfig, saveConfig, portOf } from './config.js';
import { readUsage } from './usage.js';
import { decide, rankCandidates } from './policy.js';
import { notify } from './notify.js';
import { seatByName, makeProfileSeat, seedProfile, installHooks, uninstallHooks, claudeEnv, ensureTrusted, PROBE_CWD } from './seats.js';
import { sleep } from './paths.js';
import { SessionManager } from './sessions.js';
import { scanLibrary, findStored, recentProjects, searchTranscripts } from './library.js';
import { setMark, getMark, allTags } from './marks.js';
import { readUsageDelta, lastCostState, EMPTY, add, totalTokens } from './tokens.js';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');

// Single source of truth for the version: package.json, so the daemon, CLI and dashboard
// footer never drift apart.
export const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } })();
ensureHome();
let cfg = loadConfig();
const PORT = portOf(cfg);
const startedAt = Date.now();
const persisted = readJson(STATE_FILE, {}) || {};
const sessions = new Map(Object.entries(persisted.sessions || {}));
const events = Array.isArray(persisted.events) ? persisted.events : [];
const jobs = Array.isArray(persisted.jobs) ? persisted.jobs : [];
const tasks = Array.isArray(persisted.tasks) ? persisted.tasks : [];
const projects = Array.isArray(persisted.projects) ? persisted.projects : [];
const findTask = id => tasks.find(t => t.id === id) || null;
const findProject = id => projects.find(p => p.id === id) || null;
const TODOS_DIR = path.join(BASE_CLAUDE_DIR, 'todos'); // Claude Code's TodoWrite plans (a shared entry)
const planCache = new Map();
const notified = new Map();
let usageCache = {};
const LEDGER_FILE = path.join(HOME, 'ledger.json');
const ledger = readJson(LEDGER_FILE, null) || { days: {} };
if (!ledger.days) ledger.days = {};
const seenIds = new Map();
let ledgerTimer = null;
function scheduleLedgerPersist() { if (ledgerTimer) return; ledgerTimer = setTimeout(() => { ledgerTimer = null; try { writeJson(LEDGER_FILE, ledger); } catch (e) { log('warn', `ledger persist failed: ${e.message}`); } }, 500); }
function dayKey(ts = Date.now()) { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function initTokenTracking(s) {
  let size = 0; try { size = fs.statSync(s.transcriptPath).size; } catch {}
  s.tok = { file: s.transcriptPath, offset: size, costSeen: lastCostState(s.transcriptPath) ?? 0 };
}
// Attribute tokens written to the transcript since the last check to the seat the session is on now.
function accountTokens(s, { turn = false } = {}) {
  if (s.kind !== 'claude' || !s.transcriptPath) return;
  if (!s.tok || s.tok.file !== s.transcriptPath) initTokenTracking(s);
  let r; try { r = readUsageDelta(s.transcriptPath, s.tok.offset, seenIds.get(s.cs) || seenIds.set(s.cs, new Set()).get(s.cs)); } catch (e) { log('warn', `tokens: ${e.message}`); return; }
  if (!r) return;
  s.tok.offset = r.offset;
  let cost = 0;
  if (r.costTotal != null) { cost = r.costTotal >= s.tok.costSeen ? r.costTotal - s.tok.costSeen : r.costTotal; s.tok.costSeen = r.costTotal; }
  const d = { ...r.delta, cost, turns: turn ? 1 : 0 };
  if (!totalTokens(d) && !cost && !turn) return;
  const day = ledger.days[dayKey()] ||= { seats: {}, sessions: {} };
  add(day.seats[s.seat || 'unknown'] ||= EMPTY(), d);
  const ss = day.sessions[s.cs] ||= { ...EMPTY(), name: s.name, cwd: s.cwd, sessionId: s.sessionId, seat: s.seat };
  add(ss, d); ss.name = s.name || ss.name; ss.seat = s.seat || ss.seat;
  add(s.tokens ||= EMPTY(), d);
  scheduleLedgerPersist();
}
// On-demand usage check: start Claude Code on the seat in an empty folder, let it refresh its
// own usage cache (startup, or the /usage command), then exit. No prompt is ever sent.
const probes = new Map();
const PROBE_STRIP = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]/g;
function probeState(name) { const r = probes.get(name); return r ? { running: !!r.running, startedAt: r.startedAt || null, lastAt: r.lastAt || null, lastResult: r.lastResult || null } : null; }
async function probeSeat(seat) {
  const rec = probes.get(seat.name) || {};
  if (rec.running) return rec;
  Object.assign(rec, { running: true, startedAt: Date.now(), lastResult: null });
  probes.set(seat.name, rec);
  const u0 = readUsage(seat);
  const before = u0.fetchedAt || 0;
  const finish = (result) => { rec.running = false; rec.lastAt = Date.now(); rec.lastResult = result; addEvent('usage', `${seat.name}: ${result.ok ? `5-hour window at ${result.pct ?? '?'}% (refreshed via ${result.how})` : `usage check failed: ${result.reason}`}`); schedulePersist(); return rec; };
  if (!u0.loggedIn) return finish({ ok: false, reason: 'not logged in' });
  fs.mkdirSync(PROBE_CWD, { recursive: true });
  const s = newSession({ kind: 'probe', cwd: PROBE_CWD, seat: seat.name, name: `usage check · ${seat.name}`, managed: true });
  let screen = '', trustAnswered = false;
  try { manager.spawn(s, seat, { cols: 120, rows: 40 }); } catch (e) { sessions.delete(s.cs); return finish({ ok: false, reason: `could not start claude: ${e.message}` }); }
  manager.onOutput(s.cs, chunk => {
    screen = (screen + String(chunk).replace(PROBE_STRIP, ' ')).slice(-8000);
    if (!trustAnswered && /trust\s*this\s*folder/i.test(screen)) {
      trustAnswered = true;  // the probe folder is cockpit's own empty directory
      setTimeout(() => { manager.write(s, '\x1b[B'); setTimeout(() => manager.write(s, '\r'), 200); }, 300);
    }
  });
  const refreshed = () => (readUsage(seat).fetchedAt || 0) > before;
  const waitFor = async ms => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (refreshed()) return true; if (!s.alive) return false; await sleep(500); } return false; };
  let how = null;
  if (await waitFor(3000)) how = 'startup';
  for (let attempt = 0; !how && s.alive && attempt < 2; attempt++) {
    manager.write(s, '/usage\r');
    if (await waitFor(attempt ? 15000 : 8000)) how = '/usage';
    manager.write(s, '\x1b'); await sleep(400);
  }
  if (s.alive) await manager.gracefulExit(s);
  manager.forget(s.cs); sessions.delete(s.cs);
  const u = readUsage(seat);
  return finish(how ? { ok: true, how, pct: u.fiveHour.pct, fetchedAt: u.fetchedAt } : { ok: false, reason: s.alive ? 'Claude Code did not refresh its usage cache' : 'Claude Code exited early (not logged in, or a dialog needs answering)' });
}
let probeQueue = Promise.resolve();
function queueProbe(seat) { const p = probeQueue.then(() => probeSeat(seat)).catch(e => log('error', `probe ${seat.name}: ${e.message}`)); probeQueue = p; return p; }
// Run `fn` over the list with at most `limit` in flight, so "check all seats" doesn't wait for
// one probe to finish before starting the next.
async function runLimited(items, limit, fn) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, q.length) }, async () => { while (q.length) { const it = q.shift(); try { await fn(it); } catch (e) { log('error', `probe ${it.name}: ${e.message}`); } } }));
}
function probeAll() { cfg = loadConfig(); const list = cfg.seats.filter(x => !x.disabled); runLimited(list, 4, probeSeat).catch(() => {}); return list.map(x => x.name); }

// --- Arm the 5-hour window ------------------------------------------------------
// The 5-hour limit clock starts on the first message, not at login. Sending one cheap
// message now starts it, so it resets sooner relative to when real work begins. Confirmed:
// a `claude -p --model haiku` message flips the seat's resets_at from null to ~5h out at ~0 cost.
const arms = new Map();
function armState(name) { const r = arms.get(name); return r ? { running: !!r.running, lastAt: r.lastAt || null, lastResult: r.lastResult || null } : null; }
function armSeat(seat) {
  const rec = arms.get(seat.name) || {};
  if (rec.running) return Promise.resolve(rec);
  Object.assign(rec, { running: true, startedAt: Date.now(), lastResult: null });
  arms.set(seat.name, rec);
  const finish = r => { rec.running = false; rec.lastAt = Date.now(); rec.lastResult = r; addEvent('arm', `${seat.name}: ${r.ok ? '5-hour window started now (armed)' : 'arm failed: ' + r.reason}`); if (cfg.notifications && r.ok) notify('Claude Cockpit', `${seat.name}: 5-hour window armed. It now resets ~5h from now.`); schedulePersist(); return rec; };
  const u0 = readUsage(seat);
  if (!u0.loggedIn) return Promise.resolve(finish({ ok: false, reason: 'not logged in' }));
  const active = u0.fiveHour.resetsAt && !u0.fiveHour.assumedReset && new Date(u0.fiveHour.resetsAt).getTime() > Date.now();
  if (active) return Promise.resolve(finish({ ok: false, reason: 'window already active (resets ' + u0.fiveHour.resetsAt + ')' }));
  try { ensureTrusted(seat, PROBE_CWD); } catch {}
  try { fs.mkdirSync(PROBE_CWD, { recursive: true }); } catch {}
  const model = cfg.armModel || 'haiku';
  const prompt = cfg.armPrompt || 'Reply with: ok';
  return new Promise(res => {
    execFile(CLAUDE_BIN, ['-p', '--model', model, prompt], { env: claudeEnv(seat), cwd: PROBE_CWD, timeout: 90000 }, (err, stdout, stderr) => {
      const out = (String(stdout || '') + String(stderr || '')).trim();
      if (/not logged in|please run \/login/i.test(out)) { finish({ ok: false, reason: 'not logged in' }); return res(rec); }
      if (/usage limit reached|limit reached|out of extra usage/i.test(out)) { finish({ ok: false, reason: 'seat is already at its limit' }); return res(rec); }
      if (err && !out) { finish({ ok: false, reason: (err.message || 'claude error').slice(0, 80) }); return res(rec); }
      finish({ ok: true });
      queueProbe(seat); // refresh the reading so the dashboard shows the fresh window + countdown
      res(rec);
    });
  });
}
let armQueue = Promise.resolve();
function queueArm(seat) { const p = armQueue.then(() => armSeat(seat)).catch(e => log('error', `arm ${seat.name}: ${e.message}`)); armQueue = p; return p; }

// --- Burn-rate forecasting -----------------------------------------------------
// Track each seat's 5-hour % over time (only genuine new readings), derive %/hour and an
// ETA to 100%. Used to warn before a seat runs dry and to answer "will this task fit?".
const pctHistory = new Map();
function recordPct(name, u) {
  if (!u || !u.known || u.fiveHour.pct == null || u.fiveHour.assumedReset) return;
  const fetchedAt = u.fetchedAt || 0;
  const arr = pctHistory.get(name) || [];
  const last = arr[arr.length - 1];
  if (last && last.fetchedAt === fetchedAt) return;      // same cached reading, skip
  if (last && u.fiveHour.pct < last.pct - 5) arr.length = 0; // window reset -> start fresh
  arr.push({ t: Date.now(), pct: u.fiveHour.pct, fetchedAt });
  while (arr.length > 80) arr.shift();
  pctHistory.set(name, arr);
}
function burnFor(name) {
  const arr = pctHistory.get(name) || [];
  if (arr.length < 2) return null;
  const first = arr[0], last = arr[arr.length - 1];
  const hours = (last.t - first.t) / 3600000;
  if (hours < 0.03) return null;                          // need a ~2 min span
  const perHour = (last.pct - first.pct) / hours;
  if (perHour <= 0.2) return { perHour: Math.max(0, Math.round(perHour * 10) / 10), etaMin: null, rising: false };
  const etaMin = Math.max(0, Math.round((100 - last.pct) / perHour * 60));
  return { perHour: Math.round(perHour * 10) / 10, etaMin, rising: true };
}
// The recent 5-hour % readings, for drawing a sparkline of each seat's trend.
function trendFor(name) { return (pctHistory.get(name) || []).slice(-16).map(p => p.pct); }

function usageSummary() {
  const days = Object.keys(ledger.days).sort();
  const today = dayKey(); const weekStart = dayKey(Date.now() - 6 * 86400e3);
  const sum = keep => { const total = EMPTY(); const seats = {}; for (const d of days) { if (!keep(d)) continue; for (const [seat, v] of Object.entries(ledger.days[d]?.seats || {})) { add(total, v); add(seats[seat] ||= EMPTY(), v); } } return { total, seats }; };
  const byDay = [];
  for (let i = 13; i >= 0; i--) { const k = dayKey(Date.now() - i * 86400e3); const t = EMPTY(); for (const v of Object.values(ledger.days[k]?.seats || {})) add(t, v); byDay.push({ day: k, ...t }); }
  const sessionsMap = {};
  for (const d of days) { if (d < weekStart) continue; for (const [cs, v] of Object.entries(ledger.days[d]?.sessions || {})) { const x = sessionsMap[cs] ||= { ...EMPTY(), cs, name: v.name, cwd: v.cwd, sessionId: v.sessionId, seat: v.seat }; add(x, v); x.name = v.name || x.name; x.seat = v.seat || x.seat; } }
  const topSessions = Object.values(sessionsMap).sort((a, b) => totalTokens(b) - totalTokens(a)).slice(0, 10);
  const monthPrefix = today.slice(0, 7);
  const month = sum(d => d.startsWith(monthPrefix));
  return { since: days[0] || null, today: sum(d => d === today), week: sum(d => d >= weekStart), month, all: sum(() => true), byDay, topSessions, budgetMonthlyUSD: Number(cfg.budgetMonthlyUSD || 0) };
}

for (const s of sessions.values()) {
  // Processes did not survive the daemon restart. Managed Claude sessions can be resumed;
  // login sessions and outside (hook-only) sessions just end; the latter re-register via
  // their hooks if they are in fact still running.
  if (s.alive || !['ended', 'lost'].includes(s.status)) s.status = (s.kind === 'claude' && s.managed) ? 'lost' : 'ended';
  s.alive = false; s.pid = null; s.handoff = null; s.pendingHandoff = null;
}

function log(level, msg) { console.log(`${new Date().toISOString()} ${level} ${msg}`); }
let persistTimer = null;
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try { writeJson(STATE_FILE, { sessions: Object.fromEntries(sessions), events, jobs, tasks, projects }); } catch (e) { log('warn', `persist failed: ${e.message}`); }
  }, 300);
}
function addEvent(type, msg, data = {}) {
  events.push({ at: Date.now(), type, msg, ...data });
  if (events.length > 300) events.splice(0, events.length - 300);
  log('info', `${type}: ${msg}`);
  schedulePersist();
}
function label(s) { return s.name || (s.cwd ? path.basename(s.cwd) : s.cs); }
function seatByConfigDir(dir) {
  if (!dir) return cfg.seats.find(s => s.kind === 'base') || null;
  const norm = path.resolve(dir);
  return cfg.seats.find(s => path.resolve(s.configDir) === norm) || null;
}
function refreshUsage() { const out = {}; for (const s of cfg.seats) { const u = readUsage(s); out[s.name] = u; recordPct(s.name, u); } usageCache = out; return out; }
// Read live git status for each running session's folder, cached on the session (s.git).
function refreshGit() {
  for (const s of sessions.values()) {
    if (s.kind !== 'claude' || !s.alive || !s.cwd) continue;
    execFile('git', ['-C', s.cwd, 'status', '--porcelain=v1', '--branch'], { timeout: 4000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) { s.git = null; return; } // not a repo, or git unavailable
      const lines = String(stdout).split('\n'); const head = lines[0] || '';
      let branch = null, ahead = 0, behind = 0;
      if (/\(no branch\)/.test(head)) branch = 'detached';
      else { const m = head.match(/^## (?:No commits yet on )?([^ .]+)/); if (m) branch = m[1]; }
      const am = head.match(/ahead (\d+)/); if (am) ahead = +am[1];
      const bm = head.match(/behind (\d+)/); if (bm) behind = +bm[1];
      s.git = { branch, dirty: lines.slice(1).some(l => l.trim() !== ''), ahead, behind };
    });
  }
}
const WORKTREES_DIR = path.join(HOME, 'worktrees');
// Create an isolated git worktree for a repo and return its path (one-click worktree sessions).
function makeWorktree(repo, labelName, branch) {
  const safe = (labelName || 'session').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32) || 'session';
  const dir = path.join(WORKTREES_DIR, `${safe}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  const run = args => execFileSync('git', ['-C', repo, 'worktree', ...args], { timeout: 15000, stdio: 'pipe' });
  if (branch) { try { run(['add', '-b', branch, dir]); } catch { run(['add', dir, branch]); } } // new branch, else check out existing
  else run(['add', '--detach', dir, 'HEAD']);
  return dir;
}
function removeWorktree(s) {
  if (!s || !s.worktree) return;
  try { execFileSync('git', ['-C', s.worktreeRepo || s.worktree, 'worktree', 'remove', '--force', s.worktree], { timeout: 15000, stdio: 'pipe' }); }
  catch { try { fs.rmSync(s.worktree, { recursive: true, force: true }); } catch {} }
  s.worktree = null;
}
const OUTSIDE_STALE_MS = Number(process.env.COCKPIT_OUTSIDE_STALE_MS) || 20 * 60000; // an outside session silent this long is treated as gone
function isLiveClaude(s, now = Date.now()) {
  if (s.kind !== 'claude' || !s.alive) return false;
  if (s.managed) return true;                 // we own the PTY, so we know it is alive
  return now - s.lastActivity < OUTSIDE_STALE_MS; // outside: trust it only while its hooks are recent
}
function activeSessionsOn(seatName) { let n = 0; const now = Date.now(); for (const s of sessions.values()) if (s.seat === seatName && isLiveClaude(s, now)) n++; return n; }
// Only sessions cockpit itself is running on the seat: what the seat card means by "running".
// Excludes plain `claude` runs the user started in their own terminals (those show the usage,
// not a cockpit "running" count).
function managedSessionsOn(seatName) { let n = 0; for (const s of sessions.values()) if (s.seat === seatName && s.kind === 'claude' && s.managed && s.alive) n++; return n; }
function outsideSessionsOn(seatName) { let n = 0; const now = Date.now(); for (const s of sessions.values()) if (s.seat === seatName && s.kind === 'claude' && !s.managed && isLiveClaude(s, now)) n++; return n; }
function seatsInfo() { return cfg.seats.map(seat => ({ seat, usage: usageCache[seat.name] || readUsage(seat), activeSessions: activeSessionsOn(seat.name) })); }

const manager = new SessionManager({
  port: PORT,
  log,
  onLimit: (s, text) => { refreshUsage(); signalLimit(s, 'terminal output', text); },
  onRespawn: s => {
    const seat = seatByName(cfg, s.seat);
    if (!seat) { s.status = 'lost'; s.handoff = null; addEvent('error', `${label(s)}: seat ${s.seat} vanished during handoff`, { cs: s.cs }); return; }
    try { manager.spawn(s, seat); s.status = 'resuming'; manager.broadcastInfo(s); } catch (e) { s.status = 'lost'; s.handoff = null; addEvent('error', `${label(s)}: resume failed: ${e.message}`, { cs: s.cs }); }
    schedulePersist();
  },
  onExit: (s, code) => {
    if (s.kind === 'login') {
      const seat = seatByName(cfg, s.seat);
      addEvent('login', `login window for seat ${s.seat} closed (exit ${code})`, { cs: s.cs });
      if (seat) refreshIdentity(seat);
    } else if (s.kind === 'claude' && s.managed && !s.stopping && code !== 0 && code != null) {
      // The PTY died on its own: not a user stop, and not a handoff (those return before onExit).
      // Mark it recoverable so the dashboard can offer a one-click resume.
      s.status = 'crashed';
      addEvent('error', `${label(s)}: exited unexpectedly (code ${code}); resume to continue`, { cs: s.cs });
    } else {
      addEvent('end', `${label(s)}: session ended (exit ${code})`, { cs: s.cs });
    }
    s.stopping = false;
    schedulePersist();
  },
});

function refreshIdentity(seat, cb) {
  execFile(CLAUDE_BIN, ['auth', 'status', '--json'], { env: claudeEnv(seat), timeout: 30000 }, (err, stdout) => {
    try {
      const j = JSON.parse(String(stdout || '').trim());
      cfg = loadConfig();
      const live = seatByName(cfg, seat.name);
      if (live) { Object.assign(live, { loggedIn: !!j.loggedIn, email: j.email || null, org: j.orgName || null, plan: j.subscriptionType || null }); saveConfig(cfg); cfg = loadConfig(); refreshUsage(); addEvent('seat', `seat ${seat.name}: ${j.loggedIn ? `logged in as ${j.email}` : 'not logged in'}`); }
    } catch (e) { log('warn', `identity refresh for ${seat.name} failed: ${err?.message || e.message}`); }
    cb?.();
  });
}

function newSession({ cs, kind = 'claude', cwd, seat, name, managed = true, sessionId, resume = false, extra = [] }) {
  const id = cs || crypto.randomBytes(5).toString('hex');
  const s = {
    cs: id, kind, sessionId: sessionId || crypto.randomUUID(), name: name || null, cwd: cwd || null, seat: seat || null, managed,
    status: 'starting', alive: false, pid: null, resume, extra, startedAt: Date.now(), lastActivity: Date.now(), turns: 0, handoffs: [],
    lastPrompt: null, lastAssistant: null, handoff: null, pendingHandoff: null, transcriptPath: null, endedAt: null, exitCode: null, source: null, git: null, worktree: null, worktreeRepo: null,
  };
  sessions.set(id, s);
  schedulePersist();
  return s;
}

// A live, cockpit-managed PTY already wrapping this Claude session id (if any). Guards against
// spawning a second `claude --resume <same id>`, which would corrupt the shared transcript.
function liveWrapperFor(sessionId) {
  if (!sessionId) return null;
  for (const s of sessions.values()) if (s.kind === 'claude' && s.managed && s.alive && s.sessionId === sessionId) return s;
  return null;
}

function chooseSeatForNew(prefer) {
  refreshUsage();
  if (prefer) { const seat = seatByName(cfg, prefer); if (!seat) throw new Error(`unknown seat "${prefer}"`); return seat; }
  const ranked = rankCandidates(seatsInfo());
  if (ranked.length) return ranked[0].seat;
  if (!cfg.seats.length) throw new Error('no seats configured; run `cockpit init` first');
  return cfg.seats.find(s => !s.disabled) || cfg.seats[0];
}

function doHandoff(s, toSeat, reason, { resend = false, trigger = 'policy' } = {}) {
  if (s.handoff?.inProgress || !s.alive) return false;
  const from = s.seat;
  const contMsg = cfg.handoff.continueMessage || 'Please continue where you left off.';
  // Interrupted mid-turn: the partial work is already in the transcript, so the right nudge is
  // "continue where you left off" (replaying the original prompt would make it restart). An
  // interrupted turn always continues; a between-turns handoff only if auto-continue is on.
  // Passed as a resume argument, which Claude Code runs automatically on launch.
  s.continuation = resend ? contMsg : (cfg.handoff.autoContinue !== false ? contMsg : null);
  s.handoff = { inProgress: true, phase: 'exiting', from, to: toSeat.name, startedAt: Date.now(), reason, resend, prompt: s.continuation };
  s.status = 'handing_off';
  s.handoffs.push({ at: Date.now(), from, to: toSeat.name, reason, trigger });
  addEvent('handoff', `${label(s)}: ${from} → ${toSeat.name} (${reason})`, { cs: s.cs });
  if (cfg.notifications) notify('Claude Cockpit', `${label(s)}: handed off ${from} → ${toSeat.name} (${reason})`);
  manager.broadcastInfo(s);
  manager.gracefulExit(s);
  return true;
}

function evaluate(s, { hard = false, resend = false, trigger = 'poll' } = {}) {
  if (s.kind !== 'claude' || !s.managed || s.status !== 'idle' || s.handoff?.inProgress || !s.alive) return null;
  const seat = seatByName(cfg, s.seat);
  if (!seat) return null;
  const info = seatsInfo();
  const current = info.find(i => i.seat.name === seat.name);
  const policy = cfg.handoff;
  if (policy.mode === 'off') {
    if (hard) {
      const key = `off:${s.cs}:${Math.floor(Date.now() / 600000)}`;
      if (!notified.has(key)) { notified.set(key, Date.now()); addEvent('limit', `${label(s)}: limit reached on ${s.seat}; handoff mode is off. Use Hand off in the dashboard or: cockpit handoff ${s.cs}`, { cs: s.cs }); if (cfg.notifications) notify('Claude Cockpit', `${label(s)}: seat ${s.seat} hit its limit. Hand off from the dashboard.`); }
    }
    return null;
  }
  const d = decide({ current, seatsInfo: info, policy, hard });
  if (d.action === 'handoff') doHandoff(s, d.to, d.reason, { resend: hard && resend, trigger });
  else if (d.action === 'recommend') {
    const key = `rec:${s.cs}:${current.usage.fiveHour.resetsAt}`;
    if (!notified.has(key)) { notified.set(key, Date.now()); addEvent('recommend', `${label(s)}: ${d.reason}. Hand off to ${d.to.name}? (dashboard, or: cockpit handoff ${s.cs})`, { cs: s.cs, to: d.to.name }); if (cfg.notifications) notify('Claude Cockpit', `${label(s)}: ${d.reason}. Hand off to ${d.to.name}?`); }
  } else if (d.action === 'exhausted') {
    const key = `exh:${s.cs}`;
    if (!notified.has(key) || Date.now() - notified.get(key) > 10 * 60000) { notified.set(key, Date.now()); addEvent('exhausted', `${label(s)}: every seat is near its 5-hour limit; staying on ${s.seat}`, { cs: s.cs }); if (cfg.notifications) notify('Claude Cockpit', `All seats are near their 5-hour limit. ${label(s)} stays on ${s.seat}.`); }
  }
  return d;
}

function signalLimit(s, source, text) {
  if (s.kind !== 'claude') return;
  const u = usageCache[s.seat] || null;
  const pct = u?.fiveHour?.pct ?? null;
  const plausible = pct == null || pct >= 90 || u.stale;
  if (!plausible) { addEvent('ignored', `${label(s)}: "${text}" on ${s.seat}, but its cache says ${pct}%; ignoring`, { cs: s.cs }); return; }
  const resend = s.status === 'busy';
  s.status = 'idle';
  addEvent('limit', `${label(s)}: limit reached on ${s.seat} (${source})`, { cs: s.cs });
  evaluate(s, { hard: true, resend, trigger: source });
}

function handleHook(ev, q, body) {
  const cs = (q.get('cs') || '').slice(0, 128);
  // Reject a malformed or forged session id at the boundary, so it can never reach the
  // "open in Terminal" AppleScript builder (a cs with a quote or backslash could break out of it).
  if (cs && !/^[A-Za-z0-9:_-]+$/.test(cs)) return;
  const cfgDir = q.get('cfg') || '';
  let s;
  if (cs) {
    s = sessions.get(cs) || newSession({ cs, cwd: body.cwd, seat: seatByConfigDir(cfgDir)?.name || null, managed: false, sessionId: body.session_id });
  } else {
    const key = `u:${body.session_id || 'unknown'}`;
    s = sessions.get(key) || newSession({ cs: key, cwd: body.cwd, seat: seatByConfigDir(cfgDir)?.name || null, managed: false, sessionId: body.session_id });
    const seat = seatByConfigDir(cfgDir); if (seat) s.seat = seat.name;
    s.alive = true; // we only learn about outside sessions through their hooks
  }
  s.lastActivity = Date.now();
  if (body.session_id) s.sessionId = body.session_id;
  if (body.transcript_path) s.transcriptPath = body.transcript_path;
  if (body.cwd && !s.cwd) s.cwd = body.cwd;
  switch (ev) {
    case 'SessionStart':
      s.status = 'idle'; s.endedAt = null; s.source = body.source || null;
      if (s.kind === 'claude' && s.transcriptPath && (!s.tok || s.tok.file !== s.transcriptPath)) initTokenTracking(s);
      if (s.handoff?.inProgress) {
        const h = s.handoff; h.inProgress = false; h.phase = 'done'; h.completedAt = Date.now();
        addEvent('resumed', `${label(s)}: resumed on ${s.seat}`, { cs: s.cs });
      }
      break;
    case 'UserPromptSubmit':
      s.status = 'busy'; s.turns++;
      s.lastPrompt = typeof body.prompt === 'string' ? body.prompt : (typeof body.user_prompt === 'string' ? body.user_prompt : s.lastPrompt);
      break;
    case 'Stop':
      s.status = 'idle';
      s.lastAssistant = String(body.last_assistant_message || '').slice(0, 160);
      refreshUsage();
      accountTokens(s, { turn: true });
      if (s.pendingHandoff) { const to = seatByName(cfg, s.pendingHandoff.to); s.pendingHandoff = null; if (to) { doHandoff(s, to, 'manual', { trigger: 'manual' }); break; } }
      evaluate(s, { trigger: 'stop' });
      break;
    case 'StopFailure':
      refreshUsage();
      // A turn can end in failure as well as cleanly. A handoff the user queued mid-turn must
      // still fire here; otherwise it hangs "queued" forever, because a StopFailure is not a Stop.
      if (s.pendingHandoff) { const to = seatByName(cfg, s.pendingHandoff.to); s.pendingHandoff = null; if (to) { s.status = 'idle'; doHandoff(s, to, 'manual', { trigger: 'manual' }); break; } }
      if (/limit|429|rate.?limit/i.test(JSON.stringify(body))) signalLimit(s, 'StopFailure', 'turn failed with a limit error');
      else { s.status = 'idle'; evaluate(s, { trigger: 'stop' }); }
      break;
    case 'SessionEnd':
      accountTokens(s);
      if (s.handoff?.inProgress) break;
      if (!s.managed) { s.status = 'ended'; s.alive = false; s.endedAt = Date.now(); }
      s.endReason = body.reason || null;
      break;
    default: break;
  }
  if (s.managed) manager.broadcastInfo(s);
  schedulePersist();
}

// Claude Code writes its TodoWrite plan to <configDir>/todos/<sessionId>*.json. Because each seat
// runs with its own CLAUDE_CONFIG_DIR, the file can land in the base dir OR in any seat profile
// (its `todos` is meant to be symlinked to the base, but older seats predate that), so scan them all.
function todoDirs() {
  const dirs = new Set([TODOS_DIR]);
  try { for (const s of (cfg.seats || [])) if (s.configDir) dirs.add(path.join(s.configDir, 'todos')); } catch {}
  return [...dirs];
}
function readPlan(sessionId) {
  if (!sessionId) return null;
  try {
    let best = null; // prefer the session's own agent file, else the newest matching file across all dirs
    for (const dir of todoDirs()) {
      let names;
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const n of names) {
        if (!n.startsWith(sessionId) || !n.endsWith('.json')) continue;
        const f = path.join(dir, n);
        let mt; try { mt = fs.statSync(f).mtimeMs; } catch { continue; }
        const agent = n.includes(`-agent-${sessionId}`);
        if (!best || (agent && !best.agent) || (agent === best.agent && mt > best.mtime)) best = { file: f, mtime: mt, agent };
      }
    }
    if (!best) return null;
    const hit = planCache.get(best.file);
    if (hit && hit.mtime === best.mtime) return hit.plan;
    const list = readJson(best.file, null);
    const items = Array.isArray(list) ? list.map(x => ({ text: x.content, state: x.status })) : []; // state: pending|in_progress|completed
    const plan = items.length ? { items, done: items.filter(i => i.state === 'completed').length, total: items.length } : null;
    planCache.set(best.file, { mtime: best.mtime, plan });
    return plan;
  } catch { return null; }
}
function sessionView(s) { return { ...s, viewers: manager.viewerCount(s.cs), plan: (s.kind === 'claude' && s.status !== 'ended') ? readPlan(s.sessionId) : null }; }
// A task joined with its live session: cost (already tracked) + plan + status.
function taskView(t) {
  const s = t.sessionCs ? sessions.get(t.sessionCs) : null;
  const live = s ? {
    cs: s.cs, status: s.status, alive: s.alive, seat: s.seat,
    cost: s.tokens ? { usd: s.tokens.cost, tokens: totalTokens(s.tokens) } : null,
    plan: (s.kind === 'claude' && s.status !== 'ended') ? readPlan(s.sessionId) : null,
    needsYou: s.alive && s.status === 'idle',
  } : null;
  return { ...t, live };
}
// --- Projects: a named, stored thing (optionally bound to one folder, with optional tags). ---
const PROJECT_COLORS = ['#6c8cff', '#59b89c', '#e0a458', '#d87a9a', '#8a7cff', '#4bb3d4', '#c98a5e', '#7bbf6a'];
const expandHome = p => typeof p === 'string' ? p.replace(/^~(?=$|[/\\])/, os.homedir()) : p;
const resolveFolder = p => { const e = expandHome(p); return e ? path.resolve(e) : null; };
// A session belongs to a project by explicit link, or by its folder matching the project's folder.
function sessionProjectId(s) {
  if (s.projectId && findProject(s.projectId)) return s.projectId;
  if (!s.cwd) return null;
  const c = path.resolve(s.cwd);
  const pr = projects.find(p => p.folder && path.resolve(p.folder) === c);
  return pr ? pr.id : null;
}
function projectView(pr) {
  const mine = tasks.filter(t => !t.archived && t.projectId === pr.id);
  const live = [...sessions.values()].filter(s => s.kind !== 'probe' && s.alive && sessionProjectId(s) === pr.id).length;
  return { ...pr, openTasks: mine.filter(t => t.status !== 'done').length, totalTasks: mine.length, live };
}

function state() {
  refreshUsage();
  return {
    version: VERSION, port: PORT, uptime: Date.now() - startedAt, now: Date.now(),
    config: { handoff: cfg.handoff, pollSec: cfg.pollSec, notifications: cfg.notifications, autoCheckMin: Number(cfg.autoCheckMin || 0), budgetMonthlyUSD: Number(cfg.budgetMonthlyUSD || 0) },
    seats: cfg.seats.map(seat => ({ name: seat.name, kind: seat.kind, email: seat.email || null, org: seat.org || null, plan: seat.plan || null, disabled: !!seat.disabled, configDir: seat.configDir, usage: usageCache[seat.name], activeSessions: managedSessionsOn(seat.name), outsideSessions: outsideSessionsOn(seat.name), probe: probeState(seat.name), arm: armState(seat.name), burn: burnFor(seat.name), pctTrend: trendFor(seat.name) })),
    probing: [...probes.values()].some(r => r.running),
    sessions: [...sessions.values()].filter(x => x.kind !== 'probe').map(sessionView).sort((a, b) => b.lastActivity - a.lastActivity),
    jobs: jobs.filter(j => j.status === 'queued' || (j.startedAt || j.createdAt) > Date.now() - 6 * 3600e3).sort((a, b) => a.at - b.at),
    tasks: tasks.filter(t => !t.archived).map(taskView),
    projects: projects.map(projectView),
    events: events.slice(-150).reverse(),
  };
}
function findSession(ref) {
  if (sessions.has(ref)) return sessions.get(ref);
  const live = [...sessions.values()].filter(s => s.status !== 'ended');
  return live.find(s => s.name === ref) || live.find(s => s.sessionId === ref || s.sessionId.startsWith(ref)) || null;
}

function startClaudeSession({ cwd, seat: seatName, name, resumeId, extra, cols, rows, initialPrompt, worktree, branch, projectId }) {
  cfg = loadConfig();
  const proj = projectId ? findProject(projectId) : null;
  let cwdResolved = cwd ? path.resolve(expandHome(cwd)) : (proj && proj.folder ? path.resolve(proj.folder) : null);
  let stored = null;
  if (resumeId) { stored = findStored(resumeId); if (!cwdResolved && stored?.cwd) cwdResolved = stored.cwd; }
  if (!cwdResolved) cwdResolved = os.homedir();
  if (!fs.existsSync(cwdResolved) || !fs.statSync(cwdResolved).isDirectory()) throw new Error(`folder does not exist: ${cwdResolved}`);
  const wantId = stored?.sessionId || resumeId || null;
  if (wantId) { const live = liveWrapperFor(wantId); if (live) { addEvent('attach', `${label(live)}: already running; opening it instead of starting a second copy`, { cs: live.cs }); return { cs: live.cs, sessionId: live.sessionId, seat: { name: live.seat, kind: (seatByName(cfg, live.seat)||{}).kind, configDir: (seatByName(cfg, live.seat)||{}).configDir }, existing: true }; } }
  const seat = chooseSeatForNew(seatName || null);
  let worktreePath = null, worktreeRepo = null;
  if (worktree && !resumeId) {
    try {
      worktreeRepo = execFileSync('git', ['-C', cwdResolved, 'rev-parse', '--show-toplevel'], { timeout: 8000, stdio: 'pipe' }).toString().trim();
      worktreePath = makeWorktree(worktreeRepo, name || path.basename(worktreeRepo), branch ? String(branch).trim() : null);
      cwdResolved = worktreePath;
    } catch (e) { throw new Error(`could not create a git worktree: ${String(e.message).split('\n')[0]}`); }
  }
  const s = newSession({ cwd: cwdResolved, seat: seat.name, name: name || (wantId ? getMark(wantId)?.name : null) || (stored ? (stored.customTitle || null) : null), managed: true, sessionId: wantId, resume: !!resumeId, extra: Array.isArray(extra) ? extra.map(String) : [] });
  if (worktreePath) { s.worktree = worktreePath; s.worktreeRepo = worktreeRepo; }
  if (proj) s.projectId = proj.id;
  if (initialPrompt) s.continuation = String(initialPrompt);
  // If the PTY fails to start, do not leave a half-created session stuck in "starting" with an
  // orphaned git worktree on disk.
  try { manager.spawn(s, seat, { cols, rows }); }
  catch (e) { try { removeWorktree(s); } catch {} sessions.delete(s.cs); throw e; }
  addEvent('start', `${label(s)}: ${resumeId ? 'resuming' : 'starting'} on ${seat.name}`, { cs: s.cs });
  schedulePersist();
  return { cs: s.cs, sessionId: s.sessionId, seat: { name: seat.name, kind: seat.kind, configDir: seat.configDir } };
}

function startLoginSession(seat) {
  const s = newSession({ kind: 'login', cwd: os.homedir(), seat: seat.name, name: `login · ${seat.name}`, managed: true });
  manager.spawn(s, seat);
  addEvent('login', `login window opened for seat ${seat.name}`, { cs: s.cs });
  return s;
}

function shq(str) { return `'${String(str).replace(/'/g, "'\\''")}'`; }
function openInTerminalApp(cs) {
  // Defense in depth: only ever interpolate a known-safe session id into the AppleScript below.
  if (!/^[A-Za-z0-9:_.-]+$/.test(cs)) return;
  const node = shq(process.execPath), cli = shq(path.join(PKG_ROOT, 'bin', 'cockpit.js'));
  // Run attach directly (not via exec) so that if it exits with an error the window stays
  // open with the message instead of vanishing. On a clean end the window closes.
  const cmd = `clear; ${node} ${cli} attach ${shq(cs)}; __c=$?; if [ $__c -ne 0 ]; then echo; echo '[cockpit] attach exited ('$__c'). See above. Press Enter to close.'; read _; fi`;
  const app = cfg.terminalApp || 'Terminal';
  const script = app === 'iTerm'
    ? `tell application "iTerm"\nactivate\nset w to (create window with default profile)\ntell current session of w to write text "${cmd.replace(/"/g, '\\"')}"\nend tell`
    : `tell application "Terminal"\nactivate\ndo script "${cmd.replace(/"/g, '\\"')}"\nend tell`;
  spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true }).unref();
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}
const VENDOR = {
  '/vendor/xterm.js': ['@xterm/xterm/lib/xterm.js', 'text/javascript'],
  '/vendor/xterm.css': ['@xterm/xterm/css/xterm.css', 'text/css'],
  '/vendor/addon-fit.js': ['@xterm/addon-fit/lib/addon-fit.js', 'text/javascript'],
  '/vendor/addon-search.js': ['@xterm/addon-search/lib/addon-search.js', 'text/javascript'],
  '/vendor/addon-web-links.js': ['@xterm/addon-web-links/lib/addon-web-links.js', 'text/javascript'],
};
function file(res, abs, type) {
  try {
    const data = fs.readFileSync(abs);
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
    res.end(data);
  } catch { json(res, { error: 'not found' }, 404); }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', d => { buf += d; if (buf.length > 2e6) { req.destroy(); resolve(null); } });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : null); } catch { resolve(null); } });
    req.on('error', reject);
    req.on('close', () => resolve(null)); // settle even if the socket is torn down (resolve is idempotent)
  });
}
// Everything is bound to 127.0.0.1, but a web page from any origin can still reach it,
// so browser requests must come from the dashboard itself.
function allowed(req) {
  const host = req.headers.host || '';
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return false;
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) return false;
  return true;
}

const server = http.createServer(async (req, res) => {
  if (!allowed(req)) return json(res, { error: 'forbidden' }, 403);
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  let m;
  try {
    if (req.method === 'GET') {
      if (p === '/') return file(res, path.join(WEB_DIR, 'index.html'), 'text/html');
      if (p === '/app.js') return file(res, path.join(WEB_DIR, 'app.js'), 'text/javascript');
      if (p === '/style.css') return file(res, path.join(WEB_DIR, 'style.css'), 'text/css');
      if (p === '/terminal.js') return file(res, path.join(WEB_DIR, 'terminal.js'), 'text/javascript');
      if (VENDOR[p]) return file(res, path.join(PKG_ROOT, 'node_modules', VENDOR[p][0]), VENDOR[p][1]);
      if ((m = p.match(/^\/s\/([^/]+)$/))) return file(res, path.join(WEB_DIR, 'terminal.html'), 'text/html');
      if (p === '/api/health') return json(res, { ok: true, version: VERSION, pid: process.pid, uptime: Date.now() - startedAt, port: PORT });
      if (p === '/api/state') return json(res, state());
      if (p === '/api/tasks') return json(res, { tasks: tasks.filter(t => !t.archived).map(taskView) });
      if (p === '/api/library') return json(res, { sessions: scanLibrary(), tags: allTags(), now: Date.now() });
      if (p === '/api/projects') return json(res, { projects: projects.map(projectView), recent: recentProjects() });
      if (p === '/api/usage') return json(res, usageSummary());
      if (p === '/api/search') return json(res, { results: await searchTranscripts(url.searchParams.get('q') || '', { limit: 40 }) });
      if ((m = p.match(/^\/api\/sessions\/([^/]+)$/))) { const s = findSession(decodeURIComponent(m[1])); return s ? json(res, sessionView(s)) : json(res, { error: 'no such session' }, 404); }
      return json(res, { error: 'not found' }, 404);
    }
    if (req.method === 'POST') {
      const body = (await readBody(req)) || {};
      if ((m = p.match(/^\/hook\/([A-Za-z]+)$/))) { handleHook(m[1], url.searchParams, body); return json(res, { ok: true }); }
      if (p === '/api/sessions') return json(res, startClaudeSession(body));
      if (p === '/api/schedule') { if (!body.cwd || !fs.existsSync(path.resolve(body.cwd))) return json(res, { error: 'folder does not exist' }, 400); return json(res, { ok: true, job: addJob({ ...body, cwd: path.resolve(body.cwd) }) }); }
      if ((m = p.match(/^\/api\/schedule\/([^/]+)\/cancel$/))) { const job = jobs.find(j => j.id === m[1]); if (!job) return json(res, { error: 'no such job' }, 404); if (job.status === 'queued') { job.status = 'cancelled'; addEvent('schedule', `cancelled "${job.name || ''}"`); schedulePersist(); } return json(res, { ok: true }); }
      if (p === '/api/tasks') {
        const pr = body.projectId ? findProject(body.projectId) : null;
        const cwd = body.cwd ? resolveFolder(body.cwd) : (pr && pr.folder ? path.resolve(pr.folder) : null);
        const t = { id: crypto.randomBytes(4).toString('hex'), title: String(body.title || '').slice(0, 200), desc: String(body.desc || ''), cwd, projectId: pr ? pr.id : null, project: pr ? pr.name : (body.project || null), seat: body.seat || null, status: ['backlog', 'ready', 'inprogress', 'done'].includes(body.status) ? body.status : 'backlog', order: Number(body.order) || Date.now(), autoKick: body.autoKick !== false, worktree: !!body.worktree, branch: body.branch || null, sessionCs: null, sessionId: null, archived: false, createdAt: Date.now(), updatedAt: Date.now() };
        tasks.push(t); addEvent('task', `added "${t.title || 'untitled'}"`); schedulePersist();
        return json(res, { ok: true, task: taskView(t) });
      }
      if ((m = p.match(/^\/api\/tasks\/([^/]+)\/launch$/))) {
        const t = findTask(m[1]); if (!t) return json(res, { error: 'no such task' }, 404);
        if (!t.cwd || !fs.existsSync(t.cwd)) return json(res, { error: 'task has no project folder' }, 400);
        const r = startClaudeSession({ cwd: t.cwd, seat: t.seat || body.seat || null, name: t.title, initialPrompt: t.autoKick ? (t.desc || t.title) : undefined, worktree: !!t.worktree, branch: t.branch || null, projectId: t.projectId || null });
        t.sessionCs = r.cs; t.sessionId = r.sessionId; t.status = 'inprogress'; t.endedNudged = false; t.updatedAt = Date.now();
        addEvent('task', `launched "${t.title}" on ${r.seat.name}`, { cs: r.cs }); schedulePersist();
        return json(res, { ok: true, task: taskView(t) });
      }
      if ((m = p.match(/^\/api\/tasks\/([^/]+)\/delete$/))) {
        const i = tasks.findIndex(t => t.id === m[1]); if (i < 0) return json(res, { error: 'no such task' }, 404);
        const [t] = tasks.splice(i, 1); addEvent('task', `deleted "${t.title || ''}"`); schedulePersist();
        return json(res, { ok: true });
      }
      if ((m = p.match(/^\/api\/tasks\/([^/]+)$/))) {
        const t = findTask(m[1]); if (!t) return json(res, { error: 'no such task' }, 404);
        for (const k of ['title', 'desc', 'status', 'order', 'seat', 'project', 'autoKick', 'worktree', 'branch', 'archived']) if (k in body) t[k] = body[k];
        if ('projectId' in body) {
          t.projectId = body.projectId || null;
          const pr = t.projectId ? findProject(t.projectId) : null;
          if (pr) { t.project = pr.name; if (pr.folder && !('cwd' in body)) t.cwd = path.resolve(pr.folder); }
        }
        if ('cwd' in body) t.cwd = body.cwd ? resolveFolder(body.cwd) : null;
        t.completedAt = t.status === 'done' ? (t.completedAt || Date.now()) : null;
        t.updatedAt = Date.now(); schedulePersist();
        return json(res, { ok: true, task: taskView(t) });
      }
      if (p === '/api/projects') {
        const name = String(body.name || '').trim().slice(0, 60);
        if (!name) return json(res, { error: 'a project needs a name' }, 400);
        if (projects.some(x => x.name.toLowerCase() === name.toLowerCase())) return json(res, { error: `a project called "${name}" already exists` }, 400);
        let folder = null;
        if (body.folder) {
          folder = resolveFolder(body.folder);
          if (body.createFolder) { try { fs.mkdirSync(folder, { recursive: true }); } catch (e) { return json(res, { error: `could not create folder: ${e.message}` }, 400); } }
          else if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return json(res, { error: 'that folder does not exist' }, 400);
        }
        const tags = Array.isArray(body.tags) ? body.tags.map(x => String(x).trim()).filter(Boolean).slice(0, 12) : [];
        const pr = { id: crypto.randomBytes(4).toString('hex'), name, folder, tags, color: body.color || PROJECT_COLORS[projects.length % PROJECT_COLORS.length], createdAt: Date.now(), updatedAt: Date.now() };
        projects.push(pr); addEvent('project', `created project "${name}"`); schedulePersist();
        return json(res, { ok: true, project: projectView(pr) });
      }
      if ((m = p.match(/^\/api\/projects\/([^/]+)\/delete$/))) {
        const i = projects.findIndex(x => x.id === m[1]); if (i < 0) return json(res, { error: 'no such project' }, 404);
        const [pr] = projects.splice(i, 1);
        for (const t of tasks) if (t.projectId === pr.id) t.projectId = null;
        for (const s of sessions.values()) if (s.projectId === pr.id) delete s.projectId;
        addEvent('project', `deleted project "${pr.name}"`); schedulePersist();
        return json(res, { ok: true });
      }
      if ((m = p.match(/^\/api\/projects\/([^/]+)$/))) {
        const pr = findProject(m[1]); if (!pr) return json(res, { error: 'no such project' }, 404);
        if ('name' in body) { const n = String(body.name || '').trim().slice(0, 60); if (!n) return json(res, { error: 'a project needs a name' }, 400); if (projects.some(x => x.id !== pr.id && x.name.toLowerCase() === n.toLowerCase())) return json(res, { error: `a project called "${n}" already exists` }, 400); pr.name = n; }
        if ('folder' in body) {
          if (body.folder) { const f = resolveFolder(body.folder); if (body.createFolder) { try { fs.mkdirSync(f, { recursive: true }); } catch (e) { return json(res, { error: `could not create folder: ${e.message}` }, 400); } } else if (!fs.existsSync(f) || !fs.statSync(f).isDirectory()) return json(res, { error: 'that folder does not exist' }, 400); pr.folder = f; }
          else pr.folder = null;
        }
        if ('tags' in body) pr.tags = Array.isArray(body.tags) ? body.tags.map(x => String(x).trim()).filter(Boolean).slice(0, 12) : [];
        if ('color' in body) pr.color = String(body.color || '').slice(0, 20) || pr.color;
        pr.updatedAt = Date.now(); schedulePersist();
        return json(res, { ok: true, project: projectView(pr) });
      }
      if ((m = p.match(/^\/api\/marks\/([^/]+)$/))) { const mk = setMark(decodeURIComponent(m[1]), body || {}); return json(res, { ok: true, mark: mk }); }
      if (p === '/api/marks-batch') { const ids = Array.isArray(body.sessionIds) ? body.sessionIds : []; for (const id of ids) setMark(String(id), body.patch || {}); addEvent('marks', `updated ${ids.length} session${ids.length === 1 ? '' : 's'}`); return json(res, { ok: true, count: ids.length }); }
      if (p === '/api/library/delete') {
        const ids = Array.isArray(body.sessionIds) ? body.sessionIds : [];
        let deleted = 0;
        for (const id of ids) {
          if (!/^[A-Za-z0-9._-]+$/.test(String(id))) continue;            // guard the path
          if ([...sessions.values()].some(x => x.sessionId === id && x.alive)) continue; // never delete a live one
          const rec = findStored(String(id));
          const baseDir = path.resolve(BASE_CLAUDE_DIR), recFile = rec && rec.file ? path.resolve(rec.file) : null;
          if (recFile && (recFile === baseDir || recFile.startsWith(baseDir + path.sep))) {
            try { fs.rmSync(rec.file, { force: true }); const side = rec.file.replace(/\.jsonl$/, ''); if (fs.existsSync(side) && fs.statSync(side).isDirectory()) fs.rmSync(side, { recursive: true, force: true }); setMark(String(id), {}); deleted++; } catch (e) { log('warn', `delete ${id}: ${e.message}`); }
          }
        }
        addEvent('delete', `deleted ${deleted} stored session${deleted === 1 ? '' : 's'}`);
        return json(res, { ok: true, deleted });
      }
      if ((m = p.match(/^\/api\/sessions\/([^/]+)\/(handoff|signal|stop|restore|open-terminal|forget|rename)$/))) {
        const [, ref, action] = m;
        const s = findSession(decodeURIComponent(ref));
        if (!s) return json(res, { error: `no session matches "${ref}"` }, 404);
        if (action === 'handoff') {
          if (!s.managed || s.kind !== 'claude') return json(res, { error: 'that session was not started by cockpit; it cannot be handed off' }, 400);
          if (!s.alive) return json(res, { error: 'that session is not running; restore it first' }, 400);
          cfg = loadConfig(); refreshUsage();
          const to = body.toSeat ? seatByName(cfg, body.toSeat) : (rankCandidates(seatsInfo(), { exclude: [s.seat] })[0]?.seat || null);
          if (!to) return json(res, { error: body.toSeat ? `unknown seat "${body.toSeat}"` : 'no other seat with headroom' }, 400);
          if (to.name === s.seat) return json(res, { error: `already on ${to.name}` }, 400);
          if (s.status === 'idle') return json(res, { ok: doHandoff(s, to, 'manual', { trigger: 'manual' }), queued: false, to: to.name });
          s.pendingHandoff = { to: to.name };
          addEvent('queued', `${label(s)}: handoff to ${to.name} queued until the current turn ends`, { cs: s.cs });
          manager.broadcastInfo(s); schedulePersist();
          return json(res, { ok: true, queued: true, to: to.name });
        }
        if (action === 'signal') { if (body.type === 'limit_hit') { refreshUsage(); signalLimit(s, 'client', String(body.text || '').slice(0, 80)); } return json(res, { ok: true }); }
        if (action === 'stop') { s.stopping = true; const ok = await manager.kill(s); if (!ok && s.status !== 'ended') { s.status = 'ended'; s.alive = false; } addEvent('stop', `${label(s)}: stopped`, { cs: s.cs }); schedulePersist(); return json(res, { ok: true }); }
        if (action === 'restore') {
          if (s.alive) return json(res, { error: 'already running' }, 400);
          if (s.handoff?.inProgress) return json(res, { error: 'a handoff is in progress; try again in a moment' }, 409);
          if (s.kind !== 'claude') return json(res, { error: 'only Claude sessions can be restored' }, 400);
          const live = liveWrapperFor(s.sessionId); if (live && live.cs !== s.cs) return json(res, { error: `this conversation is already running as ${live.name || live.cs}; open that instead`, cs: live.cs }, 409);
          cfg = loadConfig();
          const seat = chooseSeatForNew(body.seat || null);
          s.seat = seat.name; s.resume = true; s.handoff = null; s.pendingHandoff = null; s.status = 'starting';
          manager.spawn(s, seat, { cols: body.cols, rows: body.rows });
          addEvent('restore', `${label(s)}: resumed on ${seat.name}`, { cs: s.cs }); schedulePersist();
          return json(res, { ok: true, cs: s.cs, seat: seat.name });
        }
        if (action === 'open-terminal') { openInTerminalApp(s.cs); return json(res, { ok: true }); }
        if (action === 'forget') { if (s.alive) return json(res, { error: 'still running' }, 400); if (s.handoff?.inProgress) return json(res, { error: 'a handoff is in progress; try again in a moment' }, 409); removeWorktree(s); manager.forget(s.cs); sessions.delete(s.cs); schedulePersist(); return json(res, { ok: true }); }
        if (action === 'rename') { s.name = String(body.name || '').slice(0, 80) || null; manager.broadcastInfo(s); schedulePersist(); return json(res, { ok: true }); }
      }
      if (p === '/api/seats') {
        cfg = loadConfig();
        const name = String(body.name || '').trim();
        if (!/^[a-z0-9_-]{1,24}$/i.test(name)) return json(res, { error: 'seat names use letters, digits, - and _ (max 24)' }, 400);
        if (seatByName(cfg, name)) return json(res, { error: `seat "${name}" already exists` }, 400);
        if (!cfg.seats.some(s => s.kind === 'base')) return json(res, { error: 'run `cockpit init` first' }, 400);
        const seat = makeProfileSeat(name);
        seedProfile(seat); installHooks(seat, PORT);
        cfg.seats.push(seat); saveConfig(cfg); cfg = loadConfig(); refreshUsage();
        addEvent('seat', `seat ${name} created`);
        const s = body.login === false ? null : startLoginSession(seatByName(cfg, name));
        return json(res, { ok: true, seat: name, cs: s?.cs || null });
      }
      if (p === '/api/probe-all') return json(res, { ok: true, seats: probeAll() });
      if (p === '/api/arm-all') { cfg = loadConfig(); const names = []; for (const seat of cfg.seats.filter(x => !x.disabled)) { queueArm(seat); names.push(seat.name); } return json(res, { ok: true, seats: names }); }
      if ((m = p.match(/^\/api\/seats\/([^/]+)(?:\/(login|remove|refresh|probe|arm))?$/))) {
        cfg = loadConfig();
        const seat = seatByName(cfg, decodeURIComponent(m[1]));
        if (!seat) return json(res, { error: 'unknown seat' }, 404);
        const action = m[2];
        if (!action) { if (typeof body.disabled === 'boolean') seat.disabled = body.disabled; saveConfig(cfg); cfg = loadConfig(); refreshUsage(); return json(res, { ok: true }); }
        if (action === 'login') { const s = startLoginSession(seat); return json(res, { ok: true, cs: s.cs }); }
        if (action === 'refresh') { refreshIdentity(seat, () => {}); return json(res, { ok: true }); }
        if (action === 'probe') { queueProbe(seat); return json(res, { ok: true, seat: seat.name }); }
        if (action === 'arm') { queueArm(seat); return json(res, { ok: true, seat: seat.name }); }
        if (action === 'remove') {
          if (activeSessionsOn(seat.name)) return json(res, { error: 'stop or hand off its running sessions first' }, 400);
          cfg.seats = cfg.seats.filter(x => x.name !== seat.name); saveConfig(cfg); cfg = loadConfig(); refreshUsage();
          if (seat.kind === 'base') uninstallHooks(seat);
          else if (body.purge && (path.resolve(seat.configDir) + path.sep).startsWith(path.resolve(PROFILES_DIR) + path.sep)) fs.rmSync(seat.configDir, { recursive: true, force: true });
          addEvent('seat', `seat ${seat.name} removed`);
          return json(res, { ok: true });
        }
      }
      if (p === '/api/config') {
        cfg = loadConfig();
        if (body.handoff) { const h = { ...cfg.handoff, ...body.handoff }; for (const k of ['thresholdPct', 'minGainPct', 'hardPct']) { const n = Number(h[k]); h[k] = Number.isFinite(n) ? n : cfg.handoff[k]; } cfg.handoff = h; }
        if (typeof body.notifications === 'boolean') cfg.notifications = body.notifications;
        if (body.pollSec !== undefined) { const ps = Number(body.pollSec); if (Number.isFinite(ps)) cfg.pollSec = Math.max(10, ps); }
        if (body.terminalApp) cfg.terminalApp = body.terminalApp === 'iTerm' ? 'iTerm' : 'Terminal';
        if (body.autoCheckMin !== undefined) cfg.autoCheckMin = Math.max(0, Number(body.autoCheckMin) || 0);
        if (typeof body.armModel === 'string' && body.armModel.trim()) cfg.armModel = body.armModel.trim().slice(0, 40);
        if (body.budgetMonthlyUSD !== undefined) cfg.budgetMonthlyUSD = Math.max(0, Number(body.budgetMonthlyUSD) || 0);
        saveConfig(cfg); cfg = loadConfig(); rearmPoll();
        addEvent('config', `policy: ${cfg.handoff.mode} at ${cfg.handoff.thresholdPct}%`);
        return json(res, { ok: true, config: cfg });
      }
      if (p === '/api/reload') { cfg = loadConfig(); refreshUsage(); rearmPoll(); return json(res, { ok: true, seats: cfg.seats.length }); }
      if (p === '/api/shutdown') { json(res, { ok: true }); setTimeout(shutdown, 50); return; }
      return json(res, { error: 'not found' }, 404);
    }
    return json(res, { error: 'method not allowed' }, 405);
  } catch (e) {
    log('error', e.stack || e.message);
    return json(res, { error: e.message }, 500);
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const m = url.pathname.match(/^\/ws\/([^/]+)$/);
  const s = m && allowed(req) ? findSession(decodeURIComponent(m[1])) : null;
  if (!s || !manager.has(s.cs)) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => {
    ws.on('error', () => { try { ws.close(); } catch {} }); // a routine client disconnect should not reach uncaughtException
    manager.attach(s, ws, Number(url.searchParams.get('cols')), Number(url.searchParams.get('rows')));
    ws.on('message', raw => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.t === 'in' && typeof msg.d === 'string') manager.write(s, msg.d);
      else if (msg.t === 'rs') manager.resize(s, msg.cols, msg.rows);
    });
  });
});

// --- Scheduled / queued runs ---------------------------------------------------
function addJob(j) {
  const id = crypto.randomBytes(4).toString('hex');
  const job = { id, status: 'queued', createdAt: Date.now(), startedAt: null, cs: null, error: null, cwd: j.cwd, seat: j.seat || null, name: j.name || null, extra: Array.isArray(j.extra) ? j.extra.map(String) : [], prompt: j.prompt || null, at: Number(j.at) || Date.now() };
  jobs.push(job);
  addEvent('schedule', `queued "${job.name || path.basename(job.cwd || '')}" for ${new Date(job.at).toLocaleString()}`);
  schedulePersist();
  return job;
}
function runJob(job) {
  job.status = 'started'; job.startedAt = Date.now();
  try {
    const r = startClaudeSession({ cwd: job.cwd, seat: job.seat, name: job.name, extra: job.extra, initialPrompt: job.prompt });
    job.cs = r.cs;
    addEvent('schedule', `started scheduled "${job.name || path.basename(job.cwd || '')}" on ${r.seat.name}`, { cs: r.cs });
    if (cfg.notifications) notify('Claude Cockpit', `Scheduled run started on ${r.seat.name}: ${job.name || job.cwd}`);
  } catch (e) { job.status = 'failed'; job.error = e.message; addEvent('error', `scheduled job failed: ${e.message}`); }
  schedulePersist();
}
function processJobs() {
  const now = Date.now();
  for (const job of jobs) if (job.status === 'queued' && now >= job.at) runJob(job);
  const cutoff = now - 7 * 86400e3;
  for (let i = jobs.length - 1; i >= 0; i--) { const j = jobs[i]; if (j.status !== 'queued' && (j.startedAt || j.createdAt) < cutoff) jobs.splice(i, 1); }
}

let pollTimer = null;
function poll() {
  try {
    cfg = loadConfig();
    refreshUsage();
    refreshGit();
    for (const s of sessions.values()) { if (s.alive && s.transcriptPath) accountTokens(s); if (s.managed && s.status === 'idle') evaluate(s, { trigger: 'poll' }); }
    processJobs();
    for (const t of tasks) if (t.status === 'inprogress' && t.sessionCs && !t.endedNudged) { const s = sessions.get(t.sessionCs); if (s && !s.alive && s.status === 'ended') { t.endedNudged = true; addEvent('task', `"${t.title}" session finished; ready to mark done`); schedulePersist(); } }
    for (const [name, u] of Object.entries(usageCache)) {
      const pct = u?.fiveHour?.pct;
      if (pct != null && pct >= cfg.handoff.thresholdPct) { const key = `seat:${name}:${u.fiveHour.resetsAt}`; if (!notified.has(key)) { notified.set(key, Date.now()); addEvent('threshold', `seat ${name} is at ${pct}% of its 5-hour window`); } }
    }
    const every = Number(cfg.autoCheckMin || 0);
    if (every > 0) {
      for (const seat of cfg.seats) {
        const u = usageCache[seat.name]; const rec = probes.get(seat.name);
        const due = !rec?.lastAt || Date.now() - rec.lastAt > every * 60000;
        if (!seat.disabled && u?.loggedIn && !activeSessionsOn(seat.name) && (u.stale || !u.known) && due && !rec?.running) queueProbe(seat);
      }
    }
    // Outside sessions live only through their hooks; if one goes silent, consider it gone.
    const silent = Date.now() - OUTSIDE_STALE_MS;
    for (const s of sessions.values()) if (s.kind === 'claude' && !s.managed && s.alive && s.lastActivity < silent) { s.alive = false; s.status = 'ended'; s.endedAt = s.endedAt || s.lastActivity; }
    const cutoff = Date.now() - 48 * 3600 * 1000;
    for (const [k, s] of sessions) if (!s.alive && ['ended', 'lost', 'crashed'].includes(s.status) && (s.endedAt || s.lastActivity) < cutoff) { removeWorktree(s); manager.forget(k); sessions.delete(k); }
    if (notified.size > 2000) notified.clear();
  } catch (e) { log('error', `poll: ${e.stack || e.message}`); }
  rearmPoll();
}
function rearmPoll() { clearTimeout(pollTimer); pollTimer = setTimeout(poll, Math.max(5, Number(cfg.pollSec) || 30) * 1000); }

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  log('info', 'shutting down');
  clearTimeout(pollTimer);
  // Kill the PTYs we own so no `claude` process is orphaned to keep writing a transcript.
  for (const s of sessions.values()) { if (s.alive && s.kind === 'claude' && s.managed) { try { manager.killNow(s); } catch {} s.status = 'lost'; } else if (s.alive) s.status = 'lost'; }
  try { writeJson(STATE_FILE, { sessions: Object.fromEntries(sessions), events, jobs, tasks, projects }); } catch {}
  try { writeJson(LEDGER_FILE, ledger); } catch {}
  try { if (fs.existsSync(PID_FILE) && Number(fs.readFileSync(PID_FILE, 'utf8')) === process.pid) fs.unlinkSync(PID_FILE); } catch {}
  server.close();
  setTimeout(() => process.exit(0), 150).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', e => log('error', `uncaught: ${e.stack || e.message}`));

server.on('error', e => { log('error', `listen failed on ${PORT}: ${e.message}`); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => {
  fs.writeFileSync(PID_FILE, String(process.pid));
  refreshUsage();
  log('info', `claude-cockpit daemon ${VERSION} on http://127.0.0.1:${PORT} with ${cfg.seats.length} seat(s)`);
  poll();
});
