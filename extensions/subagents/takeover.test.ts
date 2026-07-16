import assert from "node:assert/strict";
import test from "node:test";
import {
  preserveViewportOffset,
  reconcileDashboardSelection,
  setDashboardSelectionIndex,
  type DashboardSelection,
} from "./src/ui/takeover.ts";

test("dashboard paging clamps at the first and last subagent", () => {
  const subagents = Array.from({ length: 20 }, (_, index) => ({
    id: `sa-${index + 1}`,
  }));
  const selection: DashboardSelection = { id: "sa-10", index: 9 };

  setDashboardSelectionIndex(selection, subagents, selection.index - 50);
  assert.deepEqual(selection, { id: "sa-1", index: 0 });
  setDashboardSelectionIndex(selection, subagents, selection.index + 50);
  assert.deepEqual(selection, { id: "sa-20", index: 19 });
});

test("streaming transcript stays anchored while the user reads older lines", () => {
  assert.equal(preserveViewportOffset(12, 100, 107), 19);
  assert.equal(preserveViewportOffset(0, 100, 107), 0);
  assert.equal(preserveViewportOffset(12, 100, 90), 12);
});

test("dashboard selection follows its subagent id and falls back by row", () => {
  const selection: DashboardSelection = { id: "sa-7", index: 6 };

  reconcileDashboardSelection(selection, [
    { id: "sa-new" },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `sa-${index + 1}` })),
  ]);
  assert.deepEqual(selection, { id: "sa-7", index: 7 });

  reconcileDashboardSelection(selection, [
    ...Array.from({ length: 6 }, (_, index) => ({ id: `sa-${index + 1}` })),
    { id: "sa-8" },
    { id: "sa-9" },
  ]);
  assert.deepEqual(selection, { id: "sa-9", index: 7 });

  reconcileDashboardSelection(selection, [{ id: "sa-1" }, { id: "sa-2" }]);
  assert.deepEqual(selection, { id: "sa-2", index: 1 });

  reconcileDashboardSelection(selection, []);
  assert.deepEqual(selection, { id: undefined, index: 0 });
});
