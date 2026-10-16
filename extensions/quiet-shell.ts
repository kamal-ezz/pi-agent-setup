import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

export default function quietShell(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setToolsExpanded(false);
		ctx.ui.setHiddenThinkingLabel("");
	});

	pi.registerToolRenderer((toolName, next) => {
		const renderers = next();
		if (toolName !== "bash" && toolName !== "powershell") return renderers;
		const renderResult = renderers?.renderResult;
		if (!renderResult) return renderers;

		return {
			...renderers,
			renderResult(result, options, theme, context) {
				if (options.expanded) {
					// The empty collapsed result is not the original renderer's reusable component.
					return renderResult(result, options, theme, { ...context, lastComponent: undefined });
				}
				return new Container();
			},
		};
	});
}
