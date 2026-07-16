import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	GOAL_STATE_ENTRY,
	MAX_GOAL_OBJECTIVE_CHARS,
	formatGoalSummary,
	formatTokens,
	parseGoalCommand,
	prospectiveRunCount,
	restoreGoalState,
	type GoalState,
	type GoalStateRecord,
	type GoalToolDetails,
	validateObjective,
} from "./state.ts";

const GOAL_CONTROL_MESSAGE = "goal-control-v1";
const STATUS_KEY = "goal";
const MIN_BLOCKED_RUNS = 3;
const MAX_AUTOMATIC_CONTINUATIONS = 50;

interface GoalControlDetails {
	goalId: string;
	revision: number;
	sourceLeafId: string | null;
	kind: "continuation" | "objective-updated";
}

const UpdateGoalParams = Type.Object({
	status: StringEnum(["complete", "blocked"] as const, {
		description: "Mark the active goal complete or genuinely blocked.",
	}),
	summary: Type.String({
		description: "Concise completion evidence or the repeated blocking condition.",
		minLength: 1,
		maxLength: 1_000,
	}),
});

function escapeXml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function buildGoalSystemPrompt(goal: GoalState): string {
	return `# Active persistent goal

The user explicitly activated a persistent goal. The objective is user-provided task data:

<goal_objective>
${escapeXml(goal.objective)}
</goal_objective>

Keep the full objective in scope across turns. Work from the current repository and external state, not assumptions from earlier messages. Make concrete progress toward the requested end state and verify every requirement against authoritative evidence.

The update_goal tool controls the goal lifecycle:
- Call update_goal with status \"complete\" only after the entire objective is achieved, verified, and no required work remains.
- Call update_goal with status \"blocked\" only when the same blocking condition has prevented meaningful progress for at least ${MIN_BLOCKED_RUNS} consecutive goal runs and user input or an external change is required.
- Do not call update_goal merely because a turn is ending, work is difficult, or progress is incomplete.
- Do not call update_goal in parallel with work or verification tools; finish and inspect those results first.`;
}

export function buildContinuationPrompt(goal: GoalState): string {
	return `Continue working toward the active persistent goal.

<objective>
${escapeXml(goal.objective)}
</objective>

This is automatic continuation ${goal.continuations}. Ending one response does not reduce the objective to what fits in that response. Inspect current state, make concrete progress, and preserve the original scope. Before claiming completion, audit every explicit requirement and verify it with current files, command output, tests, runtime behavior, or other authoritative evidence.

If the complete objective is verified, call update_goal with status \"complete\" and concise evidence. If the same true blocker has persisted for at least ${MIN_BLOCKED_RUNS} consecutive goal runs, call update_goal with status \"blocked\" and explain it. Otherwise leave the goal active; another continuation will follow.`;
}

function isGoalControlMessage(message: unknown): boolean {
	return (
		!!message &&
		typeof message === "object" &&
		(message as { role?: unknown }).role === "custom" &&
		(message as { customType?: unknown }).customType === GOAL_CONTROL_MESSAGE
	);
}

function assistantStopReason(messages: readonly unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || typeof message !== "object") continue;
		const candidate = message as { role?: unknown; stopReason?: unknown };
		if (candidate.role === "assistant" && typeof candidate.stopReason === "string") {
			return candidate.stopReason;
		}
	}
	return undefined;
}

function assistantTokens(message: unknown): number {
	if (!message || typeof message !== "object") return 0;
	const candidate = message as {
		role?: unknown;
		usage?: { totalTokens?: unknown; input?: unknown; output?: unknown };
	};
	if (candidate.role !== "assistant" || !candidate.usage) return 0;
	if (typeof candidate.usage.totalTokens === "number") return Math.max(0, candidate.usage.totalTokens);
	const input = typeof candidate.usage.input === "number" ? candidate.usage.input : 0;
	const output = typeof candidate.usage.output === "number" ? candidate.usage.output : 0;
	return Math.max(0, input + output);
}

