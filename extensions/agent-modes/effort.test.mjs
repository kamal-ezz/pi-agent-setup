import assert from "node:assert/strict";
import test from "node:test";
import effortExtension from "../effort.ts";

test("/effort without arguments never opens a picker outside the TUI", async () => {
  let handler;
  let selected = false;
  let notice = "";
  effortExtension({
    registerCommand(_name, command) {
      handler = command.handler;
    },
    getThinkingLevel: () => "high",
    setThinkingLevel() {},
  });

  await handler("", {
    mode: "print",
    model: { reasoning: true },
    ui: {
      notify(message) {
        notice = message;
      },
      async select() {
        selected = true;
        return undefined;
      },
    },
  });

  assert.equal(selected, false);
  assert.match(notice, /Reasoning effort: high/);
  assert.match(notice, /Usage: \/effort/);
});
