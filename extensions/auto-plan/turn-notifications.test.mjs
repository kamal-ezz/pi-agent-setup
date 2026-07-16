import assert from "node:assert/strict";
import test from "node:test";
import turnNotifications from "../turn-notifications.ts";

test("a settled TUI turn plays a completion chime only after its terminal tab loses focus", async () => {
  const handlers = new Map();
  let notifySendCalls = 0;
  let completionChimeCalls = 0;
  turnNotifications({
    on(event, handler) {
      handlers.set(event, handler);
    },
    exec: async (command) => {
      if (command === "canberra-gtk-play") {
        completionChimeCalls++;
        return { code: 0, stdout: "", stderr: "" };
      }
      notifySendCalls++;
      return { code: 0, stdout: "", stderr: "" };
    },
    registerCommand() {},
  });

  const terminalControl = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    terminalControl.push(String(chunk));
    return true;
  };
  try {
    const ctx = { mode: "tui", isIdle: () => true };
    await handlers.get("session_start")({}, ctx);
    process.stdin.emit("data", "\x1b[I");
    await handlers.get("agent_settled")({}, ctx);
    process.stdin.emit("data", "\x1b[O");
    await handlers.get("agent_settled")({}, ctx);
    await handlers.get("session_shutdown")({}, ctx);
  } finally {
    process.stdout.write = originalWrite;
    process.stdin.pause();
  }

  assert.deepEqual(terminalControl, ["\x1b[?1004h", "\x1b[?1004l"]);
  assert.equal(completionChimeCalls, 1);
  assert.equal(notifySendCalls, 0);
});
