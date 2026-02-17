# Preview Modal & Modal/Drawer Capture

## 1. Preview modal after capture

### Idea

After taking a screenshot (visible or full page), show the captured image in a temporary overlay so the user can see what was copied to the clipboard.

### Design

- Inject a `position: fixed` overlay via `chrome.scripting.executeScript` (same pattern as the flash)
- Show the captured PNG as an `<img>` element (use a `data:image/png;base64,...` src)
- Semi-transparent dark backdrop
- Image centered, scaled to fit with `max-width: 90vw; max-height: 85vh; object-fit: contain`
- Small "Copied to clipboard" label below the image
- Dismiss on: click anywhere, press Escape, or auto-fade after ~2 seconds
- Runs *after* the flash animation and clipboard copy complete
- Replace the flash with this? Or show flash first, then preview? Try both.

### Concerns

- Large full-page screenshots will produce very long base64 strings. Passing a 10MB+ base64 string as an argument to `executeScript` could be slow or hit Chrome's message size limits.
- Alternative: create a blob URL in the content script, pass only the blob URL to the overlay. But the base64 data still needs to cross the boundary once for the clipboard write — we already do that, so the preview can reuse the same injection.
- Could also skip preview for very large images (e.g. > 5MB) or show a scaled-down version.

### Implementation

Modify `captureScreenshot()` in `background.js`:
1. After `copyToClipboard()`, call a new `showPreview(tabId, base64Data)` function
2. `showPreview` injects a content script that builds the overlay DOM
3. The overlay self-destructs on click/Escape/timeout

---

## 2. Capturing scrollable modals/drawers

### The problem

When a modal or drawer is open and scrollable, "Screenshot full page" captures the page behind it (expanding the document), not the modal's full scrollable content. The user wants the full content of the modal.

### Example DOM structure (Profound Brand Kit drawer)

```
<div role="dialog" data-state="open" style="position:fixed; z-index:1000; overflow:hidden">
  <!-- header: 44px tall -->
  <div style="overflow-y:auto; height:calc(100% - 44px)">
    <!-- scrollHeight: 11089px, clientHeight: 921px -->
    ...all the modal content...
  </div>
</div>
```

### Detection strategy

When measuring page dimensions, also check for an **open modal/drawer** that is scrollable:

1. Find elements with `role="dialog"` (or common modal markers like `[data-state="open"]`, `[aria-modal="true"]`)
2. Check if any of them (or their children) have `scrollHeight > clientHeight + threshold` with `overflowY: auto|scroll`
3. If found, this is a **modal capture** scenario

### Capture approaches

#### Approach A: Expand modal, clip to its bounds

1. Detect the modal's scroll container
2. Expand it (same technique as nested scroll containers: `overflow: visible`, `height: auto`, `maxHeight: none`)
3. Also expand the modal's outer `overflow: hidden` container
4. Use `setDeviceMetricsOverride` to resize viewport to fit the expanded modal
5. Capture with a `clip` rectangle matching the modal's bounding box (not the full page)
6. Restore everything

**Pros**: Captures only the modal content, clean result
**Cons**: Complex clipping math; modal backgrounds/backdrops may render oddly when expanded

#### Approach B: Scroll-and-stitch inside the modal

1. Detect the modal's scroll container
2. Programmatically scroll it to each "page" of content
3. Take a visible-area screenshot at each scroll position, cropped to the modal's bounding rect
4. Stitch the captures together into one tall image (using OffscreenCanvas)
5. Restore scroll position

**Pros**: No DOM mutation, captures exactly what the user sees
**Cons**: Stitching artifacts at boundaries; very complex; slow for tall content

#### Approach C: Separate "Screenshot modal" button/mode

Instead of auto-detecting, add a third option: "Screenshot modal/element". The user triggers it, then clicks on the modal/element they want captured.

1. Enter a "pick element" mode (highlight elements on hover)
2. User clicks the modal
3. Find the nearest scrollable container
4. Expand and capture just that region (Approach A on the clicked element)

**Pros**: No false-positive detection; user controls what's captured
**Cons**: Extra step; more UI complexity

### Recommendation

Start with **Approach A** (expand + clip), auto-triggered:

1. In `measurePageDimensions()`, after checking for nested scroll containers, also look for `[role="dialog"][data-state="open"]` or `[aria-modal="true"]` elements
2. If a dialog has a scrollable child that's taller than the page's own content, treat it as the capture target
3. Expand the modal's scroll container and its clipping ancestors
4. Return the modal's dimensions AND its bounding rect (left, top, width) so `captureFullPage` can use a `clip` to capture just the modal area
5. The resulting screenshot is the modal content only — which is what the user wants

If auto-detection proves unreliable across different UI frameworks, fall back to **Approach C** (explicit "screenshot element" mode) later.

### Changes needed

- `lib.js`: Update `measurePageDimensions()` to detect and return modal info
- `background.js`: Use clip rect when modal is detected
- `popup.html`/`popup.js`: Possibly add a third button later (Approach C)
