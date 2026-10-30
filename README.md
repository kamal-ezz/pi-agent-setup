# pi-agent-setup

Snapshot of `~/.pi/agent`.

## Contains

- `settings.json` — `github-dark-default`, `openai/gpt-6.1-sol`, `low`; reasoning hidden by default (`Ctrl+T` to reveal)
- `extensions/btw` — `/btw` side questions
- `extensions/ctrl-c.ts` — `Ctrl+C` clears a non-empty prompt; exits Pi when the prompt is empty (aborting active work)
- `extensions/quiet-ui.ts` — compact status footer; hide agent-run shell output until expanded with `Ctrl+O`, without placeholder labels; commands and error highlighting remain visible; suppress the hidden-reasoning label
- `themes/github-dark-default.json`, `keybindings.json`, `package.json`, `tsconfig.json`

Removed: `effort`, `agent-modes`, `background-terminals`, `diff-browser`, `goal`, `mcp-runtime`, `subagents`, `codex-usage`, `emoji-responses`, `turn-notifications`, `mcp.json`, `skills/*`.

## Install

```bash
git clone git@github.com:kamal-ezz/pi-agent-setup.git
cd pi-agent-setup
./sync.sh
```

Copies managed files to `~/.pi/agent` (or `$PI_CODING_AGENT_DIR`). Changed files are backed up to `backups/`. Does not copy `auth.json`, `sessions`, `bin`, `node_modules`.

```bash
./sync.sh --dry-run   # preview
```

## Update snapshot

```bash
./sync.sh --to-repo
git diff
```

## Layout

```
.
├── settings.json / keybindings.json / package.json / tsconfig.json
├── themes/github-dark-default.json
├── extensions/btw
├── extensions/quiet-ui.ts
├── extensions/ctrl-c.ts
└── sync.sh
```
