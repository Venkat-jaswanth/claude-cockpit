// seatsInfo: [{ seat, usage, activeSessions }]
export function rankCandidates(seatsInfo, { exclude = [], maxPct = 100 } = {}) {
  return seatsInfo
    .filter(i => !i.seat.disabled && !exclude.includes(i.seat.name) && i.usage.loggedIn)
    .map(i => ({
      ...i,
      pct: i.usage.fiveHour.pct ?? 0,
      unknown: !i.usage.known,
      weeklyMax: Math.max(0, ...i.usage.weekly.map(w => w.pct || 0)),
    }))
    .filter(i => i.pct < maxPct && i.weeklyMax < 100)
    .sort((a, b) => (a.pct - b.pct) || (a.activeSessions - b.activeSessions) || (a.weeklyMax - b.weeklyMax) || (a.unknown - b.unknown));
}

// Decide what to do for one session sitting on `current.seat`.
export function decide({ current, seatsInfo, policy, hard = false }) {
  const curPct = current.usage.fiveHour.pct ?? 0;
  const cands = rankCandidates(seatsInfo, { exclude: [current.seat.name], maxPct: policy.hardPct });
  const best = cands[0] || null;
  if (hard || curPct >= policy.hardPct) {
    if (!best) return { action: 'exhausted', reason: 'no seat has headroom' };
    return { action: 'handoff', to: best.seat, hard: true, reason: hard ? 'limit reached' : `${curPct}% of the 5-hour window used` };
  }
  if (curPct >= policy.thresholdPct) {
    if (!best || best.pct > curPct - policy.minGainPct) return { action: 'none', reason: 'no seat with enough extra headroom' };
    const reason = `${current.seat.name} at ${curPct}%, ${best.seat.name} ${best.unknown ? 'unused so far' : `at ${best.pct}%`}`;
    if (policy.mode === 'auto') return { action: 'handoff', to: best.seat, hard: false, reason };
    if (policy.mode === 'ask') return { action: 'recommend', to: best.seat, reason };
    return { action: 'none', reason: 'handoff mode is off' };
  }
  return { action: 'none' };
}
