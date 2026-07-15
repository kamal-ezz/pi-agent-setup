import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const GAUGE_CELLS = 10;

function formatTokens(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function columns(left: string, right: string, width: number, ellipsis: string): string {
	if (!right) return truncateToWidth(left, width, ellipsis);
	if (visibleWidth(left) + visibleWidth(right) + 2 <= width) {
		return left + " ".repeat(width - visibleWidth(left) - visibleWidth(right)) + right;
	}

	const availableLeft = width - visibleWidth(right) - 2;
	if (availableLeft < 8) return truncateToWidth(left, width, ellipsis);
	const compactLeft = truncateToWidth(left, availableLeft, ellipsis);
	return compactLeft + " ".repeat(Math.max(2, width - visibleWidth(compactLeft) - visibleWidth(right))) + right;
}

function firstThatFits(candidates: string[], width: number): string {
	return candidates.find((candidate) => visibleWidth(candidate) <= width) ?? candidates[candidates.length - 1]!;
}

async function repositoryName(pi: ExtensionAPI, cwd: string): Promise<string> {
	try {
		const result = await pi.exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 2000 });
		if (result.code === 0 && result.stdout.trim()) return basename(result.stdout.trim());
	} catch {
		// A footer should still render when Git is missing or the directory is not a repository.
	}
	return basename(cwd) || cwd;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const project = await repositoryName(pi, ctx.sessionManager.getCwd());
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			const separator = theme.fg("dim", " │ ");
			const dot = theme.fg("dim", " · ");
			const ellipsis = theme.fg("dim", "…");

			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					let input = 0;
					let output = 0;
					let cacheWrite = 0;
					let latestCacheHitRate: number | undefined;

					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type !== "message" || entry.message.role !== "assistant") continue;
						const usage = entry.message.usage;
						input += usage.input;
						output += usage.output;
						cacheWrite += usage.cacheWrite;
						const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
						latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
					}

					const projectText = theme.bold(theme.fg("accent", project));
					const branch = footerData.getGitBranch();
					const sessionName = ctx.sessionManager.getSessionName();
					const locationCandidates = [
						[projectText, branch ? theme.fg("muted", branch) : "", sessionName ? theme.fg("muted", sessionName) : ""]
							.filter(Boolean)
							.join(dot),
						[projectText, branch ? theme.fg("muted", branch) : ""].filter(Boolean).join(dot),
						projectText,
					];

					const model = ctx.model;
					const thinking = model?.reasoning ? pi.getThinkingLevel() : undefined;
					const modelText = model
						? theme.fg("muted", model.id) + (thinking ? dot + theme.fg("accent", thinking === "off" ? "thinking off" : thinking) : "")
						: theme.fg("dim", "no model");
					const location = locationCandidates.find(
						(candidate) => visibleWidth(candidate) + visibleWidth(modelText) + 2 <= width,
					) ?? projectText;
					const header = columns(location, modelText, width, ellipsis);

					const context = ctx.getContextUsage();
					const percent = context?.percent;
					const roundedPercent = percent == null ? "?" : String(Math.round(percent));
					const filledCells = percent == null ? 0 : Math.max(0, Math.min(GAUGE_CELLS, Math.round(percent / 10)));
					const contextTone = percent != null && percent > 90 ? "error" : percent != null && percent > 70 ? "warning" : "accent";
					const gauge = theme.fg(contextTone, "▓".repeat(filledCells)) + theme.fg("dim", "░".repeat(GAUGE_CELLS - filledCells));
					const contextCompact = theme.fg("muted", "ctx ") + theme.fg(contextTone, `${roundedPercent}%`);
					const contextFull = theme.fg("muted", "ctx ") + gauge + " " + theme.fg(contextTone, `${roundedPercent}%`);
					const tokenTraffic = `${theme.fg("muted", "in ")}${formatTokens(input)}  ${theme.fg("muted", "out ")}${formatTokens(output)}`;
					const cache = latestCacheHitRate === undefined
						? ""
						: `${theme.fg("muted", "cache ")}${Math.round(latestCacheHitRate)}%`;
					const cacheWriteText = cacheWrite > 0 ? `${theme.fg("muted", "write ")}${formatTokens(cacheWrite)}` : "";

					const telemetry = firstThatFits(
						[
							[contextFull, tokenTraffic, cache, cacheWriteText].filter(Boolean).join(separator),
							[contextCompact, tokenTraffic, cache].filter(Boolean).join(separator),
							[contextCompact, tokenTraffic].join(separator),
							contextCompact,
						],
						width,
					);

					const lines = [truncateToWidth(header, width, ellipsis), truncateToWidth(telemetry, width, ellipsis)];
					const statuses = [...footerData.getExtensionStatuses().entries()]
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, value]) => value.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
					if (statuses.length) lines.push(truncateToWidth(statuses.join(" "), width, ellipsis));
					return lines;
				},
			};
		});
	});
}
