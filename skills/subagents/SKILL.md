---
name: subagents
description: invoke this skill when the user asks you to use subagents
---

# Subagents

Each subagent is silent and headless, has its own context window, cannot see the parent conversation, cannot ask the user, cannot spawn more agents/workflows, and must not emit desktop or audio notifications. Give every child a self-contained prompt with paths, constraints, and the expected report.

## Allowed harnesses

Use GPT-backed harnesses only:

- `pi` — preferred; in-process Pi session with normal inherited tools/config.
- `codex` — use only when the user explicitly needs Codex CLI behavior.

Never use the Claude harness or any Anthropic model.

## Model routing

Only these models are allowed. Omit `model` to let the extension route automatically, or choose according to this table:

| Model | Use for | Recommended effort |
| --- | --- | --- |
| `gpt-5.6-luna` | Simple lookups, file discovery, summaries, extraction, repetitive/high-volume checks | `medium` |
| `gpt-5.6-terra` | Standard coding, tests, repository research, ordinary review and implementation | `medium` |
| `gpt-5.6-sol` | Complex architecture, difficult debugging, security, migrations, concurrency, high-stakes review | `medium` |

Sol is the frontier tier, Terra balances intelligence and cost, and Luna is the cost-sensitive high-volume tier. Complex or high-risk signals take priority over words such as “quick.”

For the Pi harness, model ids resolve to `openai-codex/gpt-5.6-*`. For Codex, use the bare `gpt-5.6-*` slug. The extension normalizes this automatically.

## Spawn and manage

Call `subagent_spawn` with a complete `prompt`, short `name`, `harness: "pi"` by default, and optional `working_dir`, `model`, and `reasoning_effort`. At most four subagents run concurrently.

- `subagent_check({ id })`: peek without blocking.
- `subagent_list()`: list all runs.
- `subagent_wait({ ids })`: block only when results are required to proceed.
- `subagent_cancel({ ids })`: stop runs while preserving partial transcripts.
- `/subagents`: inspect or take over a run interactively.

Results return silently into the parent conversation. After spawning, continue useful parent work instead of immediately waiting.
