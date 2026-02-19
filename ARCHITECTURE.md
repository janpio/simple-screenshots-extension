# Architecture Overview

## What This Extension Does

Simple Screenshots is a Chrome extension (Manifest V3) that captures visible-area or full-page screenshots and copies them to the clipboard as PNG images. It handles complex DOM layouts including nested scroll containers, modals/drawers, and sticky elements.

## Key Files

| File | Lines | Role |
|------|-------|------|
| `manifest.json` | — | MV3 manifest: permissions, service worker, popup, web-accessible resources |
| `background.js` | ~700 | Service worker: capture orchestration, CDP interaction, clipboard, preview overlay |
| `lib.js` | ~237 | Pure functions shared across 3 contexts (see below) |
| `popup.html` | ~53 | Popup UI with capture buttons |
| `popup.js` | ~19 | Popup logic: button state, message passing |
| `test/lib.test.js` | ~784 | Unit tests for lib.js (Node test runner + jsdom) |
| `test/background.test.js` | ~700 | Unit tests for background.js (Chrome API mocks + VM context) |
| `eslint.config.js` | ~112 | ESLint 9 flat config with per-file environment overrides |
| `.github/workflows/ci.yml` | ~18 | GitHub Actions CI (lint + test on Node 18/22) |

## How `lib.js` Is Loaded (3 Contexts)

`lib.js` contains pure functions and is loaded in three different ways:

1. **Service worker** — `importScripts("lib.js")` in `background.js`
2. **Popup** — `<script src="lib.js">` in `popup.html`
3. **Target pages** — injected via CDP `Runtime.evaluate` during full-page capture

This is why `lib.js` is listed in `web_accessible_resources` in the manifest: the service worker needs to `fetch(chrome.runtime.getURL("lib.js"))` to get the source text for injection.

Any change to `lib.js` affects all three contexts.

## Permissions

| Permission | Used For |
|------------|----------|
| `activeTab` | Access to the current tab for capture |
| `contextMenus` | Right-click "Screenshot visible/full page" |
| `debugger` | CDP protocol for full-page capture |
| `clipboardWrite` | Copying PNG to clipboard |
| `scripting` | Injecting content scripts (clipboard, preview, flash) |

## Capture Flows

### Visible Area

Simple path, no debugger involved:

1. `chrome.tabs.captureVisibleTab()` returns base64 PNG
2. Copy to clipboard via content script injection
3. Show preview overlay + badge

### Full Page

Uses Chrome DevTools Protocol (CDP). Wrapped in `try/finally` for guaranteed cleanup:

1. **Attach debugger** (CDP v1.3) to the tab
2. **Get viewport width** via `Page.getLayoutMetrics`
3. **Inject `lib.js`** via `Runtime.evaluate`
4. **Call `measurePageDimensions()`** — detects nested scroll containers and modals, expands them, neutralizes sticky/fixed elements, returns `{ width, height }`
5. **Detect complexity** — check for `__screenshot-expanded__` elements to determine DPR strategy
6. **Read native DPR** — `window.devicePixelRatio` to decide if native resolution is safe
7. **Hide scrollbars** — inject `<style>` with `*::-webkit-scrollbar { display: none }`
8. **Hide viewport overlay** — suppress Chrome's viewport size indicator
9. **Block resize events** — suppress `resize` and `ResizeObserver` callbacks to prevent SPA frameworks from re-rendering during viewport resize
10. **Choose DPR** — native (0) when physical height stays under GPU texture limit (16384px), DPR=1 otherwise. Generate a warning if even DPR=1 exceeds the limit
11. **Resize viewport** to full content height via `Emulation.setDeviceMetricsOverride`
12. **Capture** with `Page.captureScreenshot` using a clip rect
13. **Cleanup (finally block):** clear emulation, restore resize handlers, remove scrollbar style, restore containers, detach debugger — each step individually wrapped so failures don't cascade

## Core Functions in `lib.js`

### `isRestrictedUrl(url)`

Returns `true` for URLs where the extension cannot operate: `chrome://`, `edge://`, `about:`, `chrome-extension://`, `chrome-search://`, Chrome Web Store pages. Also returns `true` for null/undefined/empty input.

### `measurePageDimensions()`

Complex dimension measurement + DOM mutation for capture:

1. Checks `document.scrollWidth`/`scrollHeight` as baseline
2. Scans all elements for **nested scroll containers**: `scrollHeight > clientHeight + 10` with `overflowY: auto|scroll|overlay`
3. If found, selects the **largest** one and expands it:
   - Sets `overflow: visible`, `height: auto`, `maxHeight: none`
   - Stores original styles in `dataset` attributes
   - Adds `__screenshot-expanded__` class
