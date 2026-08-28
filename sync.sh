#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ./sync.sh [options]

Sync the portable Pi agent snapshot between this repository and the live
agent directory (PI_CODING_AGENT_DIR or ~/.pi/agent).

  (no flag)            Install: copy managed files from repo -> agent (default)
  --to-agent           Same as default: repo -> agent with backup + deps
  --to-repo            Snapshot: copy managed files from agent -> repo (update snapshot)
  --snapshot           Alias for --to-repo
  --dry-run            Show what would change without writing
  -h, --help           Show this help

Managed files are an explicit allowlist; credentials (auth.json), sessions,
binaries, and node_modules are never copied.
USAGE
}

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
agent_dir="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"
if [[ "$agent_dir" == "~" ]]; then
  agent_dir="$HOME"
elif [[ "$agent_dir" == "~/"* ]]; then
  agent_dir="${HOME}/${agent_dir:2}"
fi

mode="to-agent"
dry_run=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --to-agent) mode="to-agent"; shift ;;
    --to-repo|--snapshot|--pull) mode="to-repo"; shift ;;
    --dry-run|-n) dry_run=true; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Allowlist: what this repo manages after cleanup.
# Keep this in sync with the working tree after your deletions.
# ---------------------------------------------------------------------------
managed_files=(
  settings.json
  keybindings.json
  extensions/effort.ts
  extensions/status-footer.ts
  package.json
  tsconfig.json
)

managed_directories=(
  extensions/btw
  themes
)

# Paths that were managed by older snapshots but are intentionally removed.
# When installing (repo -> agent) they are moved aside to backup so Pi does
# not auto-discover stale extensions/skills. Kept intentionally exhaustive
# after the large cleanup in this repo.
legacy_managed_paths=(
  mcp.json
  extensions/agent-modes
  extensions/background-terminals
  extensions/btw
  extensions/codex-usage.ts
  extensions/diff-browser
  extensions/emoji-responses.ts
  extensions/goal
  extensions/mcp-runtime
  extensions/subagents
  extensions/turn-notifications.ts
  extensions/auto-plan
  extensions/context7-mcp
  extensions/diff
  extensions/hide-token-cost.ts
  skills/background-terminals
  skills/frontend-design
  skills/mermaid-diagram
  skills/subagents
)

# Remove the directories we currently manage from the orphan list so we do
# not treat the desired extensions as legacy.
# We keep mcp.json even though skills are gone, and keep only the truly
# removed paths.
filtered_legacy=()
for p in "${legacy_managed_paths[@]}"; do
  skip=false
  for keep in "${managed_directories[@]}" "${managed_files[@]}"; do
    if [[ "$p" == "$keep" ]]; then
      skip=true
      break
    fi
  done
  # btw is kept, so don't treat it as legacy
  if [[ "$skip" == true ]]; then
    continue
  fi
  filtered_legacy+=("$p")
done
legacy_managed_paths=("${filtered_legacy[@]}")

# Honor repository ignore rules so installed dependencies and other
# machine-local files are never treated as managed setup files.
while IFS= read -r -d '' relative_path; do
  # --cached also lists tracked files deleted from the working tree.
  [[ -e "${repo_dir}/${relative_path}" ]] || continue
  managed_files+=("$relative_path")
done < <(
  git -C "$repo_dir" ls-files --cached --others --exclude-standard -z -- \
    "${managed_directories[@]}"
)

if [[ "$mode" == "to-repo" ]]; then
  # Snapshot mode: agent -> repo (original sync.sh behavior)
  # Useful after editing the live agent to update the portable snapshot.
  if [[ "$dry_run" == true ]]; then
    printf '[dry-run] Would sync from %s -> %s\n' "$agent_dir" "$repo_dir"
  fi
  for relative_path in "${managed_files[@]}"; do
    source_path="${agent_dir}/${relative_path}"
    target_path="${repo_dir}/${relative_path}"

    if [[ "$dry_run" == true ]]; then
      if [[ ! -e "$source_path" ]]; then
        printf '[dry-run] Missing managed file in agent (skipped): %s\n' "$source_path"
        continue
      fi
      if [[ -f "$target_path" ]] && cmp -s "$source_path" "$target_path"; then
        printf '[dry-run] Unchanged: %s\n' "$relative_path"
      else
        printf '[dry-run] Would copy: %s -> %s\n' "$relative_path" "$relative_path"
      fi
      continue
    fi

    if [[ ! -f "$source_path" ]]; then
      printf 'Missing managed file: %s\n' "$source_path" >&2
      printf 'Hint: did you mean to run without --to-repo to install repo -> agent?\n' >&2
      exit 1
    fi

    mkdir -p "$(dirname -- "$target_path")"
    cp -p "$source_path" "$target_path"
  done

  if [[ "$dry_run" == true ]]; then
    printf '[dry-run] Snapshot dry-run complete.\n'
  else
    printf 'Synced the managed Pi setup from %s\n' "$agent_dir"
    printf 'Authentication, sessions, binaries, and node_modules were not copied.\n'
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Install mode: repo -> agent (default).
# ---------------------------------------------------------------------------
timestamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="${agent_dir}/backups/pi-agent-setup-${timestamp}"
backed_up=false

