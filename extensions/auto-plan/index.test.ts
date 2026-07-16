import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import autoPlanMode, {
  ADVISOR_SYSTEM_PROMPT,
  ClipboardImageMarkers,
  actionPreview,
  addInputArrow,
  createInterruptHandler,
  formatAdvisorReviewMessage,
  formatAgentInstructions,
  hasSensitiveOrExternalPath,
  prepareReviewAction,
  terminalTitle,
  trustedReadOnlyToolNames,
  unknownStreamingSlashCommand,
} from "./index.ts";

test("advisor asks only for destructive or security-critical actions", () => {
  assert.match(ADVISOR_SYSTEM_PROMPT, /Choose "ask" only/);
  assert.match(ADVISOR_SYSTEM_PROMPT, /normal non-force pushes/);
  assert.match(ADVISOR_SYSTEM_PROMPT, /Routine implementation uncertainty is not enough/);
  assert.match(ADVISOR_SYSTEM_PROMPT, /AGENTS\.md instructions/);
});

test("advisor receives every loaded AGENTS.md and ignores other context files", () => {
  const instructions = formatAgentInstructions([
    { path: "/repo/AGENTS.md", content: "Never push directly." },
    { path: "/repo/packages/app/agents.MD", content: "Use pnpm." },
    { path: "/repo/CLAUDE.md", content: "Not advisor policy." },
  ]);
  assert.match(instructions, /Never push directly/);
  assert.match(instructions, /Use pnpm/);
  assert.doesNotMatch(instructions, /Not advisor policy/);
  assert.match(formatAgentInstructions([]), /No AGENTS\.md/);
});

test("terminal title includes an active-turn spinner", () => {
  const ctx = {
    cwd: "/work/pi-agent-setup",
    sessionManager: { getSessionName: () => "feature work" },
  } as any;
  assert.equal(terminalTitle(ctx), "π - feature work - pi-agent-setup");
  assert.equal(terminalTitle(ctx, "⠋"), "⠋ π - feature work - pi-agent-setup");
});

test("input arrow prefixes only the first editable line", () => {
  assert.deepEqual(
    addInputArrow(["────", " text", " wrap", "────"], 12, "➜"),
    ["────", "➜  text", " wrap", "────"],
  );
  assert.deepEqual(addInputArrow(["──", "", "──"], 2, "➜"), ["──", "➜ ", "──"]);
});

test("unknown slash commands cannot become steering messages", () => {
  const known = ["subagents", "skill:mermaid-diagram", "review"];
  assert.equal(
    unknownStreamingSlashCommand("/not-a-command argument", "steer", known),
    "not-a-command",
  );
  assert.equal(
    unknownStreamingSlashCommand("/subagents", "steer", known),
    undefined,
  );
  assert.equal(
    unknownStreamingSlashCommand("/skill:mermaid-diagram draw", "steer", known),
    undefined,
  );
  assert.equal(
    unknownStreamingSlashCommand("/not-a-command", "followUp", known),
    undefined,
  );
  assert.equal(
    unknownStreamingSlashCommand("please /not-a-command", "steer", known),
    undefined,
  );
});

test("clipboard images render as numbered placeholders and submit real paths", () => {
  const images = new ClipboardImageMarkers();
  const first = "/tmp/pi-clipboard-129d97e0-d15a-46f4-8716-b3e6b042e261.png";
  const second = "/tmp/pi-clipboard-ed18a6e0-c6fa-4acc-a5a5-0d044c70cf2c.jpg";

  assert.equal(images.collapse(first), "[Image #1]");
  assert.equal(
    images.collapse(`Compare ${first} with ${second}`),
    "Compare [Image #1] with [Image #2]",
  );
  assert.equal(
    images.expand("Compare [Image #1] with [Image #2]"),
    `Compare ${first} with ${second}`,
  );
  assert.equal(images.collapse(first), "[Image #1]");
});

test("Ctrl/Cmd+C preserves drafts, interrupts turns, and exits on a second press", () => {
  let currentTime = 1_000;
  let idle = true;
  let aborts = 0;
  let shutdowns = 0;
  const restoredDrafts: string[] = [];
  const interrupt = createInterruptHandler(
    () => currentTime,
    () => "finish the refactor",
  );
  const ctx = {
    isIdle: () => idle,
    abort: () => aborts++,
    shutdown: () => shutdowns++,
    ui: { setEditorText: (text: string) => restoredDrafts.push(text) },
  } as any;

  interrupt(ctx);
  assert.equal(aborts, 0);
  assert.deepEqual(restoredDrafts, ["finish the refactor"]);

  currentTime += 800;
  idle = false;
  interrupt(ctx);
  assert.equal(aborts, 1);
  assert.deepEqual(restoredDrafts, ["finish the refactor", "finish the refactor"]);

  currentTime += 200;
  interrupt(ctx);
  assert.equal(shutdowns, 1);
});

