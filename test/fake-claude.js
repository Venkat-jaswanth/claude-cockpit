#!/usr/bin/env node
// Stand-in for the real `claude` binary, used by test/e2e.js. It behaves like Claude
// Code in the ways cockpit cares about: it honours CLAUDE_CONFIG_DIR, keeps a
// transcript under <config>/projects, runs the hooks from settings.json through
// `sh -c` with JSON on stdin, answers `auth status --json` / `auth login`, and
// understands --session-id / --resume. Typed commands:
//   work [ms]   run a turn (UserPromptSubmit … Stop); prints a limit message instead if <config>/LIMIT exists
//   use <pct>   write a fake usage cache for this seat
//   /exit       end the session (SessionEnd hook)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const cfgDir = process.env.CLAUDE_CONFIG_DIR || process.env.COCKPIT_BASE_CLAUDE_DIR;
const claudeJson = process.env.CLAUDE_CONFIG_DIR ? path.join(cfgDir, '.claude.json') : process.env.COCKPIT_BASE_CLAUDE_JSON;
const seatLabel = path.basename(cfgDir);
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const writeJson = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

if (args[0] === 'auth') {
  const j = readJson(claudeJson);
  if (args[1] === 'status') {
    const a = j.oauthAccount;
    process.stdout.write(JSON.stringify(a ? { loggedIn: true, authMethod: 'claude.ai', email: a.emailAddress, orgName: a.organizationName, subscriptionType: 'team', configDirectory: cfgDir } : { loggedIn: false, authMethod: 'none', configDirectory: cfgDir }) + '\n');
    process.exit(0);
  }
  if (args[1] === 'login') {
    j.oauthAccount = { emailAddress: `${seatLabel}@example.com`, organizationName: 'Test Org' };
    writeJson(claudeJson, j);
    process.stdout.write(`[fake-claude] logged in ${seatLabel}\n`);
    process.exit(0);
  }
  process.exit(2);
}

