import type { LifecycleEvent, Notification, PrivacyPolicy } from "../domain/types.js";

export const GENERIC_NOTIFICATION_BODY = "A Codex turn finished.";

const NOTIFICATION_TITLE = "Codex turn finished";
const REDACTED = "[REDACTED]";

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
    REDACTED,
  ],
  [
    /\bAuthorization\s*[:=]\s*Bearer\s+[A-Za-z0-9._~+/=-]{8,}/giu,
    `Authorization: Bearer ${REDACTED}`,
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, `Bearer ${REDACTED}`],
  [
    /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/gu,
    REDACTED,
  ],
  [
    /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)\s*[:=]\s*[^\s,;]{8,}/giu,
    REDACTED,
  ],
];

export function applyPrivacy(
  event: LifecycleEvent,
  policy: PrivacyPolicy,
): Notification {
  if (!policy.includeSummary || event.summary === null) {
    return genericNotification();
  }

  const summary = sanitizeSummary(event.summary);
  if (summary.length === 0) {
    return genericNotification();
  }

  const codePoints = Array.from(summary);
  const truncated = codePoints.length > policy.maxChars;

  return {
    title: NOTIFICATION_TITLE,
    body: truncated ? codePoints.slice(0, policy.maxChars).join("") : summary,
    severity: "info",
    truncated,
  };
}

function genericNotification(): Notification {
  return {
    title: NOTIFICATION_TITLE,
    body: GENERIC_NOTIFICATION_BODY,
    severity: "info",
    truncated: false,
  };
}

function sanitizeSummary(value: string): string {
  let sanitized = value
    .replace(/\p{Cf}+/gu, "")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  for (const [pattern, replacement] of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }

  return sanitized.replace(/\s+/gu, " ").trim();
}
