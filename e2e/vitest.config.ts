import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// The end-to-end run against a real Tereo; e2e/run.sh starts the stack and
// sets the E2E_* environment these tests read. Not part of packages/zeteo's
// unit or int projects.
export default defineConfig({
  // Vite's cache with the repository's, not in a node_modules of its own here.
  cacheDir: fileURLToPath(
    new URL("../node_modules/.vite/e2e", import.meta.url)
  ),
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["tests/**/*.e2e.test.ts"],
    environment: "node",
    globalSetup: ["support/globalSetup.ts"],
    // One stack, one set of users: files run one after another.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
