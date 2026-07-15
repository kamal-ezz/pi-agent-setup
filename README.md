# Pi agent setup

A portable snapshot of the global Pi configuration from `~/.pi/agent`.

## Included

- Pi defaults: GitHub Dark Default theme, OpenAI Codex, `gpt-5.6-sol`, and high reasoning effort
- Main-agent Auto mode by default: routine actions run automatically while destructive, security-critical, or `AGENTS.md`-violating actions require approval and send desktop notifications; Shift+Tab cycles green Auto, yellow read-only Plan, and red bypass-all modes
- Ctrl+C or Cmd+C interrupts an active turn without clearing an idle draft; a second press exits Pi
- Clipboard images appear as compact numbered placeholders such as `[Image #1]` instead of temporary file paths
- Codex usage and reset-status extension (`/usage`)
- Reasoning effort selector (`/effort`)
- Compact footer with project, branch, model, reasoning level, context gauge, and active mode
- Desktop turn-complete notifications with a short response overview (`/notifications`)
- MCP manager (`/mcp`) with Context7 enabled
- Background terminals for servers, watchers, and long-running commands (`/ps`)
- Interactive local changes browser (`/diff`)
- Pi, Claude Code, and Codex subagents with background execution and takeover UI (`/subagents`)
- Frontend design, background terminal, and subagent skills

## Install

Requirements: Pi, Node.js 20 or newer, npm, and Git. Desktop notifications additionally require `notify-send`.

Pi-backed subagents work with the installed Pi models. Claude Code and Codex subagents additionally require their respective CLIs to be installed and authenticated.

```bash
git clone git@github.com:kamal-ezz/pi-agent-setup.git
cd pi-agent-setup
./install.sh
```

The installer:

1. Copies the managed files to `${PI_AGENT_DIR:-~/.pi/agent}`.
2. Backs up changed managed files under `~/.pi/agent/backups/`.
3. Installs production dependencies for the MCP, background terminal, diff browser, and subagent extensions with `npm ci`.

Restart Pi after installation. On a new machine, authenticate separately with `/login` inside Pi.

## Update this snapshot

After changing the live setup, run:

```bash
./sync.sh
git diff
```

`sync.sh` uses an explicit allowlist. It does **not** copy credentials, sessions, downloaded binaries, or `node_modules`.

## Repository layout

```text
.
├── settings.json
├── keybindings.json
├── mcp.json
├── themes/
│   └── github-dark-default.json
├── extensions/
│   ├── auto-plan/
│   ├── background-terminals/
│   ├── codex-usage.ts
│   ├── context7-mcp/
│   ├── diff/
│   ├── effort.ts
│   ├── hide-token-cost.ts
│   ├── subagents/
│   └── turn-notifications.ts
└── skills/
    ├── background-terminals/
    ├── frontend-design/
    └── subagents/
```

## Security

Never commit `~/.pi/agent/auth.json`. Authentication is intentionally excluded and must remain machine-local.
