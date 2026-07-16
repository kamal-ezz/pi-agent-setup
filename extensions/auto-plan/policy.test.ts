import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedJson,
  hardenReadOnlyCommand,
  isPlanToolAllowed,
  isReadOnlyCommand,
  parseAdvisorDecision,
  planToolNames,
} from "./policy.ts";

test("plan mode accepts conservative read-only commands", () => {
  assert.equal(isReadOnlyCommand("git status --short"), true);
  assert.equal(isReadOnlyCommand("git log --oneline -20"), true);
  assert.equal(isReadOnlyCommand("npm list --depth=0"), true);
});

test("plan mode rejects mutation and shell escape paths", () => {
  assert.equal(isReadOnlyCommand("rm -rf build"), false);
  assert.equal(isReadOnlyCommand("ls && rm -rf build"), false);
  assert.equal(isReadOnlyCommand("find . -delete"), false);
  assert.equal(isReadOnlyCommand("rg --pre 'sh exploit.sh' token ."), false);
  assert.equal(isReadOnlyCommand("git branch new-branch"), false);
  assert.equal(isReadOnlyCommand("tree -o /tmp/tree.txt ."), false);
  assert.equal(isReadOnlyCommand("file --compile -m test.magic"), false);
  assert.equal(isReadOnlyCommand("cat /etc/passwd"), false);
  assert.equal(isReadOnlyCommand("git diff --no-index /etc/passwd /dev/null"), false);
  assert.equal(isReadOnlyCommand("date --set='2030-01-01'"), false);
  assert.equal(isReadOnlyCommand("git diff --output=patch.txt"), false);
  assert.equal(isReadOnlyCommand("npm audit --fix"), false);
  assert.equal(isReadOnlyCommand("cat file > copy"), false);
});

test("plan mode restricts jq to a stdin-only pipeline filter", () => {
  assert.equal(isReadOnlyCommand("git log | jq .message"), true);
  assert.equal(isReadOnlyCommand("git status --short | jq -r '.foo'"), true);
  // Standalone jq reads arbitrary files, including secrets.
  assert.equal(isReadOnlyCommand("jq . package.json"), false);
  assert.equal(isReadOnlyCommand("jq . ~/.aws/credentials"), false);
  assert.equal(isReadOnlyCommand("git log | jq '.a' /etc/passwd"), false);
  assert.equal(isReadOnlyCommand("git log | jq --slurpfile s /tmp/x '.a'"), false);
  assert.equal(isReadOnlyCommand("git log | jq -f filter.jq"), false);
  // jq filters can read the process environment.
  assert.equal(isReadOnlyCommand("git log | jq -n 'env'"), false);
  assert.equal(isReadOnlyCommand("git log | jq '$ENV.SECRET'"), false);
  // Field access named env is fine.
  assert.equal(isReadOnlyCommand("git log | jq '.env.name'"), true);
});

test("diff-family git commands get external drivers disabled", () => {
  assert.equal(
    hardenReadOnlyCommand("git diff"),
    "git diff --no-ext-diff --no-textconv",
  );
  assert.equal(
    hardenReadOnlyCommand("git log --oneline -5"),
    "git log --no-ext-diff --no-textconv --oneline -5",
  );
  assert.equal(
    hardenReadOnlyCommand("git show HEAD~1 | jq -r '.a'"),
    "git show --no-ext-diff --no-textconv HEAD~1 | jq -r '.a'",
  );
  // Non-diff subcommands take no diff options and are left untouched.
  assert.equal(hardenReadOnlyCommand("git status --short"), "git status --short");
  assert.equal(hardenReadOnlyCommand("git ls-files"), "git ls-files");
});

test("plan mode permits only read-only tools", () => {
  assert.equal(isPlanToolAllowed("read", { path: "README.md" }), true);
  assert.equal(isPlanToolAllowed("bash", { command: "git diff" }), true);
  assert.equal(isPlanToolAllowed("bash", { command: "git push" }), false);
  assert.equal(isPlanToolAllowed("edit", { path: "README.md" }), false);
  assert.equal(isPlanToolAllowed("subagent_spawn", {}), false);
});

test("plan tool filtering preserves only enabled read-only tools", () => {
  assert.deepEqual(
    planToolNames(["read", "bash", "edit", "bg_status", "subagent_spawn"]),
    ["read", "bash", "bg_status"],
  );
});

test("advisor decisions parse strict allow/ask JSON", () => {
  assert.deepEqual(
    parseAdvisorDecision('{"decision":"allow","reason":"Routine edit"}'),
    { decision: "allow", reason: "Routine edit" },
  );
  assert.deepEqual(
    parseAdvisorDecision('```json\n{"decision":"ask","reason":"Pushes remotely"}\n```'),
    { decision: "ask", reason: "Pushes remotely" },
  );
  assert.equal(parseAdvisorDecision('{"decision":"deny","reason":"no"}'), undefined);
  assert.equal(parseAdvisorDecision("not json"), undefined);
});

test("boundedJson caps advisor input", () => {
  const value = boundedJson({ content: "x".repeat(100) }, 40);
  assert.match(value, /omitted/);
  assert.ok(value.length < 70);
});
