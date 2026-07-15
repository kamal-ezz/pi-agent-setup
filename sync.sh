#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
agent_dir="${PI_AGENT_DIR:-${HOME}/.pi/agent}"

managed_files=(
  settings.json
  mcp.json
  extensions/codex-usage.ts
  extensions/effort.ts
  extensions/hide-token-cost.ts
  extensions/turn-notifications.ts
  extensions/context7-mcp/index.ts
  extensions/context7-mcp/package.json
  extensions/context7-mcp/package-lock.json
  skills/frontend-design/SKILL.md
  skills/frontend-design/LICENSE.txt
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
