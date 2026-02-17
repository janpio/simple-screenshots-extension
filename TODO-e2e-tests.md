# E2E Screenshot Tests

## Goal

Catch rendering bugs (duplication, blank areas, wrong dimensions) that unit tests can't detect because they require a real browser compositing engine.

## Approach

Use **Playwright** with a Chromium instance that has the extension loaded. Playwright supports loading unpacked extensions via launch args:

```js
const context = await chromium.launchPersistentContext("", {
  headless: false, // extensions require headed mode
  args: [
    "--disable-extensions-except=./",
    "--load-extension=./",
  ],
});
```

> `headless: false` is required — Chrome extensions don't load in headless mode. Playwright's `headed` mode works fine in CI via `xvfb-run` on Linux.

## Test cases

### 1. Visible area screenshot

- Navigate to a local test page (simple HTML served by Playwright's test server)
- Trigger the extension (simulate clicking the popup button via `chrome.runtime.sendMessage`)
- Read clipboard and verify the image dimensions match the viewport
- Verify the image is not blank (check that pixel data has variance)

### 2. Full page screenshot — standard page

- Navigate to a local test page with known height (e.g. 3000px tall, colored sections)
- Trigger full-page capture
- Verify image height matches the page's scrollHeight
- Verify distinct color bands appear in the expected vertical positions (no duplication)

### 3. Full page screenshot — nested scroll container (SPA-style)

- Local test page with `body { overflow: hidden; height: 100vh }` and a scrollable inner div
- Trigger full-page capture
- Verify the image captures the inner container's full scrollHeight, not just the viewport

### 4. Full page screenshot — duplication regression

- Local test page with content + a position:fixed header
- Trigger full-page capture multiple times (5–10 runs)
- For each: verify the image height is correct and content doesn't repeat
- This is the specific regression test for the `captureBeyondViewport` bug

### 5. Restricted URL handling

- Navigate to `chrome://extensions`
- Trigger capture
- Verify it fails gracefully (badge shows ✗, no crash)

## Test page fixtures

Create static HTML files in `test/fixtures/` served by Playwright's built-in server:

- `standard.html` — tall page with colored bands at known positions
- `nested-scroll.html` — SPA-style with overflow:hidden body and scrollable inner div
- `fixed-header.html` — normal page with a position:fixed header (duplication regression)

## Clipboard verification

Reading the clipboard in Playwright requires either:
- `context.grantPermissions(["clipboard-read"])` + evaluating `navigator.clipboard.read()` in the page
- Or: intercepting the extension's base64 data before it reaches the clipboard (e.g. expose it via a test hook in background.js behind a flag)

The clipboard approach is more realistic; the test hook approach is simpler.

## CI considerations

- Needs `xvfb-run` on Linux (headed Chromium)
- Extension loading is Chromium-only (won't work in Firefox/WebKit Playwright browsers)
- Keep the test suite separate from unit tests: `npm run test:e2e`
- Consider running only on explicit request (not on every commit) since it's slower

## Setup

```
npm install -D @playwright/test
npx playwright install chromium
```

Add to `package.json`:
```json
"scripts": {
  "test": "node --test test/lib.test.js",
  "test:e2e": "npx playwright test test/e2e/"
}
```
