import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Give integration tests more time (container pull + start).
    testTimeout: 60_000,
    // Integration tests create real Docker containers (workload +
    // proxy + shared netns) and stomp on each other if two test files
    // run concurrently. Run files sequentially.
    fileParallelism: false,
  },
});
