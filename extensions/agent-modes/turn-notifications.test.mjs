import assert from "node:assert/strict";
import test from "node:test";
import turnNotifications from "../turn-notifications.ts";

function createHarness({ mode = "tui", branch = [], sessionName, execImpl } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const execCalls = [];
  const uiNotifications = [];
  let terminalInput = () => undefined;
  let inputUnsubscribed = 0;
  let idle = true;
  let pendingMessages = false;

  turnNotifications({
    on(event, handler) {
      handlers.set(event, handler);
    },
    exec: async (command, args, options) => {
      execCalls.push({ args, command, options });
      if (execImpl) return execImpl(command, args, options);
      return { code: 0, stdout: "", stderr: "" };
    },
    registerCommand(name, command) {
      commands.set(name, command.handler);
    },
  });

  const ctx = {
    mode,
    cwd: "/workspace/project",
    isIdle: () => idle,
    hasPendingMessages: () => pendingMessages,
    sessionManager: {
      getBranch: () => branch,
      getSessionName: () => sessionName,
    },
    ui: {
      notify: (message, type) => uiNotifications.push({ message, type }),
      onTerminalInput(handler) {
        terminalInput = handler;
        return () => {
          inputUnsubscribed++;
          terminalInput = () => undefined;
        };
      },
    },
  };

  return {
    commands,
    ctx,
    execCalls,
    handlers,
    input: (data) => terminalInput(data),
    setIdle(value) {
      idle = value;
    },
    setPendingMessages(value) {
      pendingMessages = value;
    },
    get inputUnsubscribed() {
      return inputUnsubscribed;
    },
    uiNotifications,
  };
}

const flushAlerts = () => new Promise((resolve) => setTimeout(resolve, 10));

async function captureTerminalWrites(run) {
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = function (chunk, ...args) {
    const value = String(chunk);
    if (value === "\x1b[?1004h" || value === "\x1b[?1004l" || value === "\x07") {
      writes.push(value);
      return true;
    }
    return originalWrite.call(process.stdout, chunk, ...args);
  };
  try {
    await run(writes);
  } finally {
    process.stdout.write = originalWrite;
  }
}

test("TUI notifies the desktop while unfocused and chimes only while focused", async () => {
  const harness = createHarness();
  const chimes = () => harness.execCalls.filter(({ command }) => command === "canberra-gtk-play").length;
  const desktopAlerts = () => harness.execCalls.filter(({ command }) => command === "notify-send").length;

  await captureTerminalWrites(async (writes) => {
    await harness.handlers.get("session_start")({}, harness.ctx);

    // Startup is treated as focused: audible chime, no desktop notification.
    await harness.handlers.get("agent_settled")({}, harness.ctx);
    await flushAlerts();
    assert.equal(chimes(), 1);
    assert.equal(desktopAlerts(), 0);

    // Unfocused: the user must see a desktop notification, not hear the bell.
    assert.deepEqual(harness.input("\x1b[O"), { consume: true });
    await harness.handlers.get("agent_settled")({}, harness.ctx);
    await flushAlerts();
    assert.equal(chimes(), 1);
    assert.equal(desktopAlerts(), 1);

    // Any real input repairs a missed focus-in report, restoring the chime.
    assert.equal(harness.input("x"), undefined);
    await harness.handlers.get("agent_settled")({}, harness.ctx);
    await flushAlerts();
    assert.equal(chimes(), 2);
    assert.equal(desktopAlerts(), 1);

    assert.deepEqual(harness.input("\x1b[Iabc"), { data: "abc" });
    await harness.handlers.get("session_shutdown")({}, harness.ctx);
    assert.deepEqual(
      writes.filter((value) => value.startsWith("\x1b")),
      ["\x1b[?1004h", "\x1b[?1004l"],
    );
  });

  assert.equal(harness.inputUnsubscribed, 1);
});

