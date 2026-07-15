import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadChangedFiles, showChangedFiles } from "./src/changed-files-view.ts";
import {
  createRuntime,
  runEffect,
  type GitInfoRuntime,
} from "./src/runtime.ts";

export default function diffBrowser(pi: ExtensionAPI) {
  let runtime: GitInfoRuntime | undefined;
  const getRuntime = () => (runtime ??= createRuntime());

  pi.registerCommand("diff", {
    description: "Browse local changed files and their diffs",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(
          "The local diff browser requires the interactive TUI",
          "warning",
        );
        return;
      }

      const files = await runEffect(getRuntime(), loadChangedFiles(ctx.cwd), {
        signal: ctx.signal,
        interruptMessage: "Loading local changes was cancelled.",
      });
      if (files === null) {
        ctx.ui.notify("Not a git repository", "warning");
        return;
      }
      if (files.length === 0) {
        ctx.ui.notify("Working tree is clean", "info");
        return;
      }

      await showChangedFiles(ctx, files);
    },
  });

  pi.on("session_shutdown", async () => {
    const closing = runtime;
    runtime = undefined;
    await closing?.dispose();
  });
}
