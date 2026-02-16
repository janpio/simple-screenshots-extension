# Simple Screenshots — Chrome Extension

A minimal Chrome extension that captures visible-area or full-page screenshots and copies them to the clipboard.

## Features

- **Visible area** — instant capture via `chrome.tabs.captureVisibleTab()` (no debugger)
- **Full page** — uses Chrome DevTools Protocol to resize the viewport and capture everything in one pass
- **Clipboard** — screenshots are copied as PNG directly to the clipboard
- **Trigger** — right-click context menu or popup from the extension icon
- **Restricted pages** — buttons are disabled on `chrome://`, `edge://`, `about:`, Web Store, etc.
- **Feedback** — badge on the icon (⏳ → ✓/✗) and a screen flash on success

## Installation

1. Clone this repo
2. Go to `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked** → select the project folder

## Usage

- **Right-click** anywhere on a page → "Screenshot visible area" or "Screenshot full page"
- **Click extension icon** → choose from the popup
- Screenshot is copied to clipboard automatically

## File structure

```
background.js          — Service worker (screenshot orchestration)
lib.js                 — Shared pure functions (URL checks, dimension measurement)
popup.html             — Popup UI
popup.js               — Popup logic
manifest.json          — Extension manifest (MV3)
package.json           — Dev dependencies and test script
test/lib.test.js       — Unit tests
icons/                 — Extension icons (16, 48, 128)
```

## Architecture

- **`lib.js`** — Shared functions loaded via `importScripts()` in the service worker, `<script>` in the popup, and injected into target pages during full-page capture. Contains `isRestrictedUrl()`, `measurePageDimensions()`, and `restoreExpandedContainers()`.
- **`background.js`** — Service worker. Uses `captureVisibleTab` for visible-area and `chrome.debugger` (CDP) for full-page screenshots. Handles clipboard writing by focusing the tab and injecting a content script.
- **`popup.html` / `popup.js`** — Two-button popup that disables itself on restricted pages.

### Full page capture flow

1. Attach debugger, get viewport width via `Page.getLayoutMetrics`
2. Inject `lib.js`, call `measurePageDimensions()` — detects nested scroll containers (SPAs with `overflow:hidden` on body) and expands them
3. Hide viewport size overlay and scrollbars
4. Resize viewport to full content height (`Emulation.setDeviceMetricsOverride`)
5. Capture via `Page.captureScreenshot` with `captureBeyondViewport: true`
6. Clean up, detach debugger (which restores viewport)

### Permissions

`activeTab`, `contextMenus`, `debugger`, `clipboardWrite`, `scripting`

`lib.js` is listed in `web_accessible_resources` so it can be fetched by the service worker and injected into pages.

## Testing

```sh
npm install    # first time only — installs jsdom
npm test       # runs all tests
```

Tests use Node's built-in `node:test` runner with `jsdom`. Since jsdom doesn't do real CSS layout, `scrollHeight`/`clientHeight` are stubbed with dynamic getters.

## Notes

- Full page capture shows a brief "debugging this tab" banner — this is expected
- The debugger is **not** used for visible-area screenshots
- Some pages with `100vh` containers may not capture perfectly due to viewport resize causing re-layout
