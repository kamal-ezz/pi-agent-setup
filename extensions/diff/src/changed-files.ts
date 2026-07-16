import { basename } from "node:path";
import { runCommand } from "./process.ts";

const MAX_DIFF_LINES = 20_000;
const MAX_CHANGED_FILES = 500;
const MAX_TOTAL_DIFF_BYTES = 32 * 1024 * 1024;

export type DiffScope =
  | { kind: "worktree" }
  | { kind: "staged" }
  | { kind: "ref"; ref: string };

export function parseDiffScope(args: string | undefined): DiffScope {
  const trimmed = (args ?? "").trim();
  if (trimmed === "") return { kind: "worktree" };
  if (["staged", "--staged", "cached", "--cached"].includes(trimmed.toLowerCase())) {
    return { kind: "staged" };
  }
  if (/\s/.test(trimmed) || trimmed.startsWith("-")) {
    throw new Error("Usage: /diff [staged | <git ref>]");
  }
  return { kind: "ref", ref: trimmed };
}

export function describeDiffScope(scope: DiffScope): string {
  if (scope.kind === "staged") return "Staged changes";
  if (scope.kind === "ref") return `Working tree vs ${scope.ref}`;
  return "Working tree vs HEAD";
}

interface ChangedPath {
  path: string;
  status: string;
}

export interface ChangedFile {
  additions: number | null;
  deletions: number | null;
  diff: string[];
  name: string;
  path: string;
  status: string;
}

function parsePorcelainStatus(output: string) {
  const records = output.split("\0");
  const paths: ChangedPath[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;

    const status = record.slice(0, 2);
    const path = record.slice(3);
    paths.push({ path, status });

    // In porcelain v1 -z output, rename/copy records are followed by the old path.
    if (status.includes("R") || status.includes("C")) index += 1;
  }

  return paths;
}

function parseNameStatus(output: string) {
  const tokens = output.split("\0");
  const paths: ChangedPath[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index];
    if (!status) continue;
    // Rename/copy records carry a score and two paths; the new path is last.
    const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    const path = tokens[index + pathCount];
    index += pathCount;
    if (path) paths.push({ path, status });
  }

  return paths;
}

function dedupe(paths: ChangedPath[]) {
  return [...new Map(paths.map((entry) => [entry.path, entry])).values()];
}

function parseNumstat(output: string) {
  const line = output.split("\n").find(Boolean);
  if (!line) return { additions: 0, deletions: 0 };

  const [added, deleted] = line.split("\t");
  return {
    additions: added === "-" ? null : Number.parseInt(added ?? "0", 10),
    deletions: deleted === "-" ? null : Number.parseInt(deleted ?? "0", 10),
  };
}

function cleanDisplayPath(path: string) {
  return path.replace(/[\r\n\t]/g, " ");
}

const run = (cwd: string, args: string[], signal?: AbortSignal) =>
  runCommand("git", args, cwd, 10_000, signal);

const DIFF_FLAGS = ["--no-ext-diff", "--no-color", "--unified=3"];

function fileDiffBase(
  scope: DiffScope,
  changedPath: ChangedPath,
  hasHead: boolean,
): { diff: string[]; stat: string[] } {
  if (changedPath.status === "??" || (scope.kind === "worktree" && !hasHead)) {
    return {
      diff: ["diff", "--no-index", ...DIFF_FLAGS, "--", "/dev/null", changedPath.path],
      stat: ["diff", "--no-index", "--numstat", "--", "/dev/null", changedPath.path],
    };
  }
  if (scope.kind === "staged") {
    const base = hasHead ? ["--cached", "HEAD"] : ["--cached"];
    return {
      diff: ["diff", ...DIFF_FLAGS, ...base, "--", changedPath.path],
      stat: ["diff", "--numstat", ...base, "--", changedPath.path],
    };
  }
  const base = scope.kind === "ref" ? scope.ref : "HEAD";
  return {
    diff: ["diff", ...DIFF_FLAGS, base, "--", changedPath.path],
    stat: ["diff", "--numstat", base, "--", changedPath.path],
  };
}

