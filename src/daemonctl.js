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
  for (let i = 0; i < 30; i++) { await sleep(200); if (await health(port)) return true; }
  return false;
}

export async function stopDaemon(port) {
  let stopped = false;
  try { await request(port, 'POST', '/api/shutdown'); stopped = true; } catch {}
  const pid = Number(fs.existsSync(PID_FILE) ? fs.readFileSync(PID_FILE, 'utf8') : 0);
  if (pid) { try { process.kill(pid, 'SIGTERM'); stopped = true; } catch {} }
  for (let i = 0; i < 20; i++) { await sleep(150); if (!(await health(port))) return stopped; }
  return stopped;
}

export function plistXml(port) {
  const claudeDir = (() => { const r = spawnSync('sh', ['-lc', 'command -v claude'], { encoding: 'utf8' }); return r.stdout ? path.dirname(r.stdout.trim()) : ''; })();
  const PATH = [claudeDir, path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${DAEMON_JS}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${PATH}</string>
    <key>COCKPIT_PORT</key><string>${port}</string>
    <key>HOME</key><string>${os.homedir()}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_FILE}</string>
  <key>StandardErrorPath</key><string>${LOG_FILE}</string>
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
