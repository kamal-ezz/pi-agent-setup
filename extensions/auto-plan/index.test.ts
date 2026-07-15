import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import autoPlanMode, {
  hasSensitiveOrExternalPath,
  prepareReviewAction,
  trustedReadOnlyToolNames,
} from "./index.ts";

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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Auto is default and Shift+Tab toggles read-only Plan mode", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  let activeTools = ["read", "bash", "edit", "write", "bg_status", "subagent_spawn"];
  let shortcut: { key: string; handler: (ctx: any) => Promise<void> } | undefined;
  const entries: any[] = [];
  let branchEntries: any[] = [];
  const statuses: string[] = [];
  const notifications: string[] = [];
  const BUILTIN_NAMES = new Set(["read", "bash", "edit", "write"]);

  const pi = {
    on(name: string, handler: (...args: any[]) => any) {
      handlers.set(name, handler);
    },
    registerShortcut(key: string, options: { handler: (ctx: any) => Promise<void> }) {
      shortcut = { key, handler: options.handler };
    },
    getActiveTools: () => [...activeTools],
    setActiveTools(tools: string[]) {
      activeTools = [...tools];
    },
    appendEntry(customType: string, data: unknown) {
      const entry = { type: "custom", customType, data };
      entries.push(entry);
      branchEntries.push(entry);
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

  const ctx = {
    isIdle: () => true,
    hasUI: true,
    cwd: "/project",
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => branchEntries,
    },
    ui: {
      theme: { fg: (_color: string, value: string) => value },
      setStatus: (_key: string, value: string) => statuses.push(value),
      notify: (message: string) => notifications.push(message),
      select: async () => "Deny",
      setEditorComponent: () => {},
    },
  } as any;

  autoPlanMode(pi);
  assert.equal(shortcut?.key, "shift+tab");

  await handlers.get("session_start")?.({ type: "session_start" }, ctx);
  assert.equal(statuses.at(-1), "◆ auto");
  assert.deepEqual(activeTools, ["read", "bash", "edit", "write", "bg_status", "subagent_spawn"]);

  await shortcut?.handler(ctx);
  assert.equal(statuses.at(-1), "⏸ plan");
  assert.deepEqual(activeTools, ["read", "bash", "bg_status"]);
  assert.match(notifications.at(-1) ?? "", /Plan mode/);

  const planContext = await handlers.get("before_agent_start")?.({}, ctx);
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

  await shortcut?.handler(ctx);
  assert.equal(statuses.at(-1), "◆ auto");
  assert.deepEqual(activeTools, ["read", "bash", "edit", "write", "bg_status", "subagent_spawn"]);

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
    { type: "tool_call", toolCallId: "2", toolName: "read", input: { path: "README.md" } },
    ctx,
  );
  assert.equal(readResult, undefined);

  const reviewedEdit = await handlers.get("tool_call")?.(
    { type: "tool_call", toolCallId: "3", toolName: "edit", input: { path: "README.md" } },
    ctx,
  );
  assert.equal(reviewedEdit.block, true);
  assert.match(reviewedEdit.reason, /denied by user/);

  const planEntry = entries.find((entry) => entry.data.mode === "plan");
  branchEntries = [planEntry];
  await handlers.get("session_tree")?.({}, ctx);
  assert.deepEqual(activeTools, ["read", "bash", "bg_status"]);

  branchEntries = [[...entries].reverse().find((entry: any) => entry.data.mode === "auto")];
  await handlers.get("session_tree")?.({}, ctx);
  assert.deepEqual(activeTools, ["read", "bash", "edit", "write", "bg_status", "subagent_spawn"]);

  await shortcut?.handler(ctx);
  assert.deepEqual(activeTools, ["read", "bash", "bg_status"]);
  await handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
  assert.deepEqual(activeTools, ["read", "bash", "edit", "write", "bg_status", "subagent_spawn"]);
});