test("review payloads are complete or fail closed", () => {
  const content = `head-${"x".repeat(20_000)}-dangerous-middle-${"y".repeat(20_000)}-tail`;
  const accepted = prepareReviewAction({
    type: "tool_call",
    toolCallId: "write-1",
    toolName: "write",
    input: { path: "large.txt", content },
  });
  assert.equal(accepted.oversizedReason, undefined);
  assert.equal(accepted.payload.content, content);

  const blocked = prepareReviewAction({
    type: "tool_call",
    toolCallId: "write-2",
    toolName: "write",
    input: { path: "too-large.txt", content: "x".repeat(60_000) },
  });
  assert.match(blocked.oversizedReason ?? "", /too large to review safely/);
});

test("advisor message preserves a reviewable near-limit payload", () => {
  const content = `head-${"x".repeat(20_000)}-security-critical-middle-${"y".repeat(20_000)}-tail`;
  const message = formatAdvisorReviewMessage({
    cwd: "/repo",
    recentUserRequest: "Update the file",
    reviewPayload: { path: "large.txt", content },
    toolDescription: "Write a file",
    toolName: "write",
  });
  assert.match(message, /security-critical-middle/);
  assert.match(message, /-tail"\s*\}$/);
  assert.doesNotMatch(message, /truncated/);
});

test("approval previews are compact with explicit elision", () => {
  const write = actionPreview("write", { path: "a.txt", content: "x".repeat(5_000) });
  assert.match(write, /^path: a\.txt/);
  assert.match(write, /chars/);
  assert.match(write, /omitted/);
  assert.ok(write.length < 3_000);

  const edit = actionPreview("edit", { path: "b.ts", oldText: "old", newText: "new" });
  assert.match(edit, /--- old\nold\n\+\+\+ new\nnew/);

  assert.equal(actionPreview("bash", { command: "rm -rf build" }), "rm -rf build");
  assert.match(actionPreview("subagent_spawn", { task: "x" }), /"task": "x"/);
});

test("tool-name overrides are not trusted as read-only", () => {
  const trusted = trustedReadOnlyToolNames({
    getAllTools: () => [
      {
        name: "read",
        sourceInfo: { source: "project-extension", path: "/project/.pi/extensions/read.ts" },
      },
      {
        name: "bash",
        sourceInfo: { source: "builtin", path: "<builtin:bash>" },
      },
    ],
  } as any);
  assert.deepEqual([...trusted], ["bash"]);
});

test("sensitive and symlinked external reads require review", () => {
  const root = mkdtempSync(join(tmpdir(), "auto-plan-test-"));
  try {
    const project = join(root, "project");
    const outside = join(root, "outside.txt");
    mkdirSync(project);
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(project, "linked.txt"));
    writeFileSync(join(project, "config"), "secret");
    symlinkSync(join(project, "config"), join(project, ".env"));

    assert.equal(
      hasSensitiveOrExternalPath(
        { type: "tool_call", toolCallId: "1", toolName: "read", input: { path: "linked.txt" } },
        project,
      ),
      true,
    );
    assert.equal(
      hasSensitiveOrExternalPath(
        { type: "tool_call", toolCallId: "2", toolName: "read", input: { path: ".env" } },
        project,
      ),
      true,
    );
    assert.equal(
      hasSensitiveOrExternalPath(
        { type: "tool_call", toolCallId: "3", toolName: "read", input: { path: "@../outside.txt" } },
        project,
      ),
      true,
    );
    for (const sensitive of [
      ".npmrc",
      ".netrc",
      ".git-credentials",
      ".kube/config",
      ".docker/config.json",
      "certs/server.pem",
      "signing.key",
    ]) {
      assert.equal(
        hasSensitiveOrExternalPath(
          { type: "tool_call", toolCallId: "4", toolName: "read", input: { path: sensitive } },
          project,
        ),
        true,
        sensitive,
      );
    }
    assert.equal(
      hasSensitiveOrExternalPath(
        { type: "tool_call", toolCallId: "5", toolName: "read", input: { path: "src/keyboard.ts" } },
        project,
      ),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Shift+Tab cycles Auto, Plan, and bypass-all modes", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  let activeTools = ["read", "bash", "edit", "write", "bg_status", "subagent_spawn"];
  const shortcuts = new Map<string, { handler: (ctx: any) => Promise<void> | void }>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> | void }>();
  const entries: any[] = [];
  let branchEntries: any[] = [];
  const statuses: string[] = [];
  const notifications: string[] = [];
  const desktopNotifications: string[][] = [];
  const approvalWidgets: unknown[] = [];
  let newSessions = 0;
  const BUILTIN_NAMES = new Set(["read", "bash", "edit", "write"]);

  const pi = {
    on(name: string, handler: (...args: any[]) => any) {
      handlers.set(name, handler);
    },
    registerShortcut(key: string, options: { handler: (ctx: any) => Promise<void> | void }) {
      shortcuts.set(key, { handler: options.handler });
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> | void }) {
      commands.set(name, { handler: options.handler });
    },
    getActiveTools: () => [...activeTools],
    getCommands: () => [
      { name: "subagents", source: "extension" },
      { name: "skill:mermaid-diagram", source: "skill" },
    ],
    setActiveTools(tools: string[]) {
      activeTools = [...tools];
    },
    appendEntry(customType: string, data: unknown) {
      const entry = { type: "custom", customType, data };
      entries.push(entry);
      branchEntries.push(entry);
    },
    exec: async (_command: string, args: string[]) => {
      desktopNotifications.push(args);
      return { code: 0, stdout: "", stderr: "", killed: false };
    },
    getAllTools: () => activeTools.map((name) => ({
      name,
      description: name,
      sourceInfo: BUILTIN_NAMES.has(name)
        ? { source: "builtin", path: `<builtin:${name}>` }
        : {
            source: "extension",
            path: name.startsWith("bg_")
              ? join(getAgentDir(), "extensions/background-terminals/index.ts")
              : join(getAgentDir(), "extensions/subagents/index.ts"),
          },
    })),
  } as any;

  let confirmResult = true;
  const confirmPrompts: string[] = [];
  let terminalInputListener: ((data: string) => unknown) | undefined;
  const ctx = {
    isIdle: () => true,
    hasUI: true,
    mode: "tui",
    cwd: "/project",
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => branchEntries,
      getSessionName: () => "test session",
    },
    newSession: async () => {
      newSessions++;
      return { cancelled: false };
    },
    ui: {
      theme: { fg: (_color: string, value: string) => value },
      setStatus: (_key: string, value: string) => statuses.push(value),
      notify: (message: string) => notifications.push(message),
      confirm: async (title: string) => {
        confirmPrompts.push(title);
        return confirmResult;
      },
      select: async () => "Deny",
      onTerminalInput: (listener: (data: string) => unknown) => {
        terminalInputListener = listener;
        return () => {
          terminalInputListener = undefined;
        };
      },
      setEditorComponent: () => {},
      setEditorText: () => {},
      setTitle: () => {},
      setWidget: (_key: string, value: unknown) => approvalWidgets.push(value),
    },
  } as any;

  autoPlanMode(pi);
  const shortcut = shortcuts.get("shift+tab");
  assert.ok(shortcut);
  assert.ok(shortcuts.has("ctrl+c"));
  assert.ok(shortcuts.has("super+c"));
  await commands.get("clear")?.handler("", ctx);
  assert.equal(newSessions, 1);

  const blockedUnknownCommand = await handlers.get("input")?.(
    {
      text: "/not-a-command now",
      streamingBehavior: "steer",
      source: "interactive",
    },
    ctx,
  );
  assert.deepEqual(blockedUnknownCommand, { action: "handled" });
  assert.equal(notifications.at(-1), "Unknown command: /not-a-command");
  assert.equal(
    await handlers.get("input")?.(
      {
        text: "/skill:mermaid-diagram draw a flowchart",
        streamingBehavior: "steer",
        source: "interactive",
      },
      ctx,
    ),
    undefined,
  );

  await handlers.get("session_start")?.({ type: "session_start" }, ctx);
  assert.equal(statuses.at(-1), "◆ auto");
  assert.deepEqual(activeTools, ["read", "bash", "edit", "write", "bg_status", "subagent_spawn"]);

  await shortcut?.handler(ctx);
  assert.equal(statuses.at(-1), "⏸ plan");
  assert.deepEqual(activeTools, ["read", "bash", "bg_status"]);
  assert.match(notifications.at(-1) ?? "", /Plan mode/);

  const planContext = await handlers.get("before_agent_start")?.(
    { systemPromptOptions: { contextFiles: [] } },
    ctx,
  );
  assert.match(planContext.message.content, /PLAN MODE ACTIVE/);

  const blocked = await handlers.get("tool_call")?.(
    { type: "tool_call", toolCallId: "1", toolName: "edit", input: { path: "a" } },
    ctx,
  );
  assert.equal(blocked.block, true);
  const externalRead = await handlers.get("tool_call")?.(
    { type: "tool_call", toolCallId: "1b", toolName: "read", input: { path: "../secret" } },
    ctx,
  );
  assert.equal(externalRead.block, true);

  // Allowed plan-mode git diffs run with repo-config drivers disabled.
  const planBash = {
    type: "tool_call",
    toolCallId: "1c",
    toolName: "bash",
    input: { command: "git diff HEAD" },
  };
  const allowedBash = await handlers.get("tool_call")?.(planBash, ctx);
  assert.equal(allowedBash, undefined);
  assert.equal(planBash.input.command, "git diff --no-ext-diff --no-textconv HEAD");

  await shortcut?.handler(ctx);
  assert.equal(statuses.at(-1), "⚠ bypass-all");
  assert.deepEqual(activeTools, ["read", "bash", "edit", "write", "bg_status", "subagent_spawn"]);
  assert.match(notifications.at(-1) ?? "", /Bypass-all mode/);
  assert.match(confirmPrompts.at(-1) ?? "", /bypass-all/);

  const bypassedEdit = await handlers.get("tool_call")?.(
    { type: "tool_call", toolCallId: "2", toolName: "edit", input: { path: "README.md" } },
    ctx,
  );
  assert.equal(bypassedEdit, undefined);

  await shortcut?.handler(ctx);
  assert.equal(statuses.at(-1), "◆ auto");

  const filteredContext = await handlers.get("context")?.(
    {
      messages: [
        { role: "custom", customType: "auto-plan-context", content: "stale" },
        { role: "user", content: "keep" },
      ],
    },
    ctx,
  );
  assert.deepEqual(filteredContext.messages, [{ role: "user", content: "keep" }]);

  const readResult = await handlers.get("tool_call")?.(
    { type: "tool_call", toolCallId: "3", toolName: "read", input: { path: "README.md" } },
    ctx,
  );
  assert.equal(readResult, undefined);

  // An unfocused terminal gets the desktop alert alongside the dialog.
  assert.ok(terminalInputListener);
  terminalInputListener?.("\x1b[O");
  const reviewedEdit = await handlers.get("tool_call")?.(
    { type: "tool_call", toolCallId: "4", toolName: "edit", input: { path: "README.md" } },
    ctx,
  );
  assert.equal(reviewedEdit.block, true);
  assert.match(reviewedEdit.reason, /denied by user/);
  assert.ok(notifications.some((message) => message.includes("Advisor approval required")));
  assert.equal(desktopNotifications.length, 1);
  assert.ok(desktopNotifications[0]?.some((value) => value.includes("Pi advisor")));
  assert.ok(approvalWidgets.some((value) => Array.isArray(value)));
  assert.equal(approvalWidgets.at(-1), undefined);

  // A focused terminal skips the desktop alert; the dialog is enough.
  terminalInputListener?.("\x1b[I");
  const focusedEdit = await handlers.get("tool_call")?.(
    { type: "tool_call", toolCallId: "4b", toolName: "edit", input: { path: "README.md" } },
    ctx,
  );
  assert.equal(focusedEdit.block, true);
  assert.equal(desktopNotifications.length, 1);

  // bypass-all is never restored from persisted history.
  const bypassEntry = entries.find((entry) => entry.data.mode === "bypass-all");
  branchEntries = [bypassEntry];
  await handlers.get("session_tree")?.({}, ctx);
  assert.equal(statuses.at(-1), "◆ auto");
  assert.deepEqual(activeTools, ["read", "bash", "edit", "write", "bg_status", "subagent_spawn"]);

  const planEntry = entries.find((entry) => entry.data.mode === "plan");
  branchEntries = [planEntry];
  await handlers.get("session_tree")?.({}, ctx);
  assert.deepEqual(activeTools, ["read", "bash", "bg_status"]);

  branchEntries = [[...entries].reverse().find((entry: any) => entry.data.mode === "auto")];
  await handlers.get("session_tree")?.({}, ctx);
  assert.deepEqual(activeTools, ["read", "bash", "edit", "write", "bg_status", "subagent_spawn"]);

  // Declining the bypass-all confirmation continues the cycle to auto.
  await shortcut?.handler(ctx);
  assert.equal(statuses.at(-1), "⏸ plan");
  confirmResult = false;
  await shortcut?.handler(ctx);
  assert.equal(statuses.at(-1), "◆ auto");
  assert.deepEqual(activeTools, ["read", "bash", "edit", "write", "bg_status", "subagent_spawn"]);

  await shortcut?.handler(ctx);
  assert.deepEqual(activeTools, ["read", "bash", "bg_status"]);
  await handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
  assert.deepEqual(activeTools, ["read", "bash", "edit", "write", "bg_status", "subagent_spawn"]);
});
