<div align="center">

# Claude Cockpit

### Run and manage several Claude Code accounts from one machine.

See every account's 5-hour window at a glance · resume or hand off any session · browse, search and schedule — all from one local dashboard.

[![release](https://img.shields.io/github/v/release/Venkat-jaswanth/claude-cockpit?color=1f6feb&label=release)](https://github.com/Venkat-jaswanth/claude-cockpit/releases)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)
![platform](https://img.shields.io/badge/platform-macOS-lightgrey)
![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)

<br>

![Claude Cockpit dashboard](docs/overview-light.png)

</div>

## Why

Claude Code meters usage on a rolling 5-hour window. The moment you run more than one
account — a personal plan and a work plan, a couple of plans you switch between, or a few
across a small team — the friction shows up fast: logging in and out, losing track of which
account still has headroom, and re-finding your place when one runs dry mid-task.

**Claude Cockpit** keeps each account logged in as its own isolated **seat**, shows every
seat's headroom in real time, and lets you start, resume, search, schedule or (optionally)
hand off any session — from one dashboard or one `cockpit` command.

It reads **only** the rate-limit numbers Claude Code already caches on disk. It never reads
your OAuth tokens, your Keychain, or any private endpoint, and it never sends a prompt you
didn't ask for.

## Features

| | |
|---|---|
| 🪑 **Isolated seats** | One `CLAUDE_CONFIG_DIR` per account with its own credentials. Projects, memory, plugins, skills and history are shared via symlinks, so every seat sees the same work. |
| 📊 **Usage without tokens** | Reads each account's cached 5-hour & weekly rate-limit status straight from disk. No OAuth tokens, no Keychain, no network calls. |
| 🔥 **Burn-rate & ETA** | Per-seat %/hour and time-to-full, so you know which seat to reach for next. |
| ⚡ **Arm the 5-hour window** | Kick off a seat's window at ~0 cost with a cheap model — one seat or all idle seats at once. |
| 🖥️ **Sessions in a daemon** | Every session runs in a PTY owned by the daemon. Close the tab or Terminal — it keeps running. Reattach from anywhere. |
| 🌐 **Attach in your browser *or* Terminal** | Open any live session in a browser tab (full xterm) or pop it into Terminal.app — your choice, same session. |
| 🔀 **Opt-in handoff** | When a seat runs low, move a running session to a fresher one between turns and continue the work. **Ships off by default.** |
| 🗂️ **Session library & projects** | Every stored conversation, grouped by git repo — star, tag, note, archive, and resume on any seat. |
| 🔎 **Full-text search** | Grep across every transcript on the machine, with readable snippets. |
| ☑️ **Bulk actions** | Select conversations and star / tag / move / archive / delete them in one go. |
| 💸 **Token & cost accounting** | Tokens booked per turn to the seat that ran it — today, 7 days, all-time, a 14-day chart, per-seat spend, top sessions, CSV export. |
| 🎯 **Monthly budget** | Set a monthly spend cap and watch the budget bar. |
| ⌨️ **Command palette** | `⌘K` to jump to any view, seat, session, or action. |
| ⏰ **Scheduled runs** | Queue a session to start now, in a few hours, or at a seat's next reset — with an initial task. |
| 📟 **Status line** | Show the active seat's remaining window right in Claude Code's status line. |
| 🌗 **Light & dark** | A calm graphite theme, both ways. |

## Screenshots

**Projects** — every conversation grouped into collapsible folders, resumable on any seat:

![Projects view](docs/projects-light.png)

<table>
<tr>
<td width="50%">

**Usage** — budget, a 14-day trend, per-seat spend and top sessions.

![Usage](docs/usage-light.png)

</td>
<td width="50%">

**Seats** — one isolated login per account, each with its own windows.

![Seats](docs/seats-light.png)

</td>
</tr>
</table>

**Attach in the browser** — open any live session as a full terminal in a tab (or send it to Terminal.app), hand it off, or stop it:

![Web terminal](docs/terminal-web.png)

<table>
<tr>
<td width="50%">

**Command palette** (`⌘K`) — jump anywhere or run any action.

![Command palette](docs/command-palette.png)

</td>
<td width="50%">

**Dark mode** throughout.

![Overview in dark mode](docs/overview-dark.png)

</td>
</tr>
</table>

## Install

> npm distribution is planned. For now, install from source:

```bash
git clone https://github.com/Venkat-jaswanth/claude-cockpit ~/claude-cockpit
cd ~/claude-cockpit && npm install && npm link   # puts `cockpit` on your PATH
cockpit init --name <your-seat-name>             # adopts the current ~/.claude login as seat 1, installs hooks, starts the daemon
cockpit daemon install                           # launchd: start at login, restart if it dies
cockpit open                                     # the dashboard — add other accounts as seats from here
```

**Requirements:** macOS · Node 20+ · Claude Code 2.1+ on the `PATH` · `curl`.

<details>
<summary><b>Everyday use</b> — the CLI (everything here is also a button in the dashboard)</summary>

```bash
cockpit start                        # Claude Code in this folder, on the seat with the most headroom
cockpit start --seat sam -n api      # pin a seat, name the session
cockpit start -- --model opus        # anything after -- is passed straight to claude
cockpit resume <id or title>         # resume any stored session, on the best seat
cockpit attach [name]                # re-enter a running session; Ctrl-] detaches
cockpit handoff [name] --to alex     # move a session now, or after its current turn
cockpit status                       # seats, usage, sessions
cockpit usage [seat]                 # refresh the 5-hour reading of idle seats now
cockpit seat add <name>              # log another account in as a seat
cockpit config set handoff.mode ask  # enable handoff (see the note below)
```

Inside Claude Code nothing changes: same keys, same `/commands`, same TUI. A handoff shows
one cyan line, then the same conversation continues.

</details>

## Account sharing — please read

Cockpit is built to manage **accounts you are entitled to use** — your own plans, or
accounts whose owners have each signed in on their own seat.

**Anthropic's consumer terms prohibit sharing an account with anyone else, and Team seats
are per named user.** Running *your* session on *someone else's* seat is account sharing even
when they agree, and it can get accounts suspended. For that reason **automatic handoff ships
off (`handoff.mode: off`)** — cockpit never moves a session on its own until you turn it on.
Enabling handoff across accounts that aren't yours is a choice you make, with that risk.

<details>
<summary><b>How a handoff works</b></summary>

1. Claude Code's `Stop` hook tells the daemon the turn is over.
2. The daemon reads every seat's cached usage and applies your policy (`off` / `ask` / `auto`).
3. It sends Ctrl-C, Ctrl-U, `/exit` to the session's terminal and waits for exit.
4. It spawns `claude --resume <id>` under the next seat's `CLAUDE_CONFIG_DIR`.
5. `SessionStart` (source `resume`) confirms the session is back; an interrupted prompt is re-sent.

The session's folder is pre-trusted on every seat it runs on, so a handoff never stops at
Claude Code's "Is this a project you trust?" prompt. Sessions started with a plain `claude`
are still visible on the dashboard (their hooks report in) but can't be attached or handed off.

</details>

<details>
<summary><b>Where state lives</b></summary>

```
~/.claude-cockpit/config.json      seats and policy
~/.claude-cockpit/state.json       sessions and event log
~/.claude-cockpit/ledger.json      token ledger by day, seat and session
~/.claude-cockpit/marks.json       stars, tags and notes (cockpit never writes into transcripts)
~/.claude-cockpit/profiles/<seat>  one CLAUDE_CONFIG_DIR per seat
~/.claude-cockpit/daemon.log
```

Hooks are added to each seat's `settings.json` under `SessionStart`, `UserPromptSubmit`,
`Stop`, `StopFailure`, `SessionEnd` — each a single `curl` to `127.0.0.1`, tagged
`# claude-cockpit`; `cockpit hooks uninstall` removes only those. The daemon listens on
`127.0.0.1` only and rejects browser requests whose `Origin` isn't the dashboard itself.

</details>

## Platform support

Cockpit runs on **macOS** today. The platform-specific surface is small and isolated to
three files — launchd (`src/daemonctl.js`), `osascript` notifications (`src/notify.js`), and
opening Terminal.app (`src/daemon.js`). A Linux port (systemd + `notify-send` +
`x-terminal-emulator`) is a modest job and a Windows port a larger one. **Contributions
welcome** — see [`CONTRIBUTING.md`](CONTRIBUTING.md).

<details>
<summary><b>Caveats</b></summary>

- **Usage freshness.** A seat's limit reading only refreshes while a session runs on it. Idle
  seats show their last known value; once the window's reset time passes, cockpit assumes 0%.
- **Resume dialog.** On some plans Claude Code asks "Resume this conversation?" after a long
  break. Answer it; a re-sent prompt may need to be typed again.
- **Flags on resume.** Flags after `--` are re-applied on every resume; a positional prompt is not.
- **Token counts** come from transcript files whose format is internal to Claude Code and can
  change between versions. Forked sessions copy their history, so the all-time figure can
  count a fork twice.

</details>

## Test

```bash
npm test   # drives the real CLI, daemon, hooks, PTY sessions, WebSocket attach and the HTTP API against a fake Claude binary
```

## License

[MIT](LICENSE) © 2026 Venkat Jaswanth
