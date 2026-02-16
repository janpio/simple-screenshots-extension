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
