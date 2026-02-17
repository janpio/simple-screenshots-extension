const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const libSource = fs.readFileSync(
  path.join(__dirname, "..", "lib.js"),
  "utf-8"
);

/**
 * Create a jsdom window, execute lib.js in it, and return the window object
 * so tests can access isRestrictedUrl, measurePageDimensions, etc.
 *
 * Because `const` declarations don't become window properties in a vm context,
 * we also expose a helper `evaluate(expr)` that evaluates expressions in the
 * jsdom context to access `const` bindings like RESTRICTED_URL_PREFIXES.
 */
function createWindow(html = "<!DOCTYPE html><html><body></body></html>") {
  const dom = new JSDOM(html, {
    url: "https://example.com",
    pretendToBeVisual: true,
    runScripts: "dangerously",
  });
  const { window } = dom;

  // Execute lib.js at the top-level of the jsdom context so that function
  // declarations become globals on the window object.
  const vmContext = dom.getInternalVMContext();
  const script = new vm.Script(libSource, { filename: "lib.js" });
  script.runInContext(vmContext);

  // Helper to evaluate expressions in the same context (for const bindings)
  window.__evaluate = (expr) => vm.runInContext(expr, vmContext);

  return window;
}

/**
 * Helper to set up a nested scroll page with stubbed dimensions.
 *
 * jsdom doesn't do real CSS layout so we stub scrollHeight / clientHeight.
 * To simulate the re-layout that happens after expansion, the document's
 * scrollHeight getter checks whether the `__screenshot-expanded__` class
 * has been applied and returns the expanded height if so.
 */
function setupNestedScrollPage() {
  const win = createWindow(`<!DOCTYPE html>
    <html>
    <body style="overflow: hidden; margin: 0;">
      <div id="app" style="overflow: hidden; height: 100%;">
        <div id="scroller" style="overflow-y: auto; height: 100%;">
          <div id="content" style="height: 5000px;">content</div>
        </div>
      </div>
    </body>
    </html>`);

  const doc = win.document;
  const scroller = doc.getElementById("scroller");
  const app = doc.getElementById("app");

  // Stub dimensions — jsdom doesn't compute these.
  // Document scrollHeight returns 5000 once scroller has been expanded,
  // simulating how a real browser re-layouts after removing overflow constraints.
  Object.defineProperty(doc.documentElement, "scrollHeight", {
    get: () =>
      scroller.classList.contains("__screenshot-expanded__") ? 5000 : 800,
    configurable: true,
  });
  Object.defineProperty(doc.documentElement, "scrollWidth", {
    value: 1200,
    configurable: true,
  });
  Object.defineProperty(doc.body, "scrollHeight", {
    get: () =>
      scroller.classList.contains("__screenshot-expanded__") ? 5000 : 800,
    configurable: true,
  });
  Object.defineProperty(doc.body, "scrollWidth", {
    value: 1200,
    configurable: true,
  });

  Object.defineProperty(scroller, "scrollHeight", {
    value: 5000,
    configurable: true,
  });
  Object.defineProperty(scroller, "clientHeight", {
    value: 800,
    configurable: true,
  });
  Object.defineProperty(scroller, "scrollWidth", {
    value: 1200,
    configurable: true,
  });

  return { win, doc, scroller, app };
}

// ---------------------------------------------------------------------------
// isRestrictedUrl
// ---------------------------------------------------------------------------
describe("isRestrictedUrl", () => {
  let isRestrictedUrl;

  beforeEach(() => {
    const win = createWindow();
    isRestrictedUrl = win.isRestrictedUrl;
  });

  it("returns true for chrome:// URLs", () => {
    assert.equal(isRestrictedUrl("chrome://extensions"), true);
    assert.equal(isRestrictedUrl("chrome://settings/passwords"), true);
  });

  it("returns true for chrome-extension:// URLs", () => {
    assert.equal(
      isRestrictedUrl("chrome-extension://abcdef/popup.html"),
      true
    );
  });

  it("returns true for edge:// URLs", () => {
    assert.equal(isRestrictedUrl("edge://settings"), true);
  });

  it("returns true for about: URLs", () => {
    assert.equal(isRestrictedUrl("about:blank"), true);
  });

  it("returns true for chrome-search:// URLs", () => {
    assert.equal(isRestrictedUrl("chrome-search://local-ntp"), true);
  });

  it("returns true for Chrome Web Store URLs", () => {
    assert.equal(
      isRestrictedUrl("https://chrome.google.com/webstore/detail/xyz"),
      true
    );
    assert.equal(
      isRestrictedUrl("https://chromewebstore.google.com/detail/xyz"),
      true
    );
  });

  it("returns false for regular https URLs", () => {
    assert.equal(isRestrictedUrl("https://example.com"), false);
    assert.equal(
      isRestrictedUrl("https://www.google.com/search?q=hi"),
      false
    );
  });

  it("returns false for regular http URLs", () => {
    assert.equal(isRestrictedUrl("http://localhost:3000"), false);
  });

  it("returns true for null / undefined / empty string", () => {
    assert.equal(isRestrictedUrl(null), true);
    assert.equal(isRestrictedUrl(undefined), true);
    assert.equal(isRestrictedUrl(""), true);
  });
});

