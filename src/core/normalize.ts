import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import { HeraldError } from "../domain/errors.js";
import {
  type CodexStopInput,
  EVENT_TYPE,
  type LifecycleEvent,
} from "../domain/types.js";

export const MAX_CODEX_STOP_INPUT_BYTES = 1024 * 1024;

const MAX_PROJECT_CHARS = 80;
const UNKNOWN_PROJECT = "Unknown";

export const CodexStopInputSchema = z.object({
  session_id: z.string().min(1),
  hook_event_name: z.literal("Stop"),
  turn_id: z.string().min(1),
  cwd: z.string().optional(),
  last_assistant_message: z.string().nullable(),
});

export function parseCodexStopText(text: string): CodexStopInput {
  if (Buffer.byteLength(text, "utf8") > MAX_CODEX_STOP_INPUT_BYTES) {
    throw new HeraldError(
      "HOOK_INPUT_TOO_LARGE",
      "Codex Stop hook input exceeds the 1 MiB limit",
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new HeraldError(
      "HOOK_INPUT_INVALID",
      "Codex Stop hook input is not valid JSON",
    );
  }

  const result = CodexStopInputSchema.safeParse(value);
  if (!result.success) {
    throw new HeraldError("HOOK_INPUT_INVALID", "Codex Stop hook input is invalid");
  }

  return result.data;
}

export function normalizeCodexStop(
  input: CodexStopInput,
  occurredAt: Date,
): LifecycleEvent {
  const messageHash = sha256(input.last_assistant_message ?? "");
  const identity = JSON.stringify([
    input.session_id,
    input.turn_id,
    input.hook_event_name,
    messageHash,
  ]);

  return {
    id: `evt_${sha256(identity)}`,
    type: EVENT_TYPE,
    source: "codex",
    sourceEvent: "Stop",
    project: projectFromCwd(input.cwd),
    occurredAt: occurredAt.toISOString(),
    summary: input.last_assistant_message,
  };
}

function projectFromCwd(cwd: string | undefined): string {
  if (!cwd) {
    return UNKNOWN_PROJECT;
  }

  const project = basename(cwd)
    .replace(/\p{Cf}+/gu, "")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!project) {
    return UNKNOWN_PROJECT;
  }

  return Array.from(project).slice(0, MAX_PROJECT_CHARS).join("");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
