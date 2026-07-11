import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_CODEX_STOP_INPUT_BYTES,
  normalizeCodexStop,
  parseCodexStopText,
} from "../src/core/normalize.js";
import { applyPrivacy, GENERIC_NOTIFICATION_BODY } from "../src/core/privacy.js";
import { HeraldError } from "../src/domain/errors.js";
import type { CodexStopInput, LifecycleEvent } from "../src/domain/types.js";

const validStopInput: CodexStopInput = {
  session_id: "session-123",
  transcript_path: "/path/that/must/not/be/read.jsonl",
  cwd: "/tmp/project",
  hook_event_name: "Stop",
  model: "gpt-5",
  permission_mode: "default",
  turn_id: "turn-456",
  stop_hook_active: false,
  last_assistant_message: "Implemented the requested change.",
};

function expectHeraldError(action: () => unknown, code: HeraldError["code"]): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof HeraldError);
    assert.equal(error.code, code);
    return true;
  });
}

describe("Codex Stop normalization", () => {
  it("accepts the Stop allowlist and strips unknown fields", () => {
    const parsed = parseCodexStopText(
      JSON.stringify({
        ...validStopInput,
        prompt: "must not enter the typed core",
        future_codex_field: { nested: true },
      }),
    );

    assert.deepEqual(parsed, validStopInput);
    assert.equal("prompt" in parsed, false);
    assert.equal("future_codex_field" in parsed, false);
  });

  it("rejects hook events other than Stop", () => {
    expectHeraldError(
      () =>
        parseCodexStopText(
          JSON.stringify({ ...validStopInput, hook_event_name: "SubagentStop" }),
        ),
      "HOOK_INPUT_INVALID",
    );
  });

  it("rejects malformed JSON without echoing input", () => {
    const secret = "sk-this-must-not-appear-in-an-error";

    assert.throws(
      () => parseCodexStopText(`{"hook_event_name":"Stop","secret":"${secret}"`),
      (error: unknown) => {
        assert.ok(error instanceof HeraldError);
        assert.equal(error.code, "HOOK_INPUT_INVALID");
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      },
    );
  });

  it("rejects input over 1 MiB before JSON parsing", () => {
    expectHeraldError(
      () => parseCodexStopText("x".repeat(MAX_CODEX_STOP_INPUT_BYTES + 1)),
      "HOOK_INPUT_TOO_LARGE",
    );
  });

  it("measures the cap in UTF-8 bytes rather than UTF-16 code units", () => {
    const oversizedUnicode = "😀".repeat(MAX_CODEX_STOP_INPUT_BYTES / 4 + 1);

    expectHeraldError(
      () => parseCodexStopText(oversizedUnicode),
      "HOOK_INPUT_TOO_LARGE",
    );
  });

  it("derives a stable id from session, turn, hook, and message hash", () => {
    const first = normalizeCodexStop(
      validStopInput,
      new Date("2026-07-11T00:00:00.000Z"),
    );
    const repeated = normalizeCodexStop(
      { ...validStopInput, transcript_path: "/different/unread/path" },
      new Date("2026-07-11T00:01:00.000Z"),
    );
    const changedMessage = normalizeCodexStop(
      { ...validStopInput, last_assistant_message: "A different result." },
      new Date("2026-07-11T00:00:00.000Z"),
    );

    assert.equal(first.id, repeated.id);
    assert.notEqual(first.id, changedMessage.id);
    assert.match(first.id, /^evt_[a-f0-9]{64}$/);
    assert.deepEqual(first, {
      id: first.id,
      type: "turn.finished",
      source: "codex",
      sourceEvent: "Stop",
      occurredAt: "2026-07-11T00:00:00.000Z",
      summary: validStopInput.last_assistant_message,
    });
  });
});

describe("privacy policy", () => {
  const event: LifecycleEvent = {
    id: "evt_test",
    type: "turn.finished",
    source: "codex",
    sourceEvent: "Stop",
    occurredAt: "2026-07-11T00:00:00.000Z",
    summary: "Sensitive summary",
  };

  it("uses fixed status text when summaries are disabled", () => {
    const notification = applyPrivacy(event, {
      includePrompt: false,
      includeSummary: false,
      maxChars: 1,
    });

    assert.deepEqual(notification, {
      title: "Codex turn finished",
      body: GENERIC_NOTIFICATION_BODY,
      severity: "info",
      truncated: false,
    });
  });

  it("removes control characters and redacts common secret shapes", () => {
    const notification = applyPrivacy(
      {
        ...event,
        summary:
          "Done\u0000\nOPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz " +
          "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature " +
          "github_token=ghp_abcdefghijklmnopqrstuvwxyz123456",
      },
      { includePrompt: false, includeSummary: true, maxChars: 500 },
    );

    assert.equal(/[\p{Cc}\p{Cf}]/u.test(notification.body), false);
    assert.doesNotMatch(notification.body, /sk-abcdefghijklmnopqrstuvwxyz/u);
    assert.doesNotMatch(notification.body, /eyJhbGciOiJIUzI1NiJ9/u);
    assert.doesNotMatch(notification.body, /ghp_abcdefghijklmnopqrstuvwxyz123456/u);
    assert.match(notification.body, /\[REDACTED\]/u);
    assert.equal(notification.truncated, false);
  });

  it("truncates by Unicode code points without splitting an emoji", () => {
    const notification = applyPrivacy(
      { ...event, summary: "A😀B" },
      { includePrompt: false, includeSummary: true, maxChars: 2 },
    );

    assert.equal(notification.body, "A😀");
    assert.equal(notification.truncated, true);
  });

  it("uses fixed status text when the cleaned summary is empty", () => {
    const notification = applyPrivacy(
      { ...event, summary: "\u0000\u0007\n\t" },
      { includePrompt: false, includeSummary: true, maxChars: 500 },
    );

    assert.equal(notification.body, GENERIC_NOTIFICATION_BODY);
    assert.equal(notification.truncated, false);
  });
});
