import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["heldout/**/*.test.ts"], testTimeout: 1_800_000, hookTimeout: 120_000 } });
