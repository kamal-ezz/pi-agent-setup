import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  describeDiffScope,
  loadChangedFiles,
  parseDiffScope,
  type DiffScope,
} from "./src/changed-files.ts";
import { openDiffHtml, writeDiffHtml } from "./src/html-diff.ts";
import { isAbortError } from "./src/process.ts";

function emptyMessage(scope: DiffScope): string {
  if (scope.kind === "staged") return "No staged changes";
  if (scope.kind === "ref") return `Working tree matches ${scope.ref}`;
  return "Working tree is clean";
}

export default function diffBrowser(pi: ExtensionAPI) {
  pi.registerCommand("diff", {
    description:
      "Open changes as a polished HTML diff: /diff [staged | <git ref>]",
    handler: async (args, ctx) => {
      let scope: DiffScope;
      try {
        scope = parseDiffScope(args);
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "warning",
        );
        return;
      }

      let files;
      try {
        files = await loadChangedFiles(ctx.cwd, scope, ctx.signal);
      } catch (error) {
        if (isAbortError(error)) {
          throw new Error("Loading local changes was cancelled.");
        }
        throw error;
      }
      if (files === null) {
        ctx.ui.notify("Not a git repository", "warning");
        return;
      }
      if (files.length === 0) {
        ctx.ui.notify(emptyMessage(scope), "info");
        return;
      }

      try {
        const filePath = await writeDiffHtml(files, {
          projectName: basename(ctx.cwd) || "Working tree",
          projectKey: ctx.cwd,
          scopeLabel: describeDiffScope(scope),
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
}
