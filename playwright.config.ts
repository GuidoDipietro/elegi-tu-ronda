import { defineConfig } from "@playwright/test";
const connection = process.env.TEST_DATABASE_URL;
if (!connection || !new URL(connection).pathname.endsWith("_test"))
  throw new Error(
    "Set TEST_DATABASE_URL to a seeded disposable database ending in _test.",
  );
export default defineConfig({
  testDir: "./tests/e2e",
  workers: 1,
  retries: 0,
  use: {
    actionTimeout: 10_000,
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    launchOptions: process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {},
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: false,
    env: { DATABASE_URL: connection, ADMIN_PASSWORD: "browser-test-password" },
  },
});
