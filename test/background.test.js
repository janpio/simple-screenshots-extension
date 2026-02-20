const { describe, it } = require("node:test");
// Use non-strict assert because strict mode's deepStrictEqual checks object
// prototypes, which breaks when comparing objects created inside a VM context
// against literals created in the main context (Node ≥ 22).
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const backgroundSource = fs.readFileSync(
  path.join(__dirname, "..", "background.js"),
  "utf-8"
);

/**
 * Creates a VM context with a fully-mocked Chrome extension environment,
 * loads background.js into it, and returns the context along with helpers
 * for assertions.
 *
 * Options let individual tests customise mock behaviour:
 *   pageHeight / pageWidth / viewportWidth - dimensions returned by CDP mocks
 *   expandedContainerCount - value returned for __screenshot-expanded__ query
 *   nativeDPR - value returned for window.devicePixelRatio
 *   captureData - base64 string returned by Page.captureScreenshot
 *   sendCommandErrors - map of CDP method name → Error to throw
 *   runtimeEvaluateExceptions - array of { match, details } entries that make
 *     Runtime.evaluate return { exceptionDetails } when expression includes match
 *   captureVisibleTabResult - data URL returned by tabs.captureVisibleTab
 *   executeScriptResult - return value of scripting.executeScript
 *   executeScriptImpl - optional custom implementation for scripting.executeScript
 */
