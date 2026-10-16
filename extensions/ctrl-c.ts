import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

export default function ctrlC(pi: ExtensionAPI) {
	let unsubscribe: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		unsubscribe?.();
		unsubscribe = undefined;
		if (ctx.mode !== "tui") return;

		unsubscribe = ctx.ui.onTerminalInput((data) => {
			if (!matchesKey(data, "ctrl+c")) return;
			if (ctx.ui.getEditorText().length > 0) {
				ctx.ui.setEditorText("");
			} else {
				ctx.shutdown();
				if (!ctx.isIdle()) ctx.abort();
			}
			return { consume: true };
		});
	});

	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
	});
}
