import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_OVERVIEW_CHARS = 180;
const MAX_OVERVIEW_LINES = 3;
const FOCUS_REPORTING_ENABLE = "\x1b[?1004h";
const FOCUS_REPORTING_DISABLE = "\x1b[?1004l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const COMPLETION_CHIME_PATH = "/usr/share/sounds/ocean/stereo/completion-success.oga";

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

function wasAborted(messages: readonly unknown[]): boolean {
	return messages.some((message) => {
		if (!message || typeof message !== "object") return false;
		const value = message as {
			role?: unknown;
			stopReason?: unknown;
			isError?: unknown;
			content?: unknown;
		};
		if (value.role === "assistant" && value.stopReason === "aborted") return true;
		if (value.role !== "toolResult" || value.isError !== true || !Array.isArray(value.content)) return false;
		return value.content.some(
			(part) =>
				part &&
				typeof part === "object" &&
				(part as { type?: unknown; text?: unknown }).type === "text" &&
				(part as { text?: unknown }).text === "Operation aborted",
		);
	});
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
	let suppressNextSettledNotification = false;
	// Some terminal tabs (including Ghostty tabs) do not reliably send an
	// initial or tab-switch focus sequence. Fail open so a missed sequence does
	// not silently lose a completion alert; explicit focus-in still suppresses it.
	let terminalFocused = false;
	let focusInput = "";
	let focusListener: ((data: string | Buffer) => void) | undefined;

	function trackTerminalFocus(data: string | Buffer): void {
		focusInput = (focusInput + data.toString()).slice(-8);
		const focusInAt = focusInput.lastIndexOf(FOCUS_IN);
		const focusOutAt = focusInput.lastIndexOf(FOCUS_OUT);
		if (focusInAt >= 0 || focusOutAt >= 0) terminalFocused = focusInAt > focusOutAt;
	}

	function enableFocusTracking(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui" || focusListener) return;
		focusInput = "";
		focusListener = trackTerminalFocus;
		process.stdin.on("data", focusListener);
		process.stdout.write(FOCUS_REPORTING_ENABLE);
	}

	function disableFocusTracking(): void {
		if (!focusListener) return;
		process.stdin.removeListener("data", focusListener);
		focusListener = undefined;
		process.stdout.write(FOCUS_REPORTING_DISABLE);
	}

	async function ringBell(): Promise<void> {
		// Ghostty (and many other terminals) can mute or visually replace BEL.
		// Prefer a brief, pleasant completion chime, then fall back to the
		// standard sound-theme event and finally the terminal bell.
		const soundArgs = existsSync(COMPLETION_CHIME_PATH)
			? [`--file=${COMPLETION_CHIME_PATH}`]
			: ["--id=complete"];
		try {
			const result = await pi.exec("canberra-gtk-play", soundArgs, { timeout: 5000 });
			if (result.code === 0) return;
		} catch {
			// Fall back to the terminal's audible bell below.
		}
		process.stdout.write("\x07");
	}

	async function notify(ctx: ExtensionContext, body?: string): Promise<void> {
		// Focus reporting is enabled only in the interactive terminal. Ring only
		// when this Pi tab has lost focus; focused tabs need no completion alert.
		if (ctx.mode === "tui") {
			if (!terminalFocused) await ringBell();
			return;
		}
		const result = await pi.exec(
			"notify-send",
			[
				"--app-name=Pi",
				"--urgency=normal",
				"--expire-time=10000",
				`Pi — ${notificationLocation(ctx)}`,
				body ?? responseOverview(ctx),
			],
			{ timeout: 5000 },
		);
		if (result.code !== 0) {
			throw new Error(result.stderr.trim() || `notify-send exited with code ${result.code}`);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		enableFocusTracking(ctx);
	});

	pi.on("session_shutdown", () => {
		disableFocusTracking();
	});

	pi.on("agent_end", (event) => {
		if (wasAborted(event.messages)) suppressNextSettledNotification = true;
	});

	// agent_settled fires once after tool calls, retries, compaction, and queued
	// continuations have all completed. turn_end can fire several times in one run.
	pi.on("agent_settled", async (_event, ctx) => {
		if (suppressNextSettledNotification) {
			suppressNextSettledNotification = false;
			return;
		}
		// Another extension (for example persistent /goal) may start the next
		// run from an earlier agent_settled handler. Alert only at a true idle
		// boundary, not between automatic continuation runs.
		if (!ctx.isIdle()) return;
		if (!enabled) return;
		try {
			await notify(ctx);
		} catch {
			// Desktop notification availability should never interrupt the agent.
		}
	});

	pi.registerCommand("notifications", {
		description: "Control turn-complete alerts: /notifications [on|off|test]",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (!action) {
				ctx.ui.notify(`Turn-complete alerts are ${enabled ? "on" : "off"}.`, "info");
				return;
			}
			if (action === "on") {
				enabled = true;
				ctx.ui.notify("Turn-complete alerts enabled.", "info");
				return;
			}
			if (action === "off") {
				enabled = false;
				ctx.ui.notify("Turn-complete alerts disabled.", "info");
				return;
			}
			if (action === "test") {
				try {
					if (ctx.mode === "tui") await ringBell();
					else await notify(ctx, "Pi turn-complete alert test");
					ctx.ui.notify(ctx.mode === "tui" ? "Test completion chime played." : "Test notification sent.", "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			ctx.ui.notify("Usage: /notifications [on|off|test]", "warning");
		},
	});
}
