/**
 * TerminalManager — owns the registry of running/settled background
 * terminals.
 *
 * Each terminal is a raw `node:child_process` spawn (own process group on
 * POSIX, stdin ignored) whose stdout/stderr 'data' callbacks fold into two
 * bounded OutputBuffers. Tearing an entry down kills the whole process tree
 * (SIGTERM → SIGKILL escalation).
 *
 * The manager also exposes a synchronous `TerminalReadModel` so the
 * imperative TUI components (which render synchronously) can read snapshots
 * and issue fire-and-forget kills without touching async plumbing.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ConcurrencyLimitError,
  formatExit,
  SpawnError,
  UnknownTerminalError,
  type TerminalSnapshot,
  type TerminalStatus,
} from "./domain.ts";
import { OutputBuffer } from "./output.ts";

export const MAX_RUNNING = 8;
export const MAX_TRACKED = 32;
const MAX_SETTLED_HISTORY = MAX_TRACKED * 4;
/** In-memory retained cap per stream; the spill file keeps the full capture. */
export const RETAINED_PER_STREAM = 2 * 1024 * 1024;
/** Bound each full-log spill so a firehose process cannot fill the disk. */
export const SPILL_PER_STREAM_MAX_BYTES = 16 * 1024 * 1024;
/** Aggregate safety bound for all full-log files in one Pi session. */
export const SPILL_SESSION_MAX_BYTES = 256 * 1024 * 1024;
const STOP_TIMEOUT_MS = 5_000;
/** SIGTERM is normally enough; the second deadline covers a wedged process. */
const FORCE_KILL_AFTER_MS = 2_000;
/** After termination, how long to wait for the natural close→flush→settle
 * path before force-settling (a grandchild can hold the stdio pipes open). */
const SETTLE_GRACE_MS = 1_000;
/** Bound on waiting for spill WriteStreams to flush before settling; a hung
 * filesystem must not leave an exited entry "running" (and kill() waiting).
 * Terminate (≤2.5s) + settle grace (1s) + flush (1.5s) stays inside the 5s
 * teardown bound, so shutdown remains bounded end to end. */
const SPILL_FLUSH_TIMEOUT_MS = 1_500;
const ERROR_TEXT_MAX_LENGTH = 4_096;

function bounded(text: string) {
  return text.slice(0, ERROR_TEXT_MAX_LENGTH);
}

function boundedError(error: unknown) {
  return bounded(error instanceof Error ? error.message : String(error));
}

// --- Async helpers ---------------------------------------------------------------

/** Resolve with the promise, or resolve `undefined` at the deadline. The
 * underlying work keeps running (every teardown step is itself bounded). */
function withDeadline<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

export interface KillWaitOptions {
  readonly signal?: AbortSignal;
  readonly interruptMessage?: string;
}

/** Await the promise, but reject with `interruptMessage` when the signal
 * fires first. The underlying work continues detached. */
