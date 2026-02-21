# CLAUDE.md

See ARCHITECTURE.md for detailed design, capture flows, and test inventory.

## Commands

```sh
npm test       # alias for unit tests
npm run test:unit # run unit tests (Node.js test runner + jsdom)
npm run test:e2e # run Playwright E2E suite (manual, headed Chromium)
npm run test:all # run unit + E2E suites
npm run test:e2e:popup-only # run popup-only E2E coverage
npm run lint   # ESLint 9 flat config — per-file env overrides for browser/extension/node
```

No build step. Reload the extension at `chrome://extensions` after changes.

Requires **Node ≥ 20** (set in `engines`). CI runs on Node 20 and 22.

## Gotchas

- **Clipboard requires document focus.** `navigator.clipboard.write()` needs `document.hasFocus()` to be true. We inject a content script into the original tab to write the clipboard. If the user switched away the write fails and a sticky error toast explains what happened. **We never steal focus** (`chrome.windows.update` / `chrome.tabs.update`) — that's disruptive. The offscreen API's `CLIPBOARD` reason does **not** work for `navigator.clipboard.write()` — Chrome still requires real document focus.
- **`const` bindings don't become `window` properties in a VM context.** In tests, use `win.__evaluate('RESTRICTED_URL_PREFIXES')` to access `const` bindings from `lib.js`. `function` declarations do become globals.
- **jsdom doesn't do CSS layout.** `scrollHeight`/`clientHeight` are always 0. Tests stub them via `Object.defineProperty` with dynamic getters that react to DOM changes (e.g., checking for `__screenshot-expanded__` class to simulate re-layout after expansion).
- **`lib.js` is injected into target pages** during full-page capture via `Runtime.evaluate`. It's also loaded by the service worker (`importScripts`) and the popup (`<script>`). Any changes to `lib.js` affect all three contexts.
- **`web_accessible_resources`** in manifest.json is required so the service worker can `fetch(chrome.runtime.getURL("lib.js"))` and inject its source into pages.
- **Full page screenshots on pages with `100vh` / viewport-relative sizing** can break because `setDeviceMetricsOverride` triggers a re-layout. This is a known limitation.
- **Full page capture is height-first by design.** It prioritizes full vertical coverage and keeps capture width aligned to the current viewport (no horizontal overflow stitching).
- **Nested scroll containers** (SPAs with `overflow:hidden` on body) are detected by scanning all elements for `scrollHeight > clientHeight + 10` with `overflowY: auto|scroll|overlay`. The largest one is expanded along with its clipping ancestors.
- **Resize events are blocked** during full-page capture to prevent SPA frameworks from re-rendering and undoing `measurePageDimensions()` DOM changes. Both `resize` events and `ResizeObserver` callbacks are suppressed, then restored in the `finally` block.
- **Conditional DPR strategy:** `deviceScaleFactor: 0` (native) when physical pixel height (`height × nativeDPR`) stays under `GPU_TEXTURE_LIMIT` (16384px); falls back to `deviceScaleFactor: 1` otherwise. On pages with expanded scroll containers (`__screenshot-expanded__` class present), DPR 1 is always used. A tiling warning is shown if even DPR 1 exceeds the limit.
- **`createBackgroundContext(options)`** in `test/background.test.js` builds a full Chrome API mock namespace and loads `background.js` in a `node:vm` sandbox. Options control page height, DPR, expanded containers, sendCommand errors, etc. Tests use `require("node:assert")` (non-strict) because `deepStrictEqual` breaks across VM context boundaries.
