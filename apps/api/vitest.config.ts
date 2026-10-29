import { defineConfig } from "vitest/config";

// load/ and heldout/ have their own configs and scripts (pnpm load, pnpm heldout)
export default defineConfig({ test: { include: ["test/**/*.test.ts"], fileParallelism: false, testTimeout: 30_000, hookTimeout: 60_000 } });
