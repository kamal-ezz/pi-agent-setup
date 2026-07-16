/**
 * The unified backend interface: one `SubagentBackend` per agent runtime
 * (pi, Claude Code, Codex), all producing the same `SubagentSession` shape.
 *
 * Implementations in ./backends/:
 * - pi: in-process `createAgentSession()` via the pi SDK.
 * - claude: `@anthropic-ai/claude-agent-sdk` `query()` in streaming-input mode.
 * - codex: `codex app-server` child process speaking JSON-RPC over stdio.
 */

import type { BackendName, SpawnTask, SubagentEvent, SubagentMeta } from "./domain.ts";

export interface BackendCapabilities {
  /** Can send() steer a live run (vs. only starting a fresh run when idle). */
  readonly steering: boolean;
  readonly modelSelection: boolean;
  readonly reasoningEffort: boolean;
}

export type SubagentEventListener = (event: SubagentEvent) => void;

/**
 * A live subagent session. The manager is the single consumer of the event
 * stream; it folds the events into the `SubagentSnapshot` everything else
 * reads.
 */
export interface SubagentSession {
  /** Current metadata snapshot. Updates also arrive as MetaChanged events. */
  meta(): SubagentMeta;
  /**
   * Attach the single event consumer. Events emitted before attachment are
   * buffered and replayed synchronously; `onEnd` fires once when the stream
   * ends (session closed or backend died). Every run started within the
   * session terminates with a RunSettled event.
   */
  attach(listener: SubagentEventListener, onEnd: () => void): void;
  /**
   * Steer the active run, or start a fresh run when idle (the "is a run
   * active" decision is backend-native state). Rejects with SendError.
   */
  send(text: string): Promise<void>;
  /**
   * Interrupt the active run. Resolves once the backend acknowledges; the
   * corresponding RunSettled(Interrupted) arrives on the event stream.
   * Callers bound this with a timeout and fall back to close().
   */
  interrupt(): Promise<void>;
  /**
   * Tear the session down: interrupt/kill the underlying session or process
   * and end the event stream. Idempotent; never throws.
   */
  close(): Promise<void>;
}

export interface SubagentBackend {
  readonly name: BackendName;
  readonly capabilities: BackendCapabilities;
  /** Probe availability (binary on PATH, SDK importable, credentials). */
  available(): boolean | Promise<boolean>;
  /**
   * Spawn a session. Rejects with SpawnError. Fire-and-forget semantics
   * (detached pumps, result delivery) live in the manager.
   */
  spawn(task: SpawnTask): Promise<SubagentSession>;
}

/** Registry of all wired backends, keyed by name. */
export type BackendRegistry = ReadonlyMap<BackendName, SubagentBackend>;

/**
 * Single-consumer event channel backing a session's event stream: buffers
 * until the manager attaches, then dispatches synchronously. `end()` is
 * remembered, delivered once, and drops all later emissions — the plain
 * replacement for the old Queue + Stream.fromQueue pair.
 */
export function createEventChannel() {
  let listener: SubagentEventListener | undefined;
  let onEnd: (() => void) | undefined;
  let buffer: SubagentEvent[] = [];
  let ended = false;
  let endDelivered = false;

  return {
    emit(event: SubagentEvent) {
      if (ended) return;
      if (listener) listener(event);
      else buffer.push(event);
    },
    end() {
      if (ended) return;
      ended = true;
      if (listener && !endDelivered) {
        endDelivered = true;
        onEnd?.();
      }
    },
    attach(nextListener: SubagentEventListener, nextOnEnd: () => void) {
      listener = nextListener;
      onEnd = nextOnEnd;
      const pending = buffer;
      buffer = [];
      for (const event of pending) nextListener(event);
      if (ended && !endDelivered) {
        endDelivered = true;
        nextOnEnd();
      }
    },
  };
}

export type SubagentEventChannel = ReturnType<typeof createEventChannel>;
