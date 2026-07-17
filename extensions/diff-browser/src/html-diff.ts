import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import type { ChangedFile } from "./changed-files.ts";

export interface DiffHtmlOptions {
  generatedAt?: Date;
  projectName: string;
  /** Stable identity for the output file; defaults to projectName. */
  projectKey?: string;
  /** Human label for what is being compared, e.g. "Staged changes". */
  scopeLabel?: string;
}

interface DiffRow {
  content: string;
  highlightEnd?: number;
  highlightStart?: number;
  kind: "addition" | "context" | "deletion" | "hunk" | "meta";
  newLine?: number;
  oldLine?: number;
}

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]!);
}

function parseHunkStart(line: string): { oldLine: number; newLine: number } | undefined {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!match) return undefined;
  return {
    oldLine: Number.parseInt(match[1]!, 10),
    newLine: Number.parseInt(match[2]!, 10),
  };
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function commonSuffixLength(left: string, right: string, prefix: number): number {
  const limit = Math.min(left.length, right.length) - prefix;
  let length = 0;
  while (
    length < limit &&
    left[left.length - length - 1] === right[right.length - length - 1]
  ) {
    length += 1;
  }
  return length;
}

function addInlineHighlights(rows: DiffRow[]): void {
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index]?.kind !== "deletion") continue;
    const deletions: DiffRow[] = [];
    const additions: DiffRow[] = [];
    while (rows[index]?.kind === "deletion") deletions.push(rows[index++]!);
    while (rows[index]?.kind === "addition") additions.push(rows[index++]!);
    index -= 1;

    for (let pair = 0; pair < Math.min(deletions.length, additions.length); pair += 1) {
      const deletion = deletions[pair]!;
      const addition = additions[pair]!;
      const oldText = deletion.content.slice(1);
      const newText = addition.content.slice(1);
      const prefix = commonPrefixLength(oldText, newText);
      const suffix = commonSuffixLength(oldText, newText, prefix);
      deletion.highlightStart = prefix + 1;
      deletion.highlightEnd = Math.max(deletion.highlightStart, deletion.content.length - suffix);
      addition.highlightStart = prefix + 1;
      addition.highlightEnd = Math.max(addition.highlightStart, addition.content.length - suffix);
    }
  }
}

export function parseDiffRows(lines: readonly string[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const content of lines) {
    const hunk = parseHunkStart(content);
    if (hunk) {
      oldLine = hunk.oldLine;
      newLine = hunk.newLine;
      inHunk = true;
      rows.push({ content, kind: "hunk" });
      continue;
    }

    if (content.startsWith("diff --git")) {
      inHunk = false;
      rows.push({ content, kind: "meta" });
      continue;
    }
    if (!inHunk) {
      rows.push({ content, kind: "meta" });
      continue;
    }

    if (content.startsWith("+")) {
      rows.push({ content, kind: "addition", newLine });
      newLine += 1;
      continue;
    }
    if (content.startsWith("-")) {
      rows.push({ content, kind: "deletion", oldLine });
      oldLine += 1;
      continue;
    }
    if (content.startsWith("\\ No newline")) {
      rows.push({ content, kind: "meta" });
      continue;
    }

    rows.push({ content, kind: "context", newLine, oldLine });
    oldLine += 1;
    newLine += 1;
  }

  addInlineHighlights(rows);
  return rows;
}

function statusLabel(status: string): string {
  if (status === "??") return "Untracked";
  if (status.includes("R")) return "Renamed";
  if (status.includes("C")) return "Copied";
  if (status.includes("A")) return "Added";
  if (status.includes("D")) return "Deleted";
  if (status.includes("M")) return "Modified";
  return "Changed";
}

function numericStat(value: number | null): number {
  return value ?? 0;
}

function fileBalance(file: ChangedFile): { additions: number; deletions: number; additionPercent: number } {
  const additions = numericStat(file.additions);
  const deletions = numericStat(file.deletions);
  const total = additions + deletions;
  return {
    additions,
    deletions,
    additionPercent: total === 0 ? 50 : Math.round((additions / total) * 100),
  };
}

function renderCode(row: DiffRow): string {
  if (row.highlightStart === undefined || row.highlightEnd === undefined) {
    return escapeHtml(row.content || " ");
  }
  return (
    escapeHtml(row.content.slice(0, row.highlightStart)) +
    `<mark>${escapeHtml(row.content.slice(row.highlightStart, row.highlightEnd)) || "&nbsp;"}</mark>` +
    escapeHtml(row.content.slice(row.highlightEnd))
  );
}

