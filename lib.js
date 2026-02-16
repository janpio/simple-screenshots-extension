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
    scrollContainer.dataset.__screenshotOldOverflow =
      scrollContainer.style.overflow;
    scrollContainer.dataset.__screenshotOldHeight =
      scrollContainer.style.height;
    scrollContainer.dataset.__screenshotOldMaxHeight =
      scrollContainer.style.maxHeight;
    scrollContainer.style.overflow = "visible";
    scrollContainer.style.height = "auto";
    scrollContainer.style.maxHeight = "none";
    scrollContainer.classList.add("__screenshot-expanded__");

    // Also expand ancestors that might clip the container
    let parent = scrollContainer.parentElement;
    while (parent && parent !== document.documentElement) {
      const ps = getComputedStyle(parent);
      if (ps.overflow === "hidden" || ps.overflowY === "hidden") {
        parent.dataset.__screenshotOldOverflow = parent.style.overflow;
        parent.dataset.__screenshotOldHeight = parent.style.height;
        parent.dataset.__screenshotOldMaxHeight = parent.style.maxHeight;
        parent.style.overflow = "visible";
        parent.style.height = "auto";
        parent.style.maxHeight = "none";
        parent.classList.add("__screenshot-expanded__");
      }
      parent = parent.parentElement;
    }

    // Re-measure after expanding
    h = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
    w = Math.max(
      document.documentElement.scrollWidth,
      document.body ? document.body.scrollWidth : 0
    );
  }

  return { width: w, height: h };
}

/**
 * Undo the DOM changes made by `measurePageDimensions()`.
 * Also removes the scrollbar-hiding style element if present.
 */
function restoreExpandedContainers() {
  document.getElementById("__screenshot-hide-scrollbars__")?.remove();
  document.querySelectorAll(".__screenshot-expanded__").forEach((el) => {
    el.style.overflow = el.dataset.__screenshotOldOverflow || "";
    el.style.height = el.dataset.__screenshotOldHeight || "";
    el.style.maxHeight = el.dataset.__screenshotOldMaxHeight || "";
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
