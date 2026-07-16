import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { restoreGoalState } from "./goal/state.ts";

const MAX_OVERVIEW_CHARS = 180;
const MAX_OVERVIEW_LINES = 3;
const MAX_LOCATION_CHARS = 80;
const FOCUS_REPORTING_ENABLE = "\x1b[?1004h";
const FOCUS_REPORTING_DISABLE = "\x1b[?1004l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const COMPLETION_CHIME_PATH = "/usr/share/sounds/ocean/stereo/completion-success.oga";
const PROCESS_STATE_SYMBOL = Symbol.for("pi-agent-setup.turn-notifications.state");

interface NotificationProcessState {
	enabled: boolean;
}

function notificationProcessState(): NotificationProcessState {
	const root = globalThis as typeof globalThis & Record<symbol, unknown>;
	const existing = root[PROCESS_STATE_SYMBOL];
	if (existing && typeof existing === "object" && "enabled" in existing) {
		return existing as NotificationProcessState;
	}
	const created: NotificationProcessState = { enabled: true };
	root[PROCESS_STATE_SYMBOL] = created;
	return created;
}

const ANSI_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

function cleanPlainText(value: string): string {
	return value
		.replace(ANSI_SEQUENCE, "")
		.replace(CONTROL_CHARACTER, "")
		.replace(/<[^>\n]*>/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function notificationLocation(ctx: ExtensionContext): string {
	const location = cleanPlainText(ctx.sessionManager.getSessionName() || basename(ctx.cwd) || ctx.cwd);
	return Array.from(location).slice(0, MAX_LOCATION_CHARS).join("") || "Pi";
}

function cleanMarkdownLine(line: string): string {
	return cleanPlainText(
		line
			.trim()
			.replace(/^#{1,6}\s+/, "")
			.replace(/^>\s?/, "")
			.replace(/^[-*+]\s+/, "• ")
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
			.replace(/`([^`]+)`/g, "$1")
			.replace(/\*\*([^*]+)\*\*/g, "$1")
			.replace(/~~([^~]+)~~/g, "$1"),
	);
}

function cleanNotificationBody(value: string): string {
	return value
		.split(/\r?\n/)
		.map(cleanPlainText)
		.filter(Boolean)
		.slice(0, MAX_OVERVIEW_LINES)
		.join("\n");
}

function truncateOverview(value: string): string {
	const characters = Array.from(value);
	if (characters.length <= MAX_OVERVIEW_CHARS) return value;

	const shortened = characters.slice(0, MAX_OVERVIEW_CHARS - 1).join("");
	const lastBreak = Math.max(shortened.lastIndexOf(" "), shortened.lastIndexOf("\n"));
	return `${lastBreak >= MAX_OVERVIEW_CHARS * 0.7 ? shortened.slice(0, lastBreak) : shortened}…`;
}

interface MessageLike {
	content?: unknown;
	errorMessage?: unknown;
	isError?: unknown;
	role?: unknown;
	stopReason?: unknown;
}

function messageValue(message: unknown): MessageLike | undefined {
	return message && typeof message === "object" ? (message as MessageLike) : undefined;
}

function wasAborted(messages: readonly unknown[]): boolean {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messageValue(messages[index]);
		if (message?.role === "assistant") return message.stopReason === "aborted";
	}

	// A few Pi abort paths can terminate with only the generated tool result.
	// Keep this fallback exact so ordinary tools that mention cancellation do
	// not suppress an otherwise successful completion alert.
	const terminal = messageValue(messages.at(-1));
	if (terminal?.role !== "toolResult" || terminal.isError !== true || !Array.isArray(terminal.content)) return false;
	return terminal.content.some((part) => {
		if (!part || typeof part !== "object") return false;
		const content = part as { type?: unknown; text?: unknown };
		return (
			content.type === "text" &&
			typeof content.text === "string" &&
			/^Operation aborted\.?$/.test(content.text.trim())
		);
	});
}

function assistantOverview(message: MessageLike): string | undefined {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	let inCodeBlock = false;
	const lines: string[] = [];
	for (const part of message.content) {
		if (!part || typeof part !== "object") continue;
		const content = part as { type?: unknown; text?: unknown };
		if (content.type !== "text" || typeof content.text !== "string") continue;
		for (const rawLine of content.text.split("\n")) {
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
	if (typeof message.errorMessage === "string") {
		return truncateOverview(cleanPlainText(message.errorMessage)) || undefined;
	}
	return undefined;
}

function finalResponseOverview(messages: readonly unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messageValue(messages[index]);
		if (message?.role !== "assistant") continue;
		return assistantOverview(message);
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	const processState = notificationProcessState();
	let lastRunAborted = false;
	let lastRunOverview: string | undefined;
	let sessionGeneration = 0;
	let alertTimer: ReturnType<typeof setTimeout> | undefined;
	let alertController: AbortController | undefined;
	let resolveAlertTask: (() => void) | undefined;
	// Pi is necessarily focused when its interactive session starts. Focus-out
	// events move this to false; any later keyboard/mouse input repairs a missed
	// focus-in event, which some Ghostty tab switches do not reliably report.
	let terminalFocused = true;
	let focusUnsubscribe: (() => void) | undefined;
	let focusReportingEnabled = false;

	function trackTerminalFocus(data: string): { consume?: boolean; data?: string } | undefined {
		let sawFocusEvent = false;
		const filtered = data.replace(/\x1b\[[IO]/g, (sequence) => {
			sawFocusEvent = true;
			if (sequence === FOCUS_IN) terminalFocused = true;
			else if (sequence === FOCUS_OUT) terminalFocused = false;
			return "";
		});
		if (!sawFocusEvent && filtered.length > 0) terminalFocused = true;
		if (filtered === data) return undefined;
		return filtered.length === 0 ? { consume: true } : { data: filtered };
	}

	function enableFocusTracking(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui" || focusUnsubscribe) return;
		terminalFocused = true;
		focusUnsubscribe = ctx.ui.onTerminalInput(trackTerminalFocus);
		process.stdout.write(FOCUS_REPORTING_ENABLE);
		focusReportingEnabled = true;
	}

	function disableFocusTracking(): void {
		focusUnsubscribe?.();
		focusUnsubscribe = undefined;
		if (!focusReportingEnabled) return;
		focusReportingEnabled = false;
		process.stdout.write(FOCUS_REPORTING_DISABLE);
	}

	function cancelPendingAlert(): void {
		if (alertTimer !== undefined) clearTimeout(alertTimer);
		alertTimer = undefined;
		alertController?.abort();
		alertController = undefined;
		resolveAlertTask?.();
		resolveAlertTask = undefined;
	}

	async function ringBell(signal?: AbortSignal): Promise<void> {
		// Ghostty (and many other terminals) can mute or visually replace BEL.
		// Prefer a brief, pleasant completion chime, then fall back to the
		// standard sound-theme event and finally the terminal bell.
		const soundArgs = existsSync(COMPLETION_CHIME_PATH)
			? [`--file=${COMPLETION_CHIME_PATH}`]
			: ["--id=complete"];
		if (signal?.aborted) return;
		try {
			const result = await pi.exec("canberra-gtk-play", soundArgs, { signal, timeout: 5000 });
			if (signal?.aborted || result.code === 0) return;
		} catch {
			if (signal?.aborted) return;
			// Fall back to the terminal's audible bell below.
		}
		if (!signal?.aborted) process.stdout.write("\x07");
	}

	async function notify(ctx: ExtensionContext, body?: string, signal?: AbortSignal): Promise<void> {
		// Focus reporting is enabled only in the interactive terminal. A focused
		// tab gets a brief chime the user can hear in place; an unfocused tab gets
		// a desktop notification they can see, falling back to the chime only when
		// notify-send is unavailable.
		if (ctx.mode === "tui") {
			if (terminalFocused) {
				await ringBell(signal);
				return;
			}
			try {
				await sendDesktopNotification(ctx, body, signal);
			} catch {
				if (!signal?.aborted) await ringBell(signal);
			}
			return;
		}
		await sendDesktopNotification(ctx, body, signal);
	}

	async function sendDesktopNotification(ctx: ExtensionContext, body?: string, signal?: AbortSignal): Promise<void> {
		const result = await pi.exec(
			"notify-send",
			[
				"--app-name=Pi",
				"--urgency=normal",
				"--expire-time=10000",
				"--",
				`Pi — ${notificationLocation(ctx)}`,
				cleanNotificationBody(body ?? "Turn finished — ready for input.") || "Turn finished — ready for input.",
			],
			{ signal, timeout: 5000 },
		);
		if (signal?.aborted) return;
		if (result.code !== 0) {
			throw new Error(result.stderr.trim() || `notify-send exited with code ${result.code}`);
		}
	}

	function scheduleAlert(ctx: ExtensionContext, body?: string): Promise<void> {
		cancelPendingAlert();
		const generation = sessionGeneration;
		return new Promise((resolve) => {
			resolveAlertTask = resolve;
			const checkIdle = () => {
				alertTimer = undefined;
				if (
					generation !== sessionGeneration ||
					!processState.enabled ||
					!ctx.isIdle() ||
					ctx.hasPendingMessages()
				) {
					resolveAlertTask = undefined;
					resolve();
					return;
				}
				const controller = new AbortController();
				alertController = controller;
				void notify(ctx, body, controller.signal)
					.catch(() => {
						// Optional desktop/audio integrations never interrupt Pi.
					})
					.finally(() => {
						if (alertController === controller) alertController = undefined;
						if (resolveAlertTask === resolve) resolveAlertTask = undefined;
						resolve();
					});
			};
			// Use two timer turns. Extension handler ordering is not guaranteed:
			// a goal continuation may schedule its own zero-delay timer after this
			// handler, and must get a chance to make the session busy first.
			alertTimer = setTimeout(() => {
				alertTimer = setTimeout(checkIdle, 0);
			}, 0);
		});
	}

	pi.on("session_start", (_event, ctx) => {
		sessionGeneration += 1;
		cancelPendingAlert();
		lastRunAborted = false;
		lastRunOverview = undefined;
		if (processState.enabled) enableFocusTracking(ctx);
	});

	pi.on("session_shutdown", () => {
		sessionGeneration += 1;
		cancelPendingAlert();
		disableFocusTracking();
	});

	pi.on("agent_start", () => {
		cancelPendingAlert();
		lastRunAborted = false;
		lastRunOverview = undefined;
	});

	pi.on("agent_end", (event) => {
		// Keep only the final low-level run's outcome. A failed/aborted attempt can
		// be followed by an automatic retry before agent_settled fires.
		lastRunAborted = wasAborted(event.messages);
		lastRunOverview = lastRunAborted ? undefined : finalResponseOverview(event.messages);
	});

	// agent_settled fires once after tool calls, retries, compaction, and queued
	// continuations have all completed. turn_end can fire several times in one run.
	pi.on("agent_settled", (_event, ctx) => {
		const aborted = lastRunAborted;
		const overview = lastRunOverview;
		lastRunAborted = false;
		lastRunOverview = undefined;
		if (aborted || !processState.enabled) return;
		// Never announce an intermediate run of a persistent goal. Reading the
		// branch also avoids print/JSON handler-order races: those modes await this
		// handler, so timer deferral alone cannot let /goal schedule first.
		if (restoreGoalState(ctx.sessionManager.getBranch())?.status === "active") return;
		// Goal continuation and similar extensions launch from a zero-delay timer.
		// Defer one turn, then re-check state so we alert only at a true idle edge.
		const alertTask = scheduleAlert(ctx, overview);
		// One-shot modes may exit immediately after settlement, so keep them alive
		// long enough to deliver their desktop notification. Interactive and RPC
		// sessions stay responsive while the optional integration runs detached.
		if (ctx.mode === "print" || ctx.mode === "json") return alertTask;
	});

	pi.registerCommand("notifications", {
		description: "Control turn-complete alerts for this Pi process: /notifications [on|off|test]",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (!action) {
				ctx.ui.notify(`Turn-complete alerts are ${processState.enabled ? "on" : "off"} for this Pi process.`, "info");
				return;
			}
			if (action === "on") {
				processState.enabled = true;
				enableFocusTracking(ctx);
				ctx.ui.notify("Turn-complete alerts enabled for this Pi process.", "info");
				return;
			}
			if (action === "off") {
				processState.enabled = false;
				cancelPendingAlert();
				disableFocusTracking();
				ctx.ui.notify("Turn-complete alerts disabled for this Pi process.", "info");
				return;
			}
			if (action === "test") {
				try {
					// The terminal is necessarily focused while typing this command, so
					// exercise both channels: the focused chime and the unfocused
					// desktop notification.
					if (ctx.mode === "tui") {
						await ringBell();
						await sendDesktopNotification(ctx, "Pi turn-complete alert test");
						ctx.ui.notify("Test completion chime played and desktop notification sent.", "info");
					} else {
						await notify(ctx, "Pi turn-complete alert test");
						ctx.ui.notify("Test notification sent.", "info");
					}
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			ctx.ui.notify("Usage: /notifications [on|off|test]", "warning");
		},
	});
}
