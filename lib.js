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
        parent.dataset.__screenshotOldBottom = parent.style.bottom;
        parent.style.overflow = "visible";
        parent.style.height = "auto";
        parent.style.maxHeight = "none";
        // Fixed/absolute elements with both top+bottom set have their height
        // implicitly constrained. Clear bottom so they can grow freely.
        if (ps.position === "fixed" || ps.position === "absolute") {
          parent.style.bottom = "auto";
        }
        parent.classList.add("__screenshot-expanded__");
      }
      parent = parent.parentElement;
    }

    // If the scroll container lives inside a fixed/absolute overlay (modal,
    // drawer, etc.), hide everything else on the page so only the overlay
    // content appears in the screenshot.
    let overlayAncestor = scrollContainer.parentElement;
    while (overlayAncestor && overlayAncestor !== document.body) {
      const os = getComputedStyle(overlayAncestor);
      if (os.position === "fixed" || os.position === "absolute") {
        break;
      }
      overlayAncestor = overlayAncestor.parentElement;
    }
    if (overlayAncestor && overlayAncestor !== document.body) {
      for (const sibling of overlayAncestor.parentElement.children) {
        if (sibling === overlayAncestor) continue;
        const ss = getComputedStyle(sibling);
        if (ss.display === "none" || sibling.tagName === "SCRIPT") continue;
        sibling.dataset.__screenshotOldDisplay = sibling.style.display;
        sibling.style.display = "none";
        sibling.classList.add("__screenshot-hidden__");
      }
    }

    // Re-measure after expanding. Use getBoundingClientRect() on the
    // expanded container as well, because position:fixed elements (e.g.
    // modals/drawers) don't contribute to document.scrollHeight.
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
  }

  return { width: w, height: h };
}

/**
 * Undo the DOM changes made by `measurePageDimensions()`.
 * Also removes the scrollbar-hiding style element if present.
 */
function restoreExpandedContainers() {
  document.getElementById("__screenshot-hide-scrollbars__")?.remove();
  // Restore siblings that were hidden for modal/overlay capture
  document.querySelectorAll(".__screenshot-hidden__").forEach((el) => {
    el.style.display = el.dataset.__screenshotOldDisplay || "";
    delete el.dataset.__screenshotOldDisplay;
    el.classList.remove("__screenshot-hidden__");
  });
  document.querySelectorAll(".__screenshot-expanded__").forEach((el) => {
    el.style.overflow = el.dataset.__screenshotOldOverflow || "";
    el.style.height = el.dataset.__screenshotOldHeight || "";
    el.style.maxHeight = el.dataset.__screenshotOldMaxHeight || "";
    if (el.dataset.__screenshotOldBottom !== undefined) {
      el.style.bottom = el.dataset.__screenshotOldBottom;
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
