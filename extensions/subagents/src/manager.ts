/**
 * SubagentManager — owns the registry of running/finished subagents.
 *
 * Each subagent is a `SubagentSession` from a `SubagentBackend` whose
 * normalized event stream is folded into a mutable `SubagentSnapshot`.
 * Closing a subagent kills the underlying session/process and ends its
 * stream.
 *
 * The manager also exposes a synchronous `SubagentReadModel` so the
 * imperative TUI components (which render synchronously) can read snapshots
 * and issue fire-and-forget commands without touching async plumbing.
 */

import type {
  BackendRegistry,
  SubagentBackend,
  SubagentSession,
} from "./backend.ts";
import type {
  BackendName,
  LiveToolState,
  RunOutcome,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
  SubagentSnapshot,
  SubagentStatus,
  TranscriptItem,
} from "./domain.ts";
import {
  BackendUnavailableError,
  ConcurrencyLimitError,
  SendError,
  SpawnError,
} from "./domain.ts";

export const MAX_RUNNING = 4;
export const MAX_TRACKED = 64;
const STOP_TIMEOUT_MS = 5_000;
const ERROR_TEXT_MAX_LENGTH = 4_096;

function bounded(text: string) {
  return text.slice(0, ERROR_TEXT_MAX_LENGTH);
}

// --- Async helpers ---------------------------------------------------------------

export interface WaitOptions {
  readonly signal?: AbortSignal;
  readonly interruptMessage?: string;
}

/** Resolve with the promise's value, "timeout" at the deadline, or "error" on
 * rejection. The underlying work keeps running. */
function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | "timeout" | "error"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve("error");
      },
    );
  });
}

/** Await the promise, but reject with `interruptMessage` when the signal
 * fires first. The underlying work continues detached. */
function raceAbort<T>(promise: Promise<T>, options: WaitOptions): Promise<T> {
  const { signal, interruptMessage } = options;
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new Error(interruptMessage ?? "Operation was aborted."));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// --- Internal state -----------------------------------------------------------

/** Mutable snapshot; exposed to readers via the readonly SubagentSnapshot type. */
interface MutableSnapshot {
  id: string;
  backend: BackendName;
  title: string;
  prompt: string;
  cwd: string;
  status: SubagentStatus;
  createdAt: number;
  settledAt?: number;
  errorText?: string;
  meta: SubagentMeta;
  usage: { tokens?: number; contextWindow?: number };
  transcript: TranscriptItem[];
  liveAssistant?: { text: string; thinking: string };
  liveTools: LiveToolState[];
  queued: SubagentSnapshot["queued"];
  finalText: string;
  turns: number;
}

interface Entry {
  snapshot: MutableSnapshot;
  session: SubagentSession;
  liveToolMap: Map<string, LiveToolState>;
  /** Idle restart dispatched but RunStarted not folded yet; counts as running
   * so concurrent restarts cannot race past the cap. */
  restarting?: boolean;
  /** Single close execution: cancel, pruning, and disposeAll converge here. */
  closing?: Promise<void>;
}

// --- Read model ----------------------------------------------------------------

/** Synchronous bridge for the TUI. Snapshots are live objects; do not mutate. */
export interface SubagentReadModel {
  list(): ReadonlyArray<SubagentSnapshot>;
  get(id: string): SubagentSnapshot | undefined;
  size(): number;
  /** Any-change notification (footer status, dashboard). */
  subscribe(listener: () => void): () => void;
  /** Per-subagent notification (takeover view). */
  subscribeTo(id: string, listener: () => void): () => void;
  /** Fire-and-forget: steer/continue a subagent (takeover input). */
  requestSend(id: string, text: string): void;
  /** Fire-and-forget: abort a running subagent (dashboard `x`, takeover). */
  requestAbort(id: string): void;
  /**
   * Register the settle hook. `consumed` is true when an active
   * subagent_wait/cancel is collecting the result (so it must not also be
   * delivered as a follow-up message).
   */
  setOnSettled(
    hook: ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined,
  ): void;
}

