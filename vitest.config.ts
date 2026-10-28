import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const rootDir = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      "@agentic-action/contracts": resolve(rootDir, "packages/contracts/src/index.ts"),
      "@agentic-action/core": resolve(rootDir, "packages/core/src/index.ts"),
      "@agentic-action/adapters": resolve(rootDir, "packages/adapters/src/index.ts"),
      "@agentic-action/actions": resolve(rootDir, "packages/actions/src/index.ts"),
      "@agentic-action/extensions": resolve(rootDir, "packages/extensions/src/index.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
