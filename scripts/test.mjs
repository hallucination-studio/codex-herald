import { spawn } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsc = fileURLToPath(
  new URL("../node_modules/typescript/bin/tsc", import.meta.url),
);

await rm(new URL("../.test-dist", import.meta.url), {
  recursive: true,
  force: true,
});

await run(process.execPath, [tsc, "-p", "tsconfig.test.json"]);

const entries = await readdir(new URL("../.test-dist/test", import.meta.url), {
  recursive: true,
});
const tests = entries
  .filter((entry) => entry.endsWith(".test.js"))
  .map((entry) => `.test-dist/test/${entry}`)
  .sort();

if (tests.length === 0) {
  throw new Error("No compiled test files found");
}

await run(process.execPath, ["--test", ...tests]);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      shell: false,
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          signal
            ? `${command} terminated by ${signal}`
            : `${command} exited with code ${code ?? "unknown"}`,
        ),
      );
    });
  });
}
