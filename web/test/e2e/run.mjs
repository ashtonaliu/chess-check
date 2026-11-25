import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const temp = mkdtempSync(join(tmpdir(), "chess-check-e2e-"));
try {
  const extension = join(temp, "extension");
  const engine = join(extension, "engine");
  const options = { stdio: "inherit" };
  for (const file of ["manifest.json", "offscreen.html", "icons"]) {
    cpSync(join("../extension", file), join(extension, file), { recursive: true });
  }
  execFileSync("bash", ["../scripts/build_engine_wasm.sh", engine], options);
  execFileSync(process.execPath, ["scripts/patchStockfish.mjs", engine], options);
  const common = { bundle: true, minify: true, target: "es2022",
    define: { __CC_PROFILE__: "false", __CC_TEST__: "true" } };
  await build({ ...common, entryPoints: ["src/extension/background.ts", "src/extension/offscreen.ts"],
    format: "esm", splitting: true, outdir: join(extension, "dist") });
  await build({ ...common, entryPoints: ["src/extension/content.ts"], format: "iife",
    loader: { ".css": "text" }, outfile: join(extension, "dist/content.js") });
  await build({ ...common, entryPoints: ["src/browser/tacticsWorker.ts"], format: "esm",
    outfile: join(engine, "tacticsWorker.js") });

  const result = spawnSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test",
    "--config", "test/e2e/playwright.config.mjs", ...process.argv.slice(2)], {
    ...options, env: { ...process.env, CC_E2E_EXTENSION: extension },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
