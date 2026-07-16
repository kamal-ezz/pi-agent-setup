#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
agent_dir="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"
if [[ "$agent_dir" == "~" ]]; then
  agent_dir="$HOME"
elif [[ "$agent_dir" == "~/"* ]]; then
  agent_dir="${HOME}/${agent_dir:2}"
fi

managed_files=(
  settings.json
  keybindings.json
  mcp.json
  extensions/codex-usage.ts
  extensions/effort.ts
  extensions/emoji-responses.ts
  extensions/hide-token-cost.ts
  extensions/turn-notifications.ts
  skills/frontend-design/SKILL.md
  skills/frontend-design/LICENSE.txt
  tsconfig.json
)

managed_directories=(
  extensions/auto-plan
  extensions/background-terminals
  extensions/context7-mcp
  extensions/diff
  extensions/goal
  extensions/subagents
  skills/background-terminals
  skills/mermaid-diagram
  skills/subagents
  themes
)

# Version-controlled and unignored files in these directories form the
# allowlist. Gitignored package data and other machine-local additions are
# excluded even when they exist in the repository worktree.
while IFS= read -r -d '' relative_path; do
  managed_files+=("$relative_path")
done < <(
  git -C "$repo_dir" ls-files --cached --others --exclude-standard -z -- \
    "${managed_directories[@]}"
)

for relative_path in "${managed_files[@]}"; do
  source_path="${agent_dir}/${relative_path}"
  target_path="${repo_dir}/${relative_path}"

  if [[ ! -f "$source_path" ]]; then
    printf 'Missing managed file: %s\n' "$source_path" >&2
    exit 1
  fi

  mkdir -p "$(dirname -- "$target_path")"
  cp -p "$source_path" "$target_path"
done

printf 'Synced the managed Pi setup from %s\n' "$agent_dir"
printf 'Authentication, sessions, binaries, and node_modules were not copied.\n'
