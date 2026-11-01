// Daemon lifecycle (macOS): start it in the background, stop it, and optionally install a
// launchd agent so it survives logout and relaunches if it dies. This is the one file that
// hard-codes macOS; a Linux port would swap the launchd plist for a systemd user unit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { PKG_ROOT, LOG_FILE, PID_FILE, HOME, readJson, sleep } from './paths.js';
import { request, health } from './client.js';

const DAEMON_JS = path.join(PKG_ROOT, 'src', 'daemon.js');
const LABEL = 'com.claude-cockpit.daemon';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

export async function ensureDaemon(port) {
  if (await health(port)) return true;
  fs.mkdirSync(HOME, { recursive: true });
  const out = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [DAEMON_JS], {
    detached: true, stdio: ['ignore', out, out],
    env: { ...process.env, COCKPIT_PORT: String(port) },
  });
  child.unref();
  try { fs.closeSync(out); } catch {} // the child inherited the fd; the parent does not need it
  for (let i = 0; i < 30; i++) { await sleep(200); if (await health(port)) return true; }
  return false;
}

export async function stopDaemon(port) {
  if (!(await health(port))) return true;               // already down; don't signal a possibly-stale pid
  try { await request(port, 'POST', '/api/shutdown'); } catch {}
  for (let i = 0; i < 20; i++) { await sleep(150); if (!(await health(port))) return true; }
  // Still up: fall back to SIGTERM. Health was just up, so the recorded pid is almost certainly the
  // live daemon (it writes PID_FILE with its own pid on listen), not a recycled stale one.
  const pid = Number(fs.existsSync(PID_FILE) ? fs.readFileSync(PID_FILE, 'utf8') : 0);
  if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  for (let i = 0; i < 20; i++) { await sleep(150); if (!(await health(port))) return true; }
  return !(await health(port));                          // report the real final state, not "an action was attempted"
}

export function plistXml(port) {
  const claudeDir = (() => { const r = spawnSync('sh', ['-lc', 'command -v claude'], { encoding: 'utf8' }); return r.stdout ? path.dirname(r.stdout.trim()) : ''; })();
  const PATH = [claudeDir, path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':');
  // XML-escape every interpolated value so a path containing & < or > cannot produce a malformed plist.
  const xe = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Carry the COCKPIT_* relocation overrides into the launchd daemon, so a CLI run with (say)
  // COCKPIT_HOME set does not diverge from the daemon's state directory.
  const extraEnv = ['COCKPIT_HOME', 'COCKPIT_BASE_CLAUDE_DIR', 'COCKPIT_BASE_CLAUDE_JSON', 'COCKPIT_CLAUDE_BIN']
    .filter(k => process.env[k]).map(k => `    <key>${k}</key><string>${xe(process.env[k])}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xe(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xe(process.execPath)}</string>
    <string>${xe(DAEMON_JS)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xe(PATH)}</string>
    <key>COCKPIT_PORT</key><string>${xe(port)}</string>
    <key>HOME</key><string>${xe(os.homedir())}</string>${extraEnv ? '\n' + extraEnv : ''}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xe(LOG_FILE)}</string>
  <key>StandardErrorPath</key><string>${xe(LOG_FILE)}</string>
</dict>
</plist>
`;
}

export async function installLaunchAgent(port) {
  if (process.platform !== 'darwin') throw new Error('launchd install is macOS only');
  await stopDaemon(port);
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.writeFileSync(PLIST, plistXml(port));
  const uid = os.userInfo().uid;
  spawnSync('launchctl', ['bootout', `gui/${uid}`, PLIST], { stdio: 'ignore' });
  const r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, PLIST], { encoding: 'utf8' });
  if (r.status !== 0) {
    const r2 = spawnSync('launchctl', ['load', '-w', PLIST], { encoding: 'utf8' });
    if (r2.status !== 0) throw new Error(`launchctl failed: ${r.stderr || r2.stderr}`);
  }
  for (let i = 0; i < 30; i++) { await sleep(200); if (await health(port)) return PLIST; }
  throw new Error(`daemon did not come up; see ${LOG_FILE}`);
}

export async function uninstallLaunchAgent(port) {
  const uid = os.userInfo().uid;
  spawnSync('launchctl', ['bootout', `gui/${uid}`, PLIST], { stdio: 'ignore' });
  spawnSync('launchctl', ['unload', '-w', PLIST], { stdio: 'ignore' });
  if (fs.existsSync(PLIST)) fs.unlinkSync(PLIST);
  await stopDaemon(port);
  return PLIST;
}

export function launchAgentInstalled() { return fs.existsSync(PLIST); }
export { PLIST, LABEL };
