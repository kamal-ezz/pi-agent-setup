import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function notificationBody(ctx: ExtensionContext): string {
	const sessionName = ctx.sessionManager.getSessionName();
	const location = sessionName || basename(ctx.cwd) || ctx.cwd;
	return `${location}: turn finished — ready for input`;
}

export default function (pi: ExtensionAPI) {
	let enabled = true;

	async function notify(ctx: ExtensionContext, body = notificationBody(ctx)): Promise<void> {
		if (ctx.mode !== "tui") return;
		const result = await pi.exec(
			"notify-send",
			[
				"--app-name=Pi",
				"--urgency=normal",
				"--expire-time=7000",
				"Pi",
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
					await notify(ctx, "Desktop notifications are working.");
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
