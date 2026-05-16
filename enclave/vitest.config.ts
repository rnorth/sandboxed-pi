import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Give integration tests more time (container pull + start)
    testTimeout: 60_000,
  },
});
