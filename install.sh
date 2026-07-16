#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
agent_dir="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"
if [[ "$agent_dir" == "~" ]]; then
  agent_dir="$HOME"
elif [[ "$agent_dir" == "~/"* ]]; then
  agent_dir="${HOME}/${agent_dir:2}"
fi
timestamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="${agent_dir}/backups/pi-agent-setup-${timestamp}"
backed_up=false

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
  package.json
  tsconfig.json
)

managed_directories=(
  extensions/auto-plan
  extensions/background-terminals
  extensions/btw
  extensions/context7-mcp
  extensions/diff
  extensions/goal
  extensions/subagents
  skills/background-terminals
  skills/mermaid-diagram
  skills/subagents
  themes
)

# Honor the repository ignore rules so installed dependencies and other
# machine-local files are never treated as managed setup files.
while IFS= read -r -d '' relative_path; do
  # `--cached` also lists tracked files deleted from the working tree.
  [[ -e "${repo_dir}/${relative_path}" ]] || continue
  managed_files+=("$relative_path")
done < <(
  git -C "$repo_dir" ls-files --cached --others --exclude-standard -z -- \
    "${managed_directories[@]}"
)

mkdir -p "$agent_dir"

for relative_path in "${managed_files[@]}"; do
  source_path="${repo_dir}/${relative_path}"
  target_path="${agent_dir}/${relative_path}"

  if [[ -f "$target_path" ]] && ! cmp -s "$source_path" "$target_path"; then
    mkdir -p "${backup_dir}/$(dirname -- "$relative_path")"
    cp -p "$target_path" "${backup_dir}/${relative_path}"
    backed_up=true
  fi

  mkdir -p "$(dirname -- "$target_path")"
  cp -p "$source_path" "$target_path"
done

npm ci --omit=dev --prefix "${agent_dir}/extensions/context7-mcp"
for extension in background-terminals diff subagents; do
  npm ci --omit=dev --ignore-scripts --prefix "${agent_dir}/extensions/${extension}"
done

printf 'Installed Pi setup in %s\n' "$agent_dir"
if [[ "$backed_up" == true ]]; then
  printf 'Previous managed files were backed up to %s\n' "$backup_dir"
fi
printf 'Run pi and use /login if this machine is not authenticated.\n'