if [[ "$dry_run" == true ]]; then
  printf '[dry-run] Would install from %s -> %s\n' "$repo_dir" "$agent_dir"
fi

mkdir -p "$agent_dir"

# Move stale managed paths aside so Pi cannot load both old and new entries.
for relative_path in "${legacy_managed_paths[@]}"; do
  target_path="${agent_dir}/${relative_path}"
  if [[ -e "$target_path" || -L "$target_path" ]]; then
    if [[ "$dry_run" == true ]]; then
      printf '[dry-run] Would backup & remove orphan: %s\n' "$relative_path"
      continue
    fi
    mkdir -p "${backup_dir}/$(dirname -- "$relative_path")"
    mv "$target_path" "${backup_dir}/${relative_path}"
    backed_up=true
    printf 'Moved orphaned path to backup: %s -> %s\n' "$relative_path" "${backup_dir}/${relative_path}"
  fi
done

for relative_path in "${managed_files[@]}"; do
  source_path="${repo_dir}/${relative_path}"
  target_path="${agent_dir}/${relative_path}"

  if [[ "$dry_run" == true ]]; then
    if [[ -f "$target_path" ]] && ! cmp -s "$source_path" "$target_path"; then
      printf '[dry-run] Would backup & copy: %s (changed)\n' "$relative_path"
    elif [[ ! -e "$target_path" ]]; then
      printf '[dry-run] Would copy (new): %s\n' "$relative_path"
    else
      printf '[dry-run] Unchanged: %s\n' "$relative_path"
    fi
    continue
  fi

  if [[ -f "$target_path" ]] && ! cmp -s "$source_path" "$target_path"; then
    mkdir -p "${backup_dir}/$(dirname -- "$relative_path")"
    cp -p "$target_path" "${backup_dir}/${relative_path}"
    backed_up=true
  fi

  mkdir -p "$(dirname -- "$target_path")"
  cp -p "$source_path" "$target_path"
done

if [[ "$dry_run" == true ]]; then
  printf '[dry-run] Install dry-run complete. No files were changed.\n'
  if [[ "$backed_up" == true ]]; then
    printf '[dry-run] (would have created backup at %s if not dry-run)\n' "$backup_dir"
  fi
  exit 0
fi

# No retained extensions currently require npm install.
# Kept as a helper in case a future extension adds runtime deps.
install_extension_deps() {
  local ext_dir="$1"
  local prefix="${agent_dir}/${ext_dir}"
  if [[ ! -f "${prefix}/package.json" ]]; then
    return 0
  fi
  if [[ ! -f "${prefix}/package-lock.json" && ! -f "${prefix}/npm-shrinkwrap.json" && ! -f "${prefix}/package.json" ]]; then
    return 0
  fi
  if ! command -v npm >/dev/null 2>&1; then
    printf 'Skipping npm install for %s: npm not found\n' "$ext_dir" >&2
    return 0
  fi
  printf 'Installing deps for %s ...\n' "$ext_dir"
  if [[ -f "${prefix}/package-lock.json" ]]; then
    npm ci --omit=dev --prefix "$prefix" 2>&1 || {
      printf 'Warning: npm ci failed for %s (continuing)\n' "$ext_dir" >&2
      return 0
    }
  else
    npm install --omit=dev --prefix "$prefix" 2>&1 || {
      printf 'Warning: npm install failed for %s (continuing)\n' "$ext_dir" >&2
      return 0
    }
  fi
}

# No deps to install for the current trimmed set (btw/effort/status-footer are
# single-file, no package.json). Keep the block for extensibility.
for ext in ""; do
  [[ -z "$ext" ]] && continue
  install_extension_deps "$ext"
done

printf 'Installed Pi setup in %s\n' "$agent_dir"
if [[ "$backed_up" == true ]]; then
  printf 'Previous managed files were backed up to %s\n' "$backup_dir"
fi
printf 'Run pi and use /login if this machine is not authenticated.\n'
