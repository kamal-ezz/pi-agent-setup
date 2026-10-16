import { keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export default function quietShell(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setToolsExpanded(false);
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
					// The collapsed hint is not the original renderer's reusable component.
					return renderResult(result, options, theme, { ...context, lastComponent: undefined });
				}
				const label = context.isError ? "Command failed — output hidden" : "Output hidden";
				return new Text(
					theme.fg(context.isError ? "error" : "muted", `${label} (`) +
						keyHint("app.tools.expand", "to expand") + theme.fg("muted", ")"),
					0,
					0,
				);
			},
		};
	});
}
