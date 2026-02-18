# Architecture Overview

## What This Extension Does

Simple Screenshots is a Chrome extension (Manifest V3) that captures visible-area or full-page screenshots and copies them to the clipboard as PNG images. It handles complex DOM layouts including nested scroll containers, modals/drawers, and sticky elements.

## Key Files

| File | Lines | Role |
|------|-------|------|
| `manifest.json` | — | MV3 manifest: permissions, service worker, popup, web-accessible resources |
| `background.js` | ~431 | Service worker: capture orchestration, CDP interaction, clipboard, preview overlay |
| `lib.js` | ~237 | Pure functions shared across 3 contexts (see below) |
| `popup.html` | ~53 | Popup UI with capture buttons |
| `popup.js` | ~19 | Popup logic: button state, message passing |
| `test/lib.test.js` | ~784 | Unit tests (Node test runner + jsdom) |

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
6. **Hide scrollbars** — inject `<style>` with `*::-webkit-scrollbar { display: none }`
7. **Hide viewport overlay** — suppress Chrome's viewport size indicator
8. **Block resize events** — suppress `resize` and `ResizeObserver` callbacks to prevent SPA frameworks from re-rendering during viewport resize
9. **Resize viewport** to full content height via `Emulation.setDeviceMetricsOverride` (DPR=0 for simple pages, DPR=1 for complex expanded-container pages to avoid GPU texture limit)
10. **Capture** with `Page.captureScreenshot` using a clip rect
11. **Cleanup (finally block):** clear emulation, restore resize handlers, restore containers, detach debugger — each step individually wrapped so failures don't cascade

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

After capture, a preview is injected into the page:

- Dark semi-transparent backdrop at `z-index: 2147483647`
- Right-side panel (460px wide) with scrollable image container
- Shows "Copied to clipboard ✓" label with image dimensions (width × height px)
- Image uses a Blob URL (not data: URI) to avoid doubling memory; revoked after load
- Auto-dismiss after 4 seconds (pauses on hover)
- Dismiss via: Escape key, click backdrop, or timeout
- Mouse wheel scrolling on the panel

## Clipboard Writing

Requires document focus to work:

1. `Promise.all` of `chrome.windows.update({ focused: true })` + `chrome.tabs.update({ active: true })` — both must complete before clipboard access
2. Inject content script that calls `navigator.clipboard.write()` with a PNG blob

## Testing

Unit tests only (E2E planned, see `TODO-e2e-tests.md`). Tests use:

- **Node's built-in `node:test` runner** with jsdom
- **Dynamic getters** to stub `scrollHeight`/`clientHeight` (jsdom doesn't do CSS layout)
- **`win.__evaluate(expr)`** helper to access `const` bindings (they don't become `window` properties in a VM context)

### Test Coverage (31 tests)

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
