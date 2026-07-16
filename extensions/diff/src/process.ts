import { Context, Effect, Layer, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

export const MAX_COMMAND_STDOUT_BYTES = 64 * 1024 * 1024;
export const MAX_COMMAND_STDERR_BYTES = 2 * 1024 * 1024;

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

interface CommandRunnerShape {
  run(
    command: string,
    args: string[],
    cwd: string,
    timeout: number,
  ): Effect.Effect<CommandResult>;
}

export class CommandRunner extends Context.Service<
  CommandRunner,
  CommandRunnerShape
>()("diff-browser/CommandRunner") {}

function appendCommandFailure(stderr: string, command: string, error: Error) {
  const failure = `Failed to run ${command}: ${error.message}`;
  return stderr ? `${stderr.trimEnd()}\n${failure}` : failure;
}

export const CommandRunnerLive = Layer.effect(
  CommandRunner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;

    return CommandRunner.of({
      run: (command, args, cwd, timeout) =>
        Effect.suspend(() => {
          let stderr = "";
          let stdout = "";
          let stderrBytes = 0;
          let stdoutBytes = 0;
          let stderrTruncated = false;
          let stdoutTruncated = false;
          const child = ChildProcess.make(command, args, {
            cwd,
            detached: false,
            forceKillAfter: "5 seconds",
            stdin: "ignore",
            stderr: "pipe",
            stdout: "pipe",
          });

          return Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(child);
              const [, , code] = yield* Effect.all(
                [
                  Stream.runForEach(Stream.decodeText(handle.stdout), (chunk) =>
                    Effect.sync(() => {
                      if (stdoutTruncated) return;
                      const next = appendBoundedChunk(stdout, stdoutBytes, chunk, MAX_COMMAND_STDOUT_BYTES);
                      stdout = next.text;
                      stdoutBytes = next.bytes;
                      stdoutTruncated = next.truncated;
                    }),
                  ),
                  Stream.runForEach(Stream.decodeText(handle.stderr), (chunk) =>
                    Effect.sync(() => {
                      if (stderrTruncated) return;
                      const next = appendBoundedChunk(stderr, stderrBytes, chunk, MAX_COMMAND_STDERR_BYTES);
                      stderr = next.text;
                      stderrBytes = next.bytes;
                      stderrTruncated = next.truncated;
                    }),
                  ),
                  handle.exitCode,
                ],
                { concurrency: "unbounded" },
              );
              return {
                code: Number(code),
                stderr,
                stdout,
                ...(stderrTruncated ? { stderrTruncated: true } : {}),
                ...(stdoutTruncated ? { stdoutTruncated: true } : {}),
              };
            }),
          ).pipe(
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () => Effect.succeed({
                code: -1,
                stderr,
                stdout,
                ...(stderrTruncated ? { stderrTruncated: true } : {}),
                ...(stdoutTruncated ? { stdoutTruncated: true } : {}),
              }),
            }),
            Effect.catch((error) =>
              Effect.succeed({
                code: 1,
                stderr: appendCommandFailure(stderr, command, error),
                stdout,
                ...(stderrTruncated ? { stderrTruncated: true } : {}),
                ...(stdoutTruncated ? { stdoutTruncated: true } : {}),
              }),
            ),
          );
        }),
    });
  }),
);

export const runCommand = (
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
) =>
  Effect.gen(function* () {
    const commands = yield* CommandRunner;
    return yield* commands.run(command, args, cwd, timeout);
  });
