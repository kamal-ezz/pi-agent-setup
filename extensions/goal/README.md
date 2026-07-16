# Persistent Goal for Pi

Codex-style persistent goals for Pi.

## Commands

- `/goal <objective>` — set a goal and start automatic continuation
- `/goal` — show goal status and usage
- `/goal edit [objective]` — edit the current goal
- `/goal pause` — stop after the current run
- `/goal resume` — resume automatic continuation
- `/goal clear` — remove the goal

The extension stores state as branch-aware custom session entries. Active goals resume with the session and continue after `agent_settled`. The model must call `update_goal` to mark the full objective complete or genuinely blocked. Pressing Escape/aborting pauses the goal rather than starting another turn.

For runaway protection, a goal pauses after 50 automatic continuations in one objective revision. Review progress and use `/goal resume` to start a fresh continuation allowance.

Objectives are limited to 4,000 characters. Put longer specifications in a project file and reference that file from the objective.
