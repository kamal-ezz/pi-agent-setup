import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_OVERVIEW_CHARS = 180;
const MAX_OVERVIEW_LINES = 3;

function notificationLocation(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionName() || basename(ctx.cwd) || ctx.cwd;
}

function cleanMarkdownLine(line: string): string {
	return line
		.trim()
		.replace(/^#{1,6}\s+/, "")
		.replace(/^>\s?/, "")
		.replace(/^[-*+]\s+/, "• ")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/~~([^~]+)~~/g, "$1")
		.replace(/\s+/g, " ");
}

function truncateOverview(value: string): string {
	const characters = Array.from(value);
	if (characters.length <= MAX_OVERVIEW_CHARS) return value;

	const shortened = characters.slice(0, MAX_OVERVIEW_CHARS - 1).join("");
	const lastBreak = Math.max(shortened.lastIndexOf(" "), shortened.lastIndexOf("\n"));
	return `${lastBreak >= MAX_OVERVIEW_CHARS * 0.7 ? shortened.slice(0, lastBreak) : shortened}…`;
}

function responseOverview(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;

		let inCodeBlock = false;
		const lines: string[] = [];
		for (const part of entry.message.content) {
			if (part.type !== "text") continue;
			for (const rawLine of part.text.split("\n")) {
				if (rawLine.trim().startsWith("```")) {
					inCodeBlock = !inCodeBlock;
					continue;
				}
				if (inCodeBlock) continue;
				const line = cleanMarkdownLine(rawLine);
				if (line) lines.push(line);
				if (lines.length === MAX_OVERVIEW_LINES) break;
			}
			if (lines.length === MAX_OVERVIEW_LINES) break;
		}

		const overview = truncateOverview(lines.join("\n"));
		if (overview) return overview;
		if (entry.message.errorMessage) return truncateOverview(entry.message.errorMessage);
	}
	return "Turn finished — ready for input.";
}

export default function (pi: ExtensionAPI) {
	let enabled = true;

	async function notify(ctx: ExtensionContext, body = responseOverview(ctx)): Promise<void> {
		if (ctx.mode !== "tui") return;
		const result = await pi.exec(
			"notify-send",
			[
				"--app-name=Pi",
				"--urgency=normal",
				"--expire-time=10000",
				`Pi — ${notificationLocation(ctx)}`,
				body,
			],
			{ timeout: 5000 },
		);
		if (result.code !== 0) {
			throw new Error(result.stderr.trim() || `notify-send exited with code ${result.code}`);
		}
	}

	// agent_settled fires once after tool calls, retries, compaction, and queued
	// continuations have all completed. turn_end can fire several times in one run.
	pi.on("agent_settled", async (_event, ctx) => {
		if (!enabled) return;
		try {
			await notify(ctx);
		} catch {
			// Desktop notification availability should never interrupt the agent.
		}
	});

	pi.registerCommand("notifications", {
		description: "Control desktop turn-complete notifications: /notifications [on|off|test]",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (!action) {
				ctx.ui.notify(`Desktop notifications are ${enabled ? "on" : "off"}.`, "info");
				return;
			}
			if (action === "on") {
				enabled = true;
				ctx.ui.notify("Desktop notifications enabled.", "info");
				return;
			}
			if (action === "off") {
				enabled = false;
				ctx.ui.notify("Desktop notifications disabled.", "info");
				return;
			}
			if (action === "test") {
				try {
					await notify(ctx, "Pi shows a concise overview of the completed response.\n• Up to three lines\n• Limited to 180 characters");
					ctx.ui.notify("Test notification sent.", "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			ctx.ui.notify("Usage: /notifications [on|off|test]", "warning");
		},
	});
}
