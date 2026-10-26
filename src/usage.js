// Reading a seat's 5-hour / weekly usage. This is the heart of cockpit's "usage without
// tokens" promise: the only source is the rate-limit snapshot Claude Code already writes to
// its own config file. No OAuth tokens, no Keychain, no network calls.
import { readJson } from './paths.js';

// Claude Code refreshes `cachedUsageUtilization` in its own config JSON every few
// minutes while a session is running. Reading that file is the only usage source
// cockpit uses: no tokens, no API calls.
export const STALE_MIN = 20;

export function readUsage(seat, now = Date.now()) {
  const j = readJson(seat.claudeJson, null);
  const acct = j?.oauthAccount || null;
  const identity = {
    loggedIn: !!acct?.emailAddress,
    email: acct?.emailAddress || seat.email || null,
    org: acct?.organizationName || seat.org || null,
  };
  const c = j?.cachedUsageUtilization;
  if (!c?.utilization) {
    return { ...identity, known: false, fetchedAt: null, ageMin: null, stale: true,
      fiveHour: { pct: null, resetsAt: null, assumedReset: false }, weekly: [], extraUsage: { enabled: false }, limits: [] };
  }
  const u = c.utilization;
  const fetchedAt = c.fetchedAtMs || null;
  const ageMin = fetchedAt ? (now - fetchedAt) / 60000 : null;
  let fh = { pct: u.five_hour?.utilization ?? null, resetsAt: u.five_hour?.resets_at || null, assumedReset: false, severity: null };
  const limits = Array.isArray(u.limits) ? u.limits : [];
  const sess = limits.find(l => l.kind === 'session' || l.group === 'session');
  if (sess && typeof sess.percent === 'number') {
    fh.pct = sess.percent; fh.resetsAt = sess.resets_at || fh.resetsAt; fh.severity = sess.severity || null;
  }
  if (fh.resetsAt && fh.pct !== null && new Date(fh.resetsAt).getTime() < now) {
    // The window Claude Code last saw has already rolled over; the seat is fresh again.
    fh = { ...fh, pct: 0, assumedReset: true };
  }
  const weekly = [];
  for (const l of limits) {
    if (l.group === 'weekly' || /weekly|seven_day/.test(l.kind || '')) {
      const model = l.scope?.model?.display_name;
      weekly.push({ label: model ? `Weekly · ${model}` : 'Weekly', pct: l.percent ?? null, resetsAt: l.resets_at || null, active: !!l.is_active, severity: l.severity || null });
    }
  }
  if (!weekly.length && u.seven_day?.utilization != null) weekly.push({ label: 'Weekly', pct: u.seven_day.utilization, resetsAt: u.seven_day.resets_at || null, active: true });
  if (u.seven_day_opus?.utilization != null && !weekly.some(w => /Opus/i.test(w.label))) weekly.push({ label: 'Weekly · Opus', pct: u.seven_day_opus.utilization, resetsAt: u.seven_day_opus.resets_at || null, active: true });
  const stale = !fh.assumedReset && (ageMin == null || ageMin > STALE_MIN);
  return { ...identity, known: true, fetchedAt, ageMin, stale, fiveHour: fh, weekly, extraUsage: { enabled: !!u.extra_usage?.is_enabled }, limits };
}
