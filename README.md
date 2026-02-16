# Simple Screenshots — Chrome Extension

## Goal

A minimal Chrome extension that captures screenshots using the Chrome DevTools Protocol (same as Chrome's built-in "Capture full size screenshot" from the command palette). This avoids the issues browser extension alternatives have with fixed headers/footers.

## Requirements

- Capture **visible area** and **full page** screenshots
- Use **Chrome DevTools Protocol** (`Page.captureScreenshot`) — not scroll-based stitching
- Copy screenshot directly to **clipboard**
- Trigger via **right-click context menu** (two options) or **popup** when clicking the extension icon

## Extension Structure

```
simple-screenshots-extension/
├── manifest.json
├── background.js
├── popup.html
├── popup.js
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Key Implementation Details

### manifest.json
- Manifest V3
- Permissions: `activeTab`, `debugger`, `contextMenus`, `clipboardWrite`
- Background service worker: `background.js`
- Popup: `popup.html`

### background.js — Core Logic

1. **Context menu**: Two entries — "Screenshot visible area" and "Screenshot full page"
2. **Message listener**: Handles capture requests from the popup
3. **Capture flow**:
   - Attach Chrome Debugger to active tab
   - For full page: call `Page.getLayoutMetrics` to get full content size, then `Emulation.setDeviceMetricsOverride` to resize viewport to full page dimensions
   - Call `Page.captureScreenshot` with `format: "png"` (and `captureBeyondViewport: true` for full page)
   - For full page: call `Emulation.clearDeviceMetricsOverride` to reset viewport
   - Detach debugger
4. **Clipboard**: Inject a content script to convert base64 screenshot to blob, use `navigator.clipboard.write()` with `ClipboardItem`
5. **Badge**: Show a brief success/failure badge on the extension icon

### popup.html / popup.js
- Two-button popup: "Visible area" and "Full page"
- Sends a message to `background.js` with the capture type, then closes

### Icons
- Simple placeholder icons in the `icons/` directory

## Installation

1. Save all files in a folder
2. Go to `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked** → select the folder

## Usage

- **Right-click** anywhere on a page → "Screenshot visible area" or "Screenshot full page"
- **Click extension icon** in toolbar → choose "Visible area" or "Full page" from the popup
- Screenshot is copied to clipboard automatically

## Notes

- The debugger attachment causes a brief "debugging this tab" banner — this is expected behavior
- DevTools Protocol approach produces identical results to Chrome's built-in screenshot command
- No scroll-based stitching means fixed headers/footers are handled correctly
