import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBtwPrompt,
  conversationSnapshot,
  createBtwExtension,
} from "./index.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

async function flushTasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("conversation snapshot keeps readable message roles and bounds the tail", () => {
  const snapshot = conversationSnapshot(
    [
      { data: "not model context" },
      { role: "user", content: [{ type: "text", text: "first question" }] },
      { role: "assistant", content: [{ type: "text", text: "first answer" }] },
      {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "important output" }],
      },
    ],
    45,
  );

  assert.match(snapshot, /earlier conversation omitted/);
  assert.match(snapshot, /tool read: important output/);
  assert.doesNotMatch(snapshot, /not model context/);
});

test("BTW prompt separates the primary snapshot from the side question", () => {
  const prompt = buildBtwPrompt("What does that error mean?", "user: Fix the build");
  assert.match(prompt, /<primary-conversation-snapshot>/);
  assert.match(prompt, /user: Fix the build/);
  assert.match(prompt, /<side-question>/);
  assert.match(prompt, /What does that error mean\?/);
});

test("/btw answers out of band without waiting for or messaging the primary run", async () => {
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const entries: Array<{ type: string; data: any }> = [];
  const notifications: string[] = [];
  const statuses: Array<string | undefined> = [];
  const completion = deferred<any>();
  let completeCalls = 0;
  let sentUserMessages = 0;

  const extension = createBtwExtension((async (_model: any, request: any) => {
    completeCalls++;
    assert.match(request.messages[0]?.content[0]?.text ?? "", /Why is it red\?/);
    return completion.promise;
  }) as any);

  const pi = {
    appendEntry(type: string, data: any) {
      entries.push({ type, data });
    },
    on(name: string, handler: any) {
      handlers.set(name, handler);
    },
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
    registerEntryRenderer() {},
    sendUserMessage() {
      sentUserMessages++;
    },
  } as any;

  extension(pi);
  const ctx = {
    mode: "tui",
    model: {
      provider: "test",
      id: "model",
      name: "Model",
      contextWindow: 128_000,
      maxTokens: 4_000,
    },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
    },
    sessionManager: {
      getBranch: () => {
        throw new Error("raw branch history must not be read");
      },
      buildContextEntries: () => [
        {
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "The status is red" }],
          },
        },
      ],
    },
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    },
  } as any;

  await commands.get("btw").handler("Why is it red?", ctx);
  assert.equal(completeCalls, 1);
  assert.equal(entries.length, 0, "the command returned before the side answer");
  assert.equal(sentUserMessages, 0);
  assert.equal(statuses.at(-1), "btw: 1 thinking");

  await flushTasks();
  assert.equal(completeCalls, 1);
  assert.equal(entries.length, 0, "the primary command did not wait for the side answer");

  completion.resolve({
    content: [{ type: "text", text: "Red means the check failed." }],
  });
  await flushTasks();

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.type, "btw-answer");
  assert.equal(entries[0]?.data.answer, "Red means the check failed.");
  assert.equal(sentUserMessages, 0);
  assert.match(notifications.at(-1) ?? "", /answer ready/);
  assert.equal(statuses.at(-1), undefined);
});

test("/btw rejects one-shot modes instead of starting a doomed request", async () => {
  const commands = new Map<string, any>();
  const notifications: string[] = [];
  let completeCalls = 0;
  const extension = createBtwExtension((async () => {
    completeCalls++;
    throw new Error("must not run");
  }) as any);
  extension({
    on() {},
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerEntryRenderer() {},
  } as any);

  await commands.get("btw").handler("A side question", {
    mode: "print",
    model: { provider: "test", id: "model" },
    ui: {
      notify: (message: string) => notifications.push(message),
    },
  });

  assert.equal(completeCalls, 0);
  assert.match(notifications.at(-1) ?? "", /interactive TUI/);
});

test("session shutdown cancels an in-flight side question", async () => {
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const entries: unknown[] = [];
  let observedSignal: AbortSignal | undefined;

  const extension = createBtwExtension((async (_model: any, _request: any, options: any) => {
    observedSignal = options.signal;
    return new Promise(() => {});
  }) as any);
  const pi = {
    appendEntry: (_type: string, data: unknown) => entries.push(data),
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerEntryRenderer() {},
  } as any;
  extension(pi);
  const ctx = {
    mode: "tui",
    model: {
      provider: "test",
      id: "model",
      name: "Model",
      contextWindow: 128_000,
      maxTokens: 4_000,
    },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
    },
    sessionManager: { buildContextEntries: () => [] },
    ui: { notify() {}, setStatus() {} },
  } as any;

  await commands.get("btw").handler("A side question", ctx);
  await flushTasks();
  assert.equal(observedSignal?.aborted, false);

  await handlers.get("session_shutdown")({}, ctx);
  assert.equal(observedSignal?.aborted, true);
  assert.equal(entries.length, 0);
});
