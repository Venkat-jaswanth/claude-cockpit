#!/usr/bin/env node
// The `cockpit` CLI. Every command here is a thin client: it ensures the daemon is up and
// then calls its HTTP API (src/client.js), or manages seats/hooks directly on disk for the
// setup commands. The dashboard exposes the same actions as buttons; this is the keyboard
// path to them. `cockpit <cmd> --help` and the usage() text below list the full command set.
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HOME, LOG_FILE, PROFILES_DIR, BASE_CLAUDE_JSON, ensureHome, readJson } from '../src/paths.js';
const PKG_CLI = fileURLToPath(import.meta.url);
import { loadConfig, saveConfig, portOf } from '../src/config.js';
import { readUsage } from '../src/usage.js';
import { makeBaseSeat, makeProfileSeat, seedProfile, installHooks, uninstallHooks, hooksInstalled, refreshIdentity, login, seatByName, installStatusLine, uninstallStatusLine } from '../src/seats.js';
import { request, health } from '../src/client.js';
import { ensureDaemon, stopDaemon, installLaunchAgent, uninstallLaunchAgent, launchAgentInstalled, PLIST } from '../src/daemonctl.js';
import { attach } from '../src/attach.js';

const argv = process.argv.slice(2);
const cmd = argv.shift();

function flag(args, ...names) { for (const n of names) { const i = args.indexOf(n); if (i >= 0) { const v = args[i + 1]; args.splice(i, 2); return v; } } return null; }
function has(args, ...names) { for (const n of names) { const i = args.indexOf(n); if (i >= 0) { args.splice(i, 1); return true; } } return false; }
function out(s = '') { process.stdout.write(s + '\n'); }
function fail(s) { process.stderr.write(`cockpit: ${s}\n`); process.exit(1); }
const bold = s => `\x1b[1m${s}\x1b[0m`, dim = s => `\x1b[2m${s}\x1b[0m`;
const color = (pct) => pct == null ? dim('n/a') : pct >= 85 ? `\x1b[31m${pct}%\x1b[0m` : pct >= 60 ? `\x1b[33m${pct}%\x1b[0m` : `\x1b[32m${pct}%\x1b[0m`;
function pad(s, n) { s = String(s ?? ''); const vis = s.replace(/\x1b\[[0-9;]*m/g, ''); return s + ' '.repeat(Math.max(0, n - vis.length)); }
function resetsIn(iso) { if (!iso) return ''; const ms = new Date(iso).getTime() - Date.now(); if (ms <= 0) return 'reset'; const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; }

async function notifyDaemonReload(port) { try { await request(port, 'POST', '/api/reload'); } catch {} }

function printSeats(cfg) {
  if (!cfg.seats.length) { out(dim('no seats. Run `cockpit init`, then `cockpit seat add <name>`.')); return; }
  out(bold(pad('SEAT', 12) + pad('5H USED', 9) + pad('RESETS IN', 11) + pad('WEEKLY', 9) + pad('ACCOUNT', 34) + pad('PLAN', 8) + 'NOTES'));
  for (const seat of cfg.seats) {
    const u = readUsage(seat);
    const weekly = u.weekly.length ? Math.max(...u.weekly.map(w => w.pct || 0)) : null;
    const notes = [];
    if (!u.loggedIn) notes.push('NOT LOGGED IN');
    if (seat.disabled) notes.push('disabled');
    if (u.fiveHour.assumedReset) notes.push('window reset');
    else if (!u.known) notes.push('no usage data yet');
    else if (u.stale) notes.push(`stale ${Math.round(u.ageMin)}m`);
    if (seat.kind === 'base') notes.push('~/.claude');
    out(pad(seat.name, 12) + pad(color(u.fiveHour.pct), 9) + pad(resetsIn(u.fiveHour.resetsAt), 11) + pad(color(weekly), 9) + pad(u.email || seat.email || '?', 34) + pad(seat.plan || '', 8) + dim(notes.join(', ')));
  }
}

async function cmdInit(args) {
  ensureHome();
  const cfg = loadConfig();
  const portArg = flag(args, '--port');
  if (portArg) cfg.port = Number(portArg);
  const port = portOf(cfg);
  let base = cfg.seats.find(s => s.kind === 'base');
  if (!base) {
    const j = readJson(BASE_CLAUDE_JSON, {}) || {};
    const email = j.oauthAccount?.emailAddress || '';
    const name = flag(args, '--name') || (email ? email.split('@')[0].replace(/[^a-z0-9_-]/gi, '').slice(0, 20) : 'seat1');
    if (seatByName(cfg, name)) fail(`a seat named "${name}" already exists; pass --name`);
    base = makeBaseSeat(name);
    cfg.seats.unshift(base);
  }
  const id = refreshIdentity(base);
  if (id) Object.assign(base, id);
  saveConfig(cfg);
  installHooks(base, port);
  const up = await ensureDaemon(port);
  out(`${bold('Adopted your current login as seat')} ${bold(base.name)} ${dim(`(${base.email || 'unknown'}, ${base.plan || 'unknown plan'})`)}`);
  out(`Hooks installed in ${path.join(base.configDir, 'settings.json')} ${dim('(backup in ' + path.join(HOME, 'backups') + ')')}`);
  out(up ? `Daemon running at ${bold(`http://127.0.0.1:${port}`)}` : `Daemon failed to start; see ${LOG_FILE}`);
  out();
  out('Next:');
  out(`  cockpit seat add <name>     ${dim('log a teammate\'s account in as its own seat')}`);
  out(`  cockpit start               ${dim('start Claude Code in this folder on the freshest seat')}`);
  out(`  cockpit daemon install      ${dim('keep the daemon alive across reboots (launchd)')}`);
}

async function cmdSeat(args) {
  const sub = args.shift();
  const cfg = loadConfig();
  const port = portOf(cfg);
  if (sub === 'list' || !sub) { printSeats(cfg); return; }
  if (sub === 'add') {
    const name = args.shift();
    if (!name || !/^[a-z0-9_-]{1,24}$/i.test(name)) fail('usage: cockpit seat add <name>   (letters, digits, - and _ only)');
    if (seatByName(cfg, name)) fail(`seat "${name}" already exists`);
    if (!cfg.seats.some(s => s.kind === 'base')) fail('run `cockpit init` first so the shared ~/.claude directory is adopted');
    const noLogin = has(args, '--no-login');
    const seat = makeProfileSeat(name);
    ensureHome();
    const linked = seedProfile(seat);
    installHooks(seat, port);
    cfg.seats.push(seat);
    saveConfig(cfg);
    out(`Created seat ${bold(name)} at ${seat.configDir} ${dim(`(shares ${linked.length} entries with ~/.claude: ${linked.join(', ')})`)}`);
    if (!noLogin) {
      out(`Opening the Claude login for seat ${bold(name)}. Sign in with the teammate's account.`);
      login(seat);
    }
    const id = refreshIdentity(seat);
    if (id) { Object.assign(seat, id); saveConfig(cfg); }
    await notifyDaemonReload(port);
    out(id?.loggedIn ? `Seat ${bold(name)} is logged in as ${id.email} (${id.plan || 'unknown plan'}).` : `Seat ${bold(name)} is not logged in yet. Run: cockpit seat login ${name}`);
    return;
  }
  if (sub === 'login') {
    const seat = seatByName(cfg, args.shift() || '');
    if (!seat) fail('usage: cockpit seat login <name>');
    login(seat);
    const id = refreshIdentity(seat);
    if (id) { Object.assign(seat, id); saveConfig(cfg); }
    await notifyDaemonReload(port);
    out(id?.loggedIn ? `Seat ${bold(seat.name)} is logged in as ${id.email}.` : `Seat ${bold(seat.name)} is still not logged in.`);
    return;
  }
  if (sub === 'remove' || sub === 'rm') {
    const name = args.shift();
    const seat = seatByName(cfg, name || '');
    if (!seat) fail('usage: cockpit seat remove <name> [--purge]');
    const purge = has(args, '--purge');
    cfg.seats = cfg.seats.filter(s => s.name !== seat.name);
    saveConfig(cfg);
    if (seat.kind === 'base') uninstallHooks(seat);
    else if (purge && seat.configDir.startsWith(PROFILES_DIR)) fs.rmSync(seat.configDir, { recursive: true, force: true });
    await notifyDaemonReload(port);
    out(`Removed seat ${bold(seat.name)}${seat.kind === 'profile' && !purge ? ` ${dim(`(profile kept at ${seat.configDir}; add --purge to delete it)`)}` : ''}.`);
    return;
  }
  if (sub === 'sync') {
    for (const seat of cfg.seats) {
      if (seat.kind === 'profile') seedProfile(seat);
      installHooks(seat, port);
      const id = refreshIdentity(seat);
      if (id) Object.assign(seat, id);
      out(`synced ${seat.name}${id ? ` (${id.loggedIn ? id.email : 'not logged in'})` : ''}`);
    }
    saveConfig(cfg);
    await notifyDaemonReload(port);
    return;
  }
  fail('usage: cockpit seat <list|add|login|remove|sync>');
}

async function cmdStatus() {
  const cfg = loadConfig();
  const port = portOf(cfg);
  const h = await health(port);
  out(`${bold('claude-cockpit')} · daemon ${h ? `up (pid ${h.pid}) at http://127.0.0.1:${port}` : 'down'} · policy ${cfg.handoff.mode} at ${cfg.handoff.thresholdPct}%${launchAgentInstalled() ? ' · launchd' : ''}`);
  out();
  printSeats(cfg);
  if (!h) return;
  const st = (await request(port, 'GET', '/api/state')).body;
  const shown = st.sessions.filter(s => s.status !== 'ended');
  out();
  if (!shown.length) { out(dim('no sessions. Start one with `cockpit start`, or open the dashboard: cockpit open')); return; }
  out(bold(pad('SESSION', 12) + pad('NAME', 22) + pad('SEAT', 10) + pad('STATUS', 12) + pad('TURNS', 7) + pad('VIEWERS', 9) + 'FOLDER'));
  for (const s of shown) {
    out(pad(s.cs, 12) + pad((s.name || '').slice(0, 20), 22) + pad(s.seat || '?', 10) + pad(s.status + (s.managed ? '' : '*'), 12) + pad(s.turns, 7) + pad(s.viewers ?? 0, 9) + dim(s.cwd || ''));
  }
  if (shown.some(s => !s.managed)) out(dim('* started outside cockpit; visible but cannot be attached or handed off'));
  if (shown.some(s => s.status === 'lost')) out(dim('lost = the daemon restarted while it ran; resume it from the dashboard or: cockpit resume <session-id>'));
  out(dim('attach: cockpit attach <session|name> · detach inside with Ctrl-]'));
}

function termSize() { return { cols: process.stdout.columns || 120, rows: process.stdout.rows || 36 }; }

async function createAndAttach(body, labelText) {
  const cfg = loadConfig();
  const port = portOf(cfg);
  if (!cfg.seats.length) fail('no seats configured yet. Run `cockpit init` first.');
  if (!(await ensureDaemon(port))) fail(`could not start the cockpit daemon on port ${port}; see ${LOG_FILE}`);
  const r = await request(port, 'POST', '/api/sessions', { ...body, ...termSize() }).catch(e => ({ status: 0, body: { error: e.message } }));
  if (r.status !== 200) fail(r.body?.error || 'the daemon refused to create a session');
  const code = await attach(port, r.body.cs, { label: labelText || body.name || '' });
  process.exit(code);
}

async function cmdStart(args) {
  const extraIdx = args.indexOf('--');
  const extra = extraIdx >= 0 ? args.splice(extraIdx + 1) : [];
  if (extraIdx >= 0) args.splice(extraIdx, 1);
  const opts = { seat: flag(args, '--seat', '-s'), name: flag(args, '--name', '-n'), cwd: flag(args, '--cwd', '-C'), resumeId: flag(args, '--resume', '-r') };
  if (args.length) fail(`unknown arguments: ${args.join(' ')} (pass Claude Code flags after --)`);
  await createAndAttach({ cwd: path.resolve(opts.cwd || process.cwd()), seat: opts.seat, name: opts.name, resumeId: opts.resumeId, extra });
}

async function cmdResume(args) {
  const seat = flag(args, '--seat', '-s'); const cwd = flag(args, '--cwd', '-C'); const name = flag(args, '--name', '-n');
  const ref = args.shift();
  if (!ref) fail('usage: cockpit resume <session-id|title> [--seat N] [--cwd D]');
  await createAndAttach({ resumeId: ref, seat, cwd: cwd ? path.resolve(cwd) : null, name, extra: [] }, ref);
}

async function cmdAttach(args) {
  const cfg = loadConfig(); const port = portOf(cfg);
  const ref = args.shift();
  if (!(await health(port))) fail('daemon is not running');
  let cs = ref;
  if (!cs) {
    const st = (await request(port, 'GET', '/api/state')).body;
    const live = st.sessions.filter(s => s.managed && s.alive && s.kind === 'claude');
    if (live.length === 1) cs = live[0].cs;
    else if (!live.length) fail('no running cockpit sessions');
    else fail(`several running sessions; name one: ${live.map(s => `${s.cs} (${s.name || s.cwd})`).join(', ')}`);
  }
  const r = await request(port, 'GET', `/api/sessions/${encodeURIComponent(cs)}`);
  if (r.status !== 200) fail(r.body?.error || 'no such session');
  if (!r.body.alive) fail(`session ${r.body.name || cs} is not running (${r.body.status}). Resume it with: cockpit resume ${r.body.sessionId}`);
  process.exit(await attach(port, r.body.cs, { label: r.body.name || '' }));
}

async function cmdStop(args) {
  const cfg = loadConfig(); const port = portOf(cfg);
  const ref = args.shift(); if (!ref) fail('usage: cockpit stop <session|name>');
  const r = await request(port, 'POST', `/api/sessions/${encodeURIComponent(ref)}/stop`, {});
  if (r.status !== 200) fail(r.body?.error || 'stop failed');
  out('stopped');
}

async function cmdStatusline(args) {
  const sub = args[0];
  const cfg = loadConfig(); const port = portOf(cfg);
  if (sub === 'install' || sub === 'uninstall') {
    let n = 0;
    for (const seat of cfg.seats) { const ok = sub === 'install' ? installStatusLine(seat, process.execPath, PKG_CLI) : uninstallStatusLine(seat); if (ok) n++; out(`${sub === 'install' ? 'installed' : 'removed'} status line for ${seat.name}`); }
    out(dim(`${sub}ed on ${n} seat(s). It shows the seat, 5-hour headroom and burn inside Claude Code's prompt.`));
    return;
  }
  // Renderer: Claude Code pipes session JSON on stdin and renders our stdout as the status line.
  let data = {}; try { data = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
  let st = null;
  try {
    const cacheFile = path.join(HOME, 'statusline-cache.json');
    const c = readJson(cacheFile, null);
    if (c && Date.now() - c.at < 3000) st = c.st;
    else if (await health(port)) { st = (await request(port, 'GET', '/api/state')).body; try { fs.writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), st })); } catch {} }
  } catch {}
  const dimc = s => `[2m${s}[0m`;
  if (!st) { process.stdout.write(dimc('⇄ cockpit offline')); return; }
  const cs = process.env.COCKPIT_SESSION;
  const cfgDir = process.env.CLAUDE_CONFIG_DIR;
  let seatName = null;
  if (cs) seatName = (st.sessions.find(x => x.cs === cs) || {}).seat;
  if (!seatName && cfgDir) seatName = (st.seats.find(x => x.configDir && path.resolve(x.configDir) === path.resolve(cfgDir)) || {}).name;
  if (!seatName) seatName = (st.seats.find(x => x.kind === 'base') || st.seats[0] || {}).name;
  const seat = st.seats.find(x => x.name === seatName);
  if (!seat) { process.stdout.write(dimc('⇄ cockpit')); return; }
  const u = seat.usage || {}; const fh = u.fiveHour || {};
  const pct = fh.pct == null ? '–' : fh.pct + '%';
  const col = fh.pct == null ? dimc(pct) : fh.pct >= 85 ? `[31m${pct}[0m` : fh.pct >= 60 ? `[33m${pct}[0m` : `[32m${pct}[0m`;
  const resetStr = (() => { if (!fh.resetsAt) return ''; const ms = new Date(fh.resetsAt).getTime() - Date.now(); if (ms <= 0) return dimc('reset'); const m = Math.round(ms / 60000); return dimc(m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m`); })();
  const parts = [`[1m⇄ ${seatName}[0m`, `5h ${col}${resetStr ? ' ' + resetStr : ''}`];
  if (seat.burn && seat.burn.rising && seat.burn.etaMin != null) parts.push(`[31m▲${seat.burn.etaMin >= 60 ? Math.floor(seat.burn.etaMin / 60) + 'h' + (seat.burn.etaMin % 60) + 'm' : seat.burn.etaMin + 'm'}[0m`);
  const mine = cs && st.sessions.find(x => x.cs === cs);
  if (mine && mine.status === 'handing_off') parts.push('[36m⇄ handing off…[0m');
  if (data.model && data.model.display_name) parts.push(dimc(data.model.display_name));
  process.stdout.write(parts.join(dimc(' · ')));
}

async function cmdUsage(args) {
  const cfg = loadConfig(); const port = portOf(cfg);
  const only = args.shift();
  if (!(await ensureDaemon(port))) fail(`daemon not running; see ${LOG_FILE}`);
  if (only) { const r = await request(port, 'POST', `/api/seats/${encodeURIComponent(only)}/probe`, {}); if (r.status !== 200) fail(r.body?.error || 'probe refused'); }
  else await request(port, 'POST', '/api/probe-all', {});
  process.stdout.write(dim(`checking ${only || 'all seats'}: Claude Code is opened briefly on each seat, asked for /usage, and closed. No prompt is sent.`) + '\n');
  const t0 = Date.now(); let st;
  while (Date.now() - t0 < 180000) { st = (await request(port, 'GET', '/api/state')).body; const busy = st.seats.filter(x => x.probe?.running || (!only && !x.probe && !x.disabled && x.usage?.loggedIn)); if (!st.probing && !busy.length) break; await new Promise(r => setTimeout(r, 1000)); }
  printSeats(loadConfig());
  for (const x of st.seats) if (x.probe?.lastResult && !x.probe.lastResult.ok) out(dim(`${x.name}: ${x.probe.lastResult.reason}`));
}

async function cmdHandoff(args) {
  const cfg = loadConfig();
  const port = portOf(cfg);
  const to = flag(args, '--to');
  const ref = args.shift();
  if (!(await health(port))) fail('daemon is not running');
  let target = ref;
  if (!target) {
    const st = (await request(port, 'GET', '/api/state')).body;
    const live = st.sessions.filter(s => s.managed && s.status !== 'ended');
    if (live.length === 1) target = live[0].cs;
    else if (!live.length) fail('no live cockpit sessions');
    else fail(`several live sessions; name one: ${live.map(s => `${s.cs} (${s.name || s.cwd})`).join(', ')}`);
  }
  const r = await request(port, 'POST', `/api/sessions/${target}/handoff`, { toSeat: to || null });
  if (r.status !== 200) fail(r.body?.error || 'handoff refused');
  out(r.body.queued ? `Handoff to ${bold(r.body.to)} queued; it happens when the current turn ends.` : `Handing off to ${bold(r.body.to)} now.`);
}

async function cmdDaemon(args) {
  const sub = args.shift() || 'status';
  const cfg = loadConfig();
  const port = portOf(cfg);
  if (sub === 'start') { out((await ensureDaemon(port)) ? `daemon up at http://127.0.0.1:${port}` : `failed; see ${LOG_FILE}`); return; }
  if (sub === 'stop') { out((await stopDaemon(port)) ? 'daemon stopped' : 'daemon was not running'); return; }
  if (sub === 'status') { const h = await health(port); out(h ? `up · pid ${h.pid} · port ${port} · version ${h.version}${launchAgentInstalled() ? ' · launchd agent installed' : ''}` : `down (port ${port})`); return; }
  if (sub === 'logs') { const n = Number(flag(args, '-n') || 60); const lines = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n') : []; out(lines.slice(-n).join('\n')); return; }
  if (sub === 'install') { const p = await installLaunchAgent(port); out(`launchd agent installed (${p}); the daemon now starts at login and restarts if it dies.`); return; }
  if (sub === 'uninstall') { await uninstallLaunchAgent(port); out(`launchd agent removed (${PLIST}).`); return; }
  fail('usage: cockpit daemon <start|stop|status|logs|install|uninstall>');
}

async function cmdConfig(args) {
  const cfg = loadConfig();
  const port = portOf(cfg);
  const sub = args.shift() || 'get';
  if (sub === 'get') { out(JSON.stringify({ port: cfg.port, pollSec: cfg.pollSec, handoff: cfg.handoff, notifications: cfg.notifications }, null, 2)); return; }
  if (sub === 'set') {
    const key = args.shift(), raw = args.shift();
    if (!key || raw === undefined) fail('usage: cockpit config set <handoff.mode|handoff.thresholdPct|handoff.minGainPct|handoff.hardPct|pollSec|notifications|port> <value>');
    const val = /^-?\d+$/.test(raw) ? Number(raw) : raw === 'true' ? true : raw === 'false' ? false : raw;
    if (key === 'handoff.mode' && !['auto', 'ask', 'off'].includes(val)) fail('handoff.mode must be auto, ask or off');
    const [a, b] = key.split('.');
    if (b) { if (!cfg[a] || typeof cfg[a] !== 'object') fail(`unknown key ${key}`); cfg[a][b] = val; } else cfg[a] = val;
    saveConfig(cfg);
    await notifyDaemonReload(port);
    out(`${key} = ${JSON.stringify(val)}`);
    return;
  }
  fail('usage: cockpit config <get|set>');
}

async function cmdHooks(args) {
  const sub = args.shift();
  const cfg = loadConfig();
  const port = portOf(cfg);
  if (sub === 'install') { for (const s of cfg.seats) { installHooks(s, port); out(`hooks installed for ${s.name}`); } return; }
  if (sub === 'uninstall') { for (const s of cfg.seats) out(`${uninstallHooks(s) ? 'hooks removed' : 'no hooks'} for ${s.name}`); return; }
  if (sub === 'status' || !sub) { for (const s of cfg.seats) out(`${s.name}: ${hooksInstalled(s, port) ? 'installed' : 'MISSING'}`); return; }
  fail('usage: cockpit hooks <status|install|uninstall>');
}

function help() {
  out(`${bold('claude-cockpit')} · one laptop, many Claude Code seats

  cockpit init [--name N] [--port P]      adopt the current ~/.claude login as the first seat, install hooks, start the daemon
  cockpit seat add <name> [--no-login]    create an isolated seat and log a teammate's account into it
  cockpit seat list | login | remove | sync
  cockpit start [--seat N] [--name S] [--cwd D] [-- claude flags]
                                          run Claude Code here on the freshest seat; cockpit hands the session to another seat when this one runs dry
  cockpit resume <session-id|title> [--seat N]
                                          resume any stored session, on any seat
  cockpit attach [session|name]           re-enter a running session (Ctrl-] detaches, it keeps running)
  cockpit stop <session|name>             end a running session
  cockpit status                          seats, usage, sessions
  cockpit usage [seat]                    refresh the 5-hour reading of every seat now (opens Claude briefly, sends no prompt)
  cockpit statusline install|uninstall    show seat + 5-hour headroom inside Claude Code's prompt
  cockpit handoff [session] [--to seat]   move a session to another seat now (or when its current turn ends)
  cockpit config get|set <key> <value>    handoff.mode auto|ask|off, handoff.thresholdPct, pollSec, notifications
  cockpit daemon start|stop|status|logs|install|uninstall
  cockpit hooks status|install|uninstall
  cockpit open                            open the dashboard`);
}

(async () => {
  try {
    switch (cmd) {
      case 'init': return await cmdInit(argv);
      case 'seat': case 'seats': return await cmdSeat(argv);
      case 'start': return await cmdStart(argv);
      case 'resume': return await cmdResume(argv);
      case 'attach': return await cmdAttach(argv);
      case 'stop': return await cmdStop(argv);
      case 'status': case 'st': case 'ls': return await cmdStatus();
      case 'handoff': return await cmdHandoff(argv);
      case 'usage': case 'check': return await cmdUsage(argv);
      case 'statusline': return await cmdStatusline(argv);
      case 'daemon': return await cmdDaemon(argv);
      case 'config': return await cmdConfig(argv);
      case 'hooks': return await cmdHooks(argv);
      case 'open': { const port = portOf(); await ensureDaemon(port); spawn('open', [`http://127.0.0.1:${port}`], { stdio: 'ignore', detached: true }).unref(); return out(`http://127.0.0.1:${port}`); }
      case undefined: case 'help': case '--help': case '-h': return help();
      default: fail(`unknown command "${cmd}"\n`), help();
    }
  } catch (e) { fail(e.message); }
})();
