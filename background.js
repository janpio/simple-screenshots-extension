// Load shared utilities (isRestrictedUrl, etc.)
importScripts("lib.js");

// Create context menu items on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "screenshot-visible",
    title: "📷 Screenshot visible area",
    contexts: ["page", "frame", "image", "link", "selection"]
  });
  chrome.contextMenus.create({
    id: "screenshot-full",
    title: "📄 Screenshot full page",
    contexts: ["page", "frame", "image", "link", "selection"]
  });
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "screenshot-visible") {
    captureScreenshot(tab, false);
  } else if (info.menuItemId === "screenshot-full") {
    captureScreenshot(tab, true);
  }
});

// Handle messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "capture") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        captureScreenshot(tabs[0], msg.fullPage);
      }
    });
  } else if (msg.action === "debug-expand") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs[0]) return;
      const tabId = tabs[0].id;
      const debuggee = { tabId };
      try {
        await chrome.debugger.attach(debuggee, "1.3");

        // Get original viewport dimensions (same as captureFullPage)
        const metrics = await chrome.debugger.sendCommand(
          debuggee, "Page.getLayoutMetrics"
        );
        const viewportWidth = Math.ceil(metrics.cssLayoutViewport.clientWidth);
        const viewportHeight = Math.ceil(metrics.cssLayoutViewport.clientHeight);

        // Inject lib.js
        await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
          expression: await fetch(chrome.runtime.getURL("lib.js")).then(r => r.text()),
          returnByValue: true
        });

        // Measure + expand (same as captureFullPage)
        const { result } = await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
          expression: `JSON.stringify(measurePageDimensions())`,
          returnByValue: true
        });
        const dims = JSON.parse(result.value);

        // Skip scrollbar hiding in debug mode. Instead, force overflow:auto
        // on html+body so we get a scrollbar for inspecting the tall content.
        // (captureFullPage uses overflow:visible + hidden scrollbars, but for
        // debug we need to be able to scroll.)
        await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
          expression: `
            document.documentElement.style.setProperty('overflow', 'auto', 'important');
            document.body.style.setProperty('overflow', 'auto', 'important');
          `,
          returnByValue: true
        });

        // Suppress viewport size overlay
        try {
          await chrome.debugger.sendCommand(debuggee,
            "Overlay.setShowViewportSizeOnResize", { show: false }
          );
        } catch (_) {}

        // Block resize / ResizeObserver (same as captureFullPage)
        await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
          expression: `(() => {
            window.__screenshotResizeBlocker = (e) => {
              e.stopImmediatePropagation();
            };
            window.addEventListener('resize', window.__screenshotResizeBlocker, true);
            if (window.ResizeObserver) {
              window.__screenshotOrigResizeObserver = window.ResizeObserver;
              window.ResizeObserver = class {
                constructor() {}
                observe() {}
                unobserve() {}
                disconnect() {}
              };
            }
          })()`,
          returnByValue: true
        });

        // setDeviceMetricsOverride — use the ORIGINAL viewport height so
        // you can still scroll to inspect. The DOM changes are identical
        // to captureFullPage; only the viewport height differs (capture
        // uses dims.height). This triggers resize events and re-layout
        // even at the original size, reproducing the framework interference
        // that the resize blocker must handle.
        await chrome.debugger.sendCommand(debuggee,
          "Emulation.setDeviceMetricsOverride", {
            width: viewportWidth,
            height: viewportHeight,
            deviceScaleFactor: 1,  // Force DPR=1 to match capture path
            mobile: false
          }
        );

        // Keep debugger attached so user can scroll and inspect
        sendResponse({ dims });
      } catch (err) {
        console.error("debug-expand error:", err);
        try { await chrome.debugger.detach(debuggee); } catch (_) {}
        sendResponse({ error: err.message });
      }
    });
    return true; // async sendResponse
  } else if (msg.action === "debug-restore") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs[0]) return;
      const tabId = tabs[0].id;
      const debuggee = { tabId };
      try {
        // Clear viewport override
        await chrome.debugger.sendCommand(debuggee,
          "Emulation.clearDeviceMetricsOverride"
        );

        // Restore resize / ResizeObserver
        await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
          expression: `(() => {
            if (window.__screenshotResizeBlocker) {
              window.removeEventListener('resize', window.__screenshotResizeBlocker, true);
              delete window.__screenshotResizeBlocker;
            }
            if (window.__screenshotOrigResizeObserver) {
              window.ResizeObserver = window.__screenshotOrigResizeObserver;
              delete window.__screenshotOrigResizeObserver;
            }
          })()`,
          returnByValue: true
        });

        // Restore expanded containers + scrollbar style + debug overflow
        await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
          expression: `
            document.documentElement.style.removeProperty('overflow');
            document.body.style.removeProperty('overflow');
            restoreExpandedContainers()
          `,
          returnByValue: true
        });

        await chrome.debugger.detach(debuggee);
      } catch (err) {
        console.error("debug-restore error:", err);
        try { await chrome.debugger.detach(debuggee); } catch (_) {}
      }
      sendResponse({});
    });
    return true; // async sendResponse
  }
});

