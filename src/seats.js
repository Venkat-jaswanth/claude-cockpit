// Seats: one isolated account per CLAUDE_CONFIG_DIR. This module creates a seat's profile
// directory, shares the right slices of ~/.claude into it via symlinks (SHARED_ENTRIES),
// installs/removes the daemon's hooks in the seat's settings.json, and pre-trusts folders so
// handoffs don't stall on Claude Code's trust prompt. Credentials and usage stay private to
// each seat; conversations, memory, plugins and skills are shared.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PROFILES_DIR, BASE_CLAUDE_DIR, BASE_CLAUDE_JSON, BACKUPS_DIR, CLAUDE_BIN, HOME, readJson, writeJson } from './paths.js';

export const PROBE_CWD = path.join(HOME, 'probe-cwd');

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd'];
// Entries of ~/.claude that every seat should share on one laptop: sessions, memory,
// plugins, skills, history. Everything else (credentials, .claude.json, settings,
// per-process state) stays private to the seat's own config directory.
export const SHARED_ENTRIES = ['projects', 'plugins', 'skills', 'commands', 'agents', 'keybindings.json', 'history.jsonl', 'file-history', 'plans', 'paste-cache', 'session-env', 'shell-snapshots', 'todos', 'CLAUDE.md'];
const MARK = '# claude-cockpit';

export function hookCommand(port, ev) {
  const timeout = ev === 'SessionEnd' ? 1 : 2;
  return `curl -s -m ${timeout} -X POST "http://127.0.0.1:${port}/hook/${ev}?cs=\${COCKPIT_SESSION:-}&cfg=\${CLAUDE_CONFIG_DIR:-}" -H "content-type: application/json" --data-binary @- >/dev/null 2>&1; true ${MARK}`;
}

export function claudeEnv(seat, extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
  if (seat.kind === 'base') delete env.CLAUDE_CONFIG_DIR; else env.CLAUDE_CONFIG_DIR = seat.configDir;
  return { ...env, ...extra };
}

export function seatByName(cfg, name) {
  return cfg.seats.find(s => s.name === name) || null;
}

export function settingsPath(seat) { return path.join(seat.configDir, 'settings.json'); }

function isCockpitGroup(g) {
  return (g.hooks || []).some(h => typeof h.command === 'string' && h.command.includes(MARK));
}

export function installHooks(seat, port) {
  const file = settingsPath(seat);
  const s = readJson(file, {}) || {};
  if (fs.existsSync(file)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    fs.copyFileSync(file, path.join(BACKUPS_DIR, `${seat.name}-settings-${Date.now()}.json`));
  }
  s.hooks = s.hooks && typeof s.hooks === 'object' ? s.hooks : {};
  for (const ev of HOOK_EVENTS) {
    const groups = (Array.isArray(s.hooks[ev]) ? s.hooks[ev] : []).filter(g => !isCockpitGroup(g));
    groups.push({ hooks: [{ type: 'command', command: hookCommand(port, ev), timeout: 5 }] });
    s.hooks[ev] = groups;
  }
  writeJson(file, s);
}

export function uninstallHooks(seat) {
  const file = settingsPath(seat);
  const s = readJson(file, null);
  if (!s?.hooks) return false;
  let changed = false;
  for (const ev of Object.keys(s.hooks)) {
    const before = s.hooks[ev];
    if (!Array.isArray(before)) continue;
    const after = before.filter(g => !isCockpitGroup(g));
    if (after.length !== before.length) { changed = true; if (after.length) s.hooks[ev] = after; else delete s.hooks[ev]; }
  }
  if (!Object.keys(s.hooks).length) delete s.hooks;
  if (changed) writeJson(file, s);
  return changed;
}

export function hooksInstalled(seat, port) {
  const s = readJson(settingsPath(seat), null);
  if (!s?.hooks) return false;
  return HOOK_EVENTS.every(ev => (s.hooks[ev] || []).some(g => (g.hooks || []).some(h => typeof h.command === 'string' && h.command.includes(MARK) && h.command.includes(`:${port}/`))));
}