// ---------------------------------------------------------------------------
// measurePageDimensions — standard page (no nested scroll container)
// ---------------------------------------------------------------------------
describe("measurePageDimensions — standard page", () => {
  it("returns document dimensions when there is no nested scroll container", () => {
    const win = createWindow(`<!DOCTYPE html>
      <html>
      <body style="margin:0">
        <div style="width: 1200px; height: 3000px;"></div>
      </body>
      </html>`);

    const dims = win.measurePageDimensions();

    // jsdom doesn't do real layout, so scrollWidth/scrollHeight default to 0.
    // The important thing is the function runs without error and returns an object.
    assert.equal(typeof dims.width, "number");
    assert.equal(typeof dims.height, "number");
  });
});

// ---------------------------------------------------------------------------
// measurePageDimensions — nested scroll container
// ---------------------------------------------------------------------------
describe("measurePageDimensions — nested scroll container", () => {
  it("detects the nested scroll container and returns its larger dimensions", () => {
    const { win } = setupNestedScrollPage();
    const dims = win.measurePageDimensions();

    // After expansion, docHeight should have been bumped to 5000
    assert.ok(
      dims.height >= 5000,
      `Expected height >= 5000 but got ${dims.height}`
    );
    assert.ok(
      dims.width >= 1200,
      `Expected width >= 1200 but got ${dims.width}`
    );
  });

  it("expands the scroll container (overflow, height, maxHeight)", () => {
    const { win, scroller } = setupNestedScrollPage();
    win.measurePageDimensions();

    assert.equal(scroller.style.getPropertyValue("overflow"), "visible");
    assert.equal(scroller.style.height, "auto");
    assert.equal(scroller.style.maxHeight, "none");
    assert.ok(scroller.classList.contains("__screenshot-expanded__"));
  });

  it("expands ancestors with overflow:hidden", () => {
    const { win, doc } = setupNestedScrollPage();
    win.measurePageDimensions();

    // The #app div and body should both be expanded
    const expanded = doc.querySelectorAll(".__screenshot-expanded__");
    // At least 2: the scroller itself + ancestor(s) with overflow:hidden
    assert.ok(
      expanded.length >= 2,
      `Expected >= 2 expanded elements, got ${expanded.length}`
    );
  });

  it("stores original styles in data attributes for restore", () => {
    const { win, scroller } = setupNestedScrollPage();

    // Set some original inline styles before measuring
    scroller.style.setProperty("overflow", "auto");
    scroller.style.height = "100%";
    scroller.style.maxHeight = "500px";

    win.measurePageDimensions();

    assert.equal(scroller.dataset.__screenshotOldOverflow, "auto");
    assert.equal(scroller.dataset.__screenshotOldHeight, "100%");
    assert.equal(scroller.dataset.__screenshotOldMaxHeight, "500px");
  });
});

