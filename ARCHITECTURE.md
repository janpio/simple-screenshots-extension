# Architecture Overview

## What This Extension Does

Simple Screenshots is a Chrome extension (Manifest V3) that captures visible-area or full-page screenshots and copies them to the clipboard as PNG images. It handles complex DOM layouts including nested scroll containers, modals/drawers, and sticky elements.

## Key Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest: permissions, service worker, popup, web-accessible resources |
| `background.js` | Service worker: capture orchestration, CDP interaction, clipboard, preview overlay |
| `lib.js` | Pure functions shared across 3 contexts (see below) |
| `popup.html` | Popup UI with capture buttons |
| `popup.js` | Popup logic: button state, message passing |
| `test/lib.test.js` | Unit tests for lib.js (Node test runner + jsdom) |
| `test/background.test.js` | Unit tests for background.js (Chrome API mocks + VM context) |
| `eslint.config.js` | ESLint 9 flat config with per-file environment overrides |
| `.github/workflows/ci.yml` | GitHub Actions CI (lint + test on Node 20/22) |

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

Design tradeoff: full-page capture is intentionally **height-first**. The extension prioritizes full vertical coverage and keeps capture width aligned to the current viewport, rather than attempting horizontal overflow stitching.

## Capture Concurrency Policy

Captures are tracked per tab with monotonic capture IDs. If a newer capture starts before an older one finishes, the newer request becomes authoritative.

- Stale completions from older captures are ignored (no stale badge/preview overwrite)
- Clipboard/preview updates are capture-scoped so only the latest capture can finalize UI state for that tab
- User-visible behavior is intentionally silent: no extra warning when an old capture is superseded

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
4. Clipboard completion is capture-scoped; if a newer capture supersedes the current one, stale clipboard completions are dropped

## Testing

Unit tests run on Node 20 and 22 via GitHub Actions (`.github/workflows/ci.yml`).
E2E tests are implemented with Playwright and run manually via `.github/workflows/e2e-manual.yml`
(`workflow_dispatch`, suite input: `full`, `plumbing`, or `popup-only`).

### `test/lib.test.js`

Tests use jsdom + `node:vm` with dynamic getters to stub CSS layout properties.

| Suite | What's Tested |
|-------|---------------|
| `isRestrictedUrl` | chrome://, edge://, about:, Web Store, null/undefined |
| Standard page + null body | Basic measurement path and no-body edge case |
| Nested scroll container | Detection, expansion, ancestor expansion, style preservation |
| Multiple containers | Selects largest by scrollHeight |
| Fixed-position modal | Modal detection, fixed-to-absolute, sticky neutralization, viewport sizing |
| `restoreExpandedContainers` | Style restoration, scrollbar style removal, cleanup |
| `RESTRICTED_URL_PREFIXES` | Const export works correctly |

### `test/background.test.js`

Tests use `node:vm` with hand-rolled Chrome API mocks. A `createBackgroundContext()` helper builds the full mock `chrome` namespace, loads `background.js`, and captures registered event listeners.

| Suite | What's Tested |
|-------|---------------|
| Event listener registration | onInstalled menu items, onClicked wiring, onMessage dispatch |
| Restricted URL guard | chrome://, null URL, undefined tab, Web Store — badge + no capture |
| Visible capture | captureVisibleTab args, prefix stripping, error badge |
| Full page capture | Debugger path, success badge, large payload path |
| Capture concurrency / latest wins | Overlapping runs: stale completion/failure paths are dropped |
| captureFullPage happy path | CDP command order, clip dimensions, return value |
| DPR strategy | Native DPR, expanded containers, GPU limit fallback |
| Dimension clamping | Width capped at 10000, height floored at 1 |
| Warnings | Tiling warning, DPR fallback warning, null when OK |
| Large page stress | 50k-height path: fallback DPR, warning, clip/emulation params, cleanup |
| Cleanup on error | Detach on failure, skip if never attached, cleanup isolation |
| Overlay suppression | Capture continues when Overlay domain unavailable |
| Runtime.evaluate exceptionDetails | Clear surfaced errors when CDP eval returns exceptionDetails |
| clipboardWriteViaScript | Tab targeting, args, error on undefined result |
| showBadge | Text/color, 2s clear timeout, pulse animation |
| UI injection helpers | showPreFlash, showFlashAndPreview, removeOverlay, showError |

### `test/e2e/screenshot.e2e.spec.js` (Playwright, Chromium-only)

The E2E suite validates real browser rendering and clipboard behavior in a loaded extension context.
It is serialised (`workers: 1`) to avoid clipboard contention and uses runtime-message triggering for deterministic automation.
Popup triggering remains available in the helper for targeted popup-specific checks.
For deterministic automation, the harness loads a temporary extension bundle with test-only
`host_permissions: ["<all_urls>"]` (production manifest remains unchanged).

Key files:
- `test/e2e/playwright.config.js` — runner config, artifacts on failure
- `test/e2e/00-plumbing.e2e.spec.js` — decomposition diagnostics for core automation plumbing
- `test/e2e/helpers/extension.js` — extension harness bootstrap + service worker resolution
- `test/e2e/helpers/server.js` — local fixture HTTP server
- `test/e2e/helpers/trigger.js` — runtime-message trigger + optional popup-first path
- `test/e2e/helpers/badge.js` — badge polling and timeline capture
- `test/e2e/helpers/clipboard.js` — clipboard PNG decode + metric/color assertions
- `test/e2e/fixtures/*.html` — deterministic pages for scenario coverage
- `test/e2e/regressions/registry.json` — metadata for regression-derived cases

Current E2E scenario coverage:
- Plumbing diagnostics: tab resolution, raw `captureVisibleTab`, runtime-message path with clipboard stub, direct clipboard roundtrip
- Visible capture on standard fixture
- Popup-first visible capture smoke
- Overlapping captures regression (newest result wins)
- Full-page capture on standard fixture
- Full-page capture on nested-scroll fixture
- Fixed-header duplication regression (multi-run)
- Restricted URL handling (`chrome://extensions`)
- Large-height full-page smoke (warning path)
- Clipboard focus-loss negative path

Regression intake workflow:
1. Reproduce issue on real site
2. Classify DOM/layout pattern causing failure
3. Build minimal deterministic local fixture matching that pattern
4. Add one focused E2E regression test
5. Record metadata entry in `test/e2e/regressions/registry.json`
