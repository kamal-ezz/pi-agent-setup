# Pi agent setup

A portable snapshot of the global Pi configuration from `~/.pi/agent`.

## Included

- Pi defaults: dark theme, OpenAI Codex, `gpt-5.6-sol`, and high reasoning effort
- Codex usage and reset-status extension (`/usage`)
- Reasoning effort selector (`/effort`)
- Responsive telemetry footer with context gauge, token traffic, cache efficiency, model, and reasoning level
- Desktop turn-complete notifications with a short response overview (`/notifications`)
- MCP manager (`/mcp`) with Context7 enabled
- Frontend design skill

## Install

Requirements: Pi, Node.js 18 or newer, and npm. Desktop notifications additionally require `notify-send`.

```bash
git clone git@github.com:kamal-ezz/pi-agent-setup.git
cd pi-agent-setup
./install.sh
```

The installer:

1. Copies the managed files to `${PI_AGENT_DIR:-~/.pi/agent}`.
2. Backs up changed managed files under `~/.pi/agent/backups/`.
3. Installs the MCP extension's production dependencies with `npm ci`.

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
├── mcp.json
├── extensions/
│   ├── codex-usage.ts
│   ├── effort.ts
│   ├── hide-token-cost.ts
│   ├── turn-notifications.ts
│   └── context7-mcp/
└── skills/
    └── frontend-design/
```

## Security

Never commit `~/.pi/agent/auth.json`. Authentication is intentionally excluded and must remain machine-local.