// --- Service --------------------------------------------------------------------

export interface CancelResult {
  readonly id: string;
  readonly title: string;
  readonly status: SubagentStatus;
  readonly cancelled: boolean;
}

export interface SubagentManagerShape {
  /** Throws SpawnError | ConcurrencyLimitError | BackendUnavailableError.
   * An abort via `options.signal` rejects the wait; the session is closed as
   * soon as the backend finishes creating it. */
  spawn(
    backend: BackendName,
    task: SpawnTask,
    options?: WaitOptions,
  ): Promise<SubagentSnapshot>;
  /**
   * Wait until all listed subagents are settled. Unknown ids are treated as
   * settled (the tool layer validates ids first). While waiting, settles for
   * these ids are marked "consumed". An abort releases the interest and
   * leaves the subagents running.
   */
  waitFor(
    ids: ReadonlyArray<string>,
    onPending?: (pending: string[]) => void,
    options?: WaitOptions,
  ): Promise<void>;
  /** Cancel running subagents; resolves when they have settled. */
  cancel(
    ids: ReadonlyArray<string>,
    options?: WaitOptions,
  ): Promise<ReadonlyArray<CancelResult>>;
  /** Rejects with SendError. */
  send(id: string, text: string): Promise<void>;
  get(id: string): SubagentSnapshot | undefined;
  list(): ReadonlyArray<SubagentSnapshot>;
  disposeAll(): Promise<void>;
  readonly view: SubagentReadModel;
}

// --- Implementation --------------------------------------------------------------

