import assert from "node:assert/strict";
import test from "node:test";
import type { BackendRegistry } from "./src/backend.ts";
import { codexBackend } from "./src/backends/codex.ts";
import type { ParentContext, SpawnTask } from "./src/domain.ts";
import { createSubagentManager } from "./src/manager.ts";

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return {
    prompt,
    title: "live Codex test",
    cwd: process.cwd(),
    parent,
  };
}

const registry: BackendRegistry = new Map([["codex", codexBackend]]);

function deadline<A>(operation: Promise<A>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Live Codex test exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function codexAvailable() {
  return codexBackend.available();
}

test(
  "Codex backend completes a live manager run",
  { timeout: 75_000 },
  async (t) => {
    if (!(await codexAvailable())) {
      t.skip("codex executable is unavailable");
      return;
    }

    const manager = createSubagentManager(registry);
    try {
      const spawned = await manager.spawn(
        "codex",
        task("Reply with exactly: hello codex"),
      );

      await deadline(manager.waitFor([spawned.id]), 60_000);
      const done = manager.view.get(spawned.id);
      assert.equal(done?.status, "done");
      assert.match(done?.finalText ?? "", /hello codex/i);
      assert.equal(done?.meta.backend, "codex");
      assert.ok(done?.meta.nativeSessionId);
      assert.ok(done?.meta.sessionFilePath);
    } finally {
      await manager.disposeAll();
    }
  },
);

test(
  "Codex backend interrupt settles a live manager run",
  { timeout: 30_000 },
  async (t) => {
    if (!(await codexAvailable())) {
      t.skip("codex executable is unavailable");
      return;
    }

    const manager = createSubagentManager(registry);
    try {
      const spawned = await manager.spawn(
        "codex",
        task("Run `sleep 30`, then reply with the word finished."),
      );

      await new Promise((resolve) => setTimeout(resolve, 250));
      const result = await deadline(manager.cancel([spawned.id]), 10_000);
      assert.equal(result[0]?.cancelled, true);
      assert.equal(manager.view.get(spawned.id)?.status, "error");
      assert.equal(manager.view.get(spawned.id)?.errorText, "Run was aborted");
    } finally {
      await manager.disposeAll();
    }
  },
);