// ---------------------------------------------------------------------------
// measurePageDimensions — multiple scroll containers (picks largest)
// ---------------------------------------------------------------------------
describe("measurePageDimensions — multiple scroll containers", () => {
  it("picks the scroll container with the largest scrollHeight", () => {
    const win = createWindow(`<!DOCTYPE html>
      <html>
      <body style="overflow: hidden; margin: 0;">
        <div id="sidebar" style="overflow-y: auto; height: 100%;">
          <div style="height: 2000px;">sidebar</div>
        </div>
        <div id="main" style="overflow-y: auto; height: 100%;">
          <div style="height: 8000px;">main content</div>
        </div>
      </body>
      </html>`);

    const doc = win.document;
    const sidebar = doc.getElementById("sidebar");
    const main = doc.getElementById("main");

    // Stub document dimensions — grows to 8000 once main is expanded
    Object.defineProperty(doc.documentElement, "scrollHeight", {
      get: () =>
        main.classList.contains("__screenshot-expanded__") ? 8000 : 800,
      configurable: true,
    });
    Object.defineProperty(doc.documentElement, "scrollWidth", {
      value: 1200,
      configurable: true,
    });
    Object.defineProperty(doc.body, "scrollHeight", {
      get: () =>
        main.classList.contains("__screenshot-expanded__") ? 8000 : 800,
      configurable: true,
    });
    Object.defineProperty(doc.body, "scrollWidth", {
      value: 1200,
      configurable: true,
    });

    // Sidebar: smaller
    Object.defineProperty(sidebar, "scrollHeight", {
      value: 2000,
      configurable: true,
    });
    Object.defineProperty(sidebar, "clientHeight", {
      value: 800,
      configurable: true,
    });
    Object.defineProperty(sidebar, "scrollWidth", {
      value: 300,
      configurable: true,
    });

    // Main: larger
    Object.defineProperty(main, "scrollHeight", {
      value: 8000,
      configurable: true,
    });
    Object.defineProperty(main, "clientHeight", {
      value: 800,
      configurable: true,
    });
    Object.defineProperty(main, "scrollWidth", {
      value: 1200,
      configurable: true,
    });

    const dims = win.measurePageDimensions();

    assert.ok(
      dims.height >= 8000,
      `Expected height >= 8000 but got ${dims.height}`
    );
    // Only main should be expanded (it's the largest)
    assert.ok(main.classList.contains("__screenshot-expanded__"));
    assert.ok(!sidebar.classList.contains("__screenshot-expanded__"));
  });
});