export function createSubagentManager(
  registry: BackendRegistry,
): SubagentManagerShape {
  /** Detached cleanup work (read-model commands, pruning, aborted spawns).
   * Tracked so disposeAll can wait for it within its bound. */
  const cleanupTasks = new Set<Promise<unknown>>();
  const runCleanup = (task: Promise<unknown>) => {
    const tracked = task.then(
      () => undefined,
      () => undefined,
    );
    cleanupTasks.add(tracked);
    void tracked.finally(() => cleanupTasks.delete(tracked));
  };

  const entries = new Map<string, Entry>();
  const waitInterest = new Map<string, number>();
  const listeners = new Set<() => void>();
  /** One-shot nextChange waiters, swapped out before invocation so waiters
   * re-registering during notification are not visited in the same sweep. */
  let changeWaiters: Array<() => void> = [];
  const idListeners = new Map<string, Set<() => void>>();
  let counter = 0;
  let reserved = 0;
  let disposed = false;
  let onSettled:
    ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined;

  const notify = (id?: string) => {
    const waiters = changeWaiters;
    changeWaiters = [];
    for (const waiter of waiters) waiter();
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A failed status/render listener must not corrupt lifecycle state.
      }
    }
    if (id) {
      for (const listener of idListeners.get(id) ?? []) {
        try {
          listener();
        } catch {
          // Same.
        }
      }
    }
  };

  /** Resolves on the next state change. */
  const nextChange = () =>
    new Promise<void>((resolve) => {
      changeWaiters.push(resolve);
    });

  const runningCount = () =>
    [...entries.values()].filter(
      (e) => e.snapshot.status === "running" || e.restarting === true,
    ).length;

  const addInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) waitInterest.set(id, (waitInterest.get(id) ?? 0) + 1);
  };
  const releaseInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) {
      const count = (waitInterest.get(id) ?? 1) - 1;
      if (count <= 0) waitInterest.delete(id);
      else waitInterest.set(id, count);
    }
  };

  const closeEntry = (entry: Entry) =>
    (entry.closing ??= entry.session.close().catch(() => undefined));

  const pruneSettled = () => {
    if (entries.size <= MAX_TRACKED) return;
    const candidates = [...entries.values()]
      .filter(
        (e) =>
          e.snapshot.status !== "running" && !waitInterest.has(e.snapshot.id),
      )
      .sort(
        (a, b) =>
          (a.snapshot.settledAt ?? a.snapshot.createdAt) -
          (b.snapshot.settledAt ?? b.snapshot.createdAt),
      );
    for (const entry of candidates) {
      if (entries.size <= MAX_TRACKED) break;
      entries.delete(entry.snapshot.id);
      runCleanup(closeEntry(entry));
    }
  };

  const settle = (entry: Entry, outcome: RunOutcome) => {
    const s = entry.snapshot;
    entry.restarting = false;
    if (s.status !== "running") return;
    s.settledAt = Date.now();
    switch (outcome._tag) {
      case "Completed":
        s.status = "done";
        s.errorText = undefined;
        s.finalText = outcome.finalText;
        break;
      case "Failed":
        s.status = "error";
        s.errorText = bounded(outcome.errorText);
        // Never let a failed run report the previous run's successful output.
        s.finalText = outcome.partialText ?? "";
        break;
      case "Interrupted":
        s.status = "error";
        s.errorText = "Run was aborted";
        s.finalText = outcome.partialText ?? "";
        break;
    }
    s.liveAssistant = undefined;
    entry.liveToolMap.clear();
    s.liveTools = [];
    s.queued = [];
    const consumed = (waitInterest.get(s.id) ?? 0) > 0;
    notify(s.id);
    try {
      // During teardown, don't queue results into a shutting-down session.
      if (!disposed) onSettled?.(s, consumed);
    } catch {
      // The parent session may be unavailable; settlement stays final.
    }
    pruneSettled();
  };

  const foldEvent = (entry: Entry, event: SubagentEvent) => {
    const s = entry.snapshot;
    switch (event._tag) {
      case "RunStarted":
        entry.restarting = false;
        s.status = "running";
        s.settledAt = undefined;
        s.errorText = undefined;
        break;
      case "RunSettled":
        settle(entry, event.outcome);
        return; // settle() already notified
      case "UserMessage":
        s.transcript.push({ kind: "user", text: event.text });
        break;
      case "AssistantDelta": {
        const live = s.liveAssistant ?? { text: "", thinking: "" };
        s.liveAssistant =
          event.kind === "text"
            ? { ...live, text: live.text + event.delta }
            : { ...live, thinking: live.thinking + event.delta };
        break;
      }
      case "AssistantMessage":
        s.transcript.push({ kind: "assistant", parts: event.parts });
        s.liveAssistant = undefined;
        s.turns++;
        break;
      case "ToolStart":
        entry.liveToolMap.set(event.toolId, {
          toolId: event.toolId,
          name: event.name,
          argsPreview: event.argsPreview,
        });
        s.liveTools = [...entry.liveToolMap.values()];
        break;
      case "ToolUpdate": {
        const current = entry.liveToolMap.get(event.toolId);
        if (current) {
          entry.liveToolMap.set(event.toolId, {
            ...current,
            outputPreview: event.outputPreview ?? current.outputPreview,
          });
          s.liveTools = [...entry.liveToolMap.values()];
        }
        break;
      }
      case "ToolEnd":
        entry.liveToolMap.delete(event.toolId);
        s.liveTools = [...entry.liveToolMap.values()];
        s.transcript.push({
          kind: "toolResult",
          toolId: event.toolId,
          name: event.name,
          isError: event.isError,
          outputPreview: event.outputPreview,
        });
        break;
      case "QueueChanged":
        s.queued = event.queued;
        break;
      case "UsageChanged":
        s.usage = {
          tokens: event.tokens ?? s.usage.tokens,
          contextWindow: event.contextWindow ?? s.usage.contextWindow,
        };
        break;
      case "MetaChanged":
        s.meta = { ...s.meta, ...event.meta };
        break;
      case "BackendError":
        s.errorText = bounded(event.message);
        break;
    }
    notify(s.id);
  };

  const spawn = async (
    backendName: BackendName,
    task: SpawnTask,
    options: WaitOptions = {},
  ): Promise<SubagentSnapshot> => {
    // Reserve synchronously (before the first await) so parallel tool calls
    // cannot race past the global cap.
    if (disposed) {
      throw new SpawnError({ message: "Subagent manager is shutting down." });
    }
    if (runningCount() + reserved >= MAX_RUNNING) {
      throw new ConcurrencyLimitError({
        message: `Max ${MAX_RUNNING} subagents can run concurrently. Wait for one to finish (subagent_wait) before spawning another.`,
      });
    }
    reserved++;
    try {
      const backend: SubagentBackend | undefined = registry.get(backendName);
      if (!backend) {
        throw new BackendUnavailableError({
          message: `Unknown backend "${backendName}".`,
        });
      }
      if (!(await backend.available())) {
        throw new BackendUnavailableError({
          message: `Backend "${backendName}" is not available on this machine (binary/SDK/credentials missing).`,
        });
      }

      // Spawning is not cancellable mid-flight; an abort rejects the wait
      // and the session (once created) is closed in the background so no
      // live child leaks without a registry entry.
      const sessionPromise = backend.spawn(task);
      let session: SubagentSession;
      try {
        session = await raceAbort(sessionPromise, options);
      } catch (error) {
        runCleanup(
          sessionPromise.then(
            (created) => created.close(),
            () => undefined,
          ),
        );
        throw error;
      }
      if (options.signal?.aborted || disposed) {
        runCleanup(session.close().catch(() => undefined));
        throw disposed
          ? new SpawnError({
              message: "Subagent manager shut down while spawning.",
            })
          : new Error(options.interruptMessage ?? "Operation was aborted.");
      }

      const id = `sa-${++counter}`;
      const meta = session.meta();
      const entry: Entry = {
        snapshot: {
          id,
          backend: backendName,
          title: task.title,
          prompt: task.prompt,
          cwd: task.cwd,
          status: "running",
          createdAt: Date.now(),
          meta,
          usage: { contextWindow: meta.contextWindow },
          transcript: [],
          liveTools: [],
          queued: [],
          finalText: "",
          turns: 0,
        },
        session,
        liveToolMap: new Map(),
      };
      entries.set(id, entry);

      // Pump: fold the event stream into the snapshot. If the stream ends
      // while the subagent still looks running, the backend died out from
      // under us.
      session.attach(
        (event) => foldEvent(entry, event),
        () => {
          if (entry.snapshot.status === "running") {
            settle(entry, {
              _tag: "Failed",
              errorText: "Backend event stream ended unexpectedly",
            });
          }
        },
      );

      notify(id);
      return entry.snapshot as SubagentSnapshot;
    } finally {
      reserved--;
      notify();
    }
  };

  const waitFor = async (
    ids: ReadonlyArray<string>,
    onPending?: (pending: string[]) => void,
    options: WaitOptions = {},
  ) => {
    const unique = [...new Set(ids)];
    addInterest(unique);
    try {
      while (true) {
        const pending = unique.filter(
          (id) => entries.get(id)?.snapshot.status === "running",
        );
        if (pending.length === 0) return;
        onPending?.(pending);
        await raceAbort(nextChange(), options);
      }
    } finally {
      releaseInterest(unique);
      pruneSettled();
    }
  };

  /** Interrupt one running entry, force-closing its session after 5s. */
  const abortEntry = async (entry: Entry) => {
    if (entry.snapshot.status !== "running") return;
    const graceful = await settleWithin(
      entry.session.interrupt().then(() => "ok" as const),
      STOP_TIMEOUT_MS,
    );
    if (graceful !== "ok") {
      // Settle before closing so the stream-ended fallback ("Backend event
      // stream ended unexpectedly") cannot win the race and report the
      // wrong terminal reason.
      settle(entry, { _tag: "Interrupted" });
      entry.snapshot.errorText =
        "Abort deadline exceeded; session was force-disposed";
      notify(entry.snapshot.id);
      // Bound the close like disposeAll does: a stuck backend teardown must
      // not hang cancel after the run is already settled.
      await settleWithin(closeEntry(entry), STOP_TIMEOUT_MS);
    }
  };

  const cancel = async (
    ids: ReadonlyArray<string>,
    options: WaitOptions = {},
  ): Promise<ReadonlyArray<CancelResult>> => {
    const unique = [...new Set(ids)];
    const running = unique
      .map((id) => entries.get(id))
      .filter(
        (entry): entry is Entry => entry?.snapshot.status === "running",
      );
    const runningIds = running.map((entry) => entry.snapshot.id);
    // Mark consumed before interrupting so cancellation does not also
    // enqueue duplicate automatic result messages into the parent.
    addInterest(runningIds);
    try {
      // Interrupts run detached: an aborted cancel wait must not cancel the
      // termination that was already requested.
      for (const entry of running) runCleanup(abortEntry(entry));
      while (running.some((entry) => entry.snapshot.status === "running")) {
        await raceAbort(nextChange(), options);
      }
      return unique.map((id) => {
        const snapshot = entries.get(id)?.snapshot;
        return {
          id,
          title: snapshot?.title ?? "?",
          status: snapshot?.status ?? "error",
          cancelled: runningIds.includes(id),
        };
      });
    } finally {
      releaseInterest(runningIds);
      pruneSettled();
    }
  };

  const send = (id: string, text: string): Promise<void> => {
    const entry = entries.get(id);
    if (!entry || disposed) {
      return Promise.reject(
        new SendError({ message: `Subagent "${id}" is no longer tracked.` }),
      );
    }
    // Restarting a settled subagent occupies a running slot again, so it
    // must respect the same cap as spawn. Steering an already-running one
    // does not consume additional capacity.
    if (entry.snapshot.status !== "running") {
      if (runningCount() + reserved >= MAX_RUNNING) {
        return Promise.reject(
          new SendError({
            message: `Max ${MAX_RUNNING} subagents can run concurrently; restarting "${id}" would exceed that.`,
          }),
        );
      }
      // Occupy the slot synchronously: the RunStarted that flips status
      // arrives via the event stream, and two concurrent restarts must not
      // both pass the check in that window. Cleared by RunStarted/settle,
      // or here when the backend rejects the send.
      entry.restarting = true;
      return entry.session.send(text).catch((error) => {
        entry.restarting = false;
        throw error;
      });
    }
    return entry.session.send(text);
  };

  const disposeAll = async () => {
    disposed = true;
    const all = [...entries.values()];
    entries.clear();
    await Promise.all(
      all.map((entry) => settleWithin(closeEntry(entry), STOP_TIMEOUT_MS)),
    );
    // Detached cleanups are bounded too; a stuck backend teardown cannot
    // block shutdown indefinitely.
    await settleWithin(
      Promise.allSettled([...cleanupTasks]),
      STOP_TIMEOUT_MS,
    );
    notify();
  };

  const view: SubagentReadModel = {
    list: () => [...entries.values()].map((entry) => entry.snapshot),
    get: (id) => entries.get(id)?.snapshot,
    size: () => entries.size,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeTo: (id, listener) => {
      let set = idListeners.get(id);
      if (!set) {
        set = new Set();
        idListeners.set(id, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) idListeners.delete(id);
      };
    },
    requestSend: (id, text) => {
      runCleanup(send(id, text).catch(() => undefined));
    },
    requestAbort: (id) => {
      const entry = entries.get(id);
      if (!entry) return;
      // UI-initiated aborts are not "consumed": the failed result still
      // flows back to the parent as a follow-up message, matching v1.
      runCleanup(abortEntry(entry));
    },
    setOnSettled: (hook) => {
      onSettled = hook;
    },
  };

  return {
    spawn,
    waitFor,
    cancel,
    send,
    get: (id) => entries.get(id)?.snapshot,
    list: () => [...entries.values()].map((e) => e.snapshot),
    disposeAll,
    view,
  };
}
