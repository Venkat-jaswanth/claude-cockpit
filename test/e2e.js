#!/usr/bin/env node
// End-to-end test: real CLI, daemon, hooks, PTY sessions, WebSocket attach, library and
// seat APIs, with test/fake-claude.js standing in for Claude Code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pty = require('node-pty');
const CLI = path.join(ROOT, 'bin', 'cockpit.js');
const PORT = Number(process.env.E2E_PORT || 7449);
// realpathSync canonicalizes the temp dir: on macOS os.tmpdir() is /var/folders/… which is a
// symlink to /private/var/folders/…, and child processes resolve their cwd to the /private form.
// Without this, `stored.cwd === proj` and the projects check compare /var against /private and fail.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(process.env.E2E_TMP || os.tmpdir(), 'cockpit-e2e-')));
const base = path.join(tmp, 'dot-claude');
const baseJson = path.join(tmp, 'dot-claude.json');
const proj = path.join(tmp, 'project');
fs.mkdirSync(path.join(base, 'projects'), { recursive: true });
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(base, 'settings.json'), JSON.stringify({ theme: 'dark' }, null, 2));
fs.writeFileSync(baseJson, JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com', organizationName: 'Test Org' }, projects: { [proj]: { hasTrustDialogAccepted: true } } }, null, 2));

const env = { ...process.env, COCKPIT_HOME: path.join(tmp, 'home'), COCKPIT_BASE_CLAUDE_DIR: base, COCKPIT_BASE_CLAUDE_JSON: baseJson, COCKPIT_CLAUDE_BIN: path.join(ROOT, 'test', 'fake-claude.js'), COCKPIT_PORT: String(PORT), COCKPIT_NO_NOTIFY: '1', COCKPIT_RESEND_DELAY_MS: '300', COCKPIT_OUTSIDE_STALE_MS: '1500' };
for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_CONFIG_DIR') delete env[k];

const strip = s => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
function setSeatUsage(claudeJsonPath, pct) {
  const j = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
  const resets = new Date(Date.now() + 2 * 3600e3).toISOString();
  j.cachedUsageUtilization = { fetchedAtMs: Date.now(), utilization: { five_hour: { utilization: pct, resets_at: resets }, limits: [{ kind: 'session', group: 'session', percent: pct, severity: 'normal', resets_at: resets, is_active: true }] } };
  fs.writeFileSync(claudeJsonPath, JSON.stringify(j, null, 2));
}
let failures = 0;
function check(cond, msg) { if (cond) console.log(`  ok   ${msg}`); else { failures++; console.log(`  FAIL ${msg}`); } }
function cli(...a) { const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'cockpit.js'), ...a], { env, encoding: 'utf8', cwd: proj }); return { code: r.status, out: strip((r.stdout || '') + (r.stderr || '')) }; }
async function api(method, p, body, headers = {}) { const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; }
const st = async () => (await api('GET', '/api/state')).body;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function term(args) {
  const t = pty.spawn(process.execPath, [path.join(ROOT, 'bin', 'cockpit.js'), ...args], { name: 'xterm-256color', cols: 100, rows: 30, cwd: proj, env });
  const h = { t, out: '', exited: null, m: 0 };
  t.onData(d => { h.out += strip(d); });
  t.onExit(e => { h.exited = e.exitCode; });
  h.mark = () => { h.m = h.out.length; };
  h.waitFor = async (re, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (re.test(h.out.slice(h.m))) return true; await sleep(100); } return false; };
  h.waitExit = async (ms = 8000) => { const t0 = Date.now(); while (h.exited === null && Date.now() - t0 < ms) await sleep(100); return h.exited; };
  h.write = s => t.write(s);
  return h;
}

