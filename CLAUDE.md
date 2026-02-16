# CLAUDE.md

See README.md for project overview, architecture, and file structure.

## Commands

```sh
npm test       # run unit tests (Node.js test runner + jsdom)
```

No build step. Reload the extension at `chrome://extensions` after changes.

## Gotchas

- **Clipboard requires document focus.** Must call both `chrome.windows.update({ focused: true })` and `chrome.tabs.update({ active: true })` before injecting the clipboard content script, or you get "Document is not focused".
- **`const` bindings don't become `window` properties in a VM context.** In tests, use `win.__evaluate('RESTRICTED_URL_PREFIXES')` to access `const` bindings from `lib.js`. `function` declarations do become globals.
- **jsdom doesn't do CSS layout.** `scrollHeight`/`clientHeight` are always 0. Tests stub them via `Object.defineProperty` with dynamic getters that react to DOM changes (e.g., checking for `__screenshot-expanded__` class to simulate re-layout after expansion).
- **`lib.js` is injected into target pages** during full-page capture via `Runtime.evaluate`. It's also loaded by the service worker (`importScripts`) and the popup (`<script>`). Any changes to `lib.js` affect all three contexts.
- **`web_accessible_resources`** in manifest.json is required so the service worker can `fetch(chrome.runtime.getURL("lib.js"))` and inject its source into pages.
- **Full page screenshots on pages with `100vh` / viewport-relative sizing** can break because `setDeviceMetricsOverride` triggers a re-layout. This is a known limitation.
- **Nested scroll containers** (SPAs with `overflow:hidden` on body) are detected by scanning all elements for `scrollHeight > clientHeight + 10` with `overflowY: auto|scroll|overlay`. The largest one is expanded along with its clipping ancestors.