function createBackgroundContext(options = {}) {
  const {
    pageHeight = 3000,
    pageWidth = 1280,
    viewportWidth = 1280,
    expandedContainerCount = 0,
    nativeDPR = 1,
    captureData = "fakeBase64Data",
    sendCommandErrors = {},
    runtimeEvaluateExceptions = [],
    captureVisibleTabResult = "data:image/png;base64,visibleBase64",
    executeScriptResult = [{ result: { ok: true } }],
    executeScriptImpl = null,
  } = options;

  // --- Recording helper ---
  function mockFn(name, impl) {
    const fn = function (...args) {
      fn.calls.push(args);
      return impl ? impl(...args) : undefined;
    };
    fn.calls = [];
    fn.displayName = name;
    return fn;
  }

  // --- Build chrome mock namespace ---
  const chrome = {
    runtime: {
      onInstalled: {
        addListener: mockFn("runtime.onInstalled.addListener"),
      },
      onMessage: {
        addListener: mockFn("runtime.onMessage.addListener"),
      },
      getURL: mockFn("runtime.getURL", (p) => `chrome-extension://test/${p}`),
    },
    contextMenus: {
      create: mockFn("contextMenus.create"),
      onClicked: {
        addListener: mockFn("contextMenus.onClicked.addListener"),
      },
    },
    tabs: {
      captureVisibleTab: mockFn(
        "tabs.captureVisibleTab",
        async () => captureVisibleTabResult
      ),
      query: mockFn("tabs.query", (_query, cb) => {
        cb([{ id: 1, url: "https://example.com", windowId: 1 }]);
      }),
      get: mockFn("tabs.get", async () => ({ id: 1, windowId: 1 })),
      update: mockFn("tabs.update", async () => ({})),
    },
    windows: {
      update: mockFn("windows.update", async () => ({})),
    },
    debugger: {
      attach: mockFn("debugger.attach", async () => {}),
      detach: mockFn("debugger.detach", async () => {}),
      sendCommand: mockFn(
        "debugger.sendCommand",
        async (_debuggee, method, params) => {
          // Throw if this method is configured to error
          if (sendCommandErrors[method]) {
            throw sendCommandErrors[method];
          }

          switch (method) {
            case "Page.getLayoutMetrics":
              return {
                cssLayoutViewport: { clientWidth: viewportWidth },
              };
            case "Runtime.evaluate": {
              const expr = params?.expression || "";
              for (const ex of runtimeEvaluateExceptions) {
                if (expr.includes(ex.match)) {
                  return {
                    exceptionDetails:
                      typeof ex.details === "string"
                        ? { text: ex.details }
                        : ex.details,
                  };
                }
              }
              if (
                expr.includes("__simpleScreenshotsLibReady") &&
                expr.includes("typeof measurePageDimensions")
              ) {
                return { result: { value: false } };
              }
              if (expr.includes("JSON.stringify(measurePageDimensions())")) {
                return {
                  result: {
                    value: JSON.stringify({
                      height: pageHeight,
                      width: pageWidth,
                    }),
                  },
                };
              }
              if (expr.includes("__screenshot-expanded__")) {
                return { result: { value: expandedContainerCount } };
              }
              if (expr.includes("devicePixelRatio")) {
                return { result: { value: nativeDPR } };
              }
              // All other Runtime.evaluate calls (lib injection, scrollbar,
              // resize blocker, cleanup steps) — return benign value
              return { result: { value: undefined } };
            }
            case "Page.captureScreenshot":
              return { data: captureData };
            case "Emulation.setDeviceMetricsOverride":
            case "Emulation.clearDeviceMetricsOverride":
            case "Overlay.setShowViewportSizeOnResize":
              return {};
            default:
              return {};
          }
        }
      ),
    },
    scripting: {
      executeScript: mockFn(
        "scripting.executeScript",
        async (...args) => (
          executeScriptImpl
            ? executeScriptImpl(...args)
            : executeScriptResult
        )
      ),
    },
    action: {
      setBadgeText: mockFn("action.setBadgeText"),
      setBadgeBackgroundColor: mockFn("action.setBadgeBackgroundColor"),
    },
  };

  // --- Captured timers ---
  const timeouts = [];
  const intervals = [];

  // --- Create VM context with all required globals ---
  const context = vm.createContext({
    chrome,
    importScripts: mockFn("importScripts"), // no-op
    // Provide the real isRestrictedUrl from lib.js
    isRestrictedUrl: (() => {
      const libSource = fs.readFileSync(
        path.join(__dirname, "..", "lib.js"),
        "utf-8"
      );
      const libContext = vm.createContext({ module: { exports: {} } });
      vm.runInContext(libSource, libContext);
      return libContext.module.exports.isRestrictedUrl;
    })(),
    fetch: mockFn("fetch", async () => ({
      text: async () => "/* lib.js source */",
    })),
    setTimeout: mockFn("setTimeout", (fn, ms) => {
      const id = timeouts.length + 1;
      timeouts.push({ fn, ms, id });
      return id;
    }),
    clearTimeout: mockFn("clearTimeout"),
    setInterval: mockFn("setInterval", (fn, ms) => {
      const id = intervals.length + 1;
      intervals.push({ fn, ms, id });
      return id;
    }),
    clearInterval: mockFn("clearInterval"),
    console: {
      warn: mockFn("console.warn"),
      error: mockFn("console.error"),
      log: mockFn("console.log"),
    },
    Promise,
    JSON,
    Math,
    parseInt,
    String,
  });

  // --- Load background.js ---
  const script = new vm.Script(backgroundSource, {
    filename: "background.js",
  });
  script.runInContext(context);

  // --- Extract captured listeners ---
  const onInstalledCb =
    chrome.runtime.onInstalled.addListener.calls[0]?.[0];
  const onClickedCb =
    chrome.contextMenus.onClicked.addListener.calls[0]?.[0];
  const onMessageCb =
    chrome.runtime.onMessage.addListener.calls[0]?.[0];

  return {
    context,
    chrome,
    timeouts,
    intervals,
    listeners: { onInstalledCb, onClickedCb, onMessageCb },
    // Direct access to function declarations (hoisted, so available on context)
    captureScreenshot: context.captureScreenshot,
    captureFullPage: context.captureFullPage,
    copyToClipboard: context.copyToClipboard,
    clipboardWriteViaScript: context.clipboardWriteViaScript,
    showBadge: context.showBadge,
    showPreFlash: context.showPreFlash,
    showFlashAndPreview: context.showFlashAndPreview,
    showError: context.showError,
    removeOverlay: context.removeOverlay,
    updatePreviewLabel: context.updatePreviewLabel,
    // Access const bindings
    evaluate: (expr) => vm.runInContext(expr, context),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the CDP methods from recorded sendCommand calls. */
function cdpMethods(chrome) {
  return chrome.debugger.sendCommand.calls.map((c) => c[1]);
}

/** Find the sendCommand call for a specific CDP method. */
function cdpCall(chrome, method) {
  return chrome.debugger.sendCommand.calls.find((c) => c[1] === method);
}

/** Get all badge texts set via chrome.action.setBadgeText. */
function badgeTexts(chrome) {
  return chrome.action.setBadgeText.calls.map((c) => c[0].text);
}

function deferredPromise() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForCondition(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("Timed out waiting for test condition");
}

// ===========================================================================
// Tests
// ===========================================================================

describe("event listener registration", () => {
  it("registers onInstalled, onClicked, and onMessage listeners", () => {
    const { chrome } = createBackgroundContext();

    assert.equal(chrome.runtime.onInstalled.addListener.calls.length, 1);
    assert.equal(
      chrome.contextMenus.onClicked.addListener.calls.length,
      1
    );
    assert.equal(chrome.runtime.onMessage.addListener.calls.length, 1);
  });

  it("onInstalled creates two context menu items with correct IDs", () => {
    const { chrome, listeners } = createBackgroundContext();

    listeners.onInstalledCb();

    assert.equal(chrome.contextMenus.create.calls.length, 2);

    const [visible] = chrome.contextMenus.create.calls[0];
    assert.equal(visible.id, "screenshot-visible");
    assert.deepEqual(visible.contexts, [
      "page",
      "frame",
      "image",
      "link",
      "selection",
    ]);

    const [full] = chrome.contextMenus.create.calls[1];
    assert.equal(full.id, "screenshot-full");
  });

  it("onMessage queries the active tab and dispatches capture", () => {
    const { chrome, listeners } = createBackgroundContext();

    listeners.onMessageCb({ action: "capture", fullPage: false });

    assert.equal(chrome.tabs.query.calls.length, 1);
    const [queryInfo] = chrome.tabs.query.calls[0];
    assert.deepEqual(queryInfo, { active: true, currentWindow: true });
  });
});

describe("captureScreenshot — restricted URL guard", () => {
  it("shows error badge for chrome:// URL and does not capture", async () => {
    const { captureScreenshot, chrome } = createBackgroundContext();

    await captureScreenshot(
      { url: "chrome://extensions", id: 1, windowId: 1 },
      false
    );

    assert.deepEqual(chrome.action.setBadgeText.calls[0][0], {
      text: "✗",
    });
    assert.equal(chrome.tabs.captureVisibleTab.calls.length, 0);
    assert.equal(chrome.debugger.attach.calls.length, 0);
  });

  it("shows error badge when tab.url is null", async () => {
    const { captureScreenshot, chrome } = createBackgroundContext();

    await captureScreenshot({ url: null, id: 1, windowId: 1 }, false);

    assert.deepEqual(chrome.action.setBadgeText.calls[0][0], {
      text: "✗",
    });
  });

  it("shows error badge for Chrome Web Store URL", async () => {
    const { captureScreenshot, chrome } = createBackgroundContext();

    await captureScreenshot(
      {
        url: "https://chromewebstore.google.com/detail/xyz",
        id: 1,
        windowId: 1,
      },
      false
    );

    assert.deepEqual(chrome.action.setBadgeText.calls[0][0], {
      text: "✗",
    });
  });

  it("shows error badge when tab is undefined", async () => {
    const { captureScreenshot, chrome } = createBackgroundContext();

    await captureScreenshot(undefined, false);

    assert.deepEqual(chrome.action.setBadgeText.calls[0][0], {
      text: "✗",
    });
    assert.equal(chrome.tabs.captureVisibleTab.calls.length, 0);
    assert.equal(chrome.debugger.attach.calls.length, 0);
  });
});

describe("captureScreenshot — visible capture", () => {
  it("calls captureVisibleTab with correct windowId", async () => {
    const { captureScreenshot, chrome } = createBackgroundContext();

    await captureScreenshot(
      { url: "https://example.com", id: 1, windowId: 42 },
      false
    );

    assert.equal(chrome.tabs.captureVisibleTab.calls.length, 1);
    const [windowId, opts] = chrome.tabs.captureVisibleTab.calls[0];
    assert.equal(windowId, 42);
    assert.deepEqual(opts, { format: "png" });
  });

  it("strips data URL prefix before passing to preview", async () => {
    const { captureScreenshot, chrome } = createBackgroundContext({
      captureVisibleTabResult: "data:image/png;base64,abc123",
    });

    await captureScreenshot(
      { url: "https://example.com", id: 1, windowId: 1 },
      false
    );

    // showFlashAndPreview is called via scripting.executeScript
    // The args passed should contain the stripped base64 data
    const execCalls = chrome.scripting.executeScript.calls;
    // Find the showFlashAndPreview call (args: [b64, warning, captureId])
    const previewCall = execCalls.find(
      (c) => c[0].args && c[0].args.length === 3
    );
    assert.ok(previewCall, "showFlashAndPreview should have been called");
    assert.equal(previewCall[0].args[0], "abc123");
  });

  it("shows error badge when captureVisibleTab rejects", async () => {
    const { chrome } = createBackgroundContext();
    // Override captureVisibleTab to reject
    chrome.tabs.captureVisibleTab = async () => {
      throw new Error("tab not visible");
    };
    // Need to re-run background.js with this override — instead, call the
    // function directly from the already-loaded context
    const { captureScreenshot } = createBackgroundContext({
      captureVisibleTabResult: null, // won't matter
    });
    // Override after creation
    captureScreenshot; // not used; we need a different approach

    // Better approach: create context and manually override
    const ctx = createBackgroundContext();
    ctx.chrome.tabs.captureVisibleTab = async () => {
      throw new Error("tab not visible");
    };

    await ctx.captureScreenshot(
      { url: "https://example.com", id: 1, windowId: 1 },
      false
    );

    const texts = badgeTexts(ctx.chrome);
    assert.ok(texts.includes("✗"), "Should show error badge");
    assert.ok(
      ctx.chrome.action.setBadgeText.calls[0][0].text !== "✗",
      "First badge should be progress indicator"
    );
  });
});

describe("captureScreenshot — full page capture", () => {
  it("uses debugger path when fullPage is true", async () => {
    const { captureScreenshot, chrome } = createBackgroundContext();

    await captureScreenshot(
      { url: "https://example.com", id: 1, windowId: 1 },
      true
    );

    assert.ok(
      chrome.debugger.attach.calls.length > 0,
      "Should attach debugger for full page"
    );
    assert.equal(
      chrome.tabs.captureVisibleTab.calls.length,
      0,
      "Should not use captureVisibleTab for full page"
    );
  });

  it("shows success badge after full page capture", async () => {
    const { captureScreenshot, chrome } = createBackgroundContext();

    await captureScreenshot(
      { url: "https://example.com", id: 1, windowId: 1 },
      true
    );

    // Clipboard write runs in a non-awaited .then() — flush microtasks
    // so the success badge callback executes before we check.
    await new Promise((r) => setTimeout(r, 0));

    const texts = badgeTexts(chrome);
    assert.ok(
      texts.includes("✓"),
      "Should show success badge after capture"
    );
  });

  it("handles large base64 payload through preview/clipboard path", async () => {
    const largeBase64 = "A".repeat(1024 * 1024); // 1 MiB deterministic payload
    const { captureScreenshot, chrome } = createBackgroundContext({
      captureData: largeBase64,
    });

    await captureScreenshot(
      { url: "https://example.com", id: 1, windowId: 1 },
      true
    );

    // showFlashAndPreview call args are [base64, warning, captureId]
    const previewCall = chrome.scripting.executeScript.calls.find(
      (c) => c[0].args && c[0].args.length === 3
    );
    assert.ok(previewCall, "Preview injection call should exist");
    assert.equal(previewCall[0].args[0].length, largeBase64.length);

    // Clipboard write and success label update run in a non-awaited .then()
    await new Promise((r) => setTimeout(r, 0));
    const texts = badgeTexts(chrome);
    assert.ok(
      texts.includes("✓"),
      "Should complete success path with large payload"
    );
  });
});

describe("captureScreenshot — concurrency / latest wins", () => {
  it("drops stale full-page completion when a newer visible capture starts", async () => {
    const gate = deferredPromise();
    const ctx = createBackgroundContext();
    const originalSendCommand = ctx.chrome.debugger.sendCommand;
    let blockedFirstFullCapture = false;
    let delayedOnce = false;

    ctx.chrome.debugger.sendCommand = async (...args) => {
      const method = args[1];
      if (method === "Page.captureScreenshot" && !delayedOnce) {
        delayedOnce = true;
        blockedFirstFullCapture = true;
        await gate.promise;
      }
      return originalSendCommand(...args);
    };

    const tab = { url: "https://example.com", id: 1, windowId: 1 };
    const firstCapture = ctx.captureScreenshot(tab, true);
    await waitForCondition(() => blockedFirstFullCapture);

    await ctx.captureScreenshot(tab, false);
    await new Promise((r) => setTimeout(r, 0));

    gate.resolve();
    await firstCapture;
    await new Promise((r) => setTimeout(r, 0));

    const texts = badgeTexts(ctx.chrome);
    assert.equal(texts.filter((t) => t === "✓").length, 1);
    assert.equal(texts.includes("✗"), false);

    const previewCalls = ctx.chrome.scripting.executeScript.calls.filter((c) => {
      const args = c[0].args;
      return args && args.length === 3 && args[0] === "visibleBase64";
    });
    assert.equal(previewCalls.length, 1);

    const stalePreviewCalls = ctx.chrome.scripting.executeScript.calls.filter((c) => {
      const args = c[0].args;
      return args && args.length === 3 && args[0] === "fakeBase64Data";
    });
    assert.equal(stalePreviewCalls.length, 0);
  });

  it("ignores stale full-page failures so they do not clobber newer success UI", async () => {
    const gate = deferredPromise();
    const ctx = createBackgroundContext();
    const originalSendCommand = ctx.chrome.debugger.sendCommand;
    let blockedFirstFullCapture = false;
    let failedFirstFullCapture = false;

    ctx.chrome.debugger.sendCommand = async (...args) => {
      const method = args[1];
      if (method === "Page.captureScreenshot" && !failedFirstFullCapture) {
        failedFirstFullCapture = true;
        blockedFirstFullCapture = true;
        await gate.promise;
        throw new Error("GPU OOM");
      }
      return originalSendCommand(...args);
    };

    const tab = { url: "https://example.com", id: 1, windowId: 1 };
    const firstCapture = ctx.captureScreenshot(tab, true);
    await waitForCondition(() => blockedFirstFullCapture);

    await ctx.captureScreenshot(tab, false);
    await new Promise((r) => setTimeout(r, 0));

    gate.resolve();
    await firstCapture;
    await new Promise((r) => setTimeout(r, 0));

    const texts = badgeTexts(ctx.chrome);
    assert.equal(texts.filter((t) => t === "✓").length, 1);
    assert.equal(texts.includes("✗"), false);

    const staleCleanupCalls = ctx.chrome.scripting.executeScript.calls.filter((c) => {
      const args = c[0].args || [];
      return (
        args[0] === "__screenshot-preflash__" ||
        args[0] === "__screenshot-preview__"
      );
    });
    assert.equal(staleCleanupCalls.length, 0);
  });

  it("allows only the current capture to finalize clipboard success UI", async () => {
    const firstClipboardGate = deferredPromise();
    let firstClipboardBlocked = false;
    const ctx = createBackgroundContext({
      executeScriptImpl: async (injection) => {
        const fnSource = injection.func?.toString?.() || "";
        const isClipboardWrite = fnSource.includes("navigator.clipboard.write");
        const captureId = injection.args?.[1];

        if (isClipboardWrite && captureId === 1 && !firstClipboardBlocked) {
          firstClipboardBlocked = true;
          return firstClipboardGate.promise;
        }

        return [{ result: { ok: true } }];
      },
    });

    const tab = { url: "https://example.com", id: 1, windowId: 1 };
    await ctx.captureScreenshot(tab, false);
    await waitForCondition(() => firstClipboardBlocked);

    await ctx.captureScreenshot(tab, false);
    await new Promise((r) => setTimeout(r, 0));

    firstClipboardGate.resolve([{ result: { stale: true } }]);
    await new Promise((r) => setTimeout(r, 0));

    const texts = badgeTexts(ctx.chrome);
    assert.equal(texts.filter((t) => t === "✓").length, 1);
    assert.equal(texts.includes("✗"), false);

    const successLabelUpdates = ctx.chrome.scripting.executeScript.calls.filter((c) => {
      const args = c[0].args || [];
      return args[0] === "Copied to clipboard \u2713";
    });
    assert.equal(successLabelUpdates.length, 1);
    assert.equal(successLabelUpdates[0][0].args[3], 2);
  });
});

describe("captureFullPage — happy path", () => {
  it("attaches debugger with protocol version 1.3", async () => {
    const { captureFullPage, chrome } = createBackgroundContext();

    await captureFullPage({ id: 1 });

    assert.equal(chrome.debugger.attach.calls.length, 1);
    const [debuggee, version] = chrome.debugger.attach.calls[0];
    assert.deepEqual(debuggee, { tabId: 1 });
    assert.equal(version, "1.3");
  });

  it("sends CDP commands in correct order", async () => {
    const { captureFullPage, chrome } = createBackgroundContext();

    await captureFullPage({ id: 1 });

    const methods = cdpMethods(chrome);
    // Main sequence (before cleanup)
    assert.equal(methods[0], "Page.getLayoutMetrics");
    assert.equal(methods[1], "Runtime.evaluate"); // injected helpers check
    assert.equal(methods[2], "Runtime.evaluate"); // inject lib.js
    assert.equal(methods[3], "Runtime.evaluate"); // mark injected helpers
    assert.equal(methods[4], "Runtime.evaluate"); // measurePageDimensions
    assert.equal(methods[5], "Runtime.evaluate"); // expanded count
    assert.equal(methods[6], "Runtime.evaluate"); // devicePixelRatio
    assert.equal(methods[7], "Runtime.evaluate"); // scrollbar hiding
    assert.equal(methods[8], "Overlay.setShowViewportSizeOnResize");
    assert.equal(methods[9], "Runtime.evaluate"); // resize blocker
    assert.equal(methods[10], "Emulation.setDeviceMetricsOverride");
    assert.equal(methods[11], "Page.captureScreenshot");
    // Cleanup
    assert.equal(methods[12], "Emulation.clearDeviceMetricsOverride");
  });

  it("returns { data, warning } object", async () => {
    const { captureFullPage } = createBackgroundContext({
      captureData: "myBase64",
    });

    const result = await captureFullPage({ id: 1 });

    assert.equal(result.data, "myBase64");
    assert.equal(result.warning, null);
  });

  it("captures with clip matching clamped dimensions", async () => {
    const { captureFullPage, chrome } = createBackgroundContext({
      pageHeight: 5000,
      viewportWidth: 1280,
    });

    await captureFullPage({ id: 1 });

    const screenshotCall = cdpCall(chrome, "Page.captureScreenshot");
    assert.ok(screenshotCall);
    const params = screenshotCall[2];
    assert.equal(params.format, "png");
    assert.deepEqual(params.clip, {
      x: 0,
      y: 0,
      width: 1280,
      height: 5000,
      scale: 1,
    });
  });
});

describe("captureFullPage — DPR strategy", () => {
  it("uses deviceScaleFactor 0 when no expanded containers and page fits", async () => {
    const { captureFullPage, chrome } = createBackgroundContext({
      expandedContainerCount: 0,
      nativeDPR: 1,
      pageHeight: 3000,
    });

    await captureFullPage({ id: 1 });

    const emulationCall = cdpCall(chrome, "Emulation.setDeviceMetricsOverride");
    assert.equal(emulationCall[2].deviceScaleFactor, 0);
  });

  it("uses deviceScaleFactor 1 when expanded containers exist", async () => {
    const { captureFullPage, chrome } = createBackgroundContext({
      expandedContainerCount: 2,
      nativeDPR: 1,
      pageHeight: 3000,
    });

    await captureFullPage({ id: 1 });

    const emulationCall = cdpCall(chrome, "Emulation.setDeviceMetricsOverride");
    assert.equal(emulationCall[2].deviceScaleFactor, 1);
  });

  it("uses deviceScaleFactor 1 when physical height exceeds GPU limit", async () => {
    const { captureFullPage, chrome } = createBackgroundContext({
      expandedContainerCount: 0,
      nativeDPR: 2, // 9000 * 2 = 18000 > 16384
      pageHeight: 9000,
    });

    await captureFullPage({ id: 1 });

    const emulationCall = cdpCall(chrome, "Emulation.setDeviceMetricsOverride");
    assert.equal(emulationCall[2].deviceScaleFactor, 1);
  });
});

describe("captureFullPage — dimension clamping", () => {
  it("clamps viewport width to MAX_CAPTURE_WIDTH (10000)", async () => {
    const { captureFullPage, chrome } = createBackgroundContext({
      viewportWidth: 15000,
    });

    await captureFullPage({ id: 1 });

    const emulationCall = cdpCall(chrome, "Emulation.setDeviceMetricsOverride");
    assert.equal(emulationCall[2].width, 10000);

    const screenshotCall = cdpCall(chrome, "Page.captureScreenshot");
    assert.equal(screenshotCall[2].clip.width, 10000);
  });

  it("clamps height minimum to 1", async () => {
    const { captureFullPage, chrome } = createBackgroundContext({
      pageHeight: 0,
    });

    await captureFullPage({ id: 1 });

    const emulationCall = cdpCall(chrome, "Emulation.setDeviceMetricsOverride");
    assert.equal(emulationCall[2].height, 1);
  });
});

describe("captureFullPage — warnings", () => {
  it("returns tiling warning when height exceeds GPU_TEXTURE_LIMIT", async () => {
    const { captureFullPage } = createBackgroundContext({
      pageHeight: 20000,
      nativeDPR: 1,
    });

    const result = await captureFullPage({ id: 1 });

    assert.ok(result.warning);
    assert.ok(result.warning.includes("repeating"));
  });

  it("returns DPR fallback warning when page is too tall for native DPR", async () => {
    const { captureFullPage } = createBackgroundContext({
      pageHeight: 9000,
      nativeDPR: 2, // 9000 * 2 = 18000 > 16384
    });

    const result = await captureFullPage({ id: 1 });

    assert.ok(result.warning);
    assert.ok(result.warning.includes("reduced resolution"));
  });

  it("returns null warning when page is within limits", async () => {
    const { captureFullPage } = createBackgroundContext({
      pageHeight: 3000,
      nativeDPR: 1,
    });

    const result = await captureFullPage({ id: 1 });

    assert.equal(result.warning, null);
  });
});

describe("captureFullPage — large page stress", () => {
  it("handles 50k page height with deterministic fallback behavior", async () => {
    const { captureFullPage, chrome } = createBackgroundContext({
      pageHeight: 50000,
      nativeDPR: 2,
    });

    const result = await captureFullPage({ id: 1 });

    assert.equal(result.data, "fakeBase64Data");
    assert.ok(result.warning, "Should return a warning for very tall pages");
    assert.ok(
      result.warning.includes("repeating/tiled sections"),
      "Should include tall-page tiling warning text"
    );

    const emulationCall = cdpCall(chrome, "Emulation.setDeviceMetricsOverride");
    assert.ok(emulationCall, "Should set emulation metrics");
    assert.equal(emulationCall[2].height, 50000);
    assert.equal(emulationCall[2].deviceScaleFactor, 1);

    const screenshotCall = cdpCall(chrome, "Page.captureScreenshot");
    assert.ok(screenshotCall, "Should capture screenshot");
    assert.equal(screenshotCall[2].clip.height, 50000);

    assert.ok(
      chrome.debugger.detach.calls.length > 0,
      "Should detach debugger after large-page capture"
    );
  });
});

describe("captureFullPage — cleanup on error", () => {
  it("detaches debugger even when Page.captureScreenshot fails", async () => {
    const { captureFullPage, chrome } = createBackgroundContext({
      sendCommandErrors: {
        "Page.captureScreenshot": new Error("GPU OOM"),
      },
    });

    await assert.rejects(() => captureFullPage({ id: 1 }));

    assert.ok(
      chrome.debugger.detach.calls.length > 0,
      "Should still detach debugger"
    );
    // Verify cleanup commands were issued
    const methods = cdpMethods(chrome);
    assert.ok(
      methods.includes("Emulation.clearDeviceMetricsOverride"),
      "Should clear emulation override"
    );
  });

  it("skips all cleanup if debugger.attach fails", async () => {
    const { chrome } = createBackgroundContext();
    // Override attach to reject
    chrome.debugger.attach = async () => {
      throw new Error("Another debugger attached");
    };
    // Need a fresh context with failing attach
    const ctx = createBackgroundContext();
    ctx.chrome.debugger.attach = async () => {
      throw new Error("Another debugger attached");
    };

    await assert.rejects(() => ctx.captureFullPage({ id: 1 }));

    assert.equal(
      ctx.chrome.debugger.detach.calls.length,
      0,
      "Should not attempt detach if never attached"
    );
    // sendCommand should only have been called 0 times (not even cleanup)
    assert.equal(
      ctx.chrome.debugger.sendCommand.calls.length,
      0,
      "Should not send any CDP commands if attach failed"
    );
  });

  it("continues cleanup when clearDeviceMetricsOverride fails", async () => {
    const { captureFullPage, chrome } = createBackgroundContext({
      sendCommandErrors: {
        "Emulation.clearDeviceMetricsOverride": new Error("fail"),
      },
    });

    // captureScreenshot still succeeds because the error is in cleanup
    const result = await captureFullPage({ id: 1 });
    assert.equal(result.data, "fakeBase64Data");

    // Despite clearDeviceMetricsOverride failing, detach should still run
    assert.ok(
      chrome.debugger.detach.calls.length > 0,
      "Should still detach debugger after cleanup error"
    );
  });
});

describe("captureFullPage — Overlay suppression", () => {
  it("continues capture when Overlay domain is unavailable", async () => {
    const { captureFullPage } = createBackgroundContext({
      sendCommandErrors: {
        "Overlay.setShowViewportSizeOnResize": new Error("unsupported"),
      },
    });

    const result = await captureFullPage({ id: 1 });

    assert.equal(result.data, "fakeBase64Data");
  });
});

describe("captureFullPage — Runtime.evaluate exceptionDetails", () => {
  it("throws clear error when lib.js injection evaluate reports exceptionDetails", async () => {
    const { captureFullPage, chrome } = createBackgroundContext({
      runtimeEvaluateExceptions: [
        {
          match: "lib.js source",
          details: {
            text: "SyntaxError: Unexpected token",
            lineNumber: 0,
            columnNumber: 9,
          },
        },
      ],
    });

    await assert.rejects(
      () => captureFullPage({ id: 1 }),
      /Injecting lib\.js into target page failed: SyntaxError: Unexpected token \(line 1, col 10\)/
    );
    assert.ok(
      chrome.debugger.detach.calls.length > 0,
      "Should detach debugger when Runtime.evaluate returns exceptionDetails"
    );
  });

  it("throws clear error when measurePageDimensions evaluate reports exceptionDetails", async () => {
    const { captureFullPage, chrome } = createBackgroundContext({
      runtimeEvaluateExceptions: [
        {
          match: "JSON.stringify(measurePageDimensions())",
          details: "ReferenceError: measurePageDimensions is not defined",
        },
      ],
    });

    await assert.rejects(
      () => captureFullPage({ id: 1 }),
      /Measuring page dimensions failed: ReferenceError: measurePageDimensions is not defined/
    );
    assert.ok(
      chrome.debugger.detach.calls.length > 0,
      "Should detach debugger when measurePageDimensions evaluate fails"
    );
  });
});

describe("clipboardWriteViaScript", () => {
  it("injects script targeting the correct tab", async () => {
    const { clipboardWriteViaScript, chrome } = createBackgroundContext();

    await clipboardWriteViaScript(42, "base64data");

    assert.equal(chrome.scripting.executeScript.calls.length, 1);
    const [injection] = chrome.scripting.executeScript.calls[0];
    assert.deepEqual(injection.target, { tabId: 42 });
  });

  it("passes base64 data as script argument", async () => {
    const { clipboardWriteViaScript, chrome } = createBackgroundContext();

    await clipboardWriteViaScript(1, "myBase64");

    const [injection] = chrome.scripting.executeScript.calls[0];
    assert.deepEqual(injection.args, ["myBase64", null]);
  });

  it("throws when injected script returns undefined result", async () => {
    const { clipboardWriteViaScript } = createBackgroundContext({
      executeScriptResult: [{ result: undefined }],
    });

    await assert.rejects(
      () => clipboardWriteViaScript(1, "data"),
      { message: "Clipboard write did not complete successfully" }
    );
  });

  it("returns stale marker when injected script reports stale capture", async () => {
    const { clipboardWriteViaScript } = createBackgroundContext({
      executeScriptResult: [{ result: { stale: true } }],
    });

    const result = await clipboardWriteViaScript(1, "data", 7);
    assert.deepEqual(result, { stale: true });
  });
});

describe("showBadge", () => {
  it("sets badge text and background color", () => {
    const { showBadge, chrome } = createBackgroundContext();

    showBadge("✓", "#22c55e");

    assert.deepEqual(chrome.action.setBadgeText.calls[0][0], {
      text: "✓",
    });
    assert.deepEqual(chrome.action.setBadgeBackgroundColor.calls[0][0], {
      color: "#22c55e",
    });
  });

  it("schedules badge clear after 2 seconds for non-progress text", () => {
    const { showBadge, timeouts } = createBackgroundContext();

    showBadge("✓", "#22c55e");

    assert.ok(timeouts.length > 0, "Should schedule a timeout");
    const clearTimeout = timeouts.find((t) => t.ms === 2000);
    assert.ok(clearTimeout, "Should schedule 2000ms timeout");
  });

  it("starts pulse animation for progress indicator", () => {
    const { showBadge, intervals } = createBackgroundContext();

    showBadge("...", "#6b7280");

    assert.ok(intervals.length > 0, "Should start interval for pulse");
    assert.equal(intervals[0].ms, 500);
  });
});

describe("showPreFlash", () => {
  it("injects script targeting the correct tab", () => {
    const { showPreFlash, chrome } = createBackgroundContext();

    showPreFlash(42);

    assert.equal(chrome.scripting.executeScript.calls.length, 1);
    const [injection] = chrome.scripting.executeScript.calls[0];
    assert.deepEqual(injection.target, { tabId: 42 });
  });
});

describe("showFlashAndPreview", () => {
  it("injects script with base64 data and warning", () => {
    const { showFlashAndPreview, chrome } = createBackgroundContext();

    showFlashAndPreview(1, "imgData", "some warning");

    assert.equal(chrome.scripting.executeScript.calls.length, 1);
    const [injection] = chrome.scripting.executeScript.calls[0];
    assert.deepEqual(injection.target, { tabId: 1 });
    assert.equal(injection.args[0], "imgData");
    assert.equal(injection.args[1], "some warning");
    assert.equal(injection.args[2], null);
  });

  it("passes null warning when not provided", () => {
    const { showFlashAndPreview, chrome } = createBackgroundContext();

    showFlashAndPreview(1, "imgData", null);

    const [injection] = chrome.scripting.executeScript.calls[0];
    assert.equal(injection.args[1], null);
  });

  it("passes capture ID when provided", () => {
    const { showFlashAndPreview, chrome } = createBackgroundContext();

    showFlashAndPreview(1, "imgData", null, 42);

    const [injection] = chrome.scripting.executeScript.calls[0];
    assert.equal(injection.args[2], 42);
  });

  it("removes document keydown listener inside dismiss helper", () => {
    const { showFlashAndPreview, chrome } = createBackgroundContext();

    showFlashAndPreview(1, "imgData", null);

    const [injection] = chrome.scripting.executeScript.calls[0];
    const fnSource = injection.func.toString();
    assert.match(
      fnSource,
      /function dismiss\(\)\s*\{[\s\S]*document\.removeEventListener\("keydown", onKey\);/
    );
  });
});

describe("removeOverlay", () => {
  it("injects script to remove element by ID", () => {
    const { removeOverlay, chrome } = createBackgroundContext();

    removeOverlay(1, "__screenshot-preview__");

    assert.equal(chrome.scripting.executeScript.calls.length, 1);
    const [injection] = chrome.scripting.executeScript.calls[0];
    assert.deepEqual(injection.target, { tabId: 1 });
    assert.deepEqual(injection.args, ["__screenshot-preview__"]);
  });
});

describe("showError", () => {
  it("injects error toast script targeting correct tab", () => {
    const { showError, chrome } = createBackgroundContext();

    showError(1, "Something went wrong");

    assert.equal(chrome.scripting.executeScript.calls.length, 1);
    const [injection] = chrome.scripting.executeScript.calls[0];
    assert.deepEqual(injection.target, { tabId: 1 });
    assert.deepEqual(injection.args, ["Something went wrong"]);
  });
});
