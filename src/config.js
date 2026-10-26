// Config: defaults merged over ~/.claude-cockpit/config.json. DEFAULTS documents every
// knob and its shipped value; loadConfig() deep-merges the handoff block so a user's
// config.json only needs to override the keys it cares about.
import { CONFIG_FILE, readJson, writeJson, ensureHome } from './paths.js';

export const DEFAULTS = {
  port: 7447,
  pollSec: 30,
  handoff: {
    // off | ask | auto. Ships as 'off': cockpit never moves a session on its own until
    // you opt in. 'ask' only notifies; 'auto' moves between seats past the threshold (and
    // always on a hard-limit hit, unless mode is 'off'). Read the "Account sharing" note in
    // the README before enabling handoff across accounts that aren't your own.
    mode: 'off',
    thresholdPct: 85,    // recommend/auto-hand-off once the seat's 5-hour window is this full
    minGainPct: 20,      // only move if the target seat has at least this much more headroom
    hardPct: 97,         // treat as "limit reached"
    autoContinue: true,  // after a handoff, automatically continue the work (no need to type "continue")
    continueMessage: 'Please continue where you left off.',
  },
  budgetMonthlyUSD: 0,         // >0: alert when this month's spend (from Claude Code's own cost) crosses it
  armModel: 'haiku',           // cheap model used to start ("arm") a seat's 5-hour window on demand
  armPrompt: 'Reply with: ok', // the minimal message sent to start the window
  notifications: true,
  autoCheckMin: 0,     // >0: re-check idle seats' usage automatically every N minutes; 0 = only when you click
  seats: [],
};

export function loadConfig() {
  const c = readJson(CONFIG_FILE, {}) || {};
  return {
    ...DEFAULTS,
    ...c,
    handoff: { ...DEFAULTS.handoff, ...(c.handoff || {}) },
    seats: Array.isArray(c.seats) ? c.seats : [],
  };
}

export function saveConfig(cfg) {
  ensureHome();
  writeJson(CONFIG_FILE, cfg);
}

export function portOf(cfg = loadConfig()) {
  return Number(process.env.COCKPIT_PORT || cfg.port || DEFAULTS.port);
}