async function captureScreenshot(tab, fullPage) {
  if (!tab.url || isRestrictedUrl(tab.url)) {
    showBadge("✗", "#ef4444");
    console.warn("Cannot capture screenshot on restricted page:", tab.url);
    return;
  }

  showBadge("...", "#6b7280");

  try {
    let base64Data;

    if (fullPage) {
      base64Data = await captureFullPage(tab);
    } else {
      // Use the simple captureVisibleTab API — no debugger needed.
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "png"
      });
      base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");
    }

    await copyToClipboard(tab.id, base64Data);
    showBadge("✓", "#22c55e");
    showPreview(tab.id, base64Data);
  } catch (err) {
    console.error("Screenshot error:", err);
    showBadge("✗", "#ef4444");
  }
}

async function captureFullPage(tab) {
  const tabId = tab.id;
  const debuggee = { tabId };

  try {
    await chrome.debugger.attach(debuggee, "1.3");

    // Get the current viewport width
    const metrics = await chrome.debugger.sendCommand(
      debuggee,
      "Page.getLayoutMetrics"
    );
    const viewportWidth = Math.ceil(metrics.cssLayoutViewport.clientWidth);

    // Inject lib.js into the page so measurePageDimensions is available
    await chrome.debugger.sendCommand(
      debuggee,
      "Runtime.evaluate",
      {
        expression: await fetch(chrome.runtime.getURL("lib.js")).then((r) =>
          r.text()
        ),
        returnByValue: true
      }
    );

    // Measure the true scrollable content height.
    // This also detects and expands nested scroll containers (SPAs, etc.).
    const { result: dims } = await chrome.debugger.sendCommand(
      debuggee,
      "Runtime.evaluate",
      {
        expression: `JSON.stringify(measurePageDimensions())`,
        returnByValue: true
      }
    );
    const { width, height } = JSON.parse(dims.value);

    // Hide scrollbars so they don't leave a grey strip in the capture
    await chrome.debugger.sendCommand(
      debuggee,
      "Runtime.evaluate",
      {
        expression: `(() => {
          const s = document.createElement('style');
          s.id = '__screenshot-hide-scrollbars__';
          s.textContent = '*::-webkit-scrollbar { display: none !important } * { scrollbar-width: none !important }';
          document.documentElement.appendChild(s);
        })()`,
        returnByValue: true
      }
    );

    // Suppress the "viewport size" overlay Chrome shows during emulation.
    // This is cosmetic-only, so ignore errors (the Overlay domain may not
    // be available in every Chrome build).
    try {
      await chrome.debugger.sendCommand(
        debuggee,
        "Overlay.setShowViewportSizeOnResize",
        { show: false }
      );
    } catch (_) {}

    // Block resize / ResizeObserver events so that setDeviceMetricsOverride
    // doesn't trigger framework re-renders that undo our DOM changes.
    // SPA frameworks (React, etc.) listen for resize events and may restore
    // position:fixed, overflow:hidden, and position:sticky — undoing the
    // expansion and repositioning done by measurePageDimensions().
    await chrome.debugger.sendCommand(
      debuggee,
      "Runtime.evaluate",
      {
        expression: `(() => {
          window.__screenshotResizeBlocker = (e) => {
            e.stopImmediatePropagation();
          };
          window.addEventListener('resize', window.__screenshotResizeBlocker, true);

          // Also suppress ResizeObserver callbacks — many frameworks use
          // these instead of (or alongside) the resize event.
          if (window.ResizeObserver) {
            window.__screenshotOrigResizeObserver = window.ResizeObserver;
            const Orig = window.ResizeObserver;
            window.ResizeObserver = class {
              constructor() {}
              observe() {}
              unobserve() {}
              disconnect() {}
            };
            // Disconnect existing observers by patching the prototype
            // temporarily — new observers created during resize will be no-ops.
          }
        })()`,
        returnByValue: true
      }
    );

    // Set viewport to exact content height with DPR=1.
    // DPR must be forced to 1 to avoid Chrome GPU texture limits (16384px).
    // At 150% Windows scaling (DPR=1.5), an 11000px page becomes 16500
    // physical pixels — exceeding the limit and causing Chrome's compositor
    // to tile/repeat the rendered content.
    await chrome.debugger.sendCommand(
      debuggee,
      "Emulation.setDeviceMetricsOverride",
      {
        width: viewportWidth,
        height: height,
        deviceScaleFactor: 1,
        mobile: false
      }
    );

    // Capture with a clip rect matching the exact content dimensions
    const result = await chrome.debugger.sendCommand(
      debuggee,
      "Page.captureScreenshot",
      {
        format: "png",
        clip: { x: 0, y: 0, width: viewportWidth, height: height, scale: 1 }
      }
    );

    // Clear the emulation override (restores original viewport)
    await chrome.debugger.sendCommand(
      debuggee,
      "Emulation.clearDeviceMetricsOverride"
    );

    // Restore resize / ResizeObserver handling before restoring containers,
    // so the framework can respond normally to subsequent layout changes.
    await chrome.debugger.sendCommand(
      debuggee,
      "Runtime.evaluate",
      {
        expression: `(() => {
          if (window.__screenshotResizeBlocker) {
            window.removeEventListener('resize', window.__screenshotResizeBlocker, true);
            delete window.__screenshotResizeBlocker;
          }
          if (window.__screenshotOrigResizeObserver) {
            window.ResizeObserver = window.__screenshotOrigResizeObserver;
            delete window.__screenshotOrigResizeObserver;
          }
        })()`,
        returnByValue: true
      }
    );

    // Clean up: remove scrollbar-hiding style and restore expanded containers
    await chrome.debugger.sendCommand(
      debuggee,
      "Runtime.evaluate",
      {
        expression: `restoreExpandedContainers()`,
        returnByValue: true
      }
    );

    // Detach immediately — this also restores the viewport.
    await chrome.debugger.detach(debuggee);
    return result.data;
  } catch (err) {
    try { await chrome.debugger.detach(debuggee); } catch (_) {}
    throw err;
  }
}

