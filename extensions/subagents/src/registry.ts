/**
 * Production backend wiring: the public/runtime policy wires Pi and Codex
 * only (see policy.ts for model routing).
 */

import type { BackendRegistry, SubagentBackend } from "./backend.ts";
import { codexBackend } from "./backends/codex.ts";
import { piBackend } from "./backends/pi.ts";
import type { BackendName } from "./domain.ts";

export function createBackendRegistry(): BackendRegistry {
  const backends: SubagentBackend[] = [piBackend, codexBackend];
  return new Map<BackendName, SubagentBackend>(
    backends.map((backend) => [backend.name, backend]),
  );
}
