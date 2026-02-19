# Simple Screenshots — Chrome Extension

A minimal Chrome extension that captures visible-area or full-page screenshots and copies them to the clipboard.

## Screenshot Modes

The extension handles three distinct capture scenarios:

1. **Visible area** — captures exactly what's on screen using `chrome.tabs.captureVisibleTab()`. No debugger needed, instant result at native DPR.

2. **Full page (simple)** — for standard long pages without modals or drawers. Attaches the Chrome debugger, resizes the viewport to the full content height, and captures in one pass. Uses native DPR for sharp output when the physical pixel height stays under Chrome's GPU texture limit (16384px); falls back to DPR=1 for very tall pages.

3. **Full page (complex — modals/drawers)** — for pages with open scrollable overlays (modals, drawers, sidepanels). Detects nested scroll containers, expands them, converts `position: fixed` to `absolute` and `sticky` to `relative`, blocks resize events to prevent framework re-renders, and forces DPR=1 to stay under Chrome's GPU texture limit (16384px).

The extension auto-detects which full-page path to use — no user action required. If a page exceeds the GPU texture limit even at DPR=1, the capture proceeds but a warning banner appears in the preview.

## Features

- **Clipboard** — screenshots are copied as PNG directly to the clipboard. Never steals window/tab focus; if the tab loses focus during capture, a sticky error toast explains what happened
- **Trigger** — right-click context menu or popup from the extension icon
- **Restricted pages** — buttons are disabled on `chrome://`, `edge://`, `about:`, Web Store, etc.
- **Preview** — after capture, a white→dark flash plays, then a scrollable preview panel appears showing the image, dimensions, and clipboard status (spinner while copying, green checkmark on success, red message on failure). Hovering or scrolling the preview pauses the auto-dismiss timer. Warning banners appear when the page exceeds GPU texture limits
- **Feedback** — pulsing badge (`...`) while capturing, then ✓ or ✗

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
test/lib.test.js       — Unit tests for lib.js (31 tests)
test/background.test.js — Unit tests for background.js (38 tests)
icons/                 — Extension icons (16, 48, 128)
generate-icons.js      — Dev utility to regenerate icons (requires canvas npm package)
```

## Architecture

- **`lib.js`** — Shared functions loaded via `importScripts()` in the service worker, `<script>` in the popup, and injected into target pages during full-page capture. Contains `isRestrictedUrl()`, `measurePageDimensions()`, and `restoreExpandedContainers()`.
- **`background.js`** — Service worker. Uses `captureVisibleTab` for visible-area and `chrome.debugger` (CDP) for full-page screenshots. Clipboard writing is done via content script injection without stealing focus; the preview shows immediately and updates its label when the clipboard operation completes or fails.
- **`popup.html` / `popup.js`** — Two-button popup that disables itself on restricted pages.

### Full page capture flow

1. Show soft pre-flash (gentle white blink) to indicate capture has started
2. Attach debugger, get viewport width via `Page.getLayoutMetrics`
3. Inject `lib.js`, call `measurePageDimensions()` — detects nested scroll containers (SPAs with `overflow:hidden` on body) and expands them
4. Read native `devicePixelRatio` to decide DPR strategy
5. Hide viewport size overlay and scrollbars
6. Block resize/ResizeObserver events (prevents SPA re-renders during viewport resize)
7. Choose DPR: native (0) when physical height stays under 16384px, DPR=1 otherwise. Generate a warning if even DPR=1 exceeds the limit
8. Resize viewport to full content height (`Emulation.setDeviceMetricsOverride`)
9. Capture via `Page.captureScreenshot` with clip rect
10. Clean up (try/finally): clear emulation, restore events, remove scrollbar-hide style, restore containers, detach debugger
11. Play flash animation → show preview panel with clipboard spinner → write clipboard in background → update label on success/failure

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