interface SplitRow {
  band?: DiffRow;
  left?: DiffRow;
  right?: DiffRow;
}

export function buildSplitRows(rows: readonly DiffRow[]): SplitRow[] {
  const result: SplitRow[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.kind === "hunk" || row.kind === "meta") {
      result.push({ band: row });
      continue;
    }
    if (row.kind === "context") {
      result.push({ left: row, right: row });
      continue;
    }
    // Pair a run of deletions with the run of additions that follows it,
    // mirroring the inline-highlight pairing.
    const deletions: DiffRow[] = [];
    const additions: DiffRow[] = [];
    while (rows[index]?.kind === "deletion") deletions.push(rows[index++]!);
    while (rows[index]?.kind === "addition") additions.push(rows[index++]!);
    index -= 1;
    const pairs = Math.max(deletions.length, additions.length, 1);
    for (let pair = 0; pair < pairs; pair += 1) {
      result.push({ left: deletions[pair], right: additions[pair] });
    }
  }
  return result;
}

/** Split cells drop the leading +/-/space marker; shift highlights to match. */
function renderSplitCode(row: DiffRow): string {
  const text = row.content.slice(1);
  if (row.highlightStart === undefined || row.highlightEnd === undefined) {
    return escapeHtml(text || " ");
  }
  const start = Math.max(0, row.highlightStart - 1);
  const end = Math.max(start, row.highlightEnd - 1);
  return (
    escapeHtml(text.slice(0, start)) +
    `<mark>${escapeHtml(text.slice(start, end)) || "&nbsp;"}</mark>` +
    escapeHtml(text.slice(end))
  );
}

function splitCellKind(row: DiffRow | undefined, changed: string): string {
  if (!row) return "empty";
  return row.kind === "context" ? "context" : changed;
}

