# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Use GitHub's private vulnerability reporting: the **Security** tab of this repository →
**Report a vulnerability**. I'll respond as quickly as I can.

## Scope & design notes

Claude Cockpit is a local tool that binds to `127.0.0.1` only and is meant for a single
machine you control. A few things worth knowing when assessing it:

- **Usage is read from Claude Code's own on-disk cache** (`cachedUsageUtilization` in each
  account's config JSON). Cockpit does **not** read OAuth tokens, the Keychain, or any
  remote endpoint, and it never transmits your data anywhere.
- **The daemon listens on `127.0.0.1` only** and rejects browser requests whose `Origin` is
  not the dashboard itself.
- **State stays local** under `~/.claude-cockpit/` (seats, policy, token ledger, logs).
- **Session deletion is guarded** to paths under the base Claude directory.

If you find a way these protections can be bypassed (the daemon serving non-local clients,
data leaving the machine, a path-traversal in session handling, or similar), please report
it privately as above.

## Account sharing

Rotating one person's session across other people's accounts violates Anthropic's terms and
is **not** a supported use (automatic handoff ships off by default). That's a policy matter,
not a security vulnerability; reports about it will be closed with a pointer to the README.