// ---------------------------------------------------------------------------
// measurePageDimensions — modal/drawer with position:fixed parent
// ---------------------------------------------------------------------------
describe("measurePageDimensions — fixed-position modal", () => {
  function setupModalPage() {
    const win = createWindow(`<!DOCTYPE html>
      <html>
      <body style="overflow: hidden; margin: 0;">
        <div id="page-header" style="position: sticky; top: 0;">Brand Hub</div>
        <div id="page-content">background page</div>
        <div id="fixed-sidebar" style="position: fixed; top: 0; bottom: 0; left: 0; width: 232px;">sidebar</div>
        <div id="dialog" style="position: fixed; overflow: hidden; height: 100%;">
          <div id="sticky-header" style="position: sticky; top: 0;">Edit Brand Kit</div>
          <div id="modal-scroll" style="overflow-y: auto; height: 90%;">
            <div id="modal-content" style="height: 11000px;">modal content</div>
            <button id="sticky-save" style="position: sticky; bottom: 24px;">Save</button>
          </div>
        </div>
      </body>
      </html>`);

    const doc = win.document;
    const dialog = doc.getElementById("dialog");
    const modalScroll = doc.getElementById("modal-scroll");

    // Stub scrollHeight/clientHeight for the modal scroll container
    Object.defineProperty(modalScroll, "scrollHeight", {
      value: 11000,
      configurable: true,
    });
    Object.defineProperty(modalScroll, "clientHeight", {
      value: 900,
      configurable: true,
    });
    Object.defineProperty(modalScroll, "scrollWidth", {
      value: 800,
      configurable: true,
    });

    // Document scrollHeight stays small even after expansion because
    // fixed-position elements don't contribute to document flow.
    Object.defineProperty(doc.documentElement, "scrollHeight", {
      value: 980,
      configurable: true,
    });
    Object.defineProperty(doc.documentElement, "scrollWidth", {
      value: 1200,
      configurable: true,
    });
    Object.defineProperty(doc.body, "scrollHeight", {
      value: 980,
      configurable: true,
    });
    Object.defineProperty(doc.body, "scrollWidth", {
      value: 1200,
      configurable: true,
    });

    // After expansion, getBoundingClientRect on the scroll container
    // should reflect its expanded size.
    modalScroll.getBoundingClientRect = () => ({
      top: 50,
      left: 400,
      width: 800,
      height: 11000,
      bottom: 11050,
      right: 1200,
    });

    // Stub window.scrollY
    Object.defineProperty(win, "scrollY", {
      value: 0,
      configurable: true,
    });

    return { win, doc, dialog, modalScroll };
  }

  it("detects the modal scroll container and returns its full height", () => {
    const { win } = setupModalPage();
    const dims = win.measurePageDimensions();

    // Height should be at least 11050 (expandedRect.bottom + scrollY)
    // even though document.scrollHeight is only 980
    assert.ok(
      dims.height >= 11050,
      `Expected height >= 11050 but got ${dims.height}`
    );
  });

  it("expands the fixed-position dialog parent and clears bottom", () => {
    const { win, dialog } = setupModalPage();

    // Simulate a dialog constrained by top+bottom (common for drawers)
    dialog.style.top = "8px";
    dialog.style.bottom = "8px";

    win.measurePageDimensions();

    assert.ok(
      dialog.classList.contains("__screenshot-expanded__"),
      "Dialog parent should be expanded"
    );
    assert.equal(dialog.style.getPropertyValue("overflow"), "visible");
    assert.equal(dialog.style.height, "auto");
    assert.equal(
      dialog.style.bottom,
      "auto",
      "Bottom should be cleared so fixed element can grow"
    );
  });

  it("scrolls the container to top before expansion", () => {
    const { win, modalScroll } = setupModalPage();

    // Simulate the user having scrolled partway down
    modalScroll.scrollTop = 500;

    win.measurePageDimensions();

    assert.equal(
      modalScroll.scrollTop,
      0,
      "Scroll container should be scrolled to top"
    );
  });

  it("does not hide page content siblings behind the modal", () => {
    const { win, doc } = setupModalPage();
    const pageContent = doc.getElementById("page-content");

    win.measurePageDimensions();

    // Page content should remain visible — we want a normal full-page
    // screenshot with the modal expanded, not a cropped modal-only view.
    assert.ok(
      !pageContent.classList.contains("__screenshot-hidden__"),
      "Page content sibling should NOT be hidden"
    );
    assert.notEqual(pageContent.style.display, "none");
  });

  it("switches position:fixed to position:absolute on overlay ancestor", () => {
    const { win, doc, dialog } = setupModalPage();

    win.measurePageDimensions();

    assert.ok(
      dialog.classList.contains("__screenshot-repositioned__"),
      "Dialog should be marked as repositioned"
    );
    assert.equal(
      dialog.style.position,
      "absolute",
      "Fixed overlay should be switched to absolute to prevent duplication"
    );
  });

  it("restoreExpandedContainers restores position:fixed on all repositioned elements", () => {
    const { win, doc, dialog } = setupModalPage();
    const sidebar = doc.getElementById("fixed-sidebar");

    win.measurePageDimensions();
    assert.equal(dialog.style.position, "absolute");
    assert.equal(sidebar.style.position, "absolute");

    win.restoreExpandedContainers();
    assert.equal(
      dialog.style.position,
      "fixed",
      "Dialog position should be restored to fixed"
    );
    assert.equal(
      sidebar.style.position,
      "fixed",
      "Sidebar position should be restored to fixed"
    );
    assert.ok(!dialog.classList.contains("__screenshot-repositioned__"));
    assert.ok(!sidebar.classList.contains("__screenshot-repositioned__"));
  });

  it("converts ALL fixed elements to absolute (including unrelated ones like sidebar)", () => {
    const { win, doc } = setupModalPage();
    const sidebar = doc.getElementById("fixed-sidebar");

    win.measurePageDimensions();

    // ALL position:fixed elements are converted to position:absolute to
    // prevent them from spanning the full viewport when the viewport is
    // stretched for the screenshot. This includes unrelated fixed elements
    // like the sidebar.
    assert.equal(
      sidebar.style.position,
      "absolute",
      "Sidebar should be converted to position:absolute"
    );
    assert.ok(
      sidebar.classList.contains("__screenshot-repositioned__"),
      "Sidebar should be marked as repositioned"
    );
  });

  it("converts ALL fixed ancestors in the chain, not just the nearest one", () => {
    // Mimics real-world DOM: backdrop (fixed inset-0) > drawer (fixed z-drawer)
    // > scroll container. Both fixed ancestors must be converted to absolute.
    const win = createWindow(`<!DOCTYPE html>
      <html>
      <body style="overflow: hidden; margin: 0;">
        <div id="fixed-sidebar" style="position: fixed; top: 0; bottom: 0; left: 0; width: 232px;">sidebar</div>
        <div id="backdrop" style="position: fixed; top: 0; bottom: 0; left: 0; right: 0;">
          <div id="drawer" style="position: fixed; overflow: hidden; height: 100%;">
            <div id="modal-scroll" style="overflow-y: auto; height: 90%;">
              <div style="height: 11000px;">content</div>
            </div>
          </div>
        </div>
      </body>
      </html>`);

    const doc = win.document;
    const backdrop = doc.getElementById("backdrop");
    const drawer = doc.getElementById("drawer");
    const sidebar = doc.getElementById("fixed-sidebar");
    const modalScroll = doc.getElementById("modal-scroll");

    Object.defineProperty(modalScroll, "scrollHeight", { value: 11000, configurable: true });
    Object.defineProperty(modalScroll, "clientHeight", { value: 900, configurable: true });
    Object.defineProperty(modalScroll, "scrollWidth", { value: 800, configurable: true });
    Object.defineProperty(doc.documentElement, "scrollHeight", { value: 980, configurable: true });
    Object.defineProperty(doc.documentElement, "scrollWidth", { value: 1200, configurable: true });
    Object.defineProperty(doc.body, "scrollHeight", { value: 980, configurable: true });
    Object.defineProperty(doc.body, "scrollWidth", { value: 1200, configurable: true });
    modalScroll.getBoundingClientRect = () => ({
      top: 50, left: 400, width: 800, height: 11000, bottom: 11050, right: 1200,
    });
    Object.defineProperty(win, "scrollY", { value: 0, configurable: true });

    win.measurePageDimensions();

    // Both fixed ancestors should be converted
    assert.equal(backdrop.style.position, "absolute",
      "Outer backdrop should be converted to absolute");
    assert.ok(backdrop.classList.contains("__screenshot-repositioned__"));
    assert.equal(drawer.style.position, "absolute",
      "Inner drawer should be converted to absolute");
    assert.ok(drawer.classList.contains("__screenshot-repositioned__"));

    // Sidebar (not an ancestor) should ALSO be converted — all fixed elements
    // are converted to prevent viewport-spanning duplication.
    assert.equal(sidebar.style.position, "absolute",
      "Sidebar should also be converted to absolute");
    assert.ok(sidebar.classList.contains("__screenshot-repositioned__"));

    // Restore should bring all back
    win.restoreExpandedContainers();
    assert.equal(backdrop.style.position, "fixed");
    assert.equal(drawer.style.position, "fixed");
    assert.equal(sidebar.style.position, "fixed");
    assert.ok(!backdrop.classList.contains("__screenshot-repositioned__"));
    assert.ok(!drawer.classList.contains("__screenshot-repositioned__"));
    assert.ok(!sidebar.classList.contains("__screenshot-repositioned__"));
  });

  it("neutralises all position:sticky elements including outside the overlay", () => {
    const { win, doc } = setupModalPage();
    const stickyHeader = doc.getElementById("sticky-header");
    const stickySave = doc.getElementById("sticky-save");
    const pageHeader = doc.getElementById("page-header");

    win.measurePageDimensions();

    // Inside the overlay
    assert.equal(
      stickyHeader.style.position,
      "relative",
      "Sticky header should be switched to relative"
    );
    assert.ok(stickyHeader.classList.contains("__screenshot-repositioned__"));

    assert.equal(
      stickySave.style.position,
      "relative",
      "Sticky save button should be switched to relative"
    );
    assert.ok(stickySave.classList.contains("__screenshot-repositioned__"));

    // Outside the overlay (main page)
    assert.equal(
      pageHeader.style.position,
      "relative",
      "Page-level sticky header should also be switched to relative"
    );
    assert.ok(pageHeader.classList.contains("__screenshot-repositioned__"));
  });

  it("restoreExpandedContainers restores all sticky elements", () => {
    const { win, doc } = setupModalPage();
    const stickyHeader = doc.getElementById("sticky-header");
    const stickySave = doc.getElementById("sticky-save");
    const pageHeader = doc.getElementById("page-header");

    win.measurePageDimensions();
    assert.equal(stickyHeader.style.position, "relative");
    assert.equal(stickySave.style.position, "relative");
    assert.equal(pageHeader.style.position, "relative");

    win.restoreExpandedContainers();
    assert.equal(
      stickyHeader.style.position,
      "sticky",
      "Sticky header position should be restored"
    );
    assert.equal(
      stickySave.style.position,
      "sticky",
      "Sticky save button position should be restored"
    );
    assert.equal(
      pageHeader.style.position,
      "sticky",
      "Page-level sticky header should be restored"
    );
    assert.ok(!stickyHeader.classList.contains("__screenshot-repositioned__"));
    assert.ok(!stickySave.classList.contains("__screenshot-repositioned__"));
    assert.ok(!pageHeader.classList.contains("__screenshot-repositioned__"));
  });
});

