import * as path from "node:path";
import type { BackendName } from "./domain.ts";

export const PUBLIC_SUBAGENT_HARNESSES = ["pi", "codex"] as const;
export type PublicSubagentHarness = (typeof PUBLIC_SUBAGENT_HARNESSES)[number];

const CHILD_SILENCED_EXTENSION_BASENAMES = new Set(["turn-notifications.ts"]);

export function childExtensionMayLoad(resolvedPath: string): boolean {
  return !CHILD_SILENCED_EXTENSION_BASENAMES.has(path.basename(resolvedPath));
}

export const GPT_SUBAGENT_MODELS = [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
] as const;
export type GptSubagentModel = (typeof GPT_SUBAGENT_MODELS)[number];

const SOL_PATTERN = new RegExp(
  [
    "architect(?:ure|ural)?",
    "security",
    "threat model",
    "authentication",
    "authorization",
    "cryptograph",
    "race condition",
    "deadlock",
    "concurren",
    "root cause",
    "flaky",
    "production incident",
    "migration",
    "redesign",
    "cross[- ]cutting",
    "performance bottleneck",
    "complex",
    "difficult",
    "high[- ]stakes",
    "deep audit",
    "multi[- ]service",
  ].join("|"),
  "i",
);

const LUNA_PATTERN = new RegExp(
  [
    "simple",
    "quick",
    "lightweight",
    "mechanical",
    "boilerplate",
    "typo",
    "format(?:ting)?",
    "list (?:the )?files",
    "enumerate",
    "locate",
    "find (?:the )?(?:file|files|reference|references)",
    "scan (?:the )?(?:files|tree|repository|repo)",
    "summari[sz]e",
    "extract",
    "classify",
    "count",
    "documentation lookup",
    "look up (?:the )?docs",
    "check one",
  ].join("|"),
  "i",
);

/**
 * Route by task risk/complexity using the GPT-5.6 family tiers:
 * Sol = frontier complex work, Terra = balanced default, Luna = cheap/high-volume.
 * Complex/high-stakes signals deliberately win over words such as "quick".
 */
export function routeSubagentModel(task: string): GptSubagentModel {
  if (SOL_PATTERN.test(task)) return "gpt-5.6-sol";
  if (LUNA_PATTERN.test(task)) return "gpt-5.6-luna";
  return "gpt-5.6-terra";
}

export function normalizeSubagentModel(model: string | undefined): GptSubagentModel | undefined {
  if (!model) return undefined;
  const normalized = model.startsWith("openai-codex/")
    ? model.slice("openai-codex/".length)
    : model;
  if ((GPT_SUBAGENT_MODELS as readonly string[]).includes(normalized)) {
    return normalized as GptSubagentModel;
  }
  throw new Error(
    `Unsupported subagent model "${model}". Allowed models: ${GPT_SUBAGENT_MODELS.join(", ")}.`,
  );
}

export function modelHintForHarness(
  harness: BackendName,
  model: GptSubagentModel,
): string {
  if (harness === "pi") return `openai-codex/${model}`;
  if (harness === "codex") return model;
  throw new Error(`Subagent harness "${harness}" is disabled; use pi or codex.`);
}