function renderSplitTable(file: ChangedFile): string {
  const rows = buildSplitRows(parseDiffRows(file.diff))
    .map((row) => {
      if (row.band) {
        return `<tr class="split-row ${row.band.kind}">
        <td class="split-band" colspan="4"><code>${renderCode(row.band)}</code></td>
      </tr>`;
      }
      const leftKind = splitCellKind(row.left, "deletion");
      const rightKind = splitCellKind(row.right, "addition");
      return `<tr class="split-row">
        <td class="line-number old ${leftKind}">${row.left?.oldLine ?? ""}</td>
        <td class="code side ${leftKind}"><code>${row.left ? renderSplitCode(row.left) : " "}</code></td>
        <td class="line-number new ${rightKind}">${row.right?.newLine ?? ""}</td>
        <td class="code side ${rightKind}"><code>${row.right ? renderSplitCode(row.right) : " "}</code></td>
      </tr>`;
    })
    .join("\n");
  return `<table class="diff-table split" aria-label="Side-by-side diff for ${escapeHtml(file.path)}">
      <colgroup><col class="num"><col><col class="num"><col></colgroup>
      <thead><tr><th class="old-heading">Base</th><th class="code-heading">Before</th><th class="new-heading">Work</th><th class="code-heading">After</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderRows(file: ChangedFile): string {
  return parseDiffRows(file.diff)
    .map((row) => {
      const marker = row.kind === "addition" ? "+" : row.kind === "deletion" ? "−" : row.kind === "hunk" ? "◆" : "";
      return `<tr class="diff-row ${row.kind}">
        <td class="change-marker" aria-hidden="true">${marker}</td>
        <td class="line-number old">${row.oldLine ?? ""}</td>
        <td class="line-number new">${row.newLine ?? ""}</td>
        <td class="code"><code>${renderCode(row)}</code></td>
      </tr>`;
    })
    .join("\n");
}

function renderFileNavigation(file: ChangedFile, index: number): string {
  const balance = fileBalance(file);
  return `<a class="file-link" href="#file-${index}" data-file-target="file-${index}" data-path="${escapeHtml(file.path)}" data-search="${escapeHtml(file.path.toLowerCase())}">
    <span class="file-link-main">
      <span class="file-name">${escapeHtml(file.name)}</span>
      <span class="file-status">${statusLabel(file.status)}</span>
    </span>
    <span class="file-path">${escapeHtml(file.path)}</span>
    <span class="balance" aria-label="${balance.additions} additions and ${balance.deletions} deletions">
      <i class="balance-add" style="width:${balance.additionPercent}%"></i><i class="balance-delete"></i>
    </span>
    <span class="file-stats"><b>+${file.additions ?? "—"}</b><em>−${file.deletions ?? "—"}</em></span>
  </a>`;
}

function renderFileSection(file: ChangedFile, index: number): string {
  const balance = fileBalance(file);
  return `<section class="file-diff" id="file-${index}" data-file-section="file-${index}" data-search="${escapeHtml(file.path.toLowerCase())}">
    <header class="file-header">
      <div class="file-heading">
        <span class="status-chip">${statusLabel(file.status)}</span>
        <div>
          <h2>${escapeHtml(file.name)}</h2>
          <p>${escapeHtml(file.path)}</p>
        </div>
      </div>
      <div class="file-actions">
        <span class="stat add">+${file.additions ?? "binary"}</span>
        <span class="stat delete">−${file.deletions ?? "binary"}</span>
        <button class="copy-path" type="button" data-copy-path="${escapeHtml(file.path)}">Copy path</button>
        <button class="collapse" type="button" aria-expanded="true">Collapse</button>
      </div>
      <div class="change-rail" aria-hidden="true"><i style="width:${balance.additionPercent}%"></i><b></b></div>
    </header>
    <div class="diff-scroll">
      <table class="diff-table unified" aria-label="Diff for ${escapeHtml(file.path)}">
        <thead><tr><th class="marker-heading"></th><th class="old-heading">Base</th><th class="new-heading">Work</th><th class="code-heading">Patch</th></tr></thead>
        <tbody>${renderRows(file)}</tbody>
      </table>
      ${renderSplitTable(file)}
    </div>
  </section>`;
}

export function renderDiffHtml(files: readonly ChangedFile[], options: DiffHtmlOptions): string {
  const generatedAt = options.generatedAt ?? new Date();
  const totalAdditions = files.reduce((sum, file) => sum + numericStat(file.additions), 0);
  const totalDeletions = files.reduce((sum, file) => sum + numericStat(file.deletions), 0);
  const projectName = escapeHtml(options.projectName);
  const scopeLabel = escapeHtml(options.scopeLabel ?? "Working tree vs HEAD");
  const fileWord = files.length === 1 ? "file" : "files";

  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
  <title>${projectName} · Local changes</title>
  <style>
    :root {
      --paper: #f4f6fb;
      --surface: #ffffff;
      --surface-raised: #ffffff;
      --ink: #182233;
      --muted: #68758a;
      --faint: #e4e8f0;
      --fainter: #edf0f6;
      --brand: #3158c9;
      --brand-soft: #e7ebfb;
      --add: #16704a;
      --add-bg: #e2f3e9;
      --delete: #ad3f50;
      --delete-bg: #f9e6e9;
      --hunk: #6d4db5;
      --hunk-bg: #eee9fa;
      --shadow: 0 16px 50px rgba(32, 45, 72, .1);
      --sidebar: 310px;
      --radius: 14px;
      font-synthesis: none;
    }
    html[data-theme="dark"] {
      --paper: #111722;
      --surface: #171e2b;
      --surface-raised: #1d2635;
      --ink: #e8edf6;
      --muted: #96a3b7;
      --faint: #303a4a;
      --fainter: #242d3c;
      --brand: #8ba6ff;
      --brand-soft: #263352;
      --add: #75d5a8;
      --add-bg: #19382d;
      --delete: #f19aa6;
      --delete-bg: #43262d;
      --hunk: #c1a6ff;
      --hunk-bg: #352d4b;
      --shadow: 0 18px 60px rgba(0, 0, 0, .3);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      background: var(--paper);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45;
    }
    button, input { font: inherit; }
    button { color: inherit; }
    .shell { display: grid; grid-template-columns: var(--sidebar) minmax(0, 1fr); min-height: 100vh; }
    .sidebar {
      position: sticky;
      top: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      border-right: 1px solid var(--faint);
      background: var(--surface);
      z-index: 10;
    }
    .identity { padding: 26px 22px 18px; border-bottom: 1px solid var(--faint); }
    .eyebrow { margin: 0 0 8px; color: var(--brand); font: 700 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .14em; text-transform: uppercase; }
    .identity h1 { margin: 0; font-size: 22px; line-height: 1.15; letter-spacing: -.035em; overflow-wrap: anywhere; }
    .identity .summary { margin: 11px 0 0; color: var(--muted); font-size: 13px; }
    .summary strong { color: var(--add); }
    .summary em { color: var(--delete); font-style: normal; font-weight: 700; }
    .search-wrap { position: relative; padding: 14px 14px 10px; }
    .search-wrap span { position: absolute; left: 27px; top: 24px; color: var(--muted); font: 12px ui-monospace, monospace; }
    #file-search {
      width: 100%;
      padding: 10px 11px 10px 34px;
      border: 1px solid var(--faint);
      border-radius: 9px;
      background: var(--paper);
      color: var(--ink);
      outline: none;
    }
    #file-search:focus { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); }
    .file-list { overflow: auto; padding: 4px 8px 22px; scrollbar-width: thin; }
    .file-link {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 3px 8px;
      margin: 2px 0;
      padding: 11px 12px;
      border: 1px solid transparent;
      border-radius: 9px;
      color: inherit;
      text-decoration: none;
      transition: background 120ms ease, border-color 120ms ease, transform 120ms ease;
    }
    .file-link:hover { background: var(--paper); transform: translateX(2px); }
    .file-link.active { background: var(--brand-soft); border-color: color-mix(in srgb, var(--brand) 28%, transparent); }
    .file-link-main { display: flex; min-width: 0; align-items: baseline; gap: 7px; }
    .file-name { overflow: hidden; font-weight: 680; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
    .file-status { color: var(--muted); font: 10px ui-monospace, monospace; text-transform: uppercase; }
    .file-path { grid-column: 1 / -1; overflow: hidden; color: var(--muted); font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
    .balance { grid-column: 1; display: flex; align-self: center; height: 3px; overflow: hidden; border-radius: 3px; background: var(--faint); }
    .balance i { background: var(--add); }
    .balance-delete { flex: 1; background: var(--delete); }
    .file-stats { display: flex; gap: 5px; font: 10px ui-monospace, monospace; }
    .file-stats b { color: var(--add); }.file-stats em { color: var(--delete); font-style: normal; font-weight: 700; }
    .sidebar-footer { margin-top: auto; display: flex; justify-content: space-between; align-items: center; padding: 13px 16px; border-top: 1px solid var(--faint); color: var(--muted); font: 11px ui-monospace, monospace; }
    .theme-toggle { border: 1px solid var(--faint); border-radius: 7px; background: var(--paper); padding: 5px 8px; cursor: pointer; }
    .main { min-width: 0; padding: 34px clamp(20px, 4vw, 64px) 90px; }
    .hero { display: flex; align-items: end; justify-content: space-between; gap: 32px; max-width: 1500px; margin: 0 auto 22px; }
    .hero-copy { max-width: 760px; }
    .hero h2 { margin: 0; font-size: clamp(30px, 3.6vw, 52px); line-height: .98; letter-spacing: -.052em; }
    .hero p { max-width: 640px; margin: 16px 0 0; color: var(--muted); font-size: 15px; }
    .hero-metrics { display: flex; flex: 0 0 auto; border: 1px solid var(--faint); border-radius: 12px; background: var(--surface); box-shadow: var(--shadow); }
    .metric { min-width: 92px; padding: 13px 17px; border-right: 1px solid var(--faint); }
    .metric:last-child { border: 0; }
    .metric span { display: block; color: var(--muted); font: 10px ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
    .metric b { display: block; margin-top: 3px; font: 750 20px ui-monospace, monospace; }
    .metric.add b { color: var(--add); }.metric.delete b { color: var(--delete); }
    .review-toolbar {
      position: sticky;
      top: 10px;
      z-index: 8;
      display: flex;
      max-width: 1500px;
      margin: 0 auto 18px;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 9px 10px 9px 14px;
      border: 1px solid var(--faint);
      border-radius: 11px;
      background: var(--surface-raised);
      box-shadow: 0 8px 28px rgba(32, 45, 72, .12);
    }
    .review-position { min-width: 0; color: var(--muted); font: 11px ui-monospace, monospace; }
    .review-position b { margin-left: 7px; color: var(--ink); font-size: 12px; }
    .view-controls { display: flex; flex: 0 0 auto; gap: 6px; }
    .view-controls button { border: 1px solid var(--faint); border-radius: 7px; background: var(--paper); padding: 6px 9px; color: var(--muted); font-size: 11px; cursor: pointer; }
    .view-controls button:hover { border-color: var(--brand); color: var(--ink); }
    .view-controls button.active { border-color: color-mix(in srgb, var(--brand) 45%, var(--faint)); background: var(--brand-soft); color: var(--brand); }
    .view-controls button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
    .file-diff { max-width: 1500px; margin: 0 auto 22px; scroll-margin-top: 76px; border: 1px solid var(--faint); border-radius: var(--radius); background: var(--surface); box-shadow: var(--shadow); overflow: hidden; }
    .file-diff[hidden] { display: none; }
    .file-header { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 15px 18px 18px; border-bottom: 1px solid var(--faint); background: var(--surface-raised); }
    .file-heading { display: flex; min-width: 0; align-items: center; gap: 12px; }
    .status-chip { flex: 0 0 auto; padding: 4px 7px; border-radius: 5px; background: var(--brand-soft); color: var(--brand); font: 700 10px ui-monospace, monospace; letter-spacing: .05em; text-transform: uppercase; }
    .file-heading h2 { margin: 0; font-size: 15px; letter-spacing: -.015em; }
    .file-heading p { margin: 2px 0 0; overflow: hidden; color: var(--muted); font: 11px ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap; }
    .file-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 7px; }
    .stat { font: 700 11px ui-monospace, monospace; }.stat.add { color: var(--add); }.stat.delete { color: var(--delete); }
    .file-actions button { border: 1px solid var(--faint); border-radius: 7px; background: var(--paper); padding: 6px 9px; font-size: 11px; cursor: pointer; }
    .file-actions button:hover { border-color: var(--brand); }
    .file-actions button:focus-visible, .theme-toggle:focus-visible, .file-link:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
    .change-rail { position: absolute; inset: auto 0 0; display: flex; height: 3px; background: var(--faint); }
    .change-rail i { background: var(--add); }.change-rail b { flex: 1; background: var(--delete); }
    .diff-scroll { overflow: auto; max-height: min(72vh, 920px); scrollbar-width: thin; }
    .file-diff.collapsed .diff-scroll { display: none; }
    .file-diff.collapsed .file-header { border-bottom: 0; }
    .diff-table { width: 100%; border-collapse: collapse; table-layout: fixed; font: 13px/1.62 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-variant-ligatures: none; }
    .diff-table thead { position: sticky; top: 0; z-index: 3; background: var(--surface-raised); color: var(--muted); font: 700 9px/1 ui-monospace, monospace; letter-spacing: .1em; text-transform: uppercase; }
    .diff-table th { height: 25px; padding: 0 8px; border-right: 1px solid var(--faint); border-bottom: 1px solid var(--faint); text-align: right; }
    .diff-table .marker-heading { width: 24px; padding: 0; }.diff-table .old-heading, .diff-table .new-heading { width: 52px; }.diff-table .code-heading { text-align: left; }
    .diff-row { background: var(--surface); }
    .diff-row:hover { filter: brightness(.985); }
    html[data-theme="dark"] .diff-row:hover { filter: brightness(1.08); }
    .diff-row.addition { background: var(--add-bg); }.diff-row.deletion { background: var(--delete-bg); }.diff-row.hunk { background: var(--hunk-bg); }
    .change-marker { width: 24px; border-right: 1px solid var(--faint); color: var(--muted); text-align: center; user-select: none; }
    .addition .change-marker { background: var(--add); color: white; }.deletion .change-marker { background: var(--delete); color: white; }.hunk .change-marker { color: var(--hunk); }
    .line-number { width: 52px; padding: 0 9px; border-right: 1px solid var(--faint); color: var(--muted); text-align: right; user-select: none; }
    .code { padding: 0 14px; overflow: visible; white-space: pre; }
    .code code { display: block; min-width: max-content; }
    .meta .code { color: var(--muted); }.meta .line-number { color: transparent; }
    .hunk .code { color: var(--hunk); font-weight: 700; }.hunk .line-number { color: transparent; }
    .addition .code { color: var(--add); }.deletion .code { color: var(--delete); }
    .code mark { margin: 0 -1px; padding: 1px; border-radius: 3px; color: inherit; font-weight: 750; }
    .addition .code mark { background: color-mix(in srgb, var(--add) 27%, transparent); box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--add) 55%, transparent); }
    .deletion .code mark { background: color-mix(in srgb, var(--delete) 27%, transparent); box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--delete) 55%, transparent); }
    .diff-table.split { display: none; }
    body.split-view .diff-table.split { display: table; }
    body.split-view .diff-table.unified { display: none; }
    .diff-table.split col.num { width: 52px; }
    .split-row { background: var(--surface); }
    .split-row .code.side { overflow: hidden; padding: 0 14px; white-space: pre; }
    .split-row .code.side code { display: block; min-width: 0; }
    .split-row .code.deletion, .split-row .line-number.deletion { background: var(--delete-bg); }
    .split-row .code.deletion { color: var(--delete); }
    .split-row .code.addition, .split-row .line-number.addition { background: var(--add-bg); }
    .split-row .code.addition { color: var(--add); }
    .split-row .code.empty, .split-row .line-number.empty { background: var(--fainter); }
    .split-row .code.deletion mark { background: color-mix(in srgb, var(--delete) 27%, transparent); box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--delete) 55%, transparent); }
    .split-row .code.addition mark { background: color-mix(in srgb, var(--add) 27%, transparent); box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--add) 55%, transparent); }
    .split-band { padding: 0 14px; color: var(--muted); font: inherit; }
    .split-row.hunk .split-band { background: var(--hunk-bg); color: var(--hunk); font-weight: 700; }
    body.hide-meta .diff-row.meta, body.hide-meta .split-row.meta { display: none; }
    body.wrap-lines .code { white-space: pre-wrap; overflow-wrap: anywhere; }
    body.wrap-lines .code code { min-width: 0; }
    body.dense .diff-table { font-size: 12px; line-height: 1.34; }
    body.dense .diff-table thead { display: none; }
    .empty-state { display: none; max-width: 600px; margin: 80px auto; color: var(--muted); text-align: center; }
    .empty-state.visible { display: block; }
    kbd { padding: 1px 5px; border: 1px solid var(--faint); border-bottom-width: 2px; border-radius: 4px; background: var(--surface); font: 10px ui-monospace, monospace; }
    @media (max-width: 900px) {
      :root { --sidebar: 245px; }
      .main { padding-inline: 18px; }
      .hero { align-items: start; flex-direction: column; }
      .hero-metrics { width: 100%; }.metric { flex: 1; min-width: 0; }
      .file-actions .stat { display: none; }
      .review-toolbar { align-items: flex-start; flex-direction: column; }
      .view-controls { width: 100%; overflow-x: auto; }
    }
    @media (max-width: 680px) {
      .shell { display: block; }
      .sidebar { position: relative; width: 100%; height: auto; max-height: 48vh; border-right: 0; border-bottom: 1px solid var(--faint); }
      .identity { padding-block: 18px 14px; }.sidebar-footer { display: none; }
      .main { padding-top: 28px; }
      .hero h2 { font-size: 36px; }
      .file-header { align-items: flex-start; flex-direction: column; }
      .file-actions { width: 100%; }.copy-path { margin-left: auto; }
      .line-number { width: 42px; padding-inline: 6px; }.change-marker { width: 20px; }
      .diff-table { font-size: 11px; }
      .review-position { display: none; }
      .review-toolbar { top: 4px; padding: 7px; }
    }
    @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } * { transition: none !important; } }
    @media print {
      .sidebar, .hero p, .file-actions button { display: none !important; }
      .shell { display: block; }.main { padding: 0; }.file-diff { break-inside: avoid; box-shadow: none; }.diff-scroll { max-height: none; overflow: visible; }
    }
  </style>
</head>
<body class="hide-meta">
  <div class="shell">
    <aside class="sidebar">
      <div class="identity">
        <p class="eyebrow">${scopeLabel}</p>
        <h1>${projectName}</h1>
        <p class="summary">${files.length} ${fileWord} · <strong>+${totalAdditions}</strong> · <em>−${totalDeletions}</em></p>
      </div>
      <label class="search-wrap"><span>/</span><input id="file-search" type="search" placeholder="Filter files" autocomplete="off" aria-label="Filter changed files"></label>
      <nav class="file-list" aria-label="Changed files">${files.map(renderFileNavigation).join("\n")}</nav>
      <div class="sidebar-footer"><span><kbd>J</kbd> <kbd>K</kbd> navigate</span><button class="theme-toggle" type="button" aria-label="Toggle color theme">Theme</button></div>
    </aside>
    <main class="main">
      <header class="hero">
        <div class="hero-copy"><p class="eyebrow">${scopeLabel} · ${escapeHtml(generatedAt.toLocaleString())}</p><h2>Local changes,<br>made legible.</h2><p>A self-contained review of ${scopeLabel.toLowerCase()}. File rails show the balance of additions and deletions; use the sidebar to move through the patch.</p></div>
        <div class="hero-metrics" aria-label="Change summary"><div class="metric"><span>Files</span><b>${files.length}</b></div><div class="metric add"><span>Added</span><b>+${totalAdditions}</b></div><div class="metric delete"><span>Removed</span><b>−${totalDeletions}</b></div></div>
      </header>
      <div class="review-toolbar" aria-label="Diff view controls">
        <div class="review-position"><span>Reviewing</span><b id="current-file">${escapeHtml(files[0]?.path ?? "No file")}</b></div>
        <div class="view-controls">
          <button type="button" data-view="split" aria-pressed="false">Split <kbd>S</kbd></button>
          <button type="button" data-view="metadata" aria-pressed="false">Git headers <kbd>M</kbd></button>
          <button type="button" data-view="wrap" aria-pressed="false">Wrap lines <kbd>W</kbd></button>
          <button type="button" data-view="density" aria-pressed="false">Compact <kbd>D</kbd></button>
          <button type="button" data-action="collapse-all">Collapse all <kbd>E</kbd></button>
        </div>
      </div>
      <div class="diffs">${files.map(renderFileSection).join("\n")}</div>
      <div class="empty-state"><h2>No matching files</h2><p>Clear the filter to return to the complete patch.</p></div>
    </main>
  </div>
  <script>
    (() => {
      const root = document.documentElement;
      const links = [...document.querySelectorAll('[data-file-target]')];
      const sections = [...document.querySelectorAll('[data-file-section]')];
      const search = document.querySelector('#file-search');
      const empty = document.querySelector('.empty-state');
      const currentFile = document.querySelector('#current-file');
      const viewButtons = Object.fromEntries([...document.querySelectorAll('[data-view]')].map((button) => [button.dataset.view, button]));
      let visibleLinks = links;
      let activeIndex = 0;

      const setTheme = (theme) => {
        root.dataset.theme = theme;
        try { localStorage.setItem('pi-diff-theme', theme); } catch {}
      };
      let savedTheme;
      try { savedTheme = localStorage.getItem('pi-diff-theme'); } catch {}
      setTheme(savedTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
      document.querySelector('.theme-toggle').addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));

      const activate = (id) => {
        links.forEach((link) => link.classList.toggle('active', link.dataset.fileTarget === id));
        const index = visibleLinks.findIndex((link) => link.dataset.fileTarget === id);
        if (index >= 0) {
          activeIndex = index;
          currentFile.textContent = visibleLinks[index].dataset.path;
        }
      };
      links.forEach((link) => link.addEventListener('click', () => activate(link.dataset.fileTarget)));

      const observer = new IntersectionObserver((entries) => {
        const current = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (current) activate(current.target.dataset.fileSection);
      }, { rootMargin: '-10% 0px -65% 0px', threshold: [0, .2, .5] });
      sections.forEach((section) => observer.observe(section));
      if (links[0]) activate(links[0].dataset.fileTarget);

      const applyFilter = () => {
        const query = search.value.trim().toLowerCase();
        links.forEach((link) => { link.hidden = !link.dataset.search.includes(query); });
        sections.forEach((section) => { section.hidden = !section.dataset.search.includes(query); });
        visibleLinks = links.filter((link) => !link.hidden);
        activeIndex = 0;
        empty.classList.toggle('visible', visibleLinks.length === 0);
        if (visibleLinks[0]) activate(visibleLinks[0].dataset.fileTarget);
      };
      search.addEventListener('input', applyFilter);

      const setView = (view, enabled) => {
        const button = viewButtons[view];
        if (!button) return;
        if (view === 'split') document.body.classList.toggle('split-view', enabled);
        if (view === 'metadata') document.body.classList.toggle('hide-meta', !enabled);
        if (view === 'wrap') document.body.classList.toggle('wrap-lines', enabled);
        if (view === 'density') document.body.classList.toggle('dense', enabled);
        button.classList.toggle('active', enabled);
        button.setAttribute('aria-pressed', String(enabled));
      };
      Object.entries(viewButtons).forEach(([view, button]) => button.addEventListener('click', () => setView(view, button.getAttribute('aria-pressed') !== 'true')));

      const collapseAll = document.querySelector('[data-action="collapse-all"]');
      const setAllCollapsed = (collapsed) => {
        sections.filter((section) => !section.hidden).forEach((section) => {
          section.classList.toggle('collapsed', collapsed);
          const button = section.querySelector('.collapse');
          button.textContent = collapsed ? 'Expand' : 'Collapse';
          button.setAttribute('aria-expanded', String(!collapsed));
        });
        collapseAll.innerHTML = collapsed ? 'Expand all <kbd>E</kbd>' : 'Collapse all <kbd>E</kbd>';
      };
      collapseAll.addEventListener('click', () => setAllCollapsed(sections.some((section) => !section.hidden && !section.classList.contains('collapsed'))));

      const go = (direction) => {
        if (!visibleLinks.length) return;
        activeIndex = Math.max(0, Math.min(visibleLinks.length - 1, activeIndex + direction));
        visibleLinks[activeIndex].click();
      };
      addEventListener('keydown', (event) => {
        if (event.key === '/' && document.activeElement !== search) { event.preventDefault(); search.focus(); }
        else if (event.key === 'Escape' && document.activeElement === search) { search.value = ''; applyFilter(); search.blur(); }
        else if (event.key.toLowerCase() === 'j' && document.activeElement !== search) go(1);
        else if (event.key.toLowerCase() === 'k' && document.activeElement !== search) go(-1);
        else if (event.key.toLowerCase() === 't' && document.activeElement !== search) document.querySelector('.theme-toggle').click();
        else if (event.key.toLowerCase() === 's' && document.activeElement !== search) viewButtons.split.click();
        else if (event.key.toLowerCase() === 'm' && document.activeElement !== search) viewButtons.metadata.click();
        else if (event.key.toLowerCase() === 'w' && document.activeElement !== search) viewButtons.wrap.click();
        else if (event.key.toLowerCase() === 'd' && document.activeElement !== search) viewButtons.density.click();
        else if (event.key.toLowerCase() === 'e' && document.activeElement !== search) collapseAll.click();
      });

      document.querySelectorAll('.collapse').forEach((button) => button.addEventListener('click', () => {
        const section = button.closest('.file-diff');
        const collapsed = section.classList.toggle('collapsed');
        button.textContent = collapsed ? 'Expand' : 'Collapse';
        button.setAttribute('aria-expanded', String(!collapsed));
        const anyOpen = sections.some((candidate) => !candidate.hidden && !candidate.classList.contains('collapsed'));
        collapseAll.innerHTML = anyOpen ? 'Collapse all <kbd>E</kbd>' : 'Expand all <kbd>E</kbd>';
      }));
      document.querySelectorAll('[data-copy-path]').forEach((button) => button.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(button.dataset.copyPath);
          button.textContent = 'Copied';
          setTimeout(() => { button.textContent = 'Copy path'; }, 1200);
        } catch { button.textContent = 'Copy unavailable'; }
      }));
    })();
  </script>
</body>
</html>`;
}