function raceAbort<T>(
  promise: Promise<T>,
  options: KillWaitOptions,
): Promise<T> {
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

/** Mutable snapshot; exposed to readers via the readonly TerminalSnapshot type.
 * stdout/stderr are getters over the live OutputBuffers. */
interface MutableSnapshot extends TerminalSnapshot {
  status: TerminalStatus;
  pid?: number;
  settledAt?: number;
  exitCode?: number;
  signal?: string;
  errorText?: string;
}

interface SpillHandle {
  file: fs.WriteStream;
  spillPath: string;
  write(chunk: string): boolean;
  resumeOnDrain(resume: () => void): void;
  remove(): void;
}

interface Entry {
  snapshot: MutableSnapshot;
  child: ChildProcess;
  stdoutBuf: OutputBuffer;
  stderrBuf: OutputBuffer;
  spillStreams: fs.WriteStream[];
  spillHandles: SpillHandle[];
  /** Set synchronously at the SIGTERM point so a natural exit that happened
   * before signaling keeps its truthful status. */
  killSignaled: boolean;
  /** The child emitted 'error' (spawn failure etc.); settles as "failed".
   * Kept separate from errorText, which also carries non-fatal notes
   * (spill failures) that must not flip a clean exit to "failed". */
  processErrored: boolean;
  /** 'exit' event observed (code/signal recorded). */
  exited: boolean;
  /** 'close' event observed (stdio flushed; the settle trigger). */
  stdioClosed: boolean;
  /** A settle-after-spill-flush is in flight; don't start a second one. */
  settling: boolean;
  /** The shell exited without stdio closing; this cancellable grace timer
   * reaps descendants that keep inherited pipes open. */
  exitCleanupTimer?: ReturnType<typeof setTimeout>;
  /** Resolved exactly once when the entry settles. Kill callers and teardown
   * can all await the same result without missing a notification. */
  settled: Promise<void>;
  resolveSettled: () => void;
  /** Single teardown execution: kill(), requestKill, pruning, and disposeAll
   * all converge on the same promise. */
  teardown?: Promise<void>;
}

export interface StartOptions {
  readonly command: string;
  readonly title: string;
  readonly cwd: string;
}

export interface KillResult {
  readonly id: string;
  readonly title: string;
  readonly status: TerminalStatus;
  /** True when the entry was still running when this kill began. */
  readonly wasRunning: boolean;
  /** True when this call initiated the termination AND the entry settled as
   * killed (a natural exit that won the race reports killed: false). */
  readonly killed: boolean;
  /** Final exit rendering ("exit 0", "SIGTERM", ...) captured at settle time,
   * so reports stay accurate even if the entry is pruned afterwards. */
  readonly exit: string;
}

// --- Read model ----------------------------------------------------------------

/** Synchronous bridge for the TUI. Snapshots are live objects; do not mutate. */
export interface TerminalReadModel {
  list(): ReadonlyArray<TerminalSnapshot>;
  get(id: string): TerminalSnapshot | undefined;
  size(): number;
  /** Any-change notification (widget, /ps list). */
  subscribe(listener: () => void): () => void;
  /** Per-terminal notification (/ps detail view). */
  subscribeTo(id: string, listener: () => void): () => void;
  /** Fire-and-forget kill (dashboard/detail `x`). Not marked consumed: the
   * settle still flows back to the model as a follow-up message. */
  requestKill(id: string): void;
  /**
   * Register the settle hook. `consumed` is true when an active bg_kill is
   * collecting the result (so it must not also be delivered as a follow-up).
   */
  setOnSettled(
    hook: ((snap: TerminalSnapshot, consumed: boolean) => void) | undefined,
  ): void;
}

// --- Service --------------------------------------------------------------------

export interface TerminalManagerShape {
  /** Throws SpawnError | ConcurrencyLimitError. */
  start(options: StartOptions): Promise<TerminalSnapshot>;
  /** Throws UnknownTerminalError. */
  status(id: string): TerminalSnapshot;
  /** Kill running terminals; resolves only after they have settled. An abort
   * via `options.signal` rejects the wait, but termination continues. */
  kill(
    ids: ReadonlyArray<string>,
    options?: KillWaitOptions,
  ): Promise<ReadonlyArray<KillResult>>;
  list(): ReadonlyArray<TerminalSnapshot>;
  disposeAll(): Promise<void>;
  readonly view: TerminalReadModel;
}

// --- Process helpers ------------------------------------------------------------

function shellInvocation(command: string) {
  if (process.platform === "win32") {
    const shell = process.env.ComSpec ?? "cmd.exe";
    return { shell, args: ["/d", "/s", "/c", command] };
  }
  return { shell: "/bin/sh", args: ["-c", command] };
}

/** Signal the whole process group on POSIX so descendants (servers a shell
 * command spawned) die with it; a wedged child must not orphan its tree. */
function killTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (process.platform === "win32" && child.pid) {
    try {
      const killer = spawn(
        "taskkill",
        [
          "/pid",
          String(child.pid),
          "/T",
          ...(signal === "SIGKILL" ? ["/F"] : []),
        ],
        { stdio: "ignore", windowsHide: true },
      );
      killer.once("error", () => {
        try {
          child.kill(signal);
        } catch {
          // Process may already be gone.
        }
      });
      killer.once("exit", (code) => {
        if (code === 0) return;
        try {
          child.kill(signal);
        } catch {
          // Process may already be gone.
        }
      });
      killer.unref();
      return;
    } catch {
      // Fall through to the direct signal when taskkill cannot be launched.
    }
  }
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Group may already be gone; fall through to the direct signal.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Process may already be gone.
  }
}

