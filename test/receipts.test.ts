import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { HeraldError } from "../src/domain/errors.js";
import type { DeliveryReceipt } from "../src/domain/types.js";
import {
  appendReceipt,
  attemptKey,
  createReceiptRepository,
  RECEIPT_MAX_BYTES,
  readAttemptedKeys,
  resolveReceiptPath,
} from "../src/observability/receipts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("receipt path resolution", () => {
  it("uses the documented environment precedence", () => {
    assert.equal(
      resolveReceiptPath(
        {
          CODEX_HERALD_RECEIPTS: "/override/receipts.ndjson",
          PLUGIN_DATA: "/plugin-data",
          XDG_STATE_HOME: "/xdg-state",
        },
        "/home/herald",
      ),
      "/override/receipts.ndjson",
    );
    assert.equal(
      resolveReceiptPath(
        { PLUGIN_DATA: "/plugin-data", XDG_STATE_HOME: "/xdg-state" },
        "/home/herald",
      ),
      "/plugin-data/receipts.ndjson",
    );
    assert.equal(
      resolveReceiptPath({ XDG_STATE_HOME: "/xdg-state" }, "/home/herald"),
      "/xdg-state/codex-herald/receipts.ndjson",
    );
    assert.equal(
      resolveReceiptPath({}, "/home/herald"),
      "/home/herald/.local/state/codex-herald/receipts.ndjson",
    );
  });

  it("rejects relative overrides and never resolves them through cwd", () => {
    for (const environment of [
      { CODEX_HERALD_RECEIPTS: "receipts.ndjson" },
      { PLUGIN_DATA: "plugin-data" },
    ]) {
      assert.throws(
        () => resolveReceiptPath(environment, "/home/herald"),
        (error: unknown) => {
          assert.ok(error instanceof HeraldError);
          assert.equal(error.code, "CONFIG_INVALID");
          return true;
        },
      );
    }

    assert.equal(
      resolveReceiptPath({ XDG_STATE_HOME: "relative" }, "/home/herald"),
      "/home/herald/.local/state/codex-herald/receipts.ndjson",
    );
  });
});

describe("receipt persistence", () => {
  it("creates private storage and persists only DeliveryReceipt fields", async () => {
    const directory = await makeTemporaryDirectory();
    const receiptPath = join(directory, "private", "receipts.ndjson");
    const receipt = {
      ...acceptedReceipt("event-1", "phone"),
      body: "DO_NOT_PERSIST_BODY",
      recipient: "+8613800000000",
      url: "https://example.test/secret-token",
      secret: "DO_NOT_PERSIST_SECRET",
    };

    await appendReceipt(receipt, receiptPath);

    const directoryMode = (await stat(join(directory, "private"))).mode & 0o777;
    const fileMode = (await stat(receiptPath)).mode & 0o777;
    const contents = await readFile(receiptPath, "utf8");
    const persisted = JSON.parse(contents.trim()) as Record<string, unknown>;

    assert.equal(directoryMode, 0o700);
    assert.equal(fileMode, 0o600);
    assert.deepEqual(Object.keys(persisted).sort(), [
      "code",
      "destination",
      "driver",
      "durationMs",
      "eventId",
      "eventType",
      "recordedAt",
      "schemaVersion",
      "status",
      "transport",
    ]);
    assert.doesNotMatch(contents, /DO_NOT_PERSIST|13800000000|secret-token/);
  });

  it("rejects an existing public directory instead of changing its permissions", async () => {
    const directory = await makeTemporaryDirectory();
    const publicDirectory = join(directory, "shared");
    const receiptPath = join(publicDirectory, "receipts.ndjson");
    await mkdir(publicDirectory, { mode: 0o755 });
    await chmod(publicDirectory, 0o755);

    await assert.rejects(
      appendReceipt(acceptedReceipt("event-1", "phone"), receiptPath),
      /receipt directory must be private/i,
    );

    assert.equal((await stat(publicDirectory)).mode & 0o777, 0o755);
  });

  it("rejects a receipt directory symlink", async () => {
    const directory = await makeTemporaryDirectory();
    const actualDirectory = join(directory, "actual");
    const linkedDirectory = join(directory, "linked");
    await mkdir(actualDirectory, { mode: 0o700 });
    await symlink(actualDirectory, linkedDirectory);

    await assert.rejects(
      appendReceipt(
        acceptedReceipt("event-1", "phone"),
        join(linkedDirectory, "receipts.ndjson"),
      ),
      /regular directory/i,
    );
  });

  it("appends one complete NDJSON record per call", async () => {
    const directory = await makeTemporaryDirectory();
    const receiptPath = join(directory, "receipts.ndjson");

    await appendReceipt(acceptedReceipt("event-1", "phone"), receiptPath);
    await appendReceipt(acceptedReceipt("event-2", "ops"), receiptPath);

    const lines = (await readFile(receiptPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as DeliveryReceipt);
    assert.deepEqual(
      lines.map(({ eventId, destination }) => ({ eventId, destination })),
      [
        { eventId: "event-1", destination: "phone" },
        { eventId: "event-2", destination: "ops" },
      ],
    );
  });

  it("serializes concurrent appenders without losing records", async () => {
    const directory = await makeTemporaryDirectory();
    const receiptPath = join(directory, "receipts.ndjson");

    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        appendReceipt(
          acceptedReceipt(`event-${index}`, `destination-${index}`),
          receiptPath,
        ),
      ),
    );

    const records = (await readFile(receiptPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as DeliveryReceipt);
    assert.equal(records.length, 24);
    assert.equal(new Set(records.map(({ eventId }) => eventId)).size, 24);
  });

  it("rotates a full file to .1 before appending the next receipt", async () => {
    const directory = await makeTemporaryDirectory();
    const receiptPath = join(directory, "receipts.ndjson");
    await mkdir(directory, { recursive: true });
    await writeFile(receiptPath, Buffer.alloc(RECEIPT_MAX_BYTES, 0x78));
    await chmod(receiptPath, 0o644);

    await appendReceipt(acceptedReceipt("event-after-rotation", "ops"), receiptPath);

    const rotatedPath = `${receiptPath}.1`;
    assert.equal((await stat(rotatedPath)).size, RECEIPT_MAX_BYTES);
    assert.equal((await stat(rotatedPath)).mode & 0o777, 0o600);
    assert.ok((await stat(receiptPath)).size < RECEIPT_MAX_BYTES);
    assert.match(await readFile(receiptPath, "utf8"), /event-after-rotation/);
  });
});

