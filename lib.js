// Shared pure functions used by both background.js and popup.js.
// In the Chrome extension context these are loaded via importScripts / <script>.
// In tests they are loaded into a jsdom environment.

const RESTRICTED_URL_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "edge://",
  "about:",
  "chrome-search://",
  "https://chrome.google.com/webstore",
  "https://chromewebstore.google.com",
];

function isRestrictedUrl(url) {
  return !url || RESTRICTED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/**
 * Measure the full page dimensions, handling pages that scroll inside a
 * nested container (e.g. SPAs with `overflow: hidden` on the body).
 *
 * When a nested scroll container is found it is temporarily expanded so the
 * browser lays out all the content. Call `restoreExpandedContainers()` after
 * taking the screenshot to undo the changes.
 *
 * @returns {{ width: number, height: number }}
 */
function measurePageDimensions() {
  // Standard document-level dimensions
  let w = Math.max(
    document.documentElement.scrollWidth,
    document.body ? document.body.scrollWidth : 0
  );
  let h = Math.max(
    document.documentElement.scrollHeight,
    document.body ? document.body.scrollHeight : 0
  );

  // Look for a nested scroll container that is taller than the viewport
  let scrollContainer = null;
  const els = document.querySelectorAll("*");
  for (const el of els) {
    if (el.scrollHeight > el.clientHeight + 10) {
      const s = getComputedStyle(el);
      if (
        s.overflowY === "auto" ||
        s.overflowY === "scroll" ||
        s.overflowY === "overlay"
      ) {
        if (el.scrollHeight > h) {
          h = el.scrollHeight;
          w = Math.max(w, el.scrollWidth);
          scrollContainer = el;
        }
      }
    }
  }

  // If we found a nested scroll container, expand it so the browser
  // renders all content for the screenshot.
  if (scrollContainer) {
    // Scroll to top so all content is captured from the beginning
    scrollContainer.scrollTop = 0;

    scrollContainer.dataset.__screenshotOldOverflow =
      scrollContainer.style.overflow;
    scrollContainer.dataset.__screenshotOldHeight =
      scrollContainer.style.height;
    scrollContainer.dataset.__screenshotOldMaxHeight =
      scrollContainer.style.maxHeight;
    // Use !important to override framework/Tailwind rules that may
    // also use !important on overflow, height, etc.
    scrollContainer.style.setProperty("overflow", "visible", "important");
    scrollContainer.style.setProperty("height", "auto", "important");
    scrollContainer.style.setProperty("max-height", "none", "important");
    scrollContainer.classList.add("__screenshot-expanded__");

    // Also expand ancestors that might clip the container
    let parent = scrollContainer.parentElement;
    while (parent && parent !== document.documentElement) {
      const ps = getComputedStyle(parent);
      if (ps.overflow === "hidden" || ps.overflowY === "hidden") {
        parent.dataset.__screenshotOldOverflow = parent.style.overflow;
        parent.dataset.__screenshotOldHeight = parent.style.height;
        parent.dataset.__screenshotOldMaxHeight = parent.style.maxHeight;
        parent.dataset.__screenshotOldBottom = parent.style.bottom;
        parent.style.setProperty("overflow", "visible", "important");
        parent.style.setProperty("height", "auto", "important");
        parent.style.setProperty("max-height", "none", "important");
        // Fixed/absolute elements with both top+bottom set have their height
        // implicitly constrained. Clear bottom so they can grow freely.
        if (ps.position === "fixed" || ps.position === "absolute") {
          parent.style.setProperty("bottom", "auto", "important");
        }
        parent.classList.add("__screenshot-expanded__");
      }
      parent = parent.parentElement;
    }

    // Convert ALL position:fixed and position:sticky elements on the page
    // to position:absolute / position:relative respectively.
    //
    // Fixed elements are pinned to the viewport. When setDeviceMetricsOverride
    // stretches the viewport to the full content height, fixed elements with
    // inset:0 span the entire viewport and render incorrectly. Converting
    // them to absolute makes them participate in normal document flow so they
    // render once at their natural position — matching the behavior of a
    // normal full-page screenshot on a long page.
    //
    // Sticky elements are converted to relative because they can re-stick
    // at wrong positions when the viewport is stretched.
    document.querySelectorAll("*").forEach((el) => {
      const pos = getComputedStyle(el).position;
      if (pos === "fixed") {
        el.dataset.__screenshotOldPosition = el.style.position;
        el.style.position = "absolute";
        el.classList.add("__screenshot-repositioned__");
      } else if (pos === "sticky") {
        el.dataset.__screenshotOldPosition = el.style.position;
        el.style.position = "relative";
        el.classList.add("__screenshot-repositioned__");
      }
    });

    // Re-measure after expanding. Use getBoundingClientRect() on the
    // expanded container as well, because position:absolute elements
    // (converted from fixed) don't contribute to document.scrollHeight.
    const expandedRect = scrollContainer.getBoundingClientRect();
    h = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
      Math.ceil(expandedRect.bottom + window.scrollY)
    );
    w = Math.max(
      document.documentElement.scrollWidth,
      document.body ? document.body.scrollWidth : 0
    );

    // Force body/html to span the full measured height so the document
    // is tall enough for the capture. Without this, the body may stay
    // at viewport height (e.g. 493px) due to overflow:hidden and the
    // absolutely-positioned overlay doesn't extend it.
    if (document.body) {
      if (!document.body.classList.contains("__screenshot-expanded__")) {
        document.body.dataset.__screenshotOldOverflow =
          document.body.style.overflow;
        document.body.dataset.__screenshotOldHeight =
          document.body.style.height;
        document.body.dataset.__screenshotOldMaxHeight =
          document.body.style.maxHeight;
        document.body.classList.add("__screenshot-expanded__");
      }
      document.body.dataset.__screenshotOldMinHeight =
        document.body.style.minHeight || "";
      document.body.style.setProperty("min-height", h + "px", "important");
    }
    if (document.documentElement) {
      document.documentElement.dataset.__screenshotOldMinHeight =
        document.documentElement.style.minHeight || "";
      document.documentElement.style.setProperty(
        "min-height",
        h + "px",
        "important"
      );
    }
  }

  return { width: w, height: h };
}

