import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const GAUGE_CELLS = 10;

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

async function repositoryName(pi: ExtensionAPI, cwd: string): Promise<string> {
	try {
		const result = await pi.exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 2000 });
		if (result.code === 0 && result.stdout.trim()) return basename(result.stdout.trim());
	} catch {
		// A footer should still render when Git is missing or the directory is not a repository.
	}
	return basename(cwd) || cwd;
}

export default function statusFooter(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const project = await repositoryName(pi, ctx.sessionManager.getCwd());
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			const dot = theme.fg("dim", " · ");
			const ellipsis = theme.fg("dim", "…");

			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
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
					const statuses = [...footerData.getExtensionStatuses().entries()]
						.filter(([key]) => key !== "codex-usage")
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, value]) => value.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
						.filter(Boolean);
					const activity = statuses.join(dot);
					const contextText =
						visibleWidth(activity) + visibleWidth(contextFull) + (activity ? 2 : 0) <= width
							? contextFull
							: contextCompact;
					const detail = activity
						? columns(activity, contextText, width, ellipsis)
						: truncateToWidth(contextText, width, ellipsis);

					return [truncateToWidth(header, width, ellipsis), detail];
				},
			};
		});
	});
}
