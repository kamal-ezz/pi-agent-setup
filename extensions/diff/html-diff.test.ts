import assert from "node:assert/strict";
import test from "node:test";
import type { ChangedFile } from "./src/changed-files-view.ts";
import {
  diffBrowserLaunchers,
  parseDiffRows,
  renderDiffHtml,
} from "./src/html-diff.ts";

const file: ChangedFile = {
  additions: 2,
  deletions: 1,
  diff: [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1111111..2222222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -10,3 +10,4 @@ export function app() {",
    " context();",
    "-oldValue();",
    "+newValue();",
    "+finish();",
  ],
  name: "app.ts",
  path: "src/app.ts",
  status: " M",
};

test("parseDiffRows assigns old and new line numbers", () => {
  const rows = parseDiffRows(file.diff);
  assert.deepEqual(
    rows.slice(5).map((row) => [row.kind, row.oldLine, row.newLine]),
    [
      ["context", 10, 10],
      ["deletion", 11, undefined],
      ["addition", undefined, 11],
      ["addition", undefined, 12],
    ],
  );
});

test("hunk content beginning with repeated plus/minus remains a change", () => {
  const rows = parseDiffRows(["@@ -1 +1 @@", "---old", "+++new"]);
  assert.deepEqual(
    rows.map((row) => [row.kind, row.oldLine, row.newLine]),
    [
      ["hunk", undefined, undefined],
      ["deletion", 1, undefined],
      ["addition", undefined, 1],
    ],
  );
});

test("Windows browser launchers never pass project paths through cmd.exe", () => {
  const path = "C:\\Temp\\repo&whoami\\changes.html";
  const launchers = diffBrowserLaunchers(path, "win32");
  assert.equal(launchers.some(({ command }) => command.toLowerCase() === "cmd.exe"), false);
  assert.equal(launchers.every(({ args }) => args.includes(path)), true);
});

test("renderDiffHtml creates a self-contained, escaped review document", () => {
  const unsafe: ChangedFile = {
    ...file,
    name: "<script>alert(1)</script>.ts",
    path: 'src/<script data-x="bad">.ts',
    diff: [...file.diff, "+<img src=x onerror=alert(1)>"],
  };
  const html = renderDiffHtml([unsafe], {
    generatedAt: new Date("2026-07-16T12:00:00Z"),
    projectName: "pi-agent-setup",
  });

  assert.match(html, /<!doctype html>/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /class="diff-row addition"/);
  assert.match(html, /class="diff-row deletion"/);
  assert.match(html, /id="file-search"/);
  assert.match(html, /class="review-toolbar"/);
  assert.match(html, /<body class="hide-meta">/);
  assert.match(html, /<mark>old<\/mark>Value\(\);/);
  assert.match(html, /<mark>new<\/mark>Value\(\);/);
  assert.match(html, /Patch dossier/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;\.ts/);
  assert.match(html, /\+&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /https?:\/\//);
});
