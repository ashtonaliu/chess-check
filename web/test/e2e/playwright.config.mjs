import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "extension.spec.mjs",
  workers: 2,
  fullyParallel: true,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  outputDir: "../../../.cache/extension-e2e",
});
