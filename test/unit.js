// Fast unit tests for pure logic, no daemon required. Run via `npm test` (before the e2e suite).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readUsage, STALE_MIN } from '../src/usage.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-unit-'));
const now = Date.now();
const iso = ms => new Date(ms).toISOString();
function seatWith(cached) {
  const p = path.join(dir, `claude-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({ oauthAccount: { emailAddress: 'x@e.dev' }, cachedUsageUtilization: cached }));
  return { name: 'x', claudeJson: p };
}

console.log('usage: a window that already rolled over is an assumed reset, treated as stale');
{
  const u = readUsage(seatWith({ fetchedAtMs: now, utilization: { five_hour: { utilization: 50, resets_at: iso(now - 60000) } } }), now);
  ok(u.fiveHour.assumedReset === true, 'assumedReset is true when resets_at is in the past');
  ok(u.fiveHour.pct === 0, 'pct is reset to 0');
  ok(u.stale === true, 'an assumed reset reads as stale, so a real limit error is never overruled');
}

console.log('usage: a fresh future-window reading is authoritative');
{
  const u = readUsage(seatWith({ fetchedAtMs: now, utilization: { five_hour: { utilization: 42, resets_at: iso(now + 3600e3) } } }), now);
  ok(u.fiveHour.pct === 42 && u.fiveHour.assumedReset === false, 'pct is kept and it is not an assumed reset');
  ok(u.stale === false, 'a recent reading is not stale');
}

console.log('usage: a reading older than the staleness window is stale');
{
  const u = readUsage(seatWith({ fetchedAtMs: now - (STALE_MIN + 5) * 60000, utilization: { five_hour: { utilization: 20, resets_at: iso(now + 3600e3) } } }), now);
  ok(u.stale === true, `a reading older than ${STALE_MIN} min is stale`);
}

console.log('usage: no cached utilization means unknown and stale');
{
  const u = readUsage(seatWith({}), now);
  ok(u.known === false && u.stale === true, 'no utilization gives known=false, stale=true');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n${fail} unit check(s) FAILED` : `\nall ${pass} unit checks passed`);
process.exit(fail ? 1 : 0);