describe("attempted receipt lookup", () => {
  it("rejects a non-regular receipt history path", async () => {
    const directory = await makeTemporaryDirectory();
    const targetPath = join(directory, "target.ndjson");
    const receiptPath = join(directory, "receipts.ndjson");
    await writeFile(targetPath, "");
    await symlink(targetPath, receiptPath);

    await assert.rejects(
      readAttemptedKeys(receiptPath),
      /receipt history path must be a regular file/i,
    );
  });

  it("reads attempted keys from the rotated and current files and skips damaged lines", async () => {
    const directory = await makeTemporaryDirectory();
    const receiptPath = join(directory, "receipts.ndjson");
    const rotatedPath = `${receiptPath}.1`;
    const failedReceipt: DeliveryReceipt = {
      ...acceptedReceipt("event-failed", "phone"),
      status: "failed",
      code: "driver_failed",
    };

    await writeFile(
      rotatedPath,
      `${JSON.stringify(acceptedReceipt("event-old", "phone"))}\n{damaged\n`,
    );
    await writeFile(
      receiptPath,
      [
        JSON.stringify(failedReceipt),
        JSON.stringify(acceptedReceipt("event-new", "ops")),
        JSON.stringify({
          ...acceptedReceipt("event-invalid", "ops"),
          schemaVersion: 99,
        }),
        "",
      ].join("\n"),
    );

    const keys = await readAttemptedKeys(receiptPath);

    assert.deepEqual(
      [...keys].sort(),
      [
        attemptKey("event-failed", "phone"),
        attemptKey("event-new", "ops"),
        attemptKey("event-old", "phone"),
      ].sort(),
    );
  });

  it("provides a repository interface for duplicate checks and appends", async () => {
    const directory = await makeTemporaryDirectory();
    const receiptPath = join(directory, "receipts.ndjson");
    const repository = createReceiptRepository(receiptPath);

    assert.equal(await repository.hasAttempted("event-1", "phone"), false);
    await repository.append(acceptedReceipt("event-1", "phone"));
    assert.equal(await repository.hasAttempted("event-1", "phone"), true);
    assert.equal(await repository.hasAttempted("event-1", "ops"), false);

    const reopened = createReceiptRepository(receiptPath);
    assert.equal(await reopened.hasAttempted("event-1", "phone"), true);
  });

  it("uses unambiguous event and destination keys", () => {
    assert.notEqual(attemptKey("event:one", "two"), attemptKey("event", "one:two"));
  });
});

function acceptedReceipt(eventId: string, destination: string): DeliveryReceipt {
  return {
    schemaVersion: 1,
    eventId,
    eventType: "turn.finished",
    destination,
    transport: "webhook",
    driver: "node-http",
    recordedAt: "2026-07-11T00:00:00.000Z",
    durationMs: 12,
    status: "accepted",
    code: "webhook_accepted",
  };
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-herald-receipts-"));
  temporaryDirectories.push(directory);
  return directory;
}
