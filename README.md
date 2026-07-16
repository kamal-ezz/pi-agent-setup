# Pi agent setup

A portable snapshot of the global Pi configuration from `~/.pi/agent`.

## Included

- Pi defaults: GitHub Dark Default theme, OpenAI Codex, `gpt-5.6-sol`, and high reasoning effort
- Main-agent Auto mode by default: routine actions run automatically while destructive, security-critical, or `AGENTS.md`-violating actions require approval with a persistent in-harness warning and desktop notification; Shift+Tab cycles green Auto, yellow read-only Plan, and red bypass-all modes
- A mode-colored arrow prefixes the input bar; the terminal tab shows an animated spinner during active turns. Conversation history uses a stable in-app viewport: mouse wheel and Page Up/Down scroll without streaming output snapping the view, while the editor and footer stay pinned. Hold Shift while dragging for native terminal text selection. Agent responses support natural, sparing Unicode emoji. `/clear` starts a fresh empty session, while Ctrl+C or Cmd+C restores an interrupted prompt without a notification or abort popup, and a second press exits Pi
- Clipboard images appear as compact numbered placeholders such as `[Image #1]` instead of temporary file paths
- Codex usage and reset extension (`/usage`) with a persistent in-harness and desktop warning when the five-hour allowance reaches 10% remaining
- Reasoning effort selector (`/effort`)
- Compact footer with project, branch, model, reasoning level, context gauge, and active mode
- A short completion chime on turn completion only when Pi's terminal tab is unfocused; desktop notifications remain the fallback outside the TUI (`/notifications`)
- Unified MCP runtime with live inventory (`/mcp`), guided configuration (`/mcp-setup`), stdio and Streamable HTTP transports, and Context7 enabled
- Persistent, branch-aware goals with automatic continuation (`/goal`)
- Background terminals for servers, watchers, and long-running commands (`/ps`)
- Self-contained HTML changes review with file filtering, line numbers, theme switching, keyboard navigation, and addition/deletion rails (`/diff`)
- GPT-5.6 Luna, Terra, and Sol subagents on Pi or Codex with automatic model routing, background execution, and takeover UI (`/subagents`)
- Frontend design, background terminal, Mermaid diagram, and subagent skills

## Install

Requirements: Pi, Node.js 22.19 or newer, npm, and Git. Desktop-notification fallback additionally requires `notify-send`; chime playback uses `canberra-gtk-play` when available.

Pi-backed subagents work with the installed Pi models. Codex subagents additionally require the Codex CLI to be installed and authenticated.

```bash
git clone git@github.com:kamal-ezz/pi-agent-setup.git
cd pi-agent-setup
./install.sh
```

The installer:

1. Copies managed files to `PI_CODING_AGENT_DIR`, or `~/.pi/agent` when the Pi override is unset.
2. Backs up changed managed files under the selected agent directory's `backups/` folder.
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
│   ├── goal/
│   ├── hide-token-cost.ts
│   ├── subagents/
│   └── turn-notifications.ts
└── skills/
    ├── background-terminals/
    ├── frontend-design/
    ├── mermaid-diagram/
    └── subagents/
```

## Security

Never commit `~/.pi/agent/auth.json`. Authentication is intentionally excluded and must remain machine-local.