export async function writeDiffHtml(
  files: readonly ChangedFile[],
  options: DiffHtmlOptions,
): Promise<string> {
  // A stable per-project path lets a re-run overwrite the previous review, so
  // refreshing the already-open browser tab shows the new diff.
  const directory = join(tmpdir(), `pi-diff-${userInfo().username}`);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const slug =
    (basename(options.projectName) || "changes").replace(/[^\w.-]+/g, "-");
  const key = createHash("sha256")
    .update(options.projectKey ?? options.projectName)
    .digest("hex")
    .slice(0, 8);
  const filePath = join(directory, `${slug}-${key}.html`);
  await writeFile(filePath, renderDiffHtml(files, options), "utf8");
  return filePath;
}

function launch(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      child.once("error", () => finish(false));
      child.once("exit", (code) => finish(code === 0));
      child.once("spawn", () => {
        child.unref();
        // A launcher that deliberately stays resident has accepted the file.
        timer = setTimeout(() => finish(true), 5_000);
      });
    } catch {
      finish(false);
    }
  });
}

export function diffBrowserLaunchers(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): ReadonlyArray<{ args: string[]; command: string }> {
  if (platform === "darwin") return [{ command: "open", args: [filePath] }];
  if (platform === "win32") {
    // Avoid `cmd /c start`: project-derived filenames can contain shell
    // metacharacters. These programs receive the path as a direct argv value.
    return [
      { command: "explorer.exe", args: [filePath] },
      { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", filePath] },
    ];
  }
  return [
    { command: "xdg-open", args: [filePath] },
    { command: "gio", args: ["open", filePath] },
  ];
}

export async function openDiffHtml(filePath: string): Promise<boolean> {
  for (const launcher of diffBrowserLaunchers(filePath)) {
    if (await launch(launcher.command, launcher.args)) return true;
  }
  return false;
}
