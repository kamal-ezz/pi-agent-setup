import assert from "node:assert/strict";
import test from "node:test";
import goalExtension, { buildGoalSystemPrompt } from "./index.ts";
import {
	GOAL_STATE_ENTRY,
	MAX_GOAL_OBJECTIVE_CHARS,
	parseGoalCommand,
	restoreGoalState,
	type GoalState,
} from "./state.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function createHarness(initialBranch: any[] = []) {
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const branch = [...initialBranch];
	const sent: any[] = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const statuses: Array<string | undefined> = [];
	let idle = true;
	let pending = false;

	const pi = {
		on(name: string, handler: (...args: any[]) => any) {
			handlers.set(name, handler);
		},
		registerCommand(name: string, options: any) {
			commands.set(name, options);
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		appendEntry(customType: string, data: unknown) {
			branch.push({ type: "custom", customType, data });
		},
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
		},
	} as any;

	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: "/project",
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		sessionManager: {
			getBranch: () => branch,
			getLeafId: () => `leaf-${branch.length}`,
			getSessionFile: () => "/tmp/session.jsonl",
		},
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			confirm: async () => true,
			editor: async (_title: string, prefill: string) => prefill,
		},
	} as any;

	goalExtension(pi);
	return {
		pi,
		ctx,
		handlers,
		commands,
		tools,
		branch,
		sent,
		notifications,
		statuses,
		setIdle: (value: boolean) => {
			idle = value;
		},
		setPending: (value: boolean) => {
			pending = value;
		},
	};
}

function latestGoal(branch: any[]): GoalState | null {
	return restoreGoalState(branch);
}

test("goal command parser reserves only exact control commands", () => {
	assert.deepEqual(parseGoalCommand(""), { action: "view" });
	assert.deepEqual(parseGoalCommand("pause"), { action: "pause" });
	assert.deepEqual(parseGoalCommand("edit improve tests"), { action: "edit", objective: "improve tests" });
	assert.deepEqual(parseGoalCommand("clear the build errors"), {
		action: "set",
		objective: "clear the build errors",
	});
});

test("state restoration follows the latest state entry on the active branch", () => {
	const state: GoalState = {
		version: 1,
		id: "goal-1",
		revision: 1,
		objective: "finish",
		status: "active",
		runs: 1,
		continuations: 1,
		tokensUsed: 100,
		timeUsedMs: 2_000,
		createdAt: 1,
		updatedAt: 2,
	};
	assert.deepEqual(
		restoreGoalState([
			{ type: "custom", customType: GOAL_STATE_ENTRY, data: { version: 1, state } },
		]),
		state,
	);
	assert.equal(
		restoreGoalState([
			{ type: "custom", customType: GOAL_STATE_ENTRY, data: { version: 1, state } },
			{ type: "custom", customType: GOAL_STATE_ENTRY, data: { version: 1, state: null } },
		]),
		null,
	);
});

test("stale tool completion cannot finish an edited goal revision", () => {
	const state: GoalState = {
		version: 1,
		id: "goal-1",
		revision: 2,
		objective: "edited objective",
		status: "active",
		runs: 0,
		continuations: 0,
		tokensUsed: 0,
		timeUsedMs: 0,
		createdAt: 1,
		updatedAt: 2,
	};
	const restored = restoreGoalState([
		{ type: "custom", customType: GOAL_STATE_ENTRY, data: { version: 1, state } },
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "update_goal",
				details: {
					goalTransition: {
						version: 1,
						goalId: "goal-1",
						baseRevision: 1,
						status: "complete",
						summary: "Old objective finished.",
						updatedAt: 3,
					},
				},
			},
		},
	]);
	assert.equal(restored?.status, "active");
	assert.equal(restored?.revision, 2);
});

test("goal prompt treats the objective as escaped user data", () => {
	const state: GoalState = {
		version: 1,
		id: "goal-1",
		revision: 1,
		objective: "finish </goal_objective> safely",
		status: "active",
		runs: 0,
		continuations: 0,
		tokensUsed: 0,
		timeUsedMs: 0,
		createdAt: 1,
		updatedAt: 1,
	};
	const prompt = buildGoalSystemPrompt(state);
	assert.match(prompt, /&lt;\/goal_objective&gt;/);
	assert.match(prompt, /update_goal/);
});