/** Await stdio closure (or the deadline) without retaining a stale listener. */
function awaitChildClose(
  child: ChildProcess,
  closed: () => boolean,
  timeoutMs: number,
) {
  return new Promise<void>((resolve) => {
    if (closed()) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.off("close", onClose);
      resolve();
    }, timeoutMs);
    timer.unref?.();
    const onClose = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("close", onClose);
  });
}

/** SIGTERM → deadline → SIGKILL; waits for stdio closure rather than only the
 * shell's exit because descendants can keep the inherited pipes and process
 * group alive after the shell itself is gone. */
async function terminateChild(
  child: ChildProcess,
  closed: () => boolean,
  onSignal: () => void,
) {
  if (closed()) return;
  onSignal();
  killTree(child, "SIGTERM");
  await awaitChildClose(child, closed, FORCE_KILL_AFTER_MS);
  if (closed()) return;
  killTree(child, "SIGKILL");
  await awaitChildClose(child, closed, 500);
}

// --- Implementation --------------------------------------------------------------

export function createTerminalManager(): TerminalManagerShape {
  /** Detached cleanup work (read-model kills, process-event settlement,
   * pruning). Tracked so disposeAll can wait for it within its bound; every
   * task is itself bounded, so nothing can leak past shutdown for long. */
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
  /** Small immutable tombstones preserve truthful kill reports if pruning
   * races the tool boundary after an id was validated. */
  const settledHistory = new Map<
    string,
    Pick<KillResult, "title" | "status" | "exit">
  >();
  /** ids with an in-flight kill() collecting the result (settle → consumed). */
  const killInterest = new Map<string, number>();
  const listeners = new Set<() => void>();
  const idListeners = new Map<string, Set<() => void>>();
  let counter = 0;
  let disposed = false;
  let spillDir: string | undefined | null;
  let sessionSpillBytes = 0;
  let onSettled:
    ((snap: TerminalSnapshot, consumed: boolean) => void) | undefined;

  const notify = (id?: string) => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A failed widget/render listener must not corrupt lifecycle state.
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

  const runningCount = () =>
    [...entries.values()].filter((e) => e.snapshot.status === "running").length;

  const addKillInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) killInterest.set(id, (killInterest.get(id) ?? 0) + 1);
  };
  const releaseKillInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) {
      const count = (killInterest.get(id) ?? 1) - 1;
      if (count <= 0) killInterest.delete(id);
      else killInterest.set(id, count);
    }
  };

  const pruneSettled = () => {
    if (entries.size <= MAX_TRACKED) return;
    const candidates = [...entries.values()]
      .filter(
        (e) =>
          e.snapshot.status !== "running" && !killInterest.has(e.snapshot.id),
      )
      .sort(
        (a, b) =>
          (a.snapshot.settledAt ?? a.snapshot.createdAt) -
          (b.snapshot.settledAt ?? b.snapshot.createdAt),
      );
    for (const entry of candidates) {
      if (entries.size <= MAX_TRACKED) break;
      entries.delete(entry.snapshot.id);
      for (const spill of entry.spillHandles) spill.remove();
      runCleanup(teardownEntry(entry));
    }
  };

  /** End all spill streams; resolves when their buffers are flushed to disk
   * (bounded), so a settle notification never points at a partial file. */
  const flushSpillStreams = async (entry: Entry) => {
    const streams = entry.spillStreams;
    entry.spillStreams = [];
    const flushed = Promise.all(
      streams.map(
        (stream) =>
          new Promise<void>((resolve) => {
            const done = () => resolve();
            try {
              stream.end(done);
            } catch {
              // Best effort; tmpdir contents are disposable.
              done();
            }
          }),
      ),
    );
    const finished = await withDeadline(flushed, SPILL_FLUSH_TIMEOUT_MS);
    if (finished === undefined && streams.length > 0) {
      entry.stdoutBuf.spillPath = undefined;
      entry.stderrBuf.spillPath = undefined;
      entry.snapshot.errorText ??=
        "Full-log spill flush timed out; full output may be incomplete";
    }
  };

  /** Single settle path — idempotent; kill vs natural exit vs error races are
   * resolved by whichever lands first (the second call is a no-op). */
  const settle = (entry: Entry) => {
    const s = entry.snapshot;
    if (s.status !== "running") return;
    s.settledAt = Date.now();
    s.status = entry.killSignaled
      ? "killed"
      : entry.processErrored
        ? "failed"
        : s.exitCode === 0
          ? "done"
          : "failed";
    settledHistory.set(s.id, {
      title: s.title,
      status: s.status,
      exit: formatExit(s),
    });
    while (settledHistory.size > MAX_SETTLED_HISTORY) {
      const oldest = settledHistory.keys().next().value;
      if (oldest === undefined) break;
      settledHistory.delete(oldest);
    }
    // Resolving `settled` resumes kill waiters, whose finally blocks release
    // interest. Snapshot consumption first so the settle hook observes the
    // interest that existed when settlement won.
    const consumed = (killInterest.get(s.id) ?? 0) > 0;
    entry.resolveSettled();
    notify(s.id);
    try {
      // During teardown, don't queue results into a shutting-down session.
      if (!disposed) onSettled?.(s, consumed);
    } catch {
      // The parent session may be unavailable; settlement stays final.
    }
    pruneSettled();
  };

  /** Flush the spill files, then settle: the completion follow-up (and the
   * kill() resolution) reference the spill path, so the full capture must be
   * on disk before anyone is told about it. Idempotent via `settling`. */
  const settleAfterFlush = (entry: Entry) => {
    if (entry.settling || entry.snapshot.status !== "running") return;
    entry.settling = true;
    runCleanup(flushSpillStreams(entry).then(() => settle(entry)));
  };

  const cancelExitCleanup = (entry: Entry) => {
    if (entry.exitCleanupTimer !== undefined) {
      clearTimeout(entry.exitCleanupTimer);
      entry.exitCleanupTimer = undefined;
    }
  };

  const scheduleExitCleanup = (entry: Entry) => {
    if (entry.exitCleanupTimer !== undefined) return;
    entry.exitCleanupTimer = setTimeout(() => {
      entry.exitCleanupTimer = undefined;
      if (entry.snapshot.status === "running" && !entry.stdioClosed) {
        runCleanup(withDeadline(teardownEntry(entry), STOP_TIMEOUT_MS));
      }
    }, SETTLE_GRACE_MS);
  };

  /** One teardown path: kill(), requestKill, pruning, and disposeAll all
   * converge here. Marks the kill at the signal point, terminates the tree,
   * and force-settles within a bounded grace. Runs at most once per entry. */
  const teardownEntry = (entry: Entry) => (entry.teardown ??= runTeardown(entry));
  const runTeardown = async (entry: Entry) => {
    cancelExitCleanup(entry);
    // Only claim "killed" when we are actually about to signal a live
    // process; a natural exit that already happened (still waiting on
    // 'close') keeps its truthful done/failed status.
    await terminateChild(
      entry.child,
      () => entry.stdioClosed,
      () => {
        entry.killSignaled ||=
          !entry.exited && entry.snapshot.status === "running";
      },
    );
    // Give the natural close→flush→settle path a bounded grace, then force
    // the settle: a grandchild holding the pipe open (detached into a new
    // group) must not leave the entry "running" forever.
    if (entry.snapshot.status === "running") {
      await withDeadline(entry.settled, SETTLE_GRACE_MS);
    }
    if (entry.snapshot.status === "running" && !entry.settling) {
      // Force the settle ourselves. When `settling` is set, the close path's
      // flush→settle is already in flight (bounded by SPILL_FLUSH_TIMEOUT_MS)
      // — settling here first would cite a spill file still being flushed.
      if (!entry.stdioClosed) {
        entry.snapshot.errorText ??=
          "stdio did not close after termination; output may be incomplete";
      }
      entry.settling = true;
      await flushSpillStreams(entry);
      settle(entry);
    }
  };

  const resolveSpillDir = () => {
    if (spillDir !== undefined) return spillDir ?? undefined;
    try {
      const base = path.join(os.tmpdir(), "pi-background-terminals");
      fs.mkdirSync(base, { recursive: true, mode: 0o700 });
      fs.chmodSync(base, 0o700);
      spillDir = fs.mkdtempSync(path.join(base, "session-"));
      fs.chmodSync(spillDir, 0o700);
    } catch {
      spillDir = null;
    }
    return spillDir ?? undefined;
  };

  const makeSpill = (
    entry: () => Entry | undefined,
    id: string,
    stream: "stdout" | "stderr",
  ): SpillHandle | undefined => {
    const dir = resolveSpillDir();
    if (!dir) return undefined;
    const spillPath = path.join(dir, `${id}.${stream}.log`);
    try {
      const file = fs.createWriteStream(spillPath, {
        flags: "a",
        mode: 0o600,
      });
      let broken = false;
      let capped = false;
      let removed = false;
      let writtenBytes = 0;
      const markUnavailable = (message: string) => {
        const current = entry();
        if (!current) return;
        const buf = stream === "stdout" ? current.stdoutBuf : current.stderrBuf;
        buf.spillPath = undefined;
        current.snapshot.errorText ??= bounded(message);
      };
      const remove = () => {
        if (removed) return;
        removed = true;
        capped = true;
        const accountedBytes = writtenBytes;
        writtenBytes = 0;
        const unlink = () => {
          fs.rm(spillPath, { force: true }, (error) => {
            // Keep failed deletions charged against the session quota; the
            // manager-level tmpdir cleanup will retry them during teardown.
            if (!error) {
              sessionSpillBytes = Math.max(0, sessionSpillBytes - accountedBytes);
            }
          });
        };
        if (file.closed) unlink();
        else if (broken) {
          file.once("close", unlink);
          file.destroy();
        } else if (file.writableEnded) file.once("close", unlink);
        else {
          file.once("close", unlink);
          file.end();
        }
      };
      file.on("error", (error) => {
        broken = true;
        markUnavailable(
          `Full-log spill to ${spillPath} failed: ${boundedError(error)}`,
        );
        remove();
      });
      return {
        spillPath,
        file,
        remove,
        write: (chunk: string) => {
          // writableEnded guard: late 'data' after the settle flush must not
          // error the ended stream (and falsely report the spill as broken).
          if (broken || capped || file.writableEnded) return true;
          const bytes = Buffer.byteLength(chunk, "utf8");
          const exceedsStream = writtenBytes + bytes > SPILL_PER_STREAM_MAX_BYTES;
          const exceedsSession = sessionSpillBytes + bytes > SPILL_SESSION_MAX_BYTES;
          if (exceedsStream || exceedsSession) {
            capped = true;
            markUnavailable(
              exceedsStream
                ? `Full-log spill stopped at the ${SPILL_PER_STREAM_MAX_BYTES / (1024 * 1024)} MiB per-stream safety limit`
                : `Full-log spill stopped at the ${SPILL_SESSION_MAX_BYTES / (1024 * 1024)} MiB session safety limit`,
            );
            remove();
            return true;
          }
          writtenBytes += bytes;
          sessionSpillBytes += bytes;
          return file.write(chunk);
        },
        resumeOnDrain: (resume: () => void) => {
          if (broken || capped || file.writableEnded) {
            queueMicrotask(resume);
            return;
          }
          let resumed = false;
          const done = () => {
            if (resumed) return;
            resumed = true;
            file.off("drain", done);
            file.off("error", done);
            resume();
          };
          file.once("drain", done);
          file.once("error", done);
        },
      };
    } catch {
      return undefined;
    }
  };

  // The whole start path is synchronous (spawn() returns immediately), so
  // there is no window where an abort or dispose can observe a live child
  // that the registry does not know about, and no reservation counter is
  // needed to make the concurrency cap race-free.
  const start = (options: StartOptions): Promise<TerminalSnapshot> => {
    if (disposed) {
      return Promise.reject(
        new SpawnError({
          message: "Background terminal manager is shutting down.",
        }),
      );
    }
    if (runningCount() >= MAX_RUNNING) {
      return Promise.reject(
        new ConcurrencyLimitError({
          message: `Max ${MAX_RUNNING} background terminals can run concurrently. Stop one with bg_kill before starting another.`,
        }),
      );
    }

    let child: ChildProcess;
    const { shell, args } = shellInvocation(options.command);
    try {
      child = spawn(shell, args, {
        cwd: options.cwd,
        env: process.env,
        // stdin IGNORED: there is no input surface, ever. A process that
        // reads stdin sees EOF immediately.
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group on POSIX → group kill takes the whole tree.
        detached: process.platform !== "win32",
      });
    } catch (error) {
      return Promise.reject(new SpawnError({ message: boundedError(error) }));
    }

    const id = `bt-${++counter}`;
    const entryRef = () => entries.get(id);
    const stdoutSpill = makeSpill(entryRef, id, "stdout");
    const stderrSpill = makeSpill(entryRef, id, "stderr");
    const stdoutBuf = new OutputBuffer(RETAINED_PER_STREAM, stdoutSpill?.write);
    const stderrBuf = new OutputBuffer(RETAINED_PER_STREAM, stderrSpill?.write);
    stdoutBuf.spillPath = stdoutSpill?.spillPath;
    stderrBuf.spillPath = stderrSpill?.spillPath;

    const snapshot: MutableSnapshot = {
      id,
      command: options.command,
      title: options.title,
      cwd: options.cwd,
      pid: child.pid,
      status: "running",
      createdAt: Date.now(),
      get stdout() {
        return stdoutBuf.view();
      },
      get stderr() {
        return stderrBuf.view();
      },
    };

    let resolveSettled!: () => void;
    const settledPromise = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const entry: Entry = {
      snapshot,
      child,
      stdoutBuf,
      stderrBuf,
      spillStreams: [stdoutSpill?.file, stderrSpill?.file].filter(
        (file): file is fs.WriteStream => file !== undefined,
      ),
      spillHandles: [stdoutSpill, stderrSpill].filter(
        (spill): spill is SpillHandle => spill !== undefined,
      ),
      killSignaled: false,
      processErrored: false,
      exited: false,
      stdioClosed: false,
      settling: false,
      settled: settledPromise,
      resolveSettled,
    };

    // Plain-callback stream plumbing: setEncoding's internal StringDecoder
    // is multibyte-safe across chunk boundaries.
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (!stdoutBuf.push(chunk)) {
        child.stdout?.pause();
        stdoutSpill?.resumeOnDrain(() => child.stdout?.resume());
      }
      notify(id);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (!stderrBuf.push(chunk)) {
        child.stderr?.pause();
        stderrSpill?.resumeOnDrain(() => child.stderr?.resume());
      }
      notify(id);
    });
    // Spawn failures (ENOENT etc.) arrive via 'error', not a throw. Node
    // still emits 'close' afterwards (with a bogus errno as code), so
    // record the failure here and let the close path do the one settle.
    child.once("error", (error) => {
      entry.processErrored = true;
      snapshot.errorText ??= boundedError(error);
      entry.exited = true;
      settleAfterFlush(entry);
    });
    // Record code/signal on 'exit'; settle on 'close' so the completion
    // notification always carries the final flushed output.
    child.once("exit", (code, signal) => {
      entry.exited = true;
      snapshot.exitCode = code ?? undefined;
      snapshot.signal = signal ?? undefined;
      // A descendant can keep the pipes open after the shell exits. Give
      // close a short natural grace, then tear down to terminate the
      // surviving process group and force a bounded settlement.
      scheduleExitCleanup(entry);
    });
    child.once("close", (code, signal) => {
      entry.exited = true;
      entry.stdioClosed = true;
      cancelExitCleanup(entry);
      // Only trust close's code/signal when 'exit' never fired (a spawn
      // 'error' close reports the errno, e.g. -2, as its code).
      if (!entry.processErrored) {
        snapshot.exitCode ??= code ?? undefined;
        snapshot.signal ??= signal ?? undefined;
      }
      settleAfterFlush(entry);
    });

    entries.set(id, entry);
    notify(id);
    return Promise.resolve(snapshot as TerminalSnapshot);
  };

  const status = (id: string): TerminalSnapshot => {
    const entry = entries.get(id);
    if (!entry) {
      const known = [...entries.keys()];
      throw new UnknownTerminalError({
        message: `Unknown terminal id "${id}". Known: ${known.join(", ") || "none"}.`,
      });
    }
    return entry.snapshot as TerminalSnapshot;
  };

  /** Kill one running entry in a DETACHED task. Once the kill flag is set the
   * termination must actually happen; a tool abort rejecting the caller's
   * wait cannot cancel it (this is what makes "termination continues in the
   * background" truthful). */
  const killEntry = (entry: Entry) => {
    if (entry.snapshot.status !== "running") return;
    runCleanup(withDeadline(teardownEntry(entry), STOP_TIMEOUT_MS));
  };

  const kill = async (
    ids: ReadonlyArray<string>,
    options: KillWaitOptions = {},
  ): Promise<ReadonlyArray<KillResult>> => {
    const unique = [...new Set(ids)];
    const byId = new Map(
      unique
        .map((id) => entries.get(id))
        .filter((entry): entry is Entry => entry !== undefined)
        .map((entry) => [entry.snapshot.id, entry]),
    );
    const running = [...byId.values()].filter(
      (entry) => entry.snapshot.status === "running",
    );
    const runningIds = running.map((entry) => entry.snapshot.id);
    // Mark consumed before signaling so this kill's settlements are not
    // ALSO queued as automatic follow-up messages to the model.
    addKillInterest(runningIds);
    try {
      for (const entry of running) killEntry(entry);
      // Every caller waits on the entries that were running when its kill
      // began. Settled promises cannot be missed and support concurrent
      // overlapping/multi-id kill calls.
      await raceAbort(
        Promise.all(running.map((entry) => entry.settled)),
        options,
      );
      // Capture the report BEFORE the finally below releases interest and
      // prunes — a just-settled entry must not vanish out from under it.
      return unique.map((id): KillResult => {
        const snapshot = byId.get(id)?.snapshot;
        const history = settledHistory.get(id);
        const status = snapshot?.status ?? history?.status ?? "killed";
        const wasRunning = runningIds.includes(id);
        return {
          id,
          title: snapshot?.title ?? history?.title ?? "?",
          status,
          wasRunning,
          // A natural exit can win the race with our SIGTERM; report what
          // actually happened rather than claiming the kill did it.
          killed: wasRunning && status === "killed",
          exit: snapshot ? formatExit(snapshot) : (history?.exit ?? "unknown"),
        };
      });
    } finally {
      releaseKillInterest(runningIds);
      pruneSettled();
    }
  };

  const disposeAll = async () => {
    disposed = true;
    const all = [...entries.values()];
    entries.clear();
    await Promise.all(
      all.map((entry) => withDeadline(teardownEntry(entry), STOP_TIMEOUT_MS)),
    );
    // Wait for detached kill/prune/flush work within the shutdown bound;
    // every task is itself bounded, so nothing runs much past it.
    await withDeadline(
      Promise.allSettled([...cleanupTasks]),
      STOP_TIMEOUT_MS,
    );
    const dir = spillDir;
    spillDir = null;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    notify();
  };

  const view: TerminalReadModel = {
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
    requestKill: (id) => {
      const entry = entries.get(id);
      if (!entry) return;
      // UI-initiated kills are not "consumed": the killed result still flows
      // back to the model as a follow-up message (subagents precedent).
      killEntry(entry);
    },
    setOnSettled: (hook) => {
      onSettled = hook;
    },
  };

  return {
    start,
    status,
    kill,
    list: () => [...entries.values()].map((e) => e.snapshot),
    disposeAll,
    view,
  };
}
