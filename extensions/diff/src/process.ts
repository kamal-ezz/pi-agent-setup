import { spawn } from "node:child_process";

export const MAX_COMMAND_STDOUT_BYTES = 64 * 1024 * 1024;
export const MAX_COMMAND_STDERR_BYTES = 2 * 1024 * 1024;

const FORCE_KILL_AFTER_MS = 5_000;

export interface CommandResult {
  code: number;
  stderr: string;
  stderrTruncated?: boolean;
  stdout: string;
  stdoutTruncated?: boolean;
}

function appendBoundedChunk(
  current: string,
  currentBytes: number,
  chunk: string,
  maxBytes: number,
): { bytes: number; text: string; truncated: boolean } {
  const remaining = Math.max(0, maxBytes - currentBytes);
  const raw = Buffer.from(chunk, "utf8");
  if (raw.length <= remaining) {
    return { bytes: currentBytes + raw.length, text: current + chunk, truncated: false };
  }
  let end = remaining;
  while (end > 0 && end < raw.length && (raw[end] & 0xc0) === 0x80) end -= 1;
  return {
    bytes: currentBytes + end,
    text: current + raw.subarray(0, end).toString("utf8"),
    truncated: true,
  };
}

export function appendBoundedText(
  current: string,
  chunk: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const { text, truncated } = appendBoundedChunk(
    current,
    Buffer.byteLength(current, "utf8"),
    chunk,
    maxBytes,
  );
  return { text, truncated };
}

function appendCommandFailure(stderr: string, command: string, error: Error) {
  const failure = `Failed to run ${command}: ${error.message}`;
  return stderr ? `${stderr.trimEnd()}\n${failure}` : failure;
}

export function abortError(message: string) {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Run a command with bounded output capture.
 *
 * Failures never reject: spawn errors surface as `code: 1` with the failure
 * appended to stderr, and timeouts as `code: -1` with the partial output.
 * The only rejection is an AbortError when `signal` fires, after which the
 * child is force-killed in the background.
 */
export function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError("Operation was aborted."));
      return;
    }

    let stderr = "";
    let stdout = "";
    let stderrBytes = 0;
    let stdoutBytes = 0;
    let stderrTruncated = false;
    let stdoutTruncated = false;
    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(command, args, {
      cwd,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const partialResult = (code: number): CommandResult => ({
      code,
      stderr,
      stdout,
      ...(stderrTruncated ? { stderrTruncated: true } : {}),
      ...(stdoutTruncated ? { stdoutTruncated: true } : {}),
    });

    const cleanup = () => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
      signal?.removeEventListener("abort", onAbort);
    };

    const kill = () => {
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, FORCE_KILL_AFTER_MS);
      forceKillTimer.unref?.();
    };

    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };

    const onAbort = () =>
      settle(() => {
        kill();
        reject(abortError("Operation was aborted."));
      });
    signal?.addEventListener("abort", onAbort, { once: true });

    timeoutTimer = setTimeout(
      () =>
        settle(() => {
          kill();
          resolve(partialResult(-1));
        }),
      timeout,
    );

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdoutTruncated) return;
      const next = appendBoundedChunk(stdout, stdoutBytes, chunk, MAX_COMMAND_STDOUT_BYTES);
      stdout = next.text;
      stdoutBytes = next.bytes;
      stdoutTruncated = next.truncated;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderrTruncated) return;
      const next = appendBoundedChunk(stderr, stderrBytes, chunk, MAX_COMMAND_STDERR_BYTES);
      stderr = next.text;
      stderrBytes = next.bytes;
      stderrTruncated = next.truncated;
    });

    child.on("error", (error) =>
      settle(() => {
        stderr = appendCommandFailure(stderr, command, error);
        resolve(partialResult(1));
      }),
    );

    // "close" fires after both stdio streams end, so capture is complete.
    child.on("close", (code) =>
      settle(() => {
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
        resolve(partialResult(code ?? 1));
      }),
    );
  });
}
