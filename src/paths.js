// Filesystem layout. Every path cockpit reads or writes resolves from here, so the whole
// app can be relocated with one env var: COCKPIT_HOME moves the state dir (config, state,
// ledger, per-seat profiles, logs) and the tests point it at a throwaway directory.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOME = process.env.COCKPIT_HOME || path.join(os.homedir(), '.claude-cockpit');
export const CONFIG_FILE = path.join(HOME, 'config.json');
export const STATE_FILE = path.join(HOME, 'state.json');
export const PROFILES_DIR = path.join(HOME, 'profiles');
export const BACKUPS_DIR = path.join(HOME, 'backups');
export const LOG_FILE = path.join(HOME, 'daemon.log');
export const PID_FILE = path.join(HOME, 'daemon.pid');
export const BASE_CLAUDE_DIR = process.env.COCKPIT_BASE_CLAUDE_DIR || path.join(os.homedir(), '.claude');
export const BASE_CLAUDE_JSON = process.env.COCKPIT_BASE_CLAUDE_JSON || path.join(os.homedir(), '.claude.json');
export const CLAUDE_BIN = process.env.COCKPIT_CLAUDE_BIN || 'claude';
export const WEB_DIR = path.join(PKG_ROOT, 'web');

export function ensureHome() {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
