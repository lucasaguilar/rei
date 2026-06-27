import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only run tests from src/ — never the compiled copies that the build emits into dist/.
    // (Running dist tests duplicated every run and could go stale vs the source.)
    include: ["src/**/*.{test,spec}.ts"],
  },
});
