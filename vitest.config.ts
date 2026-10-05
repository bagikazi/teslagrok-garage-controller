import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "server/**/*.test.ts", "web/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/shared-types/src/**/*.ts", "server/api/src/**/*.ts"],
      exclude: ["**/*.test.ts", "server/api/src/index.ts", "server/api/src/postgres-repository.ts", "server/api/src/mqtt.ts"],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 }
    }
  }
});