/**
 * Undo the DOM changes made by `measurePageDimensions()`.
 * Also removes the scrollbar-hiding style element if present.
 */
function restoreExpandedContainers() {
  document.getElementById("__screenshot-hide-scrollbars__")?.remove();

  // Restore min-height on html and body
  for (const root of [document.documentElement, document.body]) {
    if (root && root.dataset.__screenshotOldMinHeight !== undefined) {
      root.style.removeProperty("min-height");
      if (root.dataset.__screenshotOldMinHeight) {
        root.style.minHeight = root.dataset.__screenshotOldMinHeight;
      }
      delete root.dataset.__screenshotOldMinHeight;
    }
  }

  // Restore position on overlays/sticky elements that were repositioned.
  // Use removeProperty first to clear any !important flag, then re-set
  // the original value.
  document.querySelectorAll(".__screenshot-repositioned__").forEach((el) => {
    const old = el.dataset.__screenshotOldPosition || "";
    el.style.removeProperty("position");
    if (old) el.style.position = old;
    delete el.dataset.__screenshotOldPosition;
    el.classList.remove("__screenshot-repositioned__");
  });
  document.querySelectorAll(".__screenshot-expanded__").forEach((el) => {
    const oldOverflow = el.dataset.__screenshotOldOverflow || "";
    const oldHeight = el.dataset.__screenshotOldHeight || "";
    const oldMaxHeight = el.dataset.__screenshotOldMaxHeight || "";
    el.style.removeProperty("overflow");
    el.style.removeProperty("height");
    el.style.removeProperty("max-height");
    if (oldOverflow) el.style.overflow = oldOverflow;
    if (oldHeight) el.style.height = oldHeight;
    if (oldMaxHeight) el.style.maxHeight = oldMaxHeight;
    if (el.dataset.__screenshotOldBottom !== undefined) {
      el.style.removeProperty("bottom");
      if (el.dataset.__screenshotOldBottom) {
        el.style.bottom = el.dataset.__screenshotOldBottom;
      }
      delete el.dataset.__screenshotOldBottom;
    }
    delete el.dataset.__screenshotOldOverflow;
    delete el.dataset.__screenshotOldHeight;
    delete el.dataset.__screenshotOldMaxHeight;
    el.classList.remove("__screenshot-expanded__");
  });
}

// Export for Node.js tests (no-op in browser where `module` is undefined)
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    RESTRICTED_URL_PREFIXES,
    isRestrictedUrl,
    measurePageDimensions,
    restoreExpandedContainers,
  };
}