const isCockpitStatusLine = cmd => typeof cmd === 'string' && /cockpit/i.test(cmd) && /\bstatusline\b\s*$/.test(cmd.trim());
export function installStatusLine(seat, nodePath, cliPath) {
  const file = settingsPath(seat);
  const sObj = readJson(file, {}) || {};
  const existing = sObj.statusLine;
  // Don't clobber a user's own status line; only install ours or replace a previous cockpit one.
  if (existing && existing.command && !isCockpitStatusLine(existing.command)) return false;
  sObj.statusLine = { type: 'command', command: `"${nodePath}" "${cliPath}" statusline`, padding: 0 };
  writeJson(file, sObj);
  return true;
}
export function uninstallStatusLine(seat) {
  const file = settingsPath(seat);
  const sObj = readJson(file, null);
  if (sObj && sObj.statusLine && isCockpitStatusLine(sObj.statusLine.command)) { delete sObj.statusLine; writeJson(file, sObj); return true; }
  return false;
}

export function seedProfile(seat) {
  fs.mkdirSync(seat.configDir, { recursive: true });
  const linked = [];
  for (const name of SHARED_ENTRIES) {
    const src = path.join(BASE_CLAUDE_DIR, name);
    const dst = path.join(seat.configDir, name);
    if (!fs.existsSync(src)) continue;
    try { fs.lstatSync(dst); continue; } catch {}
    fs.symlinkSync(src, dst);
    linked.push(name);
  }
  const dstSettings = path.join(seat.configDir, 'settings.json');
  if (!fs.existsSync(dstSettings)) {
    const base = readJson(path.join(BASE_CLAUDE_DIR, 'settings.json'), {}) || {};
    writeJson(dstSettings, base);
  }
  if (!fs.existsSync(seat.claudeJson)) {
    const base = readJson(BASE_CLAUDE_JSON, {}) || {};
    const seed = { hasCompletedOnboarding: true };
    for (const k of ['projects', 'mcpServers', 'lastOnboardingVersion', 'shiftEnterKeyBindingInstalled', 'optionAsMetaKeyInstalled', 'hasIdeOnboardingBeenShown', 'hasSeenTasksHint']) {
      if (base[k] !== undefined) seed[k] = base[k];
    }
    seed.projects = { ...(seed.projects || {}), [PROBE_CWD]: { ...((seed.projects || {})[PROBE_CWD] || {}), hasTrustDialogAccepted: true } };
    writeJson(seat.claudeJson, seed);
  }
  return linked;
}

// Pre-trust a folder in a seat's own .claude.json so Claude Code does not show its
// "Is this a project you trust?" dialog when a session starts or is handed to this seat.
// The user chose this folder in cockpit, so it is trusted on every seat cockpit runs it on.
export function ensureTrusted(seat, cwd) {
  if (!cwd) return false;
  const j = readJson(seat.claudeJson, {}) || {};
  j.projects = j.projects && typeof j.projects === 'object' ? j.projects : {};
  const cur = j.projects[cwd] || {};
  if (cur.hasTrustDialogAccepted === true) return false;
  j.projects[cwd] = { ...cur, hasTrustDialogAccepted: true };
  writeJson(seat.claudeJson, j);
  return true;
}

export function makeProfileSeat(name) {
  const dir = path.join(PROFILES_DIR, name);
  return { name, kind: 'profile', configDir: dir, claudeJson: path.join(dir, '.claude.json'), addedAt: Date.now(), disabled: false };
}

export function makeBaseSeat(name) {
  return { name, kind: 'base', configDir: BASE_CLAUDE_DIR, claudeJson: BASE_CLAUDE_JSON, addedAt: Date.now(), disabled: false };
}

export function refreshIdentity(seat) {
  const r = spawnSync(CLAUDE_BIN, ['auth', 'status', '--json'], { env: claudeEnv(seat), encoding: 'utf8', timeout: 30000 });
  try {
    const j = JSON.parse(String(r.stdout || '').trim());
    return { loggedIn: !!j.loggedIn, email: j.email || null, org: j.orgName || null, plan: j.subscriptionType || null };
  } catch { return null; }
}

export function login(seat) {
  const r = spawnSync(CLAUDE_BIN, ['auth', 'login'], { env: claudeEnv(seat), stdio: 'inherit' });
  return r.status === 0;
}