// ---------------------------------------------------------------------------
// restoreExpandedContainers
// ---------------------------------------------------------------------------
describe("restoreExpandedContainers", () => {
  it("restores original styles on expanded elements", () => {
    const { win, scroller } = setupNestedScrollPage();

    // Set original styles
    scroller.style.setProperty("overflow", "auto");
    scroller.style.height = "100%";
    scroller.style.maxHeight = "";

    // Measure (which expands)
    win.measurePageDimensions();
    assert.equal(scroller.style.getPropertyValue("overflow"), "visible");

    // Restore
    win.restoreExpandedContainers();
    assert.equal(scroller.style.getPropertyValue("overflow"), "auto");
    assert.equal(scroller.style.height, "100%");
    assert.equal(scroller.style.maxHeight, "");
    assert.ok(!scroller.classList.contains("__screenshot-expanded__"));
  });

  it("removes the scrollbar-hiding style element", () => {
    const win = createWindow();
    const doc = win.document;

    // Simulate the scrollbar-hiding style being injected
    const style = doc.createElement("style");
    style.id = "__screenshot-hide-scrollbars__";
    style.textContent = "* { scrollbar-width: none !important }";
    doc.documentElement.appendChild(style);

    assert.ok(doc.getElementById("__screenshot-hide-scrollbars__"));

    win.restoreExpandedContainers();

    assert.equal(doc.getElementById("__screenshot-hide-scrollbars__"), null);
  });

  it("removes data attributes after restore", () => {
    const win = createWindow(`<!DOCTYPE html>
      <html>
      <body>
        <div id="el">content</div>
      </body>
      </html>`);

    const doc = win.document;
    const el = doc.getElementById("el");

    // Manually set up as if measurePageDimensions expanded it
    el.dataset.__screenshotOldOverflow = "auto";
    el.dataset.__screenshotOldHeight = "100%";
    el.dataset.__screenshotOldMaxHeight = "";
    el.style.overflow = "visible";
    el.style.height = "auto";
    el.style.maxHeight = "none";
    el.classList.add("__screenshot-expanded__");

    win.restoreExpandedContainers();

    assert.equal(el.dataset.__screenshotOldOverflow, undefined);
    assert.equal(el.dataset.__screenshotOldHeight, undefined);
    assert.equal(el.dataset.__screenshotOldMaxHeight, undefined);
  });

  it("restores bottom on fixed-position elements", () => {
    const win = createWindow(`<!DOCTYPE html>
      <html>
      <body>
        <div id="el" style="position: fixed; bottom: 8px;">content</div>
      </body>
      </html>`);

    const doc = win.document;
    const el = doc.getElementById("el");

    // Manually set up as if measurePageDimensions expanded it
    el.dataset.__screenshotOldOverflow = "";
    el.dataset.__screenshotOldHeight = "";
    el.dataset.__screenshotOldMaxHeight = "";
    el.dataset.__screenshotOldBottom = "8px";
    el.style.overflow = "visible";
    el.style.height = "auto";
    el.style.maxHeight = "none";
    el.style.bottom = "auto";
    el.classList.add("__screenshot-expanded__");

    win.restoreExpandedContainers();

    assert.equal(el.style.bottom, "8px");
    assert.equal(el.dataset.__screenshotOldBottom, undefined);
  });
});

// ---------------------------------------------------------------------------
// RESTRICTED_URL_PREFIXES
// ---------------------------------------------------------------------------
describe("RESTRICTED_URL_PREFIXES", () => {
  it("exports the expected list of prefixes", () => {
    const win = createWindow();
    // const bindings don't become window properties, use evaluate helper
    const prefixes = win.__evaluate("RESTRICTED_URL_PREFIXES");

    assert.ok(Array.isArray(prefixes));
    assert.ok(prefixes.includes("chrome://"));
    assert.ok(prefixes.includes("edge://"));
    assert.ok(prefixes.includes("about:"));
    assert.ok(prefixes.includes("chrome-extension://"));
    assert.ok(prefixes.includes("chrome-search://"));
    assert.ok(prefixes.includes("https://chrome.google.com/webstore"));
    assert.ok(prefixes.includes("https://chromewebstore.google.com"));
  });
});