// A trailing positional (not a flag, not a flag's value) is an initial/continuation prompt,
// like the real CLI's `claude --resume <id> "prompt"` which auto-runs it and stays interactive.
const FLAGS_WITH_VALUE = ['--session-id', '--resume', '-n', '--name', '--agent', '--model', '--permission-mode'];
function positionalPrompt() {
  for (let i = args.length - 1; i >= 0; i--) {
    const a = args[i];
    if (a.startsWith('-')) return null;
    if (i > 0 && FLAGS_WITH_VALUE.includes(args[i - 1])) return null;
    return a;
  }
  return null;
}
const initialPrompt = positionalPrompt();
// Print mode (-p): one headless message. Used by the "arm the window" feature. Replies and exits;
// like the real CLI it does NOT refresh the interactive usage cache (the follow-up probe does).
if (args.includes('-p') || args.includes('--print')) {
  const j = readJson(claudeJson);
  if (!j.oauthAccount) { process.stdout.write('Not logged in \u00b7 Please run /login\n'); process.exit(0); }
  if (fs.existsSync(path.join(cfgDir, 'LIMIT'))) { process.stdout.write('usage limit reached\n'); process.exit(0); }
  fs.writeFileSync(path.join(cfgDir, 'WINDOW_STARTED'), String(Date.now()));
  process.stdout.write('ok\n');
  process.exit(0);
}
const sessionId = flag('--session-id') || flag('--resume') || crypto.randomUUID();
const mode = flag('--resume') ? 'resume' : 'new';
const cwd = process.cwd();
const projDir = path.join(cfgDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(projDir, { recursive: true });
const transcript = path.join(projDir, `${sessionId}.jsonl`);
if (mode === 'resume' && !fs.existsSync(transcript)) { process.stdout.write(`No conversation found with session ID: ${sessionId}\r\n`); process.exit(1); }
fs.appendFileSync(transcript, JSON.stringify({ seat: seatLabel, mode, at: Date.now() }) + '\n');
const settings = readJson(path.join(cfgDir, 'settings.json'));

function hook(ev, extra = {}) {
  const payload = { session_id: sessionId, transcript_path: transcript, cwd, hook_event_name: ev, permission_mode: 'default', ...extra };
  for (const g of settings.hooks?.[ev] || []) for (const h of g.hooks || []) {
    if (h.type === 'command') spawnSync('sh', ['-c', h.command], { input: JSON.stringify(payload), env: process.env, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 });
  }
}
const out = s => process.stdout.write(s + '\r\n');
let trustPending = path.basename(cwd) === 'probe-cwd' && !(readJson(claudeJson).projects || {})[cwd]?.hasTrustDialogAccepted;
if (trustPending) out('Quick safety check: Is this a project you created or one you trust?\r\n❯ No, exit\r\n  Yes, I trust this folder');
else { out(`[fake-claude] seat=${seatLabel} session=${sessionId} mode=${mode}`); hook('SessionStart', { source: mode === 'resume' ? 'resume' : 'startup' }); if (initialPrompt) setTimeout(() => handle(initialPrompt), 150); }
let trustCursor = 0;

function setUsage(pct) {
  const j = readJson(claudeJson);
  j.oauthAccount = j.oauthAccount || { emailAddress: `${seatLabel}@example.com`, organizationName: 'Test Org' };
  const started = fs.existsSync(path.join(cfgDir, 'WINDOW_STARTED'));
  const resets = new Date(Date.now() + (started ? 5 : 2) * 3600e3).toISOString();
  j.cachedUsageUtilization = { fetchedAtMs: Date.now(), utilization: {
    five_hour: { utilization: pct, resets_at: resets },
    limits: [
      { kind: 'session', group: 'session', percent: pct, severity: 'normal', resets_at: resets, is_active: true },
      { kind: 'weekly_scoped', group: 'weekly', percent: 10, severity: 'normal', resets_at: resets, scope: { model: { display_name: 'Fable' } }, is_active: false },
    ] } };
  writeJson(claudeJson, j);
}

let line = '';
let turnsDone = Number(process.env.FAKE_TURNS_DONE || 0);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', chunk => {
  let text = chunk.toString().replace(/\x1b\[20[01]~/g, '');
  if (trustPending) {
    if (text.includes('\x1b[B')) trustCursor = 1;
    if (text.includes('\r')) { if (trustCursor === 1) { trustPending = false; out(`[fake-claude] trusted; seat=${seatLabel} session=${sessionId} mode=${mode}`); hook('SessionStart', { source: 'startup' }); if (initialPrompt) setTimeout(() => handle(initialPrompt), 150); } else { out('[fake-claude] not trusted, exiting'); process.exit(1); } }
    return;
  }
  for (const ch of text) {
    if (ch === '\r' || ch === '\n') { const l = line.trim(); line = ''; handle(l); }
    else if (ch === '\x15') line = '';
    else if (ch === '\x03') { out('[fake-claude] ^C'); line = ''; }
    else if (ch === '\x7f') line = line.slice(0, -1);
    else if (ch >= ' ') line += ch;
  }
});
function runTurn(promptText, ms) {
  hook('UserPromptSubmit', { prompt: promptText });
  fs.appendFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: promptText }, cwd, timestamp: new Date().toISOString(), uuid: crypto.randomUUID(), sessionId }) + '\n' + JSON.stringify({ type: 'ai-title', aiTitle: 'Fake session title', sessionId }) + '\n');
  if (fs.existsSync(path.join(cfgDir, 'LIMIT'))) { out("You've hit your limit · resets 3pm"); return; }
  out(`[fake-claude] working ${ms}ms…`);
  setTimeout(() => {
    const id = 'msg_' + crypto.randomUUID().slice(0, 8);
    const usage = { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 1000, output_tokens: 50 };
    for (let i = 0; i < 2; i++) fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { id, model: 'claude-fake-1', usage }, requestId: 'req_' + id, sessionId, timestamp: new Date().toISOString() }) + '\n');
    turnsDone++;
    fs.appendFileSync(transcript, JSON.stringify({ type: 'cost-state', sessionId, totalCostUSD: 0.01 * turnsDone, modelUsage: { 'claude-fake-1': { inputTokens: 10 * turnsDone, outputTokens: 50 * turnsDone, cacheReadInputTokens: 1000 * turnsDone, cacheCreationInputTokens: 200 * turnsDone, costUSD: 0.01 * turnsDone } } }) + '\n');
    out('[fake-claude] done'); hook('Stop', { last_assistant_message: 'done', stop_hook_active: false });
  }, ms);
}
function handle(l) {
  if (!l) return;
  if (l === '/exit') { out('[fake-claude] bye'); hook('SessionEnd', { reason: 'prompt_input_exit' }); process.exit(0); }
  let m;
  if ((m = l.match(/^use (\d+)$/))) { setUsage(Number(m[1])); out(`[fake-claude] usage for ${seatLabel} set to ${m[1]}%`); return; }
  if (l === '/usage') { const cur = readJson(claudeJson).cachedUsageUtilization?.utilization?.five_hour?.utilization; setUsage(cur ?? 42); out('[fake-claude] ███ usage refreshed · Esc to close'); return; }
  if ((m = l.match(/^work(?: (\d+))?$/))) { runTurn(l, Number(m[1] || 400)); return; }
  // Any other text (e.g. a continuation prompt passed on resume) is a normal turn.
  out(`[fake-claude] prompt: ${l}`); runTurn(l, 400);
}
