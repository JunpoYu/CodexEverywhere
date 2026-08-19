import { defineConfig, devices } from "@playwright/test";

const browserChannel =
  process.env.CE_PLAYWRIGHT_BROWSER_CHANNEL === "chrome"
    ? ("chrome" as const)
    : undefined;

export default defineConfig({
  testDir: "apps/web/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    channel: browserChannel,
    locale: "zh-CN",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "pnpm --filter @codex-everywhere/web dev --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chromium-390",
      use: {
        ...devices["Pixel 5"],
        viewport: { width: 390, height: 844 },
      },
    },
  ],
});
