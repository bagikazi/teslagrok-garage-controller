import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: { baseURL: "http://localhost:3000", trace: "retain-on-failure" },
  webServer: [
    { command: "npm run dev:api", url: "http://localhost:4000/api/system/health", reuseExistingServer: true },
    { command: "npm run dev:web", url: "http://localhost:3000", reuseExistingServer: true, env: { NEXT_PUBLIC_API_BASE_URL: "http://localhost:4000", NEXT_PUBLIC_WS_URL: "ws://localhost:4000/ws" } }
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
