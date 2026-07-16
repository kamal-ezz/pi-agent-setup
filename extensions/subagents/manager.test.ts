/**
 * End-to-end smoke tests: manager behavior exactly as the tool handlers
 * drive it. The registry is test-only: scripted stub sessions registered
 * under the claude/codex names (the production backends launch real
 * processes and have their own live test files), plus the real pi backend
 * for its cheap registry precondition.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { BackendRegistry, SubagentBackend } from "./src/backend.ts";
import { piBackend } from "./src/backends/pi.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import type { BackendName, ParentContext, SpawnTask } from "./src/domain.ts";
import {
  createSubagentManager,
  type SubagentManagerShape,
} from "./src/manager.ts";

function createTestRegistry(): BackendRegistry {
  const backends: SubagentBackend[] = [
    piBackend,
    makeStubBackend({
      backend: "claude",
      defaultModelLabel: "claude/sonnet",
      contextWindow: 200_000,
      toolName: "Bash",
      cadenceMs: 40,
    }),
    makeStubBackend({
      backend: "codex",
      defaultModelLabel: "codex/gpt-5-codex",
      contextWindow: 272_000,
      toolName: "shell",
      cadenceMs: 30,
    }),
  ];
  return new Map<BackendName, SubagentBackend>(
    backends.map((backend) => [backend.name, backend]),
  );
}

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return { prompt, title: "test", cwd: process.cwd(), parent };
}

async function withManager(
  run: (manager: SubagentManagerShape) => Promise<void>,
) {
  const manager = createSubagentManager(createTestRegistry());
  try {
    await run(manager);
  } finally {
    await manager.disposeAll();
  }
}

async function pollUntil(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

test("aborting spawn closes the late-created session and leaves no tracked entry", async () => {
  let sessionClosed = 0;
  const stub = makeStubBackend({
    backend: "claude",
    defaultModelLabel: "claude/sonnet",
    contextWindow: 200_000,
    toolName: "Bash",
    cadenceMs: 20,
  });
  const slowBackend: SubagentBackend = {
    ...stub,
    spawn: async (spawnTask) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const session = await stub.spawn(spawnTask);
      const close = session.close;
      return {
        ...session,
        close: () => {
          sessionClosed += 1;
          return close();
        },
      };
    },
  };
  const registry = new Map<BackendName, SubagentBackend>([
    ["claude", slowBackend],
  ]);
  const manager = createSubagentManager(registry);
  try {
    const controller = new AbortController();
    const spawning = manager.spawn("claude", task("slow"), {
      signal: controller.signal,
      interruptMessage: "spawn aborted",
    });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(spawning, /spawn aborted/);
    // The slow spawn resolves later; its session must then be closed.
    assert.ok(await pollUntil(() => sessionClosed === 1));
    assert.deepEqual(manager.view.list(), []);
  } finally {
    await manager.disposeAll();
  }
});

test("stub subagent completes and delivers a final result", async () => {
  await withManager(async (manager) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await manager.spawn(
      "claude",
      task("Say hello to the tests"),
    );
    assert.equal(snap.status, "running");
    assert.equal(snap.backend, "claude");
    assert.ok(snap.meta.sessionFilePath);

    await manager.waitFor([snap.id]);
    const done = manager.view.get(snap.id);
    assert.ok(done);
    assert.equal(done.status, "done");
    assert.match(
      done.finalText,
      /\[stub:claude\] completed: Say hello to the tests/,
    );
    assert.ok(done.turns >= 2);
    assert.ok(done.transcript.some((item) => item.kind === "toolResult"));
    // The waitFor marked the settle as consumed.
    assert.deepEqual(settled, [{ id: snap.id, consumed: true }]);
  });
});

test("FAIL: prompts settle as errors; unconsumed settles are delivered", async () => {
  await withManager(async (manager) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await manager.spawn("codex", task("FAIL: blow up please"));
    // Poll without wait-interest so the settle is delivered unconsumed.
    while (manager.view.get(snap.id)?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const failed = manager.view.get(snap.id);
    assert.equal(failed?.status, "error");
    assert.match(failed?.errorText ?? "", /task failed/);
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);
  });
});

test("cancel interrupts a running stub subagent", async () => {
  await withManager(async (manager) => {
    const snap = await manager.spawn("claude", task("Long running task"));
    const report = await manager.cancel([snap.id]);
    assert.deepEqual(report, [
      { id: snap.id, title: "test", status: "error", cancelled: true },
    ]);
    assert.equal(manager.view.get(snap.id)?.errorText, "Run was aborted");
  });
});

test("the concurrency cap rejects a fifth running subagent", async () => {
  await withManager(async (manager) => {
    const spawns = await Promise.all(
      [1, 2, 3, 4].map((n) => manager.spawn("codex", task(`Task ${n}`))),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      manager.spawn("codex", task("Task 5")),
      /Max 4 subagents/,
    );
  });
});

test("pi spawn fails fast without the parent model registry", async () => {
  await withManager(async (manager) => {
    await assert.rejects(
      manager.spawn("pi", task("needs a registry")),
      /model registry/,
    );
    // The failed spawn must release its concurrency reservation.
    const snap = await manager.spawn("codex", task("ok"));
    assert.equal(snap.backend, "codex");
  });
});

test("idle restarts respect the concurrency cap", async () => {
  await withManager(async (manager) => {
    // Settle one subagent, then fill all four slots with running ones.
    const settled = await manager.spawn("claude", task("early finisher"));
    await manager.waitFor([settled.id]);
    await Promise.all(
      [1, 2, 3, 4].map((n) => manager.spawn("codex", task(`Task ${n}`))),
    );
    // Restarting the settled one would be a fifth concurrent run.
    await assert.rejects(
      manager.send(settled.id, "go again"),
      /Max 4 subagents/,
    );
    assert.equal(manager.view.get(settled.id)?.status, "done");
  });
});

test("send steers an idle subagent into another turn", async () => {
  await withManager(async (manager) => {
    const snap = await manager.spawn("claude", task("First turn"));
    await manager.waitFor([snap.id]);
    const afterFirst = manager.view.get(snap.id);
    assert.equal(afterFirst?.status, "done");

    await manager.send(snap.id, "Second turn");
    // The fresh run flips the status back to running...
    while (manager.view.get(snap.id)?.status !== "running") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await manager.waitFor([snap.id]);
    const afterSecond = manager.view.get(snap.id);
    assert.equal(afterSecond?.status, "done");
    assert.match(afterSecond?.finalText ?? "", /Second turn/);
  });
});
