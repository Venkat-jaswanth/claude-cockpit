# Contributing to Claude Cockpit

Thanks for your interest! This is a small, dependency-light Node project and contributions
are welcome, especially **platform ports** (Linux, Windows) and dashboard polish.

## Development setup

```bash
git clone https://github.com/Venkat-jaswanth/claude-cockpit
cd claude-cockpit
npm install
npm test            # runs the full end-to-end suite, no real Claude account needed
```

The test suite (`test/e2e.js`) drives the **real** CLI, daemon, hooks, PTY sessions,
WebSocket attach and HTTP API against a fake Claude binary (`test/fake-claude.js`). It runs
in a throwaway `COCKPIT_HOME` on a separate port, so it never touches your real
`~/.claude-cockpit` state or a running daemon. Please keep it green and add checks for new
behavior.

### Running against your own data

The daemon and dashboard are served fresh from disk, so edits to `web/` show up on reload
without a restart. Changes to `src/` require a daemon restart to take effect
(`cockpit daemon stop && cockpit daemon start`).

## Project layout

```
bin/cockpit.js   the CLI, a thin client over the daemon's HTTP API
src/daemon.js    the long-lived daemon: PTY sessions, dashboard + API, polling, handoff
src/seats.js     per-account profile isolation, hook install, trust
src/usage.js     reads cached rate-limit numbers (the only usage source)
src/library.js   indexes stored conversations; search, projects, marks
src/policy.js    seat ranking + handoff decision
web/             the vanilla-JS dashboard (no build step)
test/            end-to-end suite + fake Claude binary
```

## Porting to another platform

The macOS-specific surface is deliberately small and isolated to three files:

- `src/daemonctl.js`: launchd agent (a systemd user unit on Linux, a service on Windows)
- `src/notify.js`: `osascript` notifications (`notify-send` on Linux, and so on)
- `src/daemon.js`: one `osascript`/Terminal.app call to open a terminal for attach

A port that keeps those behind a small platform shim would be a great PR.

## Style

- Plain modern Node ESM, no build step, minimal dependencies. Keep it that way.
- Match the surrounding code: comments explain **why**, not what.
- Run `npm test` before opening a PR.

## A note on account sharing

Cockpit is for managing accounts you're entitled to use. **Anthropic's terms prohibit
sharing an account, and Team seats are per named user.** Please keep automatic handoff
**opt-in** (it ships `off`). Features that nudge users toward running one person's session
on another person's account won't be merged.

## Reporting bugs

Open an issue with your OS, Node version, Claude Code version, and the relevant lines from
`~/.claude-cockpit/daemon.log` (scrub any account emails first).
