const path = require("node:path");
const repoRoot = path.resolve(__dirname, "..", "..");

/** @type {import('@playwright/test').PlaywrightTestConfig} */
module.exports = {
  testDir: path.resolve(__dirname),
  testMatch: ["**/*.e2e.spec.js"],
  fullyParallel: false,
  workers: 1,
  timeout: 120000,
  expect: {
    timeout: 10000,
  },
  reporter: [
    ["list"],
    [
      "html",
      {
        open: "never",
        outputFolder: path.join(repoRoot, "playwright-report"),
      },
    ],
  ],
  outputDir: path.join(repoRoot, "test-results"),
  use: {
    headless: false,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
};
