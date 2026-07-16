import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadChangedFiles } from "./src/changed-files-view.ts";
import { openDiffHtml, writeDiffHtml } from "./src/html-diff.ts";
import {
  createRuntime,
  runEffect,
  type GitInfoRuntime,
} from "./src/runtime.ts";

export default function diffBrowser(pi: ExtensionAPI) {
  let runtime: GitInfoRuntime | undefined;
  const getRuntime = () => (runtime ??= createRuntime());

  pi.registerCommand("diff", {
    description: "Open local changes as a polished HTML diff",
    handler: async (_args, ctx) => {
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

      try {
        const filePath = await writeDiffHtml(files, {
          projectName: basename(ctx.cwd) || "Working tree",
        });
        const opened = await openDiffHtml(filePath);
        ctx.ui.notify(
          opened ? `Opened HTML diff: ${filePath}` : `HTML diff saved: ${filePath}`,
          opened ? "info" : "warning",
        );
      } catch (error) {
        ctx.ui.notify(
          `Could not create HTML diff: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.on("session_shutdown", async () => {
    const closing = runtime;
    runtime = undefined;
    await closing?.dispose();
  });
}
