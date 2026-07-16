import assert from "node:assert/strict";
import test from "node:test";
import {
  assertHarnessProjectTrust,
  childExtensionMayLoad,
  modelHintForHarness,
  normalizeSubagentModel,
  routeSubagentModel,
} from "./src/policy.ts";

test("routes lightweight work to Luna", () => {
  assert.equal(routeSubagentModel("Quickly list the files that mention OAuth."), "gpt-5.6-luna");
  assert.equal(routeSubagentModel("Summarize these ten reports."), "gpt-5.6-luna");
});

test("routes standard work to Terra", () => {
  assert.equal(routeSubagentModel("Implement the API endpoint and add tests."), "gpt-5.6-terra");
  assert.equal(routeSubagentModel("Review this component for ordinary correctness issues."), "gpt-5.6-terra");
});

test("routes complex or high-stakes work to Sol even when described as quick", () => {
  assert.equal(routeSubagentModel("Quick security audit of authentication and authorization."), "gpt-5.6-sol");
  assert.equal(routeSubagentModel("Find the root cause of a flaky concurrency deadlock."), "gpt-5.6-sol");
});

test("accepts only Luna, Terra, and Sol", () => {
  assert.equal(normalizeSubagentModel("gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(normalizeSubagentModel("openai-codex/gpt-5.6-terra"), "gpt-5.6-terra");
  assert.throws(() => normalizeSubagentModel("claude-opus-4-6"), /Unsupported subagent model/);
  assert.throws(() => normalizeSubagentModel("gpt-5.5"), /Unsupported subagent model/);
});

test("normalizes model hints per GPT harness", () => {
  assert.equal(modelHintForHarness("pi", "gpt-5.6-luna"), "openai-codex/gpt-5.6-luna");
  assert.equal(modelHintForHarness("codex", "gpt-5.6-terra"), "gpt-5.6-terra");
  assert.throws(() => modelHintForHarness("claude", "gpt-5.6-sol"), /disabled/);
});

test("Codex cannot run unsandboxed in an untrusted working directory", () => {
  assert.doesNotThrow(() => assertHarnessProjectTrust("pi", false));
  assert.doesNotThrow(() => assertHarnessProjectTrust("codex", true));
  assert.throws(
    () => assertHarnessProjectTrust("codex", false),
    /require a trusted working_dir/,
  );
});

test("headless Pi children exclude desktop notification extensions", () => {
  assert.equal(childExtensionMayLoad("/home/user/.pi/agent/extensions/turn-notifications.ts"), false);
  assert.equal(childExtensionMayLoad("/home/user/.pi/agent/extensions/subagents/index.ts"), true);
});
