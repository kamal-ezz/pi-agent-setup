import assert from "node:assert/strict";
import test from "node:test";
import footerExtension from "../hide-token-cost.ts";

test("footer renders repository and activity as a compact two-row layout", async () => {
  let sessionStart;
  let footerFactory;

  const pi = {
    on(name, handler) {
      if (name === "session_start") sessionStart = handler;
    },
    exec: async () => ({ code: 0, stdout: "/work/pi-agent-setup\n", stderr: "" }),
    getThinkingLevel: () => "high",
  };
  const ctx = {
    mode: "tui",
    model: { id: "gpt-5.6-sol", reasoning: true },
    getContextUsage: () => ({ percent: 63 }),
    sessionManager: {
      getCwd: () => "/work/pi-agent-setup",
      getSessionName: () => undefined,
    },
    ui: {
      setFooter(factory) {
        footerFactory = factory;
      },
    },
  };

  footerExtension(pi);
  await sessionStart({}, ctx);
  assert.ok(footerFactory);

  const theme = {
    fg: (_color, text) => text,
    bold: (text) => text,
  };
  const footerData = {
    onBranchChange: () => () => {},
    getGitBranch: () => "master",
    getExtensionStatuses: () =>
      new Map([
        ["auto-plan-mode", "◆ auto · reviewing"],
        ["codex-usage", "Codex week 7% · resets ×3"],
      ]),
  };
  const footer = footerFactory({ requestRender() {} }, theme, footerData);
  const lines = footer.render(100);

  assert.equal(lines.length, 2);
  assert.match(lines[0], /^pi-agent-setup · master/);
  assert.match(lines[0], /gpt-5\.6-sol · high$/);
  assert.match(lines[1], /^◆ auto · reviewing/);
  assert.match(lines[1], /ctx ▓{6}░{4} 63%$/);
  assert.doesNotMatch(lines.join("\n"), /\bin\b|\bout\b|cache|week|resets/);
});
