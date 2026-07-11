import { chmod, mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("bin", { recursive: true });

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "bin/codex-herald",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "eof",
  sourcemap: false,
  logLevel: "info",
});

await chmod("bin/codex-herald", 0o755);
