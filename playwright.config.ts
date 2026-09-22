import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'bun run dev -- --headless',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 90_000,
    wait: {
      // Match cargo's "Running `…koharu.exe --port=9999 --headless`"
      // (process start), not Tauri's earlier "Running DevCommand (…)"
      // line, which prints before the backend has even compiled.
      stdout: /Running `[^`]*koharu[^`]* --headless`/,
    },
  },
})
