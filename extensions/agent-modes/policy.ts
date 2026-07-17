export type AgentMode = "auto" | "plan" | "bypass-all";

export interface AdvisorDecision {
  decision: "allow" | "ask";
  reason: string;
}

const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "bg_status",
  "bg_list",
  "subagent_check",
  "subagent_list",
  "mcp_context7_resolve-library-id",
  "mcp_context7_query-docs",
]);

const SAFE_COMMAND_PATTERNS = [
  /^pwd\s*$/,
  /^uname(?:\s+-[a-zA-Z]+)?\s*$/,
  /^whoami\s*$/,
  /^id(?:\s+[-a-zA-Z0-9_]+)?\s*$/,
  /^date(?:\s+\+\S+)?\s*$/,
  /^uptime\s*$/,
  /^ps(?:\s+[-a-zA-Z0-9,]+)*\s*$/,
  /^git\s+(?:status|log|diff|show|rev-parse|ls-files|ls-tree)(?:\s|$)/,
  /^git\s+remote(?:\s+-v)?\s*$/,
  /^git\s+branch(?:\s+(?:--show-current|--list|-a|--all|-r|--remotes|-v|-vv))*\s*$/,
  /^git\s+config\s+--get(?:-all)?(?:\s|$)/,
  /^npm\s+(?:list|ls)(?:\s|$)/,
  /^node\s+(?:--version|-v)\s*$/,
  /^python(?:3)?\s+--version\s*$/,
];

const SAFE_JQ_FLAGS = new Set([
  "-r", "--raw-output",
  "-c", "--compact-output",
  "-e", "--exit-status",
  "-s", "--slurp",
  "-S", "--sort-keys",
  "-a", "--ascii-output",
  "-j", "--join-output",
  "-C", "--color-output",
  "-M", "--monochrome-output",
  "-n", "--null-input",
  "--tab",
]);

/**
 * jq is allowed only as a downstream filter over another allowlisted command.
 * Standalone jq reads arbitrary files (including secrets), so reject the
 * first pipeline position, every file-reading flag, path-like arguments, and
 * environment access from the filter itself. Filters using `//` are rejected
 * as collateral of the path check; that is an accepted false positive.
 */
function isSafeJqStage(stage: string, index: number): boolean {
  if (index === 0) return false;
  if (/(?:^|[^.\w$])(?:env\b|\$ENV|input_filename)/.test(stage)) return false;
  const tokens = stage.split(/\s+/).slice(1);
  return tokens.every((token) => {
    const bare = token.replace(/^['"]|['"]$/g, "");
    if (bare.startsWith("-")) return SAFE_JQ_FLAGS.has(bare);
    return !/[/\\]/.test(bare) && !bare.startsWith("~");
  });
}

const FORBIDDEN_SHELL_SYNTAX = /[\n\r;&<>`]|\|\||\$\(|\$\{/;
const DANGEROUS_READ_FLAGS =
  /(?:^|\s)(?:--pre(?:-glob)?|--ext-diff|--textconv|--no-index|--output|--fix|-delete|-exec(?:dir)?|-ok(?:dir)?|-fprint(?:f)?|-fls|-i|--in-place)(?:\s|=|$)/;

/** Conservative shell allowlist used by plan mode and Auto's no-review fast path. */
export function isReadOnlyCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized || FORBIDDEN_SHELL_SYNTAX.test(normalized)) return false;

  const pipeline = normalized.split("|").map((part) => part.trim());
  if (pipeline.some((part) => !part || DANGEROUS_READ_FLAGS.test(part))) {
    return false;
  }

  return pipeline.every((part, index) =>
    /^jq(?:\s|$)/.test(part)
      ? isSafeJqStage(part, index)
      : SAFE_COMMAND_PATTERNS.some((pattern) => pattern.test(part)),
  );
}

/**
 * Diff-family git commands honor repository-configured external diff and
 * textconv drivers (.git/config diff.external / diff.<name>.textconv), which
 * execute arbitrary programs. Lexical classification cannot see repository
 * state, so disable the drivers on the command line instead. Flags are
 * inserted directly after the subcommand, so an explicitly written (and
 * separately reviewed) --textconv later on the line still wins. Aliases
 * cannot reintroduce the drivers: git ignores aliases that shadow builtins.
 *
 * Only call this with commands that passed isReadOnlyCommand: its syntax
 * rules guarantee the naive pipeline split below cannot cut through quotes.
 */
export function hardenReadOnlyCommand(command: string): string {
  return command
    .split("|")
    .map((stage) =>
      stage.replace(
        /^(\s*git\s+(?:diff|log|show))(?=\s|$)/,
        "$1 --no-ext-diff --no-textconv",
      ),
    )
    .join("|");
}

export function isReadOnlyToolCall(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (READ_ONLY_TOOLS.has(toolName)) return true;
  return toolName === "bash" && typeof input.command === "string"
    ? isReadOnlyCommand(input.command)
    : false;
}

export function isPlanToolAllowed(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  return isReadOnlyToolCall(toolName, input);
}

export function planToolNames(
  activeTools: string[],
  trustedReadOnlyTools = new Set(activeTools),
): string[] {
  return activeTools.filter(
    (name) =>
      trustedReadOnlyTools.has(name) &&
      (name === "bash" || READ_ONLY_TOOLS.has(name)),
  );
}

export function boundedText(text: string, maxLength = 12_000): string {
  if (text.length <= maxLength) return text;
  const marker = `\n… [${text.length - maxLength} characters omitted] …\n`;
  const available = Math.max(0, maxLength - marker.length);
  const headLength = Math.ceil(available / 2);
  const tailLength = Math.floor(available / 2);
  return `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`;
}

export function boundedJson(value: unknown, maxLength = 12_000): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return boundedText(text, maxLength);
}

export function parseAdvisorDecision(text: string): AdvisorDecision | undefined {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;

  try {
    const value = JSON.parse(match[0]) as {
      decision?: unknown;
      reason?: unknown;
    };
    if (value.decision !== "allow" && value.decision !== "ask") {
      return undefined;
    }
    if (typeof value.reason !== "string" || !value.reason.trim()) {
      return undefined;
    }
    return { decision: value.decision, reason: value.reason.trim().slice(0, 500) };
  } catch {
    return undefined;
  }
}