test("TUI unfocused falls back to the chime when notify-send fails", async () => {
  const harness = createHarness({
    execImpl: async (command) =>
      command === "notify-send" ? { code: 1, stdout: "", stderr: "no notification daemon" } : { code: 0, stdout: "", stderr: "" },
  });

  await captureTerminalWrites(async () => {
    await harness.handlers.get("session_start")({}, harness.ctx);
    harness.input("\x1b[O");
    await harness.handlers.get("agent_settled")({}, harness.ctx);
    await flushAlerts();
    await harness.handlers.get("session_shutdown")({}, harness.ctx);
  });

  assert.equal(harness.execCalls.filter(({ command }) => command === "notify-send").length, 1);
  assert.equal(harness.execCalls.filter(({ command }) => command === "canberra-gtk-play").length, 1);
});

test("a successful automatic retry clears an earlier abort suppression", async () => {
  const harness = createHarness();
  await captureTerminalWrites(async () => {
    await harness.handlers.get("session_start")({}, harness.ctx);
    harness.input("\x1b[O");

    await harness.handlers.get("agent_end")(
      { messages: [{ role: "assistant", stopReason: "aborted" }] },
      harness.ctx,
    );
    await harness.handlers.get("agent_end")({ messages: [] }, harness.ctx);
    await harness.handlers.get("agent_settled")({}, harness.ctx);
    await flushAlerts();

    await harness.handlers.get("agent_end")(
      { messages: [{ role: "assistant", stopReason: "aborted" }] },
      harness.ctx,
    );
    await harness.handlers.get("agent_settled")({}, harness.ctx);
    await flushAlerts();
    await harness.handlers.get("session_shutdown")({}, harness.ctx);
  });

  assert.equal(harness.execCalls.filter(({ command }) => command === "notify-send").length, 1);
});

test("desktop notifications sanitize content and terminate option parsing", async () => {
  const branch = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "# Done \u001b[31m<b>& safe</b>\u001b[0m\n- Next step",
          },
        ],
      },
    },
  ];
  const harness = createHarness({
    mode: "print",
    branch,
    sessionName: "--icon=<b>bad</b>\nname",
  });

  await harness.handlers.get("session_start")({}, harness.ctx);
  await harness.handlers.get("agent_end")(
    { messages: [branch[0].message] },
    harness.ctx,
  );
  await harness.handlers.get("agent_settled")({}, harness.ctx);
  await flushAlerts();

  const call = harness.execCalls.find(({ command }) => command === "notify-send");
  assert.ok(call);
  assert.deepEqual(call.args.slice(-3), [
    "--",
    "Pi — --icon=bad name",
    "Done & safe\n• Next step",
  ]);
  assert.doesNotMatch(call.args.join(" "), /\u001b|<b>/);
});

test("deferred idle check skips alerts between goal continuations", async () => {
  const harness = createHarness();
  await captureTerminalWrites(async () => {
    await harness.handlers.get("session_start")({}, harness.ctx);
    harness.input("\x1b[O");

    // Goal's agent_settled handler registers its zero-delay continuation first.
    setTimeout(() => harness.setIdle(false), 0);
    await harness.handlers.get("agent_settled")({}, harness.ctx);
    await flushAlerts();
    assert.equal(harness.execCalls.length, 0);

    harness.setIdle(true);
    await harness.handlers.get("agent_settled")({}, harness.ctx);
    await flushAlerts();
    assert.equal(harness.execCalls.filter(({ command }) => command === "notify-send").length, 1);
    await harness.handlers.get("session_shutdown")({}, harness.ctx);
  });
});

test("idle deferral is safe when notifications schedule before goal continuation", async () => {
  const harness = createHarness();
  await captureTerminalWrites(async () => {
    await harness.handlers.get("session_start")({}, harness.ctx);
    harness.input("\x1b[O");

    // Simulate notification's settled handler running before /goal's handler.
    await harness.handlers.get("agent_settled")({}, harness.ctx);
    setTimeout(() => harness.setIdle(false), 0);
    await flushAlerts();
    assert.equal(harness.execCalls.length, 0);
    await harness.handlers.get("session_shutdown")({}, harness.ctx);
  });
});