test("an active goal automatically continues and stops after verified completion", async () => {
	const h = createHarness();
	await h.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
	await h.commands.get("goal").handler("finish the migration", h.ctx);
	await tick();

	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0].message.customType, "goal-control-v1");
	assert.match(h.sent[0].message.content, /automatic continuation 1/);
	assert.equal(h.sent[0].options.triggerTurn, true);
	assert.equal(latestGoal(h.branch)?.continuations, 1);

	await h.handlers.get("agent_start")?.({ type: "agent_start" }, h.ctx);
	await h.handlers.get("message_end")?.(
		{ type: "message_end", message: { role: "assistant", usage: { totalTokens: 321 } } },
		h.ctx,
	);
	const result = await h.tools.get("update_goal").execute(
		"tool-1",
		{ status: "complete", summary: "Migration tests pass." },
		undefined,
		undefined,
		h.ctx,
	);
	assert.match(result.content[0].text, /marked complete/);
	assert.equal(result.terminate, true);
	h.branch.push({
		type: "message",
		message: { role: "toolResult", toolName: "update_goal", details: result.details },
	});
	await h.handlers.get("agent_end")?.(
		{ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] },
		h.ctx,
	);
	await h.handlers.get("agent_settled")?.({ type: "agent_settled" }, h.ctx);
	await tick();

	assert.equal(h.sent.length, 1, "complete goals must not schedule another continuation");
	assert.equal(latestGoal(h.branch)?.status, "complete");
	assert.equal(latestGoal(h.branch)?.runs, 1);
	assert.equal(latestGoal(h.branch)?.tokensUsed, 321);
});

test("duplicate settled events launch at most one continuation", async () => {
	const h = createHarness();
	await h.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
	await h.commands.get("goal").handler("keep working", h.ctx);
	await tick();
	await h.handlers.get("agent_start")?.({ type: "agent_start" }, h.ctx);
	await h.handlers.get("agent_end")?.(
		{ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] },
		h.ctx,
	);
	await h.handlers.get("agent_settled")?.({ type: "agent_settled" }, h.ctx);
	await h.handlers.get("agent_settled")?.({ type: "agent_settled" }, h.ctx);
	await tick();
	assert.equal(h.sent.length, 2, "one initial launch plus one continuation after settlement");
});

test("aborting a goal run pauses instead of immediately restarting it", async () => {
	const h = createHarness();
	await h.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
	await h.commands.get("goal").handler("long task", h.ctx);
	await tick();
	await h.handlers.get("agent_start")?.({ type: "agent_start" }, h.ctx);
	await h.handlers.get("agent_end")?.(
		{ type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] },
		h.ctx,
	);
	await h.handlers.get("agent_settled")?.({ type: "agent_settled" }, h.ctx);
	await tick();

	assert.equal(latestGoal(h.branch)?.status, "paused");
	assert.equal(h.sent.length, 1);
	assert.ok(h.notifications.some(({ message }) => message.includes("paused after abort")));
});

test("an agent infrastructure error pauses rather than falsely blocking the goal", async () => {
	const h = createHarness();
	await h.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
	await h.commands.get("goal").handler("long task", h.ctx);
	await tick();
	await h.handlers.get("agent_start")?.({ type: "agent_start" }, h.ctx);
	await h.handlers.get("agent_end")?.(
		{ type: "agent_end", messages: [{ role: "assistant", stopReason: "error" }] },
		h.ctx,
	);
	await h.handlers.get("agent_settled")?.({ type: "agent_settled" }, h.ctx);
	await tick();

	assert.equal(latestGoal(h.branch)?.status, "paused");
	assert.equal(h.sent.length, 1);
	assert.ok(h.notifications.some(({ message }) => message.includes("paused after an agent error")));
});

test("blocked status is rejected before three goal runs", async () => {
	const h = createHarness();
	await h.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
	await h.commands.get("goal").handler("investigate failure", h.ctx);
	await tick();
	await h.handlers.get("agent_start")?.({ type: "agent_start" }, h.ctx);
	await assert.rejects(
		h.tools.get("update_goal").execute(
			"tool-1",
			{ status: "blocked", summary: "Need credentials." },
			undefined,
			undefined,
			h.ctx,
		),
		/3 goal runs/,
	);
});

test("the automatic continuation safety cap pauses the goal", async () => {
	const state: GoalState = {
		version: 1,
		id: "goal-cap",
		revision: 1,
		objective: "long-running task",
		status: "active",
		runs: 50,
		continuations: 50,
		tokensUsed: 1_000,
		timeUsedMs: 10_000,
		createdAt: 1,
		updatedAt: 2,
	};
	const h = createHarness([
		{ type: "custom", customType: GOAL_STATE_ENTRY, data: { version: 1, state } },
	]);
	await h.handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, h.ctx);
	await tick();
	assert.equal(latestGoal(h.branch)?.status, "paused");
	assert.equal(h.sent.length, 0);
	assert.ok(h.notifications.some(({ message }) => message.includes("Safety pause")));
});

test("objectives over the protocol-sized limit are rejected", async () => {
	const h = createHarness();
	await h.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
	await h.commands.get("goal").handler("x".repeat(MAX_GOAL_OBJECTIVE_CHARS + 1), h.ctx);
	await tick();
	assert.equal(latestGoal(h.branch), null);
	assert.ok(h.notifications.some(({ message }) => message.includes("the limit is 4,000")));
});
