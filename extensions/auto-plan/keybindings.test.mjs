import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const keybindings = JSON.parse(
  readFileSync(new URL("../../keybindings.json", import.meta.url), "utf8"),
);

test("Ctrl+C is reserved for the custom interrupt shortcut", () => {
  assert.deepEqual(keybindings["app.clear"], []);
  assert.deepEqual(keybindings["tui.input.copy"], []);
  assert.deepEqual(keybindings["tui.select.cancel"], ["escape"]);
});