test("print mode never blocks a persistent goal continuation to notify", async () => {
  const now = Date.now();
  const harness = createHarness({
    mode: "print",
    branch: [{
      type: "custom",
      customType: "goal-state-v1",
      data: {
        version: 1,
        state: {
          version: 1,
          id: "goal-1",
          revision: 1,
          objective: "Finish the audit",
          status: "active",
          runs: 1,
          continuations: 0,
          tokensUsed: 10,
          timeUsedMs: 10,
          createdAt: now,
          updatedAt: now,
        },
      },
    }],
  });
  await harness.handlers.get("session_start")({}, harness.ctx);
  await harness.handlers.get("agent_settled")({}, harness.ctx);
  await flushAlerts();
  assert.equal(harness.execCalls.length, 0);
  await harness.handlers.get("session_shutdown")({}, harness.ctx);
});

test("session shutdown aborts an in-flight desktop alert without a late fallback bell", async () => {
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let aborted = false;
  const harness = createHarness({
    execImpl: (_command, _args, options) =>
      new Promise((resolve, reject) => {
        markStarted();
        options.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      }),
  });

  await captureTerminalWrites(async (writes) => {
    await harness.handlers.get("session_start")({}, harness.ctx);
    harness.input("\x1b[O");
    await harness.handlers.get("agent_settled")({}, harness.ctx);
    await started;
    await harness.handlers.get("session_shutdown")({}, harness.ctx);
    await flushAlerts();
    assert.equal(writes.includes("\x07"), false);
  });
  assert.equal(aborted, true);
});

test("a tool cancellation followed by a successful assistant still alerts", async () => {
  const harness = createHarness();
  await captureTerminalWrites(async () => {
    await harness.handlers.get("session_start")({}, harness.ctx);
    harness.input("\x1b[O");
    await harness.handlers.get("agent_end")(
      {
        messages: [
          {
            role: "toolResult",
            isError: true,
            content: [{ type: "text", text: "Cancelled previous subtask; completed fallback" }],
          },
          {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Fallback completed." }],
          },
        ],
      },
      harness.ctx,
    );
    await harness.handlers.get("agent_settled")({}, harness.ctx);
    await flushAlerts();
    await harness.handlers.get("session_shutdown")({}, harness.ctx);
  });
  const call = harness.execCalls.find(({ command }) => command === "notify-send");
  assert.ok(call);
  assert.equal(call.args.at(-1), "Fallback completed.");
});

test("tool-only completion does not reuse an older assistant overview", async () => {
  const harness = createHarness({
    mode: "print",
    branch: [
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Old unrelated response" }] },
      },
    ],
  });
  await harness.handlers.get("session_start")({}, harness.ctx);
  await harness.handlers.get("agent_end")(
    {
      messages: [
        {
          role: "toolResult",
          isError: false,
          content: [{ type: "text", text: "Done" }],
        },
      ],
    },
    harness.ctx,
  );
  await harness.handlers.get("agent_settled")({}, harness.ctx);
  await flushAlerts();

  const call = harness.execCalls.find(({ command }) => command === "notify-send");
  assert.equal(call.args.at(-1), "Turn finished — ready for input.");
});

test("/notifications off suppresses automatic alerts while test remains explicit", async () => {
  const harness = createHarness();
  await captureTerminalWrites(async () => {
    await harness.handlers.get("session_start")({}, harness.ctx);
    harness.input("\x1b[O");

    await harness.commands.get("notifications")("off", harness.ctx);
    await harness.handlers.get("agent_settled")({}, harness.ctx);
    assert.equal(harness.execCalls.length, 0);

    await harness.commands.get("notifications")("test", harness.ctx);
    assert.equal(harness.execCalls.filter(({ command }) => command === "canberra-gtk-play").length, 1);
    await harness.handlers.get("session_shutdown")({}, harness.ctx);
  });

  assert.match(harness.uiNotifications.at(-1)?.message ?? "", /Test completion chime played/);

  // Extension factories are recreated on /reload and session replacement; the
  // process-scoped preference must survive that reconstruction.
  const reloaded = createHarness();
  await captureTerminalWrites(async () => {
    await reloaded.handlers.get("session_start")({}, reloaded.ctx);
    await reloaded.commands.get("notifications")("", reloaded.ctx);
    assert.match(reloaded.uiNotifications.at(-1)?.message ?? "", /off for this Pi process/);
    await reloaded.commands.get("notifications")("on", reloaded.ctx);
    await reloaded.handlers.get("session_shutdown")({}, reloaded.ctx);
  });
});
