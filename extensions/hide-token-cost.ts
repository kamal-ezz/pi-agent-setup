import { relative, resolve, sep, isAbsolute } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function formatTokens(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function displayPath(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;

	const relativeToHome = relative(resolve(home), resolve(cwd));
	const insideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	return insideHome ? (relativeToHome ? `~${sep}${relativeToHome}` : "~") : cwd;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					let input = 0;
					let output = 0;
					let cacheRead = 0;
					let cacheWrite = 0;
					let latestCacheHitRate: number | undefined;

					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type !== "message" || entry.message.role !== "assistant") continue;
						const usage = entry.message.usage;
						input += usage.input;
						output += usage.output;
						cacheRead += usage.cacheRead;
						cacheWrite += usage.cacheWrite;
						const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
						latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
					}

					let location = displayPath(ctx.sessionManager.getCwd());
					const branch = footerData.getGitBranch();
					if (branch) location += ` (${branch})`;
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) location += ` • ${sessionName}`;

					const parts: string[] = [];
					if (input) parts.push(`↑${formatTokens(input)}`);
					if (output) parts.push(`↓${formatTokens(output)}`);
					if (cacheRead) parts.push(`R${formatTokens(cacheRead)}`);
					if (cacheWrite) parts.push(`W${formatTokens(cacheWrite)}`);
					if ((cacheRead || cacheWrite) && latestCacheHitRate !== undefined) parts.push(`CH${latestCacheHitRate.toFixed(1)}%`);

					const context = ctx.getContextUsage();
					const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const percent = context?.percent;
					const contextText = percent == null ? `?/${formatTokens(contextWindow)}` : `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
					parts.push(percent != null && percent > 90 ? theme.fg("error", contextText) : percent != null && percent > 70 ? theme.fg("warning", contextText) : contextText);

					let left = parts.join(" ");
					if (visibleWidth(left) > width) left = truncateToWidth(left, width, "...");

					const model = ctx.model;
					const thinking = model?.reasoning ? pi.getThinkingLevel() : undefined;
					const modelText = model ? `${model.id}${thinking ? ` • ${thinking === "off" ? "thinking off" : thinking}` : ""}` : "no-model";
					const providerText = model && footerData.getAvailableProviderCount() > 1 ? `(${model.provider}) ${modelText}` : modelText;
					const right = visibleWidth(left) + 2 + visibleWidth(providerText) <= width ? providerText : modelText;
					const padding = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));

					const lines = [
						truncateToWidth(theme.fg("dim", location), width, theme.fg("dim", "...")),
						truncateToWidth(theme.fg("dim", left + padding + right), width),
					];

					const statuses = [...footerData.getExtensionStatuses().entries()]
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, value]) => value.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
					if (statuses.length) lines.push(truncateToWidth(statuses.join(" "), width, theme.fg("dim", "...")));
					return lines;
				},
			};
		});
	});
}
