import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["load/**/*.test.ts"], testTimeout: 300_000, hookTimeout: 120_000 } });