try {
  console.log('setup');
  let r = cli('init', '--name', 'a');
  check(r.code === 0 && /Adopted your current login as seat/.test(r.out) && /a@example.com/.test(r.out), `cockpit init adopts base seat`);
  check(JSON.parse(fs.readFileSync(path.join(base, 'settings.json'), 'utf8')).hooks?.Stop?.length === 1, 'hooks installed into base settings.json');
  r = cli('seat', 'add', 'b', '--no-login');
  check(r.code === 0 && /Created seat b/.test(r.out), 'seat add b creates a profile');
  const profB = path.join(tmp, 'home', 'profiles', 'b');
  check(fs.lstatSync(path.join(profB, 'projects')).isSymbolicLink(), 'profile b shares the projects directory');
  check(JSON.parse(fs.readFileSync(path.join(profB, '.claude.json'), 'utf8')).projects?.[proj]?.hasTrustDialogAccepted === true, 'profile b inherits trusted folders');
  r = cli('seat', 'login', 'b');
  check(r.code === 0 && /logged in as b@example.com/.test(r.out), 'seat login b records identity');
  check(cli('config', 'set', 'handoff.mode', 'auto').code === 0, 'config set works');
  cli('config', 'set', 'pollSec', '10'); cli('config', 'set', 'handoff.autoContinue', 'false'); await api('POST', '/api/reload');
  check((await api('GET', '/api/state', null, { origin: 'http://evil.example' })).status === 403, 'requests from a foreign origin are refused');

  console.log('session on seat a');
  const a = term(['start', '--name', 'e2e']);
  check(await a.waitFor(/seat=dot-claude session=([0-9a-f-]{36}) mode=new/), 'claude started on seat a with a pre-assigned session id');
  check(/cockpit · e2e on seat a · Ctrl-\] detaches/.test(a.out), 'attach banner shown');
  const sessionId = a.out.match(/session=([0-9a-f-]{36})/)[1];
  await sleep(500);
  let s = (await st()).sessions.find(x => x.managed && x.kind === 'claude');
  check(s && s.seat === 'a' && s.status === 'idle' && s.sessionId === sessionId && s.alive && s.viewers === 1, 'daemon: session idle on a, alive, one viewer');
  a.mark(); a.write('work\r');
  check(await a.waitFor(/\[fake-claude\] done/), 'a turn completes');
  await sleep(400);
  s = (await st()).sessions.find(x => x.cs === s.cs);
  check(s.turns === 1 && s.status === 'idle' && s.lastPrompt === 'work', 'turn counted, prompt recorded, idle again');

  console.log('automatic handoff at threshold');
  a.mark(); a.write('use 95\r');
  check(await a.waitFor(/usage for dot-claude set to 95%/), 'seat a usage pushed to 95%');
  a.mark(); a.write('work\r');
  check(await a.waitFor(/cockpit: a → b/), 'handoff banner shown in the attached terminal');
  check(await a.waitFor(new RegExp(`seat=b session=${sessionId} mode=resume`)), 'same session resumed on seat b');
  await sleep(600);
  let full = await st(); s = full.sessions.find(x => x.cs === s.cs);
  check(s.seat === 'b' && s.status === 'idle' && s.handoffs.length === 1 && s.handoffs[0].from === 'a' && s.handoffs[0].to === 'b', 'daemon state: on b, idle, one handoff a→b');
  check(s.handoff && s.handoff.inProgress === false && s.handoff.phase === 'done', 'handoff marked complete after SessionStart(resume)');
  check(full.seats.find(x => x.name === 'a').usage.fiveHour.pct === 95, 'seat a shows 95% in state');

  console.log('dedupe: resuming an already-running conversation returns the live one, not a 2nd process');
  const before = (await st()).sessions.filter(x => x.alive && x.managed && x.sessionId === sessionId).length;
  const dup = (await api('POST', '/api/sessions', { resumeId: sessionId })).body;
  check(dup && dup.existing === true && dup.cs === s.cs, 'POST /api/sessions for a live conversation returns the existing wrapper, not a new one');
  await sleep(600);
  const after = (await st()).sessions.filter(x => x.alive && x.managed && x.sessionId === sessionId).length;
  check(before === 1 && after === 1, `exactly one live process for the transcript before and after (${before} -> ${after})`);

  console.log('pages and library');
  check(/Claude Cockpit/.test(await (await fetch(`http://127.0.0.1:${PORT}/`)).text()), 'dashboard page served');
  check(/xterm/.test(await (await fetch(`http://127.0.0.1:${PORT}/s/${s.cs}`)).text()), 'terminal page served');
  check((await fetch(`http://127.0.0.1:${PORT}/vendor/xterm.js`)).status === 200, 'xterm.js vendored');
  const lib = (await api('GET', '/api/library')).body.sessions;
  const stored = lib.find(x => x.sessionId === sessionId);
  check(stored && stored.title === 'Fake session title' && stored.cwd === proj && stored.firstPrompt === 'work', 'library lists the session with its title, folder and first prompt');
  check((await api('GET', '/api/projects')).body.projects.some(p => p.cwd === proj), 'recent projects include the test folder');
  check(stored.tokens && stored.tokens.output === 100 && stored.costUSD === 0.02, 'library carries per-session tokens and cost from cost-state');
  const usage = (await api('GET', '/api/usage')).body;
  check(usage.today.total.turns === 2 && usage.today.total.output === 100 && usage.today.total.input === 20 && usage.today.total.cacheRead === 2000, 'ledger counted two turns with deduplicated assistant usage');
  check(usage.today.seats.a?.output === 100 && !usage.today.seats.b, 'both turns attributed to seat a (the handoff came after the second Stop)');
  check(Math.abs(usage.today.total.cost - 0.02) < 1e-9, 'cost deltas from cost-state add up');
  check(usage.byDay.length === 14 && usage.topSessions[0]?.cs === s.cs, 'daily series and top sessions present');

  console.log('hard limit mid-turn with prompt resend (ask mode)');
  cli('config', 'set', 'handoff.mode', 'ask'); await api('POST', '/api/reload');
  fs.writeFileSync(path.join(profB, 'LIMIT'), '1');
  a.mark(); a.write('work\r');
  check(await a.waitFor(/hit your limit/), 'fake printed the limit message');
  check(await a.waitFor(/cockpit: b → a/), 'output watcher triggered a hard handoff');
  check(await a.waitFor(new RegExp(`seat=dot-claude session=${sessionId} mode=resume`)), 'session resumed on seat a');
  a.mark();
  check(await a.waitFor(/\[fake-claude\] working/, 8000), 'interrupted prompt was re-sent on seat a');
  check(await a.waitFor(/\[fake-claude\] done/, 8000), 'and completed');
  await sleep(600);
  full = await st(); s = full.sessions.find(x => x.cs === s.cs);
  check(s.seat === 'a' && s.handoffs.length === 2 && s.handoffs[1].trigger === 'terminal output', 'second handoff recorded with its trigger');
  check(full.events.some(e => e.type === 'recommend'), 'ask mode only recommends the next soft handoff');
  check(s.status === 'idle', 'session idle after the resent turn');

  console.log('manual handoff while busy is queued, then runs');
  fs.unlinkSync(path.join(profB, 'LIMIT'));
  a.mark(); a.write('work 2500\r');
  check(await a.waitFor(/working 2500ms/), 'long turn started');
  r = cli('handoff', '--to', 'b');
  check(/queued/.test(r.out), 'cockpit handoff while busy is queued');
  a.mark();
  check(await a.waitFor(/cockpit: a → b/, 8000), 'queued handoff ran when the turn ended');
  check(await a.waitFor(new RegExp(`seat=b session=${sessionId} mode=resume`)), 'session back on b');
  await sleep(400);
  r = cli('status');
  check(/e2e/.test(r.out) && /\bb\b/.test(r.out), 'cockpit status lists the session');
  const usage2 = (await api('GET', '/api/usage')).body;
  check(usage2.today.total.turns === 4 && usage2.today.seats.a?.turns === 4 && !usage2.today.seats.b, 'four turns so far, all run on seat a');

  console.log('auto-continue: a between-turns handoff keeps the work going with no user input');
  // session is on seat b now. Make b nearly full and a fresh so a soft handoff fires at the next Stop.
  cli('config', 'set', 'handoff.mode', 'auto'); cli('config', 'set', 'handoff.autoContinue', 'true'); await api('POST', '/api/reload');
  setSeatUsage(path.join(profB, '.claude.json'), 90); setSeatUsage(baseJson, 5); await api('POST', '/api/reload');
  const acBefore = (await st()).sessions.find(x => x.cs === s.cs).turns;
  a.mark(); a.write('work\r');  // completes a turn on b, then daemon hands off b -> a at Stop
  check(await a.waitFor(/cockpit: b → a/, 12000), 'between-turns handoff b -> a fired automatically');
  check(await a.waitFor(new RegExp(`seat=dot-claude session=${sessionId} mode=resume`), 8000), 'resumed on seat a');
  check(await a.waitFor(/\[fake-claude\] prompt: Please continue/, 10000), 'the continuation prompt auto-ran on resume, no user input needed');
  let acOk = false; const tAc = Date.now();
  while (Date.now() - tAc < 10000) { const cur = (await st()).sessions.find(x => x.cs === s.cs); if (cur.seat === 'a' && cur.turns >= acBefore + 2) { acOk = true; break; } await sleep(300); }
  check(acOk, `handoff ran the work turn and then auto-continued (turns ${acBefore} -> ${acBefore + 2})`);
  cli('config', 'set', 'handoff.mode', 'off'); await api('POST', '/api/reload'); // settle before detach test

  console.log('detach and reattach');
  a.mark(); a.write('\x1d');
  check((await a.waitExit()) === 0 && /detached from e2e/.test(a.out), 'Ctrl-] detaches with a hint');
  await sleep(400);
  s = (await st()).sessions.find(x => x.cs === s.cs);
  check(s.alive && s.viewers === 0, 'session keeps running with no viewers');
  const b = term(['attach', 'e2e']);
  check(await b.waitFor(/cockpit · e2e on seat [ab]\b/), 'reattached by name');
  check(/\[fake-claude\] seat=(b|dot-claude)/.test(b.out), 'scrollback replayed on attach');
  await sleep(300);
  b.mark(); b.write('/exit\r');
  check((await b.waitExit()) === 0 && /session e2e ended/.test(b.out), 'exit from the reattached terminal ends cleanly');
  await sleep(400);
  s = (await st()).sessions.find(x => x.cs === s.cs);
  check(s.status === 'ended' && !s.alive, 'daemon marked the session ended');

  console.log('resume a stored session over the API + websocket');
  const made = (await api('POST', '/api/sessions', { resumeId: sessionId, seat: 'a' })).body;
  check(made && made.cs && made.sessionId === sessionId, 'resume request accepted');
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${made.cs}?cols=80&rows=24`);
  let wsOut = '', wsExit = null;
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.t === 'out') wsOut += strip(m.d); if (m.t === 'exit') wsExit = m.code; };
  await new Promise(res => { ws.onopen = res; });
  const t0 = Date.now(); while (!new RegExp(`seat=dot-claude session=${sessionId} mode=resume`).test(wsOut) && Date.now() - t0 < 8000) await sleep(100);
  check(new RegExp(`seat=dot-claude session=${sessionId} mode=resume`).test(wsOut), 'websocket viewer sees the resumed session on seat a');
  ws.send(JSON.stringify({ t: 'in', d: '/exit\r' }));
  const t1 = Date.now(); while (wsExit === null && Date.now() - t1 < 8000) await sleep(100);
  check(wsExit === 0, 'websocket viewer receives the exit');
  ws.close();

  console.log('seat management over the API');
  check((await api('POST', '/api/seats', { name: 'c', login: false })).body?.ok === true, 'seat c created via API');
  let seats = (await st()).seats;
  check(seats.some(x => x.name === 'c' && x.usage.loggedIn === false), 'seat c listed as not logged in');
  check((await api('POST', '/api/seats/c/remove', { purge: true })).body?.ok === true && !fs.existsSync(path.join(tmp, 'home', 'profiles', 'c')), 'seat c removed and purged');

  console.log('outside sessions: counted while fresh, swept when silent');
  await fetch(`http://127.0.0.1:${PORT}/hook/SessionStart?cfg=${encodeURIComponent(base)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: '11111111-2222-3333-4444-555555555555', cwd: proj }) });
  await sleep(200);
  let full2 = await st();
  const outside = full2.sessions.find(x => !x.managed && x.sessionId === '11111111-2222-3333-4444-555555555555');
  check(outside && outside.alive && outside.seat === 'a', 'an outside session (plain claude, via hooks) shows as alive on its seat');
  check(full2.seats.find(x => x.name === 'a').outsideSessions >= 1, 'a fresh outside session counts as an outside session on its seat');
  check(full2.seats.find(x => x.name === 'a').activeSessions === 0, 'an outside session is NOT counted as a cockpit "running" session');
  await sleep(2200);
  const t0s = Date.now(); let swept = false;
  while (Date.now() - t0s < 14000) { const o = (await st()).sessions.find(x => x.sessionId === '11111111-2222-3333-4444-555555555555'); if (o && !o.alive && o.status === 'ended') { swept = true; break; } await sleep(400); }
  check(swept, 'a silent outside session is swept to ended after the staleness window');

  console.log('marks: star, tag, project grouping');
  const lib0 = (await api('GET', '/api/library')).body;
  const some = lib0.sessions[0];
  if (some) {
    check((await api('POST', `/api/marks/${some.sessionId}`, { star: true, addTag: 'release' })).body?.ok === true, 'can star and tag a stored session');
    const lib1 = (await api('GET', '/api/library')).body;
    const r = lib1.sessions.find(x => x.sessionId === some.sessionId);
    check(r && r.star === true && r.tags.includes('release'), 'library reflects the star and tag');
    check(lib1.tags.some(t => t.tag === 'release' && t.count >= 1), 'tags list includes the new tag with a count');
    check(typeof r.projectName === 'string' && 'inRepo' in r, 'each session has a project name and repo flag');
    await api('POST', `/api/marks/${some.sessionId}`, { star: false, removeTag: 'release' });
    const r2 = (await api('GET', '/api/library')).body.sessions.find(x => x.sessionId === some.sessionId);
    check(r2 && r2.star === false && !r2.tags.includes('release'), 'unstar and untag work');
  } else { check(true, 'no stored sessions to mark (skipped)'); }

  console.log('on-demand usage check (probe)');
  const beforeFetched = (await st()).seats.find(x => x.name === 'b').usage.fetchedAt || 0;
  check((await api('POST', '/api/seats/b/probe')).body?.ok === true, 'probe request accepted for seat b');
  let pb = null; const tp = Date.now();
  while (Date.now() - tp < 40000) { pb = (await st()).seats.find(x => x.name === 'b'); if (pb.probe && !pb.probe.running) break; await sleep(300); }
  check(pb.probe?.lastResult?.ok === true && pb.probe.lastResult.how === '/usage', `probe refreshed seat b via /usage (${JSON.stringify(pb.probe?.lastResult)})`);
  check((pb.usage.fetchedAt || 0) > beforeFetched && pb.usage.known, 'seat b usage cache is fresh after the probe');
  check(!(await st()).sessions.some(x => x.kind === 'probe'), 'probe session is hidden from the session list');
  fs.rmSync(path.join(tmp, 'home', 'probe-cwd'), { recursive: true, force: true });
  const j = JSON.parse(fs.readFileSync(baseJson, 'utf8')); delete j.projects?.[path.join(tmp, 'home', 'probe-cwd')]; fs.writeFileSync(baseJson, JSON.stringify(j));
  check((await api('POST', '/api/probe-all')).body?.seats?.length === 2, 'probe-all queues every seat');
  let pa = null; const ta = Date.now();
  while (Date.now() - ta < 60000) { const full = await st(); pa = full.seats.find(x => x.name === 'a'); if (!full.probing && pa.probe && !pa.probe.running) break; await sleep(300); }
  check(pa.probe?.lastResult?.ok === true, `probe on the base seat answered the trust dialog and refreshed (${JSON.stringify(pa.probe?.lastResult)})`);

  console.log('status line');
  const slIn = cli('statusline', 'install');
  check(/installed status line for a/.test(slIn.out), 'status line installed into seats');
  const bs = JSON.parse(fs.readFileSync(path.join(base, 'settings.json'), 'utf8'));
  check(bs.statusLine && String(bs.statusLine.command).includes('statusline'), 'base settings.json gained the cockpit statusLine');
  const slr = spawnSync(process.execPath, [CLI, 'statusline'], { env: { ...env, CLAUDE_CONFIG_DIR: base }, input: JSON.stringify({ model: { display_name: 'Fable' } }), encoding: 'utf8' });
  const slOut = strip((slr.stdout || '') + (slr.stderr || ''));
  check(/⇄ a\b/.test(slOut) && /5h/.test(slOut), `status line renders seat + headroom (${slOut.trim().slice(0, 60)})`);
  cli('statusline', 'uninstall');
  check(!JSON.parse(fs.readFileSync(path.join(base, 'settings.json'), 'utf8')).statusLine, 'status line removed cleanly, settings preserved');
  check(JSON.parse(fs.readFileSync(path.join(base, 'settings.json'), 'utf8')).theme === 'dark', 'other settings untouched by statusline uninstall');

  console.log('full-text search + bulk actions + delete');
  const projDir = path.join(base, 'projects', proj.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(projDir, { recursive: true });
  const mkFixture = (id, text) => fs.writeFileSync(path.join(projDir, id + '.jsonl'),
    JSON.stringify({ type: 'user', message: { role: 'user', content: text }, cwd: proj, timestamp: new Date().toISOString(), sessionId: id }) + '\n' +
    JSON.stringify({ type: 'ai-title', aiTitle: 'Fixture ' + id.slice(0, 4), sessionId: id }) + '\n');
  const fx1 = 'aaaa0000-0000-4000-8000-000000000001', fx2 = 'aaaa0000-0000-4000-8000-000000000002';
  mkFixture(fx1, 'bulk fixture one zzzmatch'); mkFixture(fx2, 'bulk fixture two zzzmatch');
  const sr = (await api('GET', '/api/search?q=zzzmatch')).body;
  check(Array.isArray(sr.results) && sr.results.length === 2 && sr.results[0].snippet.includes('zzzmatch'), `content search finds both fixtures with a snippet (${sr.results.length})`);
  await api('POST', '/api/marks-batch', { sessionIds: [fx1, fx2], patch: { star: true, addTag: 'batch' } });
  const marked = (await api('GET', '/api/library')).body.sessions.filter(r => [fx1, fx2].includes(r.sessionId));
  check(marked.length === 2 && marked.every(r => r.star && (r.tags || []).includes('batch')), 'bulk star + tag applied to both fixtures');
  await api('POST', '/api/marks-batch', { sessionIds: [fx1, fx2], patch: { archived: true } });
  check((await api('GET', '/api/library')).body.sessions.filter(r => [fx1, fx2].includes(r.sessionId) && r.archived).length === 2, 'bulk archive applied');
  const del = (await api('POST', '/api/library/delete', { sessionIds: [fx1] })).body;
  check(del.deleted === 1 && !fs.existsSync(path.join(projDir, fx1 + '.jsonl')), 'delete removed the transcript file');
  check((await api('GET', '/api/library')).body.sessions.some(r => r.sessionId === fx2) && !(await api('GET', '/api/library')).body.sessions.some(r => r.sessionId === fx1), 'deleted one fixture, kept the other');
  await api('POST', '/api/library/delete', { sessionIds: [fx2] });

  console.log('arm the 5-hour window (cheap -p message starts it)');
  await api('POST', '/api/seats', { name: 'd', login: false });
  cli('seat', 'login', 'd');  // logged in, but no usage cache yet -> window not active -> armable
  const armResp = await api('POST', '/api/seats/d/arm');
  check(armResp.body?.ok === true, 'arm request accepted for seat d');
  let armRec = null; const tArm = Date.now();
  while (Date.now() - tArm < 30000) { armRec = (await st()).seats.find(x => x.name === 'd')?.arm; if (armRec && !armRec.running && armRec.lastResult) break; await sleep(300); }
  check(armRec?.lastResult?.ok === true, `window armed via a cheap message (${JSON.stringify(armRec?.lastResult)})`);
  check((await st()).events.some(e => e.type === 'arm'), 'arm event logged');
  check(fs.existsSync(path.join(tmp, 'home', 'profiles', 'd', 'WINDOW_STARTED')), 'the -p message was actually sent on seat d');
  // arming an already-active window is refused
  setSeatUsage(path.join(tmp, 'home', 'profiles', 'd', '.claude.json'), 10); await api('POST', '/api/reload');
  await api('POST', '/api/seats/d/arm');
  let armRec2 = null; const tA2 = Date.now();
  while (Date.now() - tA2 < 8000) { armRec2 = (await st()).seats.find(x => x.name === 'd')?.arm; if (armRec2 && !armRec2.running) break; await sleep(300); }
  check(/already active/.test(armRec2?.lastResult?.reason || ''), 'arming an already-active window is refused');
  await api('POST', '/api/seats/d/remove', { purge: true });

  console.log('scheduled runs + budget');
  const sch = (await api('POST', '/api/schedule', { cwd: proj, seat: 'a', name: 'scheduled test', prompt: 'work', at: Date.now() + 300 })).body;
  check(sch.ok && sch.job && sch.job.id, 'schedule request accepted');
  check((await st()).jobs.some(j => j.id === sch.job.id && j.status === 'queued'), 'job shows as queued');
  let jobFired = false; const tJob = Date.now();
  while (Date.now() - tJob < 16000) { const j = (await st()).jobs.find(x => x.id === sch.job.id); if (j && j.status === 'started' && j.cs) { jobFired = true; break; } await sleep(400); }
  check(jobFired, 'scheduled job started automatically at its time');
  await sleep(800);
  const jobSess = (await st()).sessions.find(x => x.name === 'scheduled test' && x.alive);
  check(jobSess && jobSess.seat === 'a', 'scheduled run spawned a live session on the chosen seat');
  let ranPrompt = false; const tp2 = Date.now();
  while (Date.now() - tp2 < 6000) { const s2 = (await st()).sessions.find(x => x.name === 'scheduled test'); if (s2 && s2.turns >= 1) { ranPrompt = true; break; } await sleep(300); }
  check(ranPrompt, 'the scheduled initial task ran automatically');
  const sch2 = (await api('POST', '/api/schedule', { cwd: proj, name: 'cancel me', at: Date.now() + 600000 })).body;
  await api('POST', `/api/schedule/${sch2.job.id}/cancel`);
  check(!(await st()).jobs.some(j => j.id === sch2.job.id && j.status === 'queued'), 'a queued run can be cancelled');
  cli('config', 'set', 'budgetMonthlyUSD', '50'); await api('POST', '/api/reload');
  const us = (await api('GET', '/api/usage')).body;
  check(us.month && typeof us.month.total.cost === 'number' && us.budgetMonthlyUSD === 50, 'usage reports month-to-date and the monthly budget');

  console.log('hooks uninstall + daemon stop');
  cli('hooks', 'uninstall');
  const settings = JSON.parse(fs.readFileSync(path.join(base, 'settings.json'), 'utf8'));
  check(!settings.hooks && settings.theme === 'dark', 'hooks removed, other settings preserved');
  check(/stopped/.test(cli('daemon', 'stop').out), 'daemon stop');
} catch (e) {
  failures++; console.log('  EXCEPTION', e.stack || e);
} finally {
  try { await api('POST', '/api/shutdown'); } catch {}
}
console.log(failures ? `\n${failures} FAILED (state kept in ${tmp})` : `\nall passed (${tmp})`);
process.exit(failures ? 1 : 0);
