import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const EMOJI_RESPONSE_GUIDANCE = `Emoji support is enabled in this terminal. You may use Unicode emoji naturally and sparingly in user-facing responses when they improve clarity or scanability (for example, concise status headings). Do not use emoji in code, commands, file paths, identifiers, or structured data unless the user explicitly requests them.`;

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${EMOJI_RESPONSE_GUIDANCE}`,
  }));
}
