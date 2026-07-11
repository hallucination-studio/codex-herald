import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { z } from "zod";
import { HeraldError } from "../domain/errors.js";
import {
  type CodexStopInput,
  EVENT_TYPE,
  type LifecycleEvent,
} from "../domain/types.js";

export const MAX_CODEX_STOP_INPUT_BYTES = 1024 * 1024;

export const CodexStopInputSchema = z.object({
  session_id: z.string().min(1),
  transcript_path: z.string().nullable(),
  cwd: z.string(),
  hook_event_name: z.literal("Stop"),
  model: z.string().min(1),
  permission_mode: z.enum([
    "default",
    "acceptEdits",
    "plan",
    "dontAsk",
    "bypassPermissions",
  ]),
  turn_id: z.string().min(1),
  stop_hook_active: z.boolean(),
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
    occurredAt: occurredAt.toISOString(),
    summary: input.last_assistant_message,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
