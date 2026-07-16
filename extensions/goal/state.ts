export const GOAL_STATE_ENTRY = "goal-state-v1";
export const MAX_GOAL_OBJECTIVE_CHARS = 4_000;

export type GoalStatus = "active" | "paused" | "blocked" | "complete";

export interface GoalState {
	version: 1;
	id: string;
	revision: number;
	objective: string;
	status: GoalStatus;
	runs: number;
	continuations: number;
	tokensUsed: number;
	timeUsedMs: number;
	createdAt: number;
	updatedAt: number;
	lastSummary?: string;
}

export interface GoalStateRecord {
	version: 1;
	state: GoalState | null;
}

export interface GoalToolTransition {
	version: 1;
	goalId: string;
	baseRevision: number;
	status: "complete" | "blocked";
	summary: string;
	updatedAt: number;
}

export interface GoalToolDetails {
	goalTransition: GoalToolTransition;
	goal: GoalState;
}

export type GoalCommand =
	| { action: "view" }
	| { action: "help" }
	| { action: "clear" }
	| { action: "pause" }
	| { action: "resume" }
	| { action: "edit"; objective?: string }
	| { action: "set"; objective: string };

export function parseGoalCommand(raw: string): GoalCommand {
	const input = raw.trim();
	if (!input) return { action: "view" };
	if (input === "help") return { action: "help" };
	if (input === "clear") return { action: "clear" };
	if (input === "pause") return { action: "pause" };
	if (input === "resume") return { action: "resume" };
	if (input === "edit") return { action: "edit" };
	if (input.startsWith("edit ")) return { action: "edit", objective: input.slice(5).trim() };
	return { action: "set", objective: input };
}

export function objectiveLength(objective: string): number {
	return Array.from(objective).length;
}

export function validateObjective(objective: string): string | undefined {
	if (!objective.trim()) return "Goal objective must not be empty.";
	const length = objectiveLength(objective);
	if (length > MAX_GOAL_OBJECTIVE_CHARS) {
		return `Goal objective is ${length.toLocaleString()} characters; the limit is ${MAX_GOAL_OBJECTIVE_CHARS.toLocaleString()}. Put longer instructions in a file and reference it.`;
	}
	return undefined;
}

function isGoalStatus(value: unknown): value is GoalStatus {
	return value === "active" || value === "paused" || value === "blocked" || value === "complete";
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isGoalState(value: unknown): value is GoalState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<GoalState>;
	return (
		state.version === 1 &&
		typeof state.id === "string" &&
		state.id.length > 0 &&
		Number.isInteger(state.revision) &&
		(state.revision ?? 0) > 0 &&
		typeof state.objective === "string" &&
		!validateObjective(state.objective) &&
		isGoalStatus(state.status) &&
		Number.isInteger(state.runs) &&
		(state.runs ?? -1) >= 0 &&
		Number.isInteger(state.continuations) &&
		(state.continuations ?? -1) >= 0 &&
		isNonNegativeFiniteNumber(state.tokensUsed) &&
		isNonNegativeFiniteNumber(state.timeUsedMs) &&
		isNonNegativeFiniteNumber(state.createdAt) &&
		isNonNegativeFiniteNumber(state.updatedAt) &&
		(state.lastSummary === undefined ||
			(typeof state.lastSummary === "string" && state.lastSummary.length <= 1_000))
	);
}

function isGoalToolTransition(value: unknown): value is GoalToolTransition {
	if (!value || typeof value !== "object") return false;
	const transition = value as Partial<GoalToolTransition>;
	return (
		transition.version === 1 &&
		typeof transition.goalId === "string" &&
		transition.goalId.length > 0 &&
		Number.isInteger(transition.baseRevision) &&
		(transition.baseRevision ?? 0) > 0 &&
		(transition.status === "complete" || transition.status === "blocked") &&
		typeof transition.summary === "string" &&
		transition.summary.trim().length > 0 &&
		transition.summary.length <= 1_000 &&
		isNonNegativeFiniteNumber(transition.updatedAt)
	);
}

export function restoreGoalState(
	branch: ReadonlyArray<{
		type: string;
		customType?: string;
		data?: unknown;
		message?: { role?: string; toolName?: string; details?: unknown };
	}>,
): GoalState | null {
	let state: GoalState | null = null;
	for (const entry of branch) {
		if (entry.type === "custom" && entry.customType === GOAL_STATE_ENTRY) {
			const record = entry.data as Partial<GoalStateRecord> | undefined;
			state = record?.version === 1 && isGoalState(record.state) ? structuredClone(record.state) : null;
			continue;
		}
		if (entry.type !== "message" || entry.message?.role !== "toolResult" || entry.message.toolName !== "update_goal") {
			continue;
		}
		const details = entry.message.details as Partial<GoalToolDetails> | undefined;
		const transition = details?.goalTransition;
		if (
			!state ||
			state.status !== "active" ||
			!isGoalToolTransition(transition) ||
			transition.goalId !== state.id ||
			transition.baseRevision !== state.revision
		) {
			continue;
		}
		state = {
			...state,
			status: transition.status,
			lastSummary: transition.summary,
			updatedAt: transition.updatedAt,
		};
	}
	return state;
}

export function formatDuration(milliseconds: number): string {
	const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`;
	const hours = Math.floor(totalMinutes / 60);
	return `${hours}h ${totalMinutes % 60}m`;
}

export function formatTokens(tokens: number): string {
	if (tokens < 1_000) return String(Math.max(0, Math.round(tokens)));
	if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}m`;
}

export function formatGoalSummary(goal: GoalState): string {
	const lines = [
		"Goal",
		`Status: ${goal.status}`,
		`Objective: ${goal.objective}`,
		`Runs: ${goal.runs} (${goal.continuations} automatic continuation${goal.continuations === 1 ? "" : "s"})`,
		`Usage: ${formatTokens(goal.tokensUsed)} tokens · ${formatDuration(goal.timeUsedMs)}`,
	];
	if (goal.lastSummary) lines.push(`Last update: ${goal.lastSummary}`);
	const commands =
		goal.status === "active"
			? "Commands: /goal edit, /goal pause, /goal clear"
			: goal.status === "complete"
				? "Commands: /goal edit, /goal clear"
				: "Commands: /goal edit, /goal resume, /goal clear";
	lines.push("", commands);
	return lines.join("\n");
}

export function prospectiveRunCount(
	goal: GoalState,
	currentRunGoalId: string | null,
	currentRunGoalRevision: number,
): number {
	return goal.runs + (currentRunGoalId === goal.id && currentRunGoalRevision === goal.revision ? 1 : 0);
}
