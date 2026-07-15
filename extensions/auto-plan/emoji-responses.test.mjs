import assert from "node:assert/strict";
import test from "node:test";
import emojiResponses, { EMOJI_RESPONSE_GUIDANCE } from "../emoji-responses.ts";

test("emoji response guidance is appended to the agent system prompt", async () => {
  let beforeAgentStart;
  emojiResponses({
    on(event, handler) {
      if (event === "before_agent_start") beforeAgentStart = handler;
    },
  });

  const result = await beforeAgentStart({ systemPrompt: "Base instructions" });
  assert.equal(result.systemPrompt, `Base instructions\n\n${EMOJI_RESPONSE_GUIDANCE}`);
});