async function copyToClipboard(tabId, base64Data) {
  // Focus the window and tab so the page has clipboard access
  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tabId, { active: true });

  // Inject a content script that writes the PNG to the clipboard.
  // chrome.scripting.executeScript awaits the returned promise from async funcs.
  await chrome.scripting.executeScript({
    target: { tabId },
    func: async (b64) => {
      const res = await fetch(`data:image/png;base64,${b64}`);
      const blob = await res.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob })
      ]);
    },
    args: [base64Data]
  });
}

function showBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2000);
}

function showPreview(tabId, base64Data) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: (b64) => {
      // Remove any existing preview
      document.getElementById("__screenshot-preview__")?.remove();

      const FADE_TIMEOUT = 4000; // ms before auto-fade starts
      let timer = null;

      // --- Backdrop ---
      const backdrop = document.createElement("div");
      backdrop.id = "__screenshot-preview__";
      backdrop.style.cssText = `
        position: fixed; inset: 0; z-index: 2147483647;
        background: rgba(0,0,0,0.5); cursor: not-allowed;
        display: flex; align-items: flex-start; justify-content: flex-end;
        padding: 12px;
        opacity: 0; transition: opacity 0.2s ease-out;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      `;

      // --- Panel (minimap-style, right side) ---
      const panel = document.createElement("div");
      panel.style.cssText = `
        background: #1a1a1a; border-radius: 8px; cursor: default;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        display: flex; flex-direction: column;
        max-height: calc(100vh - 24px);
        width: 460px; overflow: hidden;
      `;

      // --- Label ---
      const label = document.createElement("div");
      label.style.cssText = `
        color: #4ade80; font-size: 12px; font-weight: 500;
        padding: 8px 12px; flex-shrink: 0;
        border-bottom: 1px solid rgba(255,255,255,0.1);
        display: flex; justify-content: space-between; align-items: center;
      `;
      const labelText = document.createElement("span");
      labelText.textContent = "Copied to clipboard \u2713";
      const labelDims = document.createElement("span");
      labelDims.style.cssText = "color: #9ca3af; font-size: 11px; font-weight: 400;";
      labelDims.textContent = "loading\u2026";
      label.appendChild(labelText);
      label.appendChild(labelDims);

      // --- Scrollable image container ---
      const imgWrap = document.createElement("div");
      imgWrap.tabIndex = -1; // allow focus for immediate scroll
      imgWrap.style.cssText = `
        overflow-y: auto; overflow-x: hidden;
        flex: 1; min-height: 0; outline: none;
      `;

      const img = document.createElement("img");
      img.src = `data:image/png;base64,${b64}`;
      img.style.cssText = `
        display: block; width: 100%;
        border-radius: 0 0 8px 8px;
      `;
      img.addEventListener("load", () => {
        labelDims.textContent = `${img.naturalWidth} \u00d7 ${img.naturalHeight} px`;
      });

      imgWrap.appendChild(img);
      panel.appendChild(label);
      panel.appendChild(imgWrap);
      backdrop.appendChild(panel);
      document.documentElement.appendChild(backdrop);

      // Fade in and focus the scroll area so it responds to wheel immediately
      requestAnimationFrame(() => {
        backdrop.style.opacity = "1";
        imgWrap.focus();
      });

      // --- Dismiss helpers ---
      function dismiss() {
        clearTimeout(timer);
        backdrop.style.opacity = "0";
        backdrop.addEventListener("transitionend", () => backdrop.remove(), { once: true });
      }

      function resetTimer() {
        clearTimeout(timer);
        timer = setTimeout(dismiss, FADE_TIMEOUT);
      }

      // --- Events ---
      // Block all pointer events from reaching the page beneath
      for (const evt of ["click", "mousedown", "mouseup", "pointerdown", "pointerup"]) {
        backdrop.addEventListener(evt, (e) => {
          e.stopPropagation();
          // Click on backdrop (outside panel) → dismiss
          if (evt === "click" && e.target === backdrop) dismiss();
        }, true);
      }

      // Escape → dismiss
      function onKey(e) {
        if (e.key === "Escape") {
          dismiss();
          document.removeEventListener("keydown", onKey);
        }
      }
      document.addEventListener("keydown", onKey);

      // Scroll anywhere on the panel → scroll the image container
      // (prevents needing to click into the panel first)
      panel.addEventListener("wheel", (e) => {
        e.preventDefault();
        imgWrap.scrollTop += e.deltaY;
      }, { passive: false });

      // Hover panel → pause timer; leave → restart
      panel.addEventListener("mouseenter", () => clearTimeout(timer));
      panel.addEventListener("mouseleave", resetTimer);

      // Start auto-dismiss timer
      resetTimer();
    },
    args: [base64Data]
  }).catch(() => {}); // ignore errors on restricted pages
}
