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
  /^jq(?:\s|$)/,
];

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

  return pipeline.every((part) =>
    SAFE_COMMAND_PATTERNS.some((pattern) => pattern.test(part)),
  );
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

export function boundedJson(value: unknown, maxLength = 12_000): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  if (text.length <= maxLength) return text;
  const marker = `\n… [${text.length - maxLength} characters omitted] …\n`;
  const available = Math.max(0, maxLength - marker.length);
  const headLength = Math.ceil(available / 2);
  const tailLength = Math.floor(available / 2);
  return `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`;
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