4. **Expands clipping ancestors** — walks up the tree, finds parents with `overflow: hidden`, expands them too
5. **Handles fixed-position overlays** — detects modal/drawer ancestors with `position: fixed` and converts to `position: absolute` (prevents duplication when viewport resizes)
6. **Neutralizes sticky elements** — converts all `position: sticky` to `position: relative` globally (prevents headers/footers from re-sticking at wrong positions)
7. Re-measures using `getBoundingClientRect()` on expanded container
8. Returns `{ width, height }`

### `restoreExpandedContainers()`

Undoes all DOM mutations from `measurePageDimensions()`:

- Removes the scrollbar-hiding `<style>` element
- Restores `position` on `.__screenshot-repositioned__` elements
- Restores `overflow`, `height`, `maxHeight`, `bottom` on `.__screenshot-expanded__` elements
- Cleans up all `dataset` attributes and marker classes

## Popup UI

- **"Screenshot visible area"** button (camera icon)
- **"Screenshot full page"** button (document icon)
- **"Not available on this page"** notice — shown when `isRestrictedUrl()` returns true

## Preview Overlay

After capture, a combined flash + preview is injected in a single `executeScript` call:

- **Flash** — white→dark animation (`0.35s ease-out`) signals capture started. A `setTimeout` fallback triggers `buildPreview` if `animationend` never fires (e.g. `prefers-reduced-motion`)
- **Preview panel** — dark backdrop at `z-index: 2147483647` with a 460px right-side panel containing a scrollable image
- **Label** — shows a spinner + "Copying to clipboard…" while the clipboard write runs in the background. Updated to "Copied to clipboard ✓" on success or a red error message on failure
- **Warning banner** — shown when the page exceeded the GPU texture limit (potential tiling artifacts)
- Image uses a Blob URL (not data: URI) to avoid doubling memory; revoked after load/error
- Auto-dismiss timer starts only after clipboard success (4 seconds, paused on hover/scroll)
- Dismiss via: Escape key, click backdrop, or timeout

## Clipboard Writing

Requires document focus — the extension never steals focus:

1. Inject content script via `chrome.scripting.executeScript` that checks `document.hasFocus()` and calls `navigator.clipboard.write()` with a PNG blob
2. If the document is not focused, the injected script throws and the error surfaces in the preview label
3. The clipboard write runs concurrently (fire-and-forget `.then()`) — the preview appears immediately while the clipboard operation completes in the background

## Testing

Unit tests only (E2E planned, see `TODO-e2e-tests.md`). CI runs on Node 18 and 22 via GitHub Actions.

### `test/lib.test.js` (31 tests)

Tests use jsdom + `node:vm` with dynamic getters to stub CSS layout properties.

| Suite | Tests | What's Tested |
|-------|-------|---------------|
| `isRestrictedUrl` | 10 | chrome://, edge://, about:, Web Store, null/undefined |
| Standard page | 1 | Basic measurement returns numbers |
| Null body | 1 | Returns documentElement dimensions when body is null |
| Nested scroll container | 4 | Detection, expansion, ancestor expansion, style preservation |
| Multiple containers | 1 | Selects largest by scrollHeight |
| Fixed-position modal | 11 | Modal detection, fixed-to-absolute, sticky neutralization, viewport sizing |
| `restoreExpandedContainers` | 3 | Style restoration, scrollbar style removal, cleanup |
| `RESTRICTED_URL_PREFIXES` | 1 | Const export works correctly |

### `test/background.test.js` (38 tests)

Tests use `node:vm` with hand-rolled Chrome API mocks. A `createBackgroundContext()` helper builds the full mock `chrome` namespace, loads `background.js`, and captures registered event listeners.

| Suite | Tests | What's Tested |
|-------|-------|---------------|
| Event listener registration | 3 | onInstalled menu items, onClicked wiring, onMessage dispatch |
| Restricted URL guard | 3 | chrome://, null URL, Web Store — badge + no capture |
| Visible capture | 3 | captureVisibleTab args, prefix stripping, error badge |
| Full page capture | 2 | Debugger path used, success badge |
| captureFullPage happy path | 4 | CDP command order, clip dimensions, return value |
| DPR strategy | 3 | Native DPR, expanded containers, GPU limit fallback |
| Dimension clamping | 2 | Width capped at 10000, height floored at 1 |
| Warnings | 3 | Tiling warning, DPR fallback warning, null when OK |
| Cleanup on error | 3 | Detach on failure, skip if never attached, cleanup isolation |
| Overlay suppression | 1 | Capture continues when Overlay domain unavailable |
| clipboardWriteViaScript | 3 | Tab targeting, args, error on undefined result |
| showBadge | 3 | Text/color, 2s clear timeout, pulse animation |
| UI injection helpers | 4 | showPreFlash, showFlashAndPreview, removeOverlay, showError |