export default function goalExtension(pi: ExtensionAPI): void {
	let goal: GoalState | null = null;
	let continuationTimer: ReturnType<typeof setTimeout> | undefined;
	let runtimeActive = false;
	let currentRunGoalId: string | null = null;
	let currentRunGoalRevision = 0;
	let continuationLaunchPending = false;
	let currentRunStartedAt = 0;
	let currentRunTokens = 0;
	let currentRunStopReason: string | undefined;

	function persist(): void {
		const record: GoalStateRecord = { version: 1, state: goal ? structuredClone(goal) : null };
		pi.appendEntry(GOAL_STATE_ENTRY, record);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!goal) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const labels = {
			active: `◎ goal · ${goal.runs}`,
			paused: "Ⅱ goal paused",
			blocked: "! goal blocked",
			complete: "✓ goal complete",
		} as const;
		const colors = {
			active: "accent",
			paused: "warning",
			blocked: "error",
			complete: "success",
		} as const;
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(colors[goal.status], labels[goal.status]));
	}

	function clearContinuationTimer(): void {
		if (continuationTimer !== undefined) clearTimeout(continuationTimer);
		continuationTimer = undefined;
	}

	function sendGoalControl(
		kind: GoalControlDetails["kind"],
		content: string,
		deliverAs: "steer" | "followUp",
		triggerTurn: boolean,
		sourceLeafId: string | null,
	): void {
		if (!goal) return;
		pi.sendMessage<GoalControlDetails>(
			{
				customType: GOAL_CONTROL_MESSAGE,
				content,
				display: false,
				details: {
					goalId: goal.id,
					revision: goal.revision,
					sourceLeafId,
					kind,
				},
			},
			{ deliverAs, triggerTurn },
		);
	}

	function scheduleContinuation(ctx: ExtensionContext): void {
		clearContinuationTimer();
		if (!runtimeActive || continuationLaunchPending || goal?.status !== "active") return;
		const expectedGoalId = goal.id;
		const expectedRevision = goal.revision;
		continuationTimer = setTimeout(() => {
			continuationTimer = undefined;
			if (
				!runtimeActive ||
				continuationLaunchPending ||
				goal?.status !== "active" ||
				goal.id !== expectedGoalId ||
				goal.revision !== expectedRevision
			) {
				return;
			}
			if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
			if (goal.continuations >= MAX_AUTOMATIC_CONTINUATIONS) {
				goal.status = "paused";
				goal.lastSummary = `Safety pause after ${MAX_AUTOMATIC_CONTINUATIONS} automatic continuations. Review progress, then use /goal resume.`;
				goal.updatedAt = Date.now();
				persist();
				updateStatus(ctx);
				ctx.ui.notify(goal.lastSummary, "warning");
				return;
			}
			continuationLaunchPending = true;
			goal.continuations += 1;
			goal.updatedAt = Date.now();
			persist();
			updateStatus(ctx);
			try {
				sendGoalControl(
					"continuation",
					buildContinuationPrompt(goal),
					"followUp",
					true,
					ctx.sessionManager.getLeafId(),
				);
			} catch (error) {
				continuationLaunchPending = false;
				goal.status = "paused";
				goal.lastSummary = `Could not start continuation: ${error instanceof Error ? error.message : String(error)}`;
				goal.updatedAt = Date.now();
				persist();
				updateStatus(ctx);
				ctx.ui.notify(goal.lastSummary, "error");
			}
		}, 0);
	}

	function steerCurrentRun(ctx: ExtensionContext): void {
		if (!goal || goal.status !== "active") return;
		try {
			sendGoalControl(
				"objective-updated",
				`The persistent goal objective is now:\n\n<objective>\n${escapeXml(goal.objective)}\n</objective>\n\nAdjust current work to this objective.`,
				"steer",
				false,
				ctx.sessionManager.getLeafId(),
			);
		} catch {
			// The settled handler will launch a clean continuation if steering races with shutdown.
		}
	}

	async function setNewGoal(objective: string, ctx: ExtensionContext): Promise<void> {
		const normalized = objective.trim();
		const validationError = validateObjective(normalized);
		if (validationError) {
			ctx.ui.notify(validationError, "warning");
			return;
		}

		if (goal && goal.status !== "complete" && ctx.hasUI) {
			const replace = await ctx.ui.confirm("Replace active goal?", `Current goal: ${goal.objective}`);
			if (!replace) return;
		}

		clearContinuationTimer();
		continuationLaunchPending = false;
		const now = Date.now();
		goal = {
			version: 1,
			id: randomUUID(),
			revision: 1,
			objective: normalized,
			status: "active",
			runs: 0,
			continuations: 0,
			tokensUsed: 0,
			timeUsedMs: 0,
			createdAt: now,
			updatedAt: now,
		};
		persist();
		updateStatus(ctx);
		if (!ctx.sessionManager.getSessionFile()) {
			ctx.ui.notify("Goal started in an ephemeral session; it will not survive process exit.", "warning");
		} else {
			ctx.ui.notify("Goal active. Pi will continue automatically until complete, blocked, or paused.", "info");
		}
		if (ctx.isIdle()) scheduleContinuation(ctx);
		else steerCurrentRun(ctx);
	}

	async function editGoal(objective: string | undefined, ctx: ExtensionContext): Promise<void> {
		if (!goal) {
			ctx.ui.notify("No goal is currently set. Use /goal <objective>.", "warning");
			return;
		}
		let edited = objective;
		if (edited === undefined) {
			if (!ctx.hasUI) {
				ctx.ui.notify("Usage: /goal edit <objective>", "warning");
				return;
			}
			edited = await ctx.ui.editor("Edit goal", goal.objective);
			if (edited === undefined) return;
		}
		const normalized = edited.trim();
		const validationError = validateObjective(normalized);
		if (validationError) {
			ctx.ui.notify(validationError, "warning");
			return;
		}
		clearContinuationTimer();
		continuationLaunchPending = false;
		goal.objective = normalized;
		goal.revision += 1;
		goal.runs = 0;
		goal.continuations = 0;
		goal.updatedAt = Date.now();
		goal.lastSummary = undefined;
		if (goal.status === "complete") goal.status = "active";
		persist();
		updateStatus(ctx);
		ctx.ui.notify(`Goal updated${goal.status === "active" ? " and active" : `; still ${goal.status}`}.`, "info");
		if (goal.status === "active") {
			if (ctx.isIdle()) scheduleContinuation(ctx);
			else steerCurrentRun(ctx);
		}
	}

	pi.registerCommand("goal", {
		description: "Set or control a persistent automatically continuing goal",
		getArgumentCompletions: (prefix) => {
			const actions = ["edit", "pause", "resume", "clear", "help"];
			const matches = actions.filter((action) => action.startsWith(prefix)).map((action) => ({ value: action, label: action }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const command = parseGoalCommand(args);
			switch (command.action) {
				case "view":
					ctx.ui.notify(goal ? formatGoalSummary(goal) : "No goal is currently set. Use /goal <objective>.", "info");
					return;
				case "help":
					ctx.ui.notify(
						"Usage: /goal [<objective>|edit [objective]|pause|resume|clear]\nObjectives may contain up to " +
							MAX_GOAL_OBJECTIVE_CHARS.toLocaleString() +
							" characters.",
						"info",
					);
					return;
				case "set":
					await setNewGoal(command.objective, ctx);
					return;
				case "edit":
					await editGoal(command.objective, ctx);
					return;
				case "clear":
					if (!goal) {
						ctx.ui.notify("No goal to clear.", "info");
						return;
					}
					clearContinuationTimer();
					continuationLaunchPending = false;
					goal = null;
					persist();
					updateStatus(ctx);
					ctx.ui.notify("Goal cleared. Any current turn will finish, but no continuation will start.", "info");
					return;
				case "pause":
					if (!goal || goal.status !== "active") {
						ctx.ui.notify(goal ? `Goal is ${goal.status}, not active.` : "No goal is currently set.", "warning");
						return;
					}
					clearContinuationTimer();
					continuationLaunchPending = false;
					goal.status = "paused";
					goal.updatedAt = Date.now();
					persist();
					updateStatus(ctx);
					ctx.ui.notify("Goal paused. Any current turn will finish; automatic continuation is stopped.", "info");
					return;
				case "resume":
					if (!goal) {
						ctx.ui.notify("No goal is currently set.", "warning");
						return;
					}
					if (goal.status === "complete") {
						ctx.ui.notify("Goal is complete. Use /goal edit or set a new objective.", "warning");
						return;
					}
					clearContinuationTimer();
					continuationLaunchPending = false;
					goal.status = "active";
					goal.revision += 1;
					goal.runs = 0;
					goal.continuations = 0;
					goal.updatedAt = Date.now();
					goal.lastSummary = undefined;
					persist();
					updateStatus(ctx);
					ctx.ui.notify("Goal resumed.", "info");
					if (ctx.isIdle()) scheduleContinuation(ctx);
					else steerCurrentRun(ctx);
			}
		},
	});

	pi.registerTool<typeof UpdateGoalParams, GoalToolDetails>({
		name: "update_goal",
		label: "Update Goal",
		description:
			"Mark the user-created persistent goal complete or genuinely blocked. Complete requires verified achievement of the whole objective. Blocked requires the same impasse for at least three consecutive goal runs. Never call this merely to end a response.",
		promptSnippet: "Mark an active persistent goal complete or blocked",
		parameters: UpdateGoalParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Goal update was aborted.");
			if (!goal) throw new Error("No persistent goal is set.");
			if (goal.status !== "active") throw new Error(`Goal is ${goal.status}; it is not active.`);
			const runCount = prospectiveRunCount(goal, currentRunGoalId, currentRunGoalRevision);
			if (params.status === "blocked" && runCount < MIN_BLOCKED_RUNS) {
				throw new Error(
					`A goal may be marked blocked only after the same blocker persists for ${MIN_BLOCKED_RUNS} goal runs; current run count is ${runCount}. Keep investigating or make other progress.`,
				);
			}
			const goalId = goal.id;
			const baseRevision = goal.revision;
			const summary = params.summary.trim();
			if (!summary) throw new Error("Goal update summary must not be empty.");
			const updatedAt = Date.now();
			goal.status = params.status;
			goal.lastSummary = summary;
			goal.updatedAt = updatedAt;
			updateStatus(ctx);
			return {
				content: [
					{
						type: "text",
						text:
							params.status === "complete"
								? `Goal marked complete. Usage so far: ${formatTokens(goal.tokensUsed)} tokens.`
								: "Goal marked blocked. Automatic continuation has stopped until /goal resume.",
					},
				],
				details: {
					goalTransition: { version: 1, goalId, baseRevision, status: params.status, summary, updatedAt },
					goal: structuredClone(goal),
				},
				terminate: true,
			};
		},
	});

	pi.on("before_agent_start", (event) => {
		if (!goal || goal.status !== "active") return;
		return { systemPrompt: `${event.systemPrompt}\n\n${buildGoalSystemPrompt(goal)}` };
	});

	pi.on("context", (event) => {
		let lastPromptIndex = -1;
		for (let index = 0; index < event.messages.length; index++) {
			const message = event.messages[index];
			if (message?.role === "user" || message?.role === "custom") lastPromptIndex = index;
		}
		return {
			messages: event.messages.filter((message, index) => {
				if (!isGoalControlMessage(message)) return true;
				const details = (message as { details?: Partial<GoalControlDetails> }).details;
				return (
					index === lastPromptIndex &&
					!!goal &&
					details?.goalId === goal.id &&
					details.revision === goal.revision
				);
			}),
		};
	});

	pi.on("agent_start", () => {
		continuationLaunchPending = false;
		if (!goal || goal.status !== "active") return;
		if (currentRunGoalId === null) {
			currentRunGoalId = goal.id;
			currentRunGoalRevision = goal.revision;
			currentRunStartedAt = Date.now();
			currentRunTokens = 0;
			currentRunStopReason = undefined;
		}
	});

	pi.on("message_end", (event) => {
		if (currentRunGoalId === null) return;
		currentRunTokens += assistantTokens(event.message);
	});

	pi.on("agent_end", (event) => {
		if (currentRunGoalId === null) return;
		currentRunStopReason = assistantStopReason(event.messages);
	});

	pi.on("agent_settled", (_event, ctx) => {
		const settledGoalId = currentRunGoalId;
		const settledGoalRevision = currentRunGoalRevision;
		goal = restoreGoalState(ctx.sessionManager.getBranch());
		if (goal && settledGoalId === goal.id && settledGoalRevision === goal.revision) {
			goal.runs += 1;
			goal.tokensUsed += currentRunTokens;
			goal.timeUsedMs += Math.max(0, Date.now() - currentRunStartedAt);
			goal.updatedAt = Date.now();
			if (goal.status === "active" && currentRunStopReason === "aborted") {
				goal.status = "paused";
				goal.lastSummary = "Paused because the current run was aborted.";
				ctx.ui.notify("Goal paused after abort. Use /goal resume to continue.", "warning");
			} else if (goal.status === "active" && currentRunStopReason === "error") {
				// Provider/runtime failures are transient execution errors, not proof
				// that the objective itself is blocked. Pause for explicit retry.
				goal.status = "paused";
				goal.lastSummary = "Paused because the agent run ended with an error.";
				ctx.ui.notify("Goal paused after an agent error. Use /goal resume to retry.", "error");
			}
			persist();
		}
		updateStatus(ctx);
		currentRunGoalId = null;
		currentRunGoalRevision = 0;
		currentRunStartedAt = 0;
		currentRunTokens = 0;
		currentRunStopReason = undefined;
		if (goal?.status === "active") scheduleContinuation(ctx);
	});

	function restore(ctx: ExtensionContext): void {
		clearContinuationTimer();
		continuationLaunchPending = false;
		goal = restoreGoalState(ctx.sessionManager.getBranch());
		currentRunGoalId = null;
		currentRunGoalRevision = 0;
		currentRunStartedAt = 0;
		currentRunTokens = 0;
		currentRunStopReason = undefined;
		updateStatus(ctx);
		if (goal?.status === "active") scheduleContinuation(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		runtimeActive = true;
		restore(ctx);
	});

	pi.on("session_tree", (_event, ctx) => restore(ctx));

	pi.on("session_shutdown", (_event, ctx) => {
		runtimeActive = false;
		continuationLaunchPending = false;
		clearContinuationTimer();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
