import { HeraldError } from "../domain/errors.js";

export async function readLimitedText(
  input: AsyncIterable<Uint8Array | string>,
  maxBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    for await (const value of input) {
      const chunk = Buffer.from(value);
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        throw new HeraldError(
          "HOOK_INPUT_TOO_LARGE",
          "Codex Stop hook input exceeds the 1 MiB limit",
        );
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof HeraldError) {
      throw error;
    }
    throw new HeraldError(
      "HOOK_INPUT_INVALID",
      "Codex Stop hook input could not be read",
    );
  }

  return Buffer.concat(chunks, totalBytes).toString("utf8");
}
