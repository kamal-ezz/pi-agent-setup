/**
 * Scripted stub sessions used by the manager tests. A stub session:
 *
 * - streams a plausible turn (thinking deltas, one fake tool cycle, text
 *   deltas, usage ramp, a final assistant message, RunSettled) over a few
 *   seconds so streaming UI, wait, and the footer counters are observable;
 * - supports send() while running (queued-steer rendering) and while idle
 *   (fresh run);
 * - supports interrupt (RunSettled Interrupted -> status "error", matching v1);
 * - fails the run when the prompt starts with "FAIL:" (error-path testing);
 * - appends every event to a JSONL "session file" in tmpdir so the
 *   "full transcript in session file" pointers resolve.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createEventChannel,
  type SubagentBackend,
  type SubagentSession,
} from "../backend.ts";
import type {
  BackendName,
  QueuedMessage,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
} from "../domain.ts";
import { SendError } from "../domain.ts";

export interface StubProfile {
  readonly backend: BackendName;
  readonly defaultModelLabel: string;
  readonly contextWindow: number;
  readonly toolName: string;
  /** Delay between scripted events; varies per backend so streams differ. */
  readonly cadenceMs: number;
}

const STUB_DIR = path.join(os.tmpdir(), "subagents-stub");
let sessionCounter = 0;

