import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER = "openai-codex";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const RESET_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
const AUTH_CLAIM = "https://api.openai.com/auth";
const REFRESH_INTERVAL_MS = 5 * 60_000;
const TICK_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

type UsageWindowPayload = {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_after_seconds?: number;
	reset_at?: number;
};

type UsagePayload = {
	plan_type?: string;
	rate_limit?: {
		allowed?: boolean;
		limit_reached?: boolean;
		primary_window?: UsageWindowPayload | null;
		secondary_window?: UsageWindowPayload | null;
	} | null;
	rate_limit_reset_credits?: {
		available_count?: number;
	} | null;
};

type UsageWindow = {
	usedPercent: number;
	windowSeconds?: number;
	resetAtMs?: number;
};

type UsageSnapshot = {
	planType?: string;
	primary?: UsageWindow;
	secondary?: UsageWindow;
	resetCredits: number;
	fetchedAt: number;
};

type RequestAuth = {
	token: string;
	accountId: string;
};

function isCodex(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === PROVIDER;
}

function accountIdFromToken(token: string): string | undefined {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return undefined;
		const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
		const auth = payload[AUTH_CLAIM];
		if (!auth || typeof auth !== "object") return undefined;
		const accountId = (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	} catch {
		return undefined;
	}
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
	return match?.[1];
}

async function resolveAuth(ctx: ExtensionContext): Promise<RequestAuth> {
	if (!ctx.model) throw new Error("No active model");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error("No Codex OAuth token is available");

	const accountId = headerValue(auth.headers, "chatgpt-account-id") ?? accountIdFromToken(auth.apiKey);
	if (!accountId) throw new Error("Could not determine the ChatGPT account ID");
	return { token: auth.apiKey, accountId };
}

async function fetchJson(
	url: string,
	auth: RequestAuth,
	init: RequestInit = {},
	signal?: AbortSignal,
): Promise<unknown> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const response = await fetch(url, {
		...init,
		headers: {
			accept: "application/json",
			authorization: `Bearer ${auth.token}`,
			"chatgpt-account-id": auth.accountId,
			...init.headers,
		},
		signal: combinedSignal,
	});

	if (!response.ok) {
		throw new Error(`Codex usage request failed (${response.status})`);
	}
	return response.json();
}

function normalizeWindow(value: UsageWindowPayload | null | undefined, fetchedAt: number): UsageWindow | undefined {
	if (!value || typeof value.used_percent !== "number") return undefined;
	const resetAtMs =
		typeof value.reset_at === "number" && value.reset_at > 0
			? value.reset_at * 1000
			: typeof value.reset_after_seconds === "number"
				? fetchedAt + Math.max(0, value.reset_after_seconds) * 1000
				: undefined;
	return {
		usedPercent: Math.max(0, Math.min(100, value.used_percent)),
		windowSeconds: typeof value.limit_window_seconds === "number" ? value.limit_window_seconds : undefined,
		resetAtMs,
	};
}

function normalizeUsage(value: unknown): UsageSnapshot {
	if (!value || typeof value !== "object") throw new Error("Codex returned an invalid usage response");
	const payload = value as UsagePayload;
	const fetchedAt = Date.now();
	const primary = normalizeWindow(payload.rate_limit?.primary_window, fetchedAt);
	const secondary = normalizeWindow(payload.rate_limit?.secondary_window, fetchedAt);
	if (!primary && !secondary) throw new Error("Codex did not return usage windows");

	const rawCredits = payload.rate_limit_reset_credits?.available_count;
	return {
		planType: typeof payload.plan_type === "string" ? payload.plan_type : undefined,
		primary,
		secondary,
		resetCredits: typeof rawCredits === "number" ? Math.max(0, Math.floor(rawCredits)) : 0,
		fetchedAt,
	};
}

function windowLabel(window: UsageWindow): string {
	const seconds = window.windowSeconds;
	if (!seconds) return "limit";
	const hours = Math.round(seconds / 3600);
	if (hours === 24 * 7) return "week";
	if (hours % 24 === 0 && hours >= 24) return `${hours / 24}d`;
	return `${hours}h`;
}

function timeUntil(resetAtMs: number | undefined): string {
	if (!resetAtMs) return "unknown";
	let minutes = Math.max(0, Math.ceil((resetAtMs - Date.now()) / 60_000));
	if (minutes === 0) return "now";
	const days = Math.floor(minutes / (24 * 60));
	minutes -= days * 24 * 60;
	const hours = Math.floor(minutes / 60);
	minutes -= hours * 60;
	if (days > 0) return `${days}d${hours ? ` ${hours}h` : ""}`;
	if (hours > 0) return `${hours}h${minutes ? ` ${minutes}m` : ""}`;
	return `${minutes}m`;
}

function formatPercent(percent: number): string {
	return Number.isInteger(percent) ? String(percent) : percent.toFixed(1);
}

