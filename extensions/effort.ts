import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Level = (typeof levels)[number];

function isLevel(value: string): value is Level {
	return (levels as readonly string[]).includes(value);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("effort", {
		description: "Set reasoning effort: /effort [minimal|low|medium|high|xhigh|max|off]",
		handler: async (args, ctx) => {
			if (!ctx.model?.reasoning) {
				ctx.ui.notify("The current model does not support reasoning effort.", "warning");
				return;
			}

			let requested = args.trim().toLowerCase();
			if (!requested) {
				const current = pi.getThinkingLevel();
				if (ctx.mode !== "tui") {
					ctx.ui.notify(
						`Reasoning effort: ${current}. Usage: /effort [${levels.join("|")}]`,
						"info",
					);
					return;
				}

				const choice = await ctx.ui.select(
					`Reasoning effort (current: ${current})`,
					levels.map((level) => (level === current ? `${level} (current)` : level)),
				);
				if (!choice) return;
				requested = choice.replace(" (current)", "");
			}

			if (!isLevel(requested)) {
				ctx.ui.notify(`Unknown effort: ${requested}. Use /effort to choose one.`, "error");
				return;
			}

			pi.setThinkingLevel(requested);
			const applied = pi.getThinkingLevel();
			ctx.ui.notify(`Reasoning effort: ${applied}${applied !== requested ? ` (closest supported to ${requested})` : ""}`, "info");
		},
	});
}