export function makeStubBackend(profile: StubProfile): SubagentBackend {
  return {
    name: profile.backend,
    capabilities: {
      steering: true,
      modelSelection: true,
      reasoningEffort: true,
    },
    // Real impls probe binary-on-PATH / SDK import / credentials here.
    available: () => true,
    spawn: (task) => makeStubSession(profile, task),
  };
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

function chunked(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size)
    chunks.push(text.slice(i, i + size));
  return chunks;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Simple single-consumer inbox for the driver loop. */
class Inbox {
  private pending: string[] = [];
  private waiter: ((value: string | undefined) => void) | undefined;
  private ended = false;

  push(text: string) {
    if (this.ended) return;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      waiter(text);
    } else {
      this.pending.push(text);
    }
  }

  clear() {
    return this.pending.splice(0);
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.(undefined);
  }

  next(): Promise<string | undefined> {
    const queued = this.pending.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.ended) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

interface TurnToken {
  cancelled: boolean;
}

async function makeStubSession(
  profile: StubProfile,
  task: SpawnTask,
): Promise<SubagentSession> {
  const sessionId = `stub-${profile.backend}-${++sessionCounter}`;
  const sessionFile = path.join(STUB_DIR, `${sessionId}.jsonl`);

  const state = {
    meta: {
      backend: profile.backend,
      modelLabel: task.model ?? profile.defaultModelLabel,
      contextWindow: profile.contextWindow,
      sessionFilePath: sessionFile,
      nativeSessionId: sessionId,
    } satisfies SubagentMeta as SubagentMeta,
    pending: [] as string[],
    turnCount: 0,
    closed: false,
    /** True between the driver dequeuing a prompt and registering its turn. */
    dispatching: false,
    active: undefined as
      | { token: TurnToken; done: Promise<void> }
      | undefined,
  };

  const channel = createEventChannel();
  const inbox = new Inbox();

  const emit = (event: SubagentEvent) => {
    try {
      fs.appendFileSync(sessionFile, `${JSON.stringify(event)}\n`);
    } catch {
      // The fake session file is best-effort.
    }
    if (event._tag === "MetaChanged") {
      state.meta = { ...state.meta, ...event.meta };
    }
    channel.emit(event);
  };

  /** Pause between scripted events; resolves true when the turn should stop. */
  const pause = async (token: TurnToken) => {
    await sleep(profile.cadenceMs);
    return token.cancelled || state.closed;
  };

  const runTurn = async (userText: string, turn: number, token: TurnToken) => {
    const interrupted = () => {
      emit({ _tag: "RunSettled", outcome: { _tag: "Interrupted" } });
    };
    emit({ _tag: "RunStarted" });
    const failing = userText.trimStart().startsWith("FAIL:");

    const thinking = "Looking at the task and planning an approach...";
    for (const delta of chunked(thinking, 16)) {
      emit({ _tag: "AssistantDelta", kind: "thinking", delta });
      if (await pause(token)) return interrupted();
    }

    const toolId = `${sessionId}-tool-${turn}`;
    const argsPreview = `{"command":"ls ${task.cwd}"}`;
    emit({
      _tag: "AssistantMessage",
      parts: [
        { type: "thinking", text: thinking },
        {
          type: "text",
          text: `I'll run ${profile.toolName} to look around first.`,
        },
        { type: "toolCall", toolId, name: profile.toolName, argsPreview },
      ],
    });
    emit({
      _tag: "ToolStart",
      toolId,
      name: profile.toolName,
      argsPreview,
    });
    if (await pause(token)) return interrupted();
    emit({
      _tag: "ToolUpdate",
      toolId,
      outputPreview: "src docs package.json",
    });
    if (await pause(token)) return interrupted();
    emit({
      _tag: "ToolEnd",
      toolId,
      name: profile.toolName,
      isError: false,
      outputPreview: "src docs package.json",
    });
    emit({
      _tag: "UsageChanged",
      tokens: Math.min(profile.contextWindow, 2400 * (turn + 1)),
      contextWindow: profile.contextWindow,
    });

    if (failing) {
      if (await pause(token)) return interrupted();
      emit({
        _tag: "RunSettled",
        outcome: {
          _tag: "Failed",
          errorText: `[stub:${profile.backend}] task failed as requested by FAIL: prefix`,
        },
      });
      return;
    }

    const finalText =
      `[stub:${profile.backend}] completed: ${firstLine(userText).slice(0, 200)}\n\n` +
      `This is a stubbed ${profile.backend} subagent turn ${turn + 1}. ` +
      `The real backend integration will replace this scripted output.`;
    for (const delta of chunked(finalText, 24)) {
      emit({ _tag: "AssistantDelta", kind: "text", delta });
      if (await pause(token)) return interrupted();
    }
    emit({
      _tag: "AssistantMessage",
      parts: [{ type: "text", text: finalText }],
    });
    emit({
      _tag: "UsageChanged",
      tokens: Math.min(profile.contextWindow, 2400 * (turn + 1) + 900),
      contextWindow: profile.contextWindow,
    });
    emit({
      _tag: "RunSettled",
      outcome: { _tag: "Completed", finalText },
    });
  };

  const queuedView = (): ReadonlyArray<QueuedMessage> =>
    state.pending.map((text) => ({ text, kind: "steer" as const }));

  // Driver: one turn at a time, in submission order.
  void (async () => {
    while (true) {
      const text = await inbox.next();
      if (text === undefined || state.closed) return;
      state.dispatching = true;
      state.pending.shift();
      emit({ _tag: "QueueChanged", queued: queuedView() });
      emit({ _tag: "UserMessage", text });
      const turn = state.turnCount++;
      const token: TurnToken = { cancelled: false };
      const done = runTurn(text, turn, token).catch(() => undefined);
      state.active = { token, done };
      state.dispatching = false;
      await done;
      state.active = undefined;
    }
  })();

  const submit = (text: string): Promise<void> => {
    if (state.closed) {
      return Promise.reject(
        new SendError({ message: "Subagent session is closed." }),
      );
    }
    state.pending.push(text);
    if (state.active) {
      // Show the queued steer line until the driver picks it up.
      emit({ _tag: "QueueChanged", queued: queuedView() });
    }
    inbox.push(text);
    return Promise.resolve();
  };

  // Announce metadata, then kick off the initial run.
  try {
    fs.mkdirSync(STUB_DIR, { recursive: true });
  } catch {
    // The fake session file directory is best-effort.
  }
  emit({ _tag: "MetaChanged", meta: state.meta });
  // The session cannot be closed yet, so the initial submit cannot fail.
  await submit(task.prompt);

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      state.closed = true;
      inbox.end();
      if (state.active) {
        state.active.token.cancelled = true;
        await state.active.done;
      }
      channel.end();
    })());

  return {
    meta: () => state.meta,
    attach: channel.attach,
    send: submit,
    interrupt: async () => {
      // Drop queued prompts so interrupting cannot immediately start
      // another turn, then stop the active turn. A prompt may be mid-flight
      // between the driver dequeuing it and registering its turn, so wait
      // that window out instead of silently missing the turn.
      const cleared = inbox.clear();
      state.pending = [];
      emit({ _tag: "QueueChanged", queued: [] });
      while (true) {
        const active = state.active;
        if (active) {
          active.token.cancelled = true;
          await active.done;
          return;
        }
        if (!state.dispatching) {
          // No turn ever started. If we cancelled queued prompts, the run
          // still needs a terminal event or it would look running forever.
          if (cleared.length > 0) {
            emit({ _tag: "RunSettled", outcome: { _tag: "Interrupted" } });
          }
          return;
        }
        await sleep(5);
      }
    },
    close,
  } satisfies SubagentSession;
}