function formatDetails(snapshot: UsageSnapshot): string {
	const lines = [`Codex usage${snapshot.planType ? ` (${snapshot.planType})` : ""}`];
	for (const window of [snapshot.primary, snapshot.secondary]) {
		if (!window) continue;
		lines.push(
			`${windowLabel(window)}: ${formatPercent(window.usedPercent)}% used; resets in ${timeUntil(window.resetAtMs)}`,
		);
	}
	lines.push(`Usage reset credits: ${snapshot.resetCredits}`);
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	let snapshot: UsageSnapshot | undefined;
	let activeCtx: ExtensionContext | undefined;
	let interval: ReturnType<typeof setInterval> | undefined;
	let requestController: AbortController | undefined;
	let inFlight: Promise<UsageSnapshot | undefined> | undefined;
	let sessionGeneration = 0;

	function updateStatus(ctx: ExtensionContext): void {
		// Usage remains available through /usage, but does not occupy the footer.
		ctx.ui.setStatus("codex-usage", undefined);
	}

	async function refresh(ctx: ExtensionContext, force = false): Promise<UsageSnapshot | undefined> {
		if (!isCodex(ctx)) {
			snapshot = undefined;
			updateStatus(ctx);
			return undefined;
		}
		if (!force && snapshot && Date.now() - snapshot.fetchedAt < REFRESH_INTERVAL_MS) {
			updateStatus(ctx);
			return snapshot;
		}
		if (inFlight) return inFlight;

		const generation = sessionGeneration;
		requestController = new AbortController();
		inFlight = (async () => {
			try {
				const auth = await resolveAuth(ctx);
				const payload = await fetchJson(USAGE_URL, auth, {}, requestController?.signal);
				if (generation !== sessionGeneration) return undefined;
				snapshot = normalizeUsage(payload);
				updateStatus(ctx);
				return snapshot;
			} finally {
				if (generation === sessionGeneration) requestController = undefined;
			}
		})().finally(() => {
			if (generation === sessionGeneration) inFlight = undefined;
		});
		return inFlight;
	}

	function startSession(ctx: ExtensionContext): void {
		sessionGeneration++;
		requestController?.abort();
		requestController = undefined;
		inFlight = undefined;
		if (interval) clearInterval(interval);
		snapshot = undefined;
		activeCtx = ctx;
		updateStatus(ctx);
		void refresh(ctx).catch(() => {});
		interval = setInterval(() => {
			if (!activeCtx) return;
			updateStatus(activeCtx);
			void refresh(activeCtx).catch(() => {});
		}, TICK_INTERVAL_MS);
	}

	pi.on("session_start", (_event, ctx) => {
		startSession(ctx);
	});

	pi.on("session_shutdown", () => {
		sessionGeneration++;
		requestController?.abort();
		requestController = undefined;
		inFlight = undefined;
		activeCtx = undefined;
		if (interval) clearInterval(interval);
		interval = undefined;
	});

	pi.on("model_select", (_event, ctx) => {
		sessionGeneration++;
		requestController?.abort();
		requestController = undefined;
		inFlight = undefined;
		snapshot = undefined;
		updateStatus(ctx);
		void refresh(ctx, true).catch(() => {});
	});

	pi.on("agent_settled", (_event, ctx) => {
		void refresh(ctx, true).catch(() => {});
	});

	pi.registerCommand("usage", {
		description: "Show Codex usage/reset times, or redeem a reset with /usage reset",
		handler: async (args, ctx) => {
			if (!isCodex(ctx)) {
				ctx.ui.notify("Usage limits are available when an openai-codex model is selected.", "warning");
				return;
			}

			const action = args.trim().toLowerCase();
			if (action && action !== "refresh" && action !== "reset") {
				ctx.ui.notify("Usage: /usage [refresh|reset]", "warning");
				return;
			}

			let current: UsageSnapshot | undefined;
			try {
				current = await refresh(ctx, true);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			if (!current) return;

			if (action !== "reset") {
				ctx.ui.notify(formatDetails(current), "info");
				return;
			}

			if (current.resetCredits < 1) {
				ctx.ui.notify("No Codex usage reset credits are available.", "warning");
				return;
			}
			const confirmed = await ctx.ui.confirm(
				"Redeem usage reset?",
				`This will consume one of your ${current.resetCredits} reset credit${current.resetCredits === 1 ? "" : "s"} and reset eligible 5-hour/weekly windows.`,
			);
			if (!confirmed) return;

			try {
				const auth = await resolveAuth(ctx);
				const result = (await fetchJson(
					RESET_URL,
					auth,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ redeem_request_id: crypto.randomUUID() }),
					},
				)) as { code?: string; windows_reset?: number };

				switch (result.code) {
					case "reset":
						ctx.ui.notify(`Usage reset complete (${result.windows_reset ?? 0} window(s) reset).`, "info");
						break;
					case "nothing_to_reset":
						ctx.ui.notify("No usage window is currently eligible for a reset.", "warning");
						break;
					case "no_credit":
						ctx.ui.notify("No usage reset credit is available.", "warning");
						break;
					case "already_redeemed":
						ctx.ui.notify("That usage reset credit was already redeemed.", "warning");
						break;
					default:
						ctx.ui.notify("Codex accepted the reset request.", "info");
				}
				snapshot = undefined;
				await refresh(ctx, true);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
