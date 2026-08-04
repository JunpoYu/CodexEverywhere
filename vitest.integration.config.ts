import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,packages}/**/*.integration.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    sequence: { concurrent: false },
  },
});