async function loadFile(
  repoRoot: string,
  scope: DiffScope,
  changedPath: ChangedPath,
  hasHead: boolean,
  signal?: AbortSignal,
): Promise<ChangedFile> {
  const args = fileDiffBase(scope, changedPath, hasHead);
  const [diffResult, statResult] = await Promise.all([
    run(repoRoot, args.diff, signal),
    run(repoRoot, args.stat, signal),
  ]);
  const stats = parseNumstat(statResult.stdout);
  const allDiffLines = diffResult.stdout.trimEnd().split("\n");
  if (diffResult.stdoutTruncated) {
    allDiffLines.push("… diff output truncated at the 64 MiB safety limit …");
  }
  const diff =
    allDiffLines.length > MAX_DIFF_LINES
      ? [
          ...allDiffLines.slice(0, MAX_DIFF_LINES),
          `… diff truncated after ${MAX_DIFF_LINES.toLocaleString()} lines …`,
        ]
      : allDiffLines;

  return {
    ...stats,
    diff:
      diff.length === 1 && diff[0] === ""
        ? ["No textual diff available."]
        : diff,
    name: cleanDisplayPath(basename(changedPath.path)),
    path: cleanDisplayPath(changedPath.path),
    status: changedPath.status,
  } satisfies ChangedFile;
}

async function listChangedPaths(
  repoRoot: string,
  scope: DiffScope,
  signal?: AbortSignal,
): Promise<ChangedPath[]> {
  if (scope.kind === "staged") {
    const result = await run(
      repoRoot,
      ["diff", "--cached", "--name-status", "-z"],
      signal,
    );
    if (result.code !== 0) throw new Error(result.stderr.trim() || "git diff --cached failed");
    return dedupe(parseNameStatus(result.stdout));
  }

  const statusResult = await run(
    repoRoot,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    signal,
  );
  if (statusResult.code !== 0) {
    throw new Error(statusResult.stderr.trim() || "git status failed");
  }
  if (statusResult.stdoutTruncated) {
    throw new Error("Git status output exceeded the 64 MiB safety limit");
  }

  if (scope.kind === "worktree") {
    return dedupe(parsePorcelainStatus(statusResult.stdout));
  }

  // Ref scope: tracked differences against the ref, plus untracked files
  // (they are additions relative to any ref).
  const verify = await run(
    repoRoot,
    ["rev-parse", "--verify", "--quiet", `${scope.ref}^{commit}`],
    signal,
  );
  if (verify.code !== 0) throw new Error(`Unknown git ref: ${scope.ref}`);
  const result = await run(
    repoRoot,
    ["diff", scope.ref, "--name-status", "-z"],
    signal,
  );
  if (result.code !== 0) throw new Error(result.stderr.trim() || "git diff failed");
  const untracked = parsePorcelainStatus(statusResult.stdout).filter(
    (entry) => entry.status === "??",
  );
  return dedupe([...parseNameStatus(result.stdout), ...untracked]);
}

export async function loadChangedFiles(
  cwd: string,
  scope: DiffScope,
  signal?: AbortSignal,
): Promise<ChangedFile[] | null> {
  const rootResult = await run(cwd, ["rev-parse", "--show-toplevel"], signal);
  if (rootResult.code !== 0) return null;

  const repoRoot = rootResult.stdout.replace(/\r?\n$/, "");
  const [changedPaths, headResult] = await Promise.all([
    listChangedPaths(repoRoot, scope, signal),
    run(repoRoot, ["rev-parse", "--verify", "HEAD"], signal),
  ]);
  if (changedPaths.length > MAX_CHANGED_FILES) {
    throw new Error(
      `Working tree has ${changedPaths.length} changed files; the HTML review limit is ${MAX_CHANGED_FILES}`,
    );
  }
  const files: ChangedFile[] = [];
  let totalDiffBytes = 0;
  for (const changedPath of changedPaths) {
    const file = await loadFile(
      repoRoot,
      scope,
      changedPath,
      headResult.code === 0,
      signal,
    );
    totalDiffBytes += file.diff.reduce(
      (bytes, line) => bytes + Buffer.byteLength(line, "utf8") + 1,
      0,
    );
    if (totalDiffBytes > MAX_TOTAL_DIFF_BYTES) {
      throw new Error("Combined diff exceeds the 32 MiB HTML review safety limit");
    }
    files.push(file);
  }

  return files;
}
