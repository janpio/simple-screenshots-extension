# Simple Screenshots — Chrome Extension

A minimal Chrome extension that captures visible-area or full-page screenshots and copies them to the clipboard.

## Screenshot Modes

The extension handles three distinct capture scenarios:

1. **Visible area** — captures exactly what's on screen using `chrome.tabs.captureVisibleTab()`. No debugger needed, instant result at native DPR.

2. **Full page (simple)** — for standard long pages without modals or drawers. Attaches the Chrome debugger, resizes the viewport to the full content height, and captures in one pass. Uses native DPR for sharp output.

3. **Full page (complex — modals/drawers)** — for pages with open scrollable overlays (modals, drawers, sidepanels). Detects nested scroll containers, expands them, converts `position: fixed` to `absolute` and `sticky` to `relative`, blocks resize events to prevent framework re-renders, and forces DPR=1 to stay under Chrome's GPU texture limit (16384px).

The extension auto-detects which full-page path to use — no user action required.

## Features

- **Clipboard** — screenshots are copied as PNG directly to the clipboard
- **Trigger** — right-click context menu or popup from the extension icon
- **Restricted pages** — buttons are disabled on `chrome://`, `edge://`, `about:`, Web Store, etc.
- **Preview** — after capture, shows a minimap-style preview panel with image dimensions
- **Feedback** — badge on the icon (⏳ → ✓/✗)

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
test/lib.test.js       — Unit tests (31 tests)
icons/                 — Extension icons (16, 48, 128)
generate-icons.js      — Dev utility to regenerate icons (requires canvas npm package)
```

## Architecture

- **`lib.js`** — Shared functions loaded via `importScripts()` in the service worker, `<script>` in the popup, and injected into target pages during full-page capture. Contains `isRestrictedUrl()`, `measurePageDimensions()`, and `restoreExpandedContainers()`.
- **`background.js`** — Service worker. Uses `captureVisibleTab` for visible-area and `chrome.debugger` (CDP) for full-page screenshots. Handles clipboard writing by focusing the tab and injecting a content script.
- **`popup.html` / `popup.js`** — Two-button popup that disables itself on restricted pages.

### Full page capture flow

1. Attach debugger, get viewport width via `Page.getLayoutMetrics`
2. Inject `lib.js`, call `measurePageDimensions()` — detects nested scroll containers (SPAs with `overflow:hidden` on body) and expands them
3. Hide viewport size overlay and scrollbars
4. Block resize/ResizeObserver events (prevents SPA re-renders during viewport resize)
5. Resize viewport to full content height (`Emulation.setDeviceMetricsOverride`), using native DPR for simple pages or DPR=1 for complex pages with expanded containers
6. Capture via `Page.captureScreenshot` with clip rect
7. Clean up (try/finally): clear emulation, restore events, restore containers, detach debugger

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
