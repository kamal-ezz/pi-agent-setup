import { completeSimple, type Message } from "@earendil-works/pi-ai/compat";
import {
  getMarkdownTheme,
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "btw-answer";
const STATUS_KEY = "btw";
const MAX_PARALLEL_QUESTIONS = 3;
const MAX_CONTEXT_CHARS = 30_000;
const MAX_QUESTION_CHARS = 8_000;
const MAX_ANSWER_TOKENS = 1_500;

const BTW_SYSTEM_PROMPT = `You answer an out-of-band side question while a primary coding agent continues working.
Use the supplied conversation snapshot only as background. Answer the side question directly and concisely.
Do not continue, redirect, or claim to modify the primary run. Do not call tools.`;

export interface BtwEntryData {
  answer: string;
  error?: boolean;
  id: string;
  model: string;
  question: string;
}

type Complete = typeof completeSimple;

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const value = part as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string"
        ? [value.text]
        : [];
    })
    .join("\n");
}

export function conversationSnapshot(
  contextMessages: readonly unknown[],
  maxChars = MAX_CONTEXT_CHARS,
): string {
  const messages: string[] = [];
  for (const value of contextMessages) {
    if (!value || typeof value !== "object") continue;
    const message = value as {
      role?: unknown;
      content?: unknown;
      toolName?: unknown;
      customType?: unknown;
    };
    const text = textFromContent(message.content).trim();
    if (!text) continue;
    const role =
      message.role === "toolResult"
        ? `tool ${String(message.toolName ?? "result")}`
        : message.role === "custom"
          ? `context ${String(message.customType ?? "message")}`
          : String(message.role ?? "message");
    messages.push(`${role}: ${text}`);
  }

  const snapshot = messages.join("\n\n");
  if (maxChars <= 0) return snapshot ? "(Conversation omitted for model context limits.)" : "";
  if (snapshot.length <= maxChars) return snapshot;
  return `… earlier conversation omitted …\n${snapshot.slice(-maxChars)}`;
}

export function buildBtwPrompt(question: string, snapshot: string): string {
  return `<primary-conversation-snapshot>\n${snapshot || "(No prior conversation.)"}\n</primary-conversation-snapshot>\n\n<side-question>\n${question}\n</side-question>`;
}

function responseText(response: Awaited<ReturnType<Complete>>): string {
  return response.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function questionPreview(question: string): string {
  const oneLine = question.replace(/\s+/g, " ").trim();
  return oneLine.length > 140 ? `${oneLine.slice(0, 137)}…` : oneLine;
}

export function createBtwExtension(complete: Complete = completeSimple) {
  return function btwExtension(pi: ExtensionAPI): void {
    let nextId = 1;
    let disposed = false;
    const jobs = new Map<string, AbortController>();

    const updateStatus = (ctx: ExtensionCommandContext) => {
      const count = jobs.size;
      ctx.ui.setStatus(
        STATUS_KEY,
        count === 0 ? undefined : `btw: ${count} thinking`,
      );
    };

    const appendResult = (
      ctx: ExtensionCommandContext,
      data: BtwEntryData,
    ) => {
      if (disposed) return;
      pi.appendEntry(ENTRY_TYPE, data);
      ctx.ui.notify(
        data.error ? `${data.id} failed` : `${data.id} answer ready`,
        data.error ? "error" : "info",
      );
    };

    pi.registerEntryRenderer<BtwEntryData>(
      ENTRY_TYPE,
      (entry, _options, theme) => {
        const container = new Container();
        const data = entry.data;
        if (!data) {
          return new Text(theme.fg("error", "BTW answer unavailable"), 0, 0);
        }
        const color = data.error ? "error" : "accent";
        container.addChild(
          new Text(
            `${theme.fg(color, theme.bold("BTW"))} ${theme.fg("dim", data.id)} ${theme.fg("muted", questionPreview(data.question))}`,
            0,
            0,
          ),
        );
        container.addChild(
          new Markdown(data.answer, 0, 0, getMarkdownTheme()),
        );
        return container;
      },
    );

    pi.registerCommand("btw", {
      description: "Ask a parallel side question without steering the active run",
      handler: async (args, ctx) => {
        const question = args.trim();
        if (!question) {
          ctx.ui.notify("Usage: /btw <side question>", "warning");
          return;
        }
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/btw is available only in interactive TUI sessions", "warning");
          return;
        }
        if (question.length > MAX_QUESTION_CHARS) {
          ctx.ui.notify(
            `/btw questions are limited to ${MAX_QUESTION_CHARS.toLocaleString()} characters`,
            "warning",
          );
          return;
        }
        if (!ctx.model) {
          ctx.ui.notify("Cannot answer /btw without an active model", "error");
          return;
        }
        if (jobs.size >= MAX_PARALLEL_QUESTIONS) {
          ctx.ui.notify(
            `At most ${MAX_PARALLEL_QUESTIONS} /btw questions can run in parallel`,
            "warning",
          );
          return;
        }

        const id = `btw-${Date.now().toString(36)}-${nextId++}`;
        const controller = new AbortController();
        const model = ctx.model;
        const maxAnswerTokens = Math.min(
          MAX_ANSWER_TOKENS,
          Math.max(1, model.maxTokens ?? MAX_ANSWER_TOKENS),
        );
        const contextCharBudget = Math.min(
          MAX_CONTEXT_CHARS,
          Math.max(
            0,
            ((model.contextWindow ?? 128_000) - maxAnswerTokens - 2_000) * 3,
          ),
        );
        const snapshot = conversationSnapshot(
          ctx.sessionManager
            .buildContextEntries()
            .flatMap(sessionEntryToContextMessages),
          contextCharBudget,
        );
        jobs.set(id, controller);
        updateStatus(ctx);
        ctx.ui.notify(`${id} is thinking in parallel`, "info");

        void (async () => {
          try {
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
            if (!auth.ok) throw new Error(auth.error);
            if (controller.signal.aborted) return;

            const message: Message = {
              role: "user",
              content: [
                {
                  type: "text",
                  text: buildBtwPrompt(question, snapshot),
                },
              ],
              timestamp: Date.now(),
            };
            const response = await complete(
              model,
              { systemPrompt: BTW_SYSTEM_PROMPT, messages: [message] },
              {
                apiKey: auth.apiKey,
                headers: auth.headers,
                env: auth.env,
                maxTokens: maxAnswerTokens,
                reasoning: "low",
                signal: controller.signal,
              },
            );
            if (controller.signal.aborted) return;
            appendResult(ctx, {
              answer: responseText(response) || "The model returned an empty answer.",
              id,
              model: `${model.provider}/${model.id}`,
              question,
            });
          } catch (error) {
            if (controller.signal.aborted || disposed) return;
            appendResult(ctx, {
              answer: error instanceof Error ? error.message : String(error),
              error: true,
              id,
              model: `${model.provider}/${model.id}`,
              question,
            });
          } finally {
            jobs.delete(id);
            if (!disposed) updateStatus(ctx);
          }
        })();
      },
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      disposed = true;
      for (const controller of jobs.values()) controller.abort();
      jobs.clear();
      ctx.ui.setStatus(STATUS_KEY, undefined);
    });
  };
}

export default createBtwExtension();
