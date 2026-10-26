# Claude Cockpit

**Run and manage several Claude Code accounts from one machine.** See each account's
remaining 5-hour window at a glance, keep every session alive in a small local daemon, and
start, resume, search or hand off any session from a single dashboard at
`http://127.0.0.1:7447`.

![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)
![platform](https://img.shields.io/badge/platform-macOS-lightgrey)

![Claude Cockpit — the Overview dashboard](docs/overview-light.png)

## Why

Claude Code meters usage on a rolling 5-hour window. The moment you run more than one
account — a personal plan and a work plan, a couple of plans you switch between, or a few
across a small team — the friction shows up fast: logging in and out, losing track of which
account still has headroom, and re-finding your place when one runs dry mid-task.

Claude Cockpit keeps each account logged in as its own isolated **seat**, shows every seat's
headroom in real time, and (optionally) lets a running session move to a fresher seat
without losing the conversation.

It reads **only** the rate-limit numbers Claude Code already caches on disk. It never reads
your OAuth tokens, your Keychain, or any private endpoint, and it never sends a prompt you
didn't ask for.

## What it does

- **Seats — isolated accounts.** Each account gets its own `CLAUDE_CONFIG_DIR` under
  `~/.claude-cockpit/profiles/<seat>/` with its own credentials. Projects, auto-memory,
  plugins, skills and prompt history are shared with `~/.claude` through symlinks, so every
  seat sees the same conversations.
- **Usage without tokens.** Claude Code caches each account's rate-limit status in that
  account's `.claude.json` and refreshes it while a session runs. Cockpit only reads those
  files — never OAuth tokens, the Keychain, or undocumented endpoints.
- **Check usage on demand.** For an idle seat, **Check usage** (or `cockpit usage`) starts
  Claude Code on that seat in an empty folder, asks it for `/usage`, and closes it a few
  seconds later. No prompt is sent, so it costs nothing. Optional automatic re-checks every
  30 / 60 / 180 minutes in Settings; off by default.
- **Sessions live in the daemon.** A Terminal window or browser tab is only a view. Close
  it and the session keeps running; reattach from anywhere. If the daemon restarts, sessions
  show as *lost* and resume with one click.
- **Library & projects.** Every stored Claude Code conversation on the machine is listed
  with its title, folder, branch, tokens and cost — grouped by git repo, full-text
  searchable, star/tag/note-able, and resumable on any seat.
- **Token & cost accounting.** At every turn the daemon reads the new transcript lines,
  deduplicates the assistant messages, and books tokens to the seat that ran the turn.
  The dashboard shows today, the last 7 days, all-time, a 14-day chart, per-seat bars, a
  monthly budget bar and the top sessions. Cost is Claude Code's own `cost-state` estimate.
- **Handoff (opt-in).** Claude Code's hooks tell the daemon when a turn starts and ends.
  With handoff enabled, between turns the daemon can move a session to a seat with more
  headroom — `/exit`, switch seat, `claude --resume <same id>` — and continue the work.
  **Ships off by default** (see [Account sharing](#account-sharing-read-this-first)).

## Screenshots

**Projects** — every conversation grouped into collapsible folders, resumable on any seat:

![Projects view](docs/projects-light.png)

**Usage** — a monthly budget bar, a 14-day token trend, per-seat spend and your top sessions:

![Usage view](docs/usage-light.png)

**Seats** — one isolated login per account, each with its own 5-hour and weekly windows:

![Seats view](docs/seats-light.png)

Dark mode throughout:

![Overview in dark mode](docs/overview-dark.png)

## Install

> npm distribution (`npm install -g claude-cockpit`) is planned. For now, install from
> source:

```bash
git clone https://github.com/Venkat-jaswanth/claude-cockpit ~/claude-cockpit
cd ~/claude-cockpit && npm install && npm link   # puts `cockpit` on your PATH
cockpit init --name <your-seat-name>             # adopts the current ~/.claude login as seat 1, installs hooks, starts the daemon
cockpit daemon install                           # launchd: start the daemon at login, restart it if it dies
cockpit open                                     # the dashboard — add other accounts as seats from here
```

**Requirements:** macOS, Node 20+, Claude Code 2.1+ on the `PATH`, `curl`.

## Everyday use

Open the dashboard — everything below is also a button there.

```bash
cockpit start                        # Claude Code in this folder, on the seat with the most headroom
cockpit start --seat work -n api     # pin a seat, name the session
cockpit start -- --model opus        # anything after -- is passed straight to claude
cockpit resume <id or title>         # resume any stored session, on the best seat
cockpit attach [name]                # re-enter a running session; Ctrl-] detaches
cockpit handoff [name] --to other    # move a session now, or after its current turn
cockpit status                       # seats, usage, sessions
cockpit usage [seat]                 # refresh the 5-hour reading of idle seats now
cockpit seat add <name>              # log another account in as a seat
cockpit config set handoff.mode ask  # enable handoff notifications (see the note below)
```

Inside Claude Code nothing changes: same keys, same `/commands`, same TUI. A handoff shows
one cyan line, then the same conversation continues.

## Account sharing — read this first

Cockpit is built to manage **accounts you are entitled to use**. Pointing it at your own
plans, or at accounts whose owners have each signed in on their own seat and keep their own
usage, is ordinary multi-account management.

What it does **not** make okay: **Anthropic's consumer terms prohibit sharing an account
with anyone else, and Team seats are per named user.** Running *your* session on *someone
else's* seat is account sharing even when they agree, and it can get accounts suspended.

For that reason **handoff ships off (`handoff.mode: off`)** — cockpit never moves a session
on its own until you turn it on. Enabling handoff *across other people's accounts* is a
choice you make, with that risk. The clean pattern is: each person uses their own seat,
cockpit makes switching and visibility painless, and the fallback when a seat is spent is a
model downshift, extra usage, or an API key.

## How a handoff works

1. The `Stop` hook tells the daemon the turn is over.
2. The daemon reads every seat's cached usage and applies your policy
   (`off` / `ask` / `auto`).
3. It sends Ctrl-C, Ctrl-U, `/exit` to the session's terminal and waits for exit.
4. It spawns `claude --resume <id>` under the next seat's `CLAUDE_CONFIG_DIR`.
5. `SessionStart` (source `resume`) confirms the session is back; an interrupted prompt is
   re-sent.

The session's folder is pre-trusted on every seat cockpit runs it on, so a handoff never
stops at Claude Code's "Is this a project you trust?" prompt. Sessions started with a plain
`claude` are still visible on the dashboard (their hooks report in) but can't be attached or
handed off.

## Files

```
~/.claude-cockpit/config.json      seats and policy
~/.claude-cockpit/state.json       sessions and event log
~/.claude-cockpit/ledger.json      token ledger by day, seat and session
~/.claude-cockpit/marks.json       stars, tags and notes (cockpit never writes into transcripts)
~/.claude-cockpit/profiles/<seat>  one CLAUDE_CONFIG_DIR per seat
~/.claude-cockpit/daemon.log
~/.claude-cockpit/backups/         settings.json backups taken before hooks are installed
```

Hooks are added to each seat's `settings.json` under `SessionStart`, `UserPromptSubmit`,
`Stop`, `StopFailure`, `SessionEnd`. Each is one `curl` to 127.0.0.1, tagged
`# claude-cockpit`; `cockpit hooks uninstall` removes only those. The daemon listens on
127.0.0.1 only and refuses browser requests whose `Origin` is not the dashboard itself.

## Platform support

Cockpit runs on **macOS** today. The platform-specific surface is small and isolated to
three files — launchd (`src/daemonctl.js`), `osascript` notifications (`src/notify.js`), and
opening Terminal.app (`src/daemon.js`). A Linux port (systemd + `notify-send` +
`x-terminal-emulator`) is a modest job and a Windows port a larger one. **Contributions
welcome** — see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Caveats

- **Usage freshness.** A seat's limit reading only refreshes while a session runs on it.
  Idle seats show their last known value; once the window's reset time passes, cockpit
  assumes 0%.
- **Resume dialog.** On some plans Claude Code asks "Resume this conversation?" after a long
  break. Answer it; a re-sent prompt may need to be typed again.
- **Flags on resume.** Flags passed after `--` are re-applied on every resume; a positional
  prompt is not.
- **Token counts** come from transcript files whose format is internal to Claude Code and
  can change between versions. Forked sessions copy their history, so the all-time figure can
  count a fork twice.

## Test

```bash
npm test   # drives the real CLI, daemon, hooks, PTY sessions, WebSocket attach and the HTTP API against test/fake-claude.js
```

## License

[MIT](LICENSE) © 2026 Venkat Jaswanth
