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
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "capture") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        captureScreenshot(tabs[0], msg.fullPage);
      }
    });
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

// Maximum dimensions to prevent Chrome from hanging on extreme pages.
// Width: 10000px covers ultra-wide monitors. Height: 16000px stays under
// Chrome's GPU texture limit (16384px) at DPR=1.
const MAX_CAPTURE_WIDTH = 10000;
const MAX_CAPTURE_HEIGHT = 16000;

async function captureFullPage(tab) {
  const tabId = tab.id;
  const debuggee = { tabId };
  let attached = false;

  try {
    await chrome.debugger.attach(debuggee, "1.3");
    attached = true;

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
    let { height } = JSON.parse(dims.value);

    // Check whether measurePageDimensions found and expanded a nested
    // scroll container (modal/drawer case). This determines DPR strategy.
    const { result: expandedResult } = await chrome.debugger.sendCommand(
      debuggee,
      "Runtime.evaluate",
      {
        expression: `document.querySelectorAll('.__screenshot-expanded__').length`,
        returnByValue: true
      }
    );
    const hasExpandedContainers = expandedResult.value > 0;

    // Clamp dimensions to safe ranges
    // Clamp height to safe capture range (width comes from viewport, not DOM measurement)
    height = Math.min(Math.max(height, 1), MAX_CAPTURE_HEIGHT);
    const captureWidth = Math.min(viewportWidth, MAX_CAPTURE_WIDTH);

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
            window.ResizeObserver = class {
              constructor() {}
              observe() {}
              unobserve() {}
              disconnect() {}
            };
          }
        })()`,
        returnByValue: true
      }
    );

    // Set viewport to exact content height.
    // For complex pages (expanded scroll containers / modals / drawers),
    // force DPR=1 to avoid Chrome's GPU texture limit (16384px). At 150%
    // Windows scaling (DPR=1.5), an 11000px page becomes 16500 physical
    // pixels — exceeding the limit and causing Chrome to tile the content.
    // For simple pages, keep the browser's native DPR (0) for sharp output.
    const dpr = hasExpandedContainers ? 1 : 0;
    await chrome.debugger.sendCommand(
      debuggee,
      "Emulation.setDeviceMetricsOverride",
      {
        width: captureWidth,
        height: height,
        deviceScaleFactor: dpr,
        mobile: false
      }
    );

    // Capture with a clip rect matching the exact content dimensions.
    // scale=1 means "capture at the current DPR", not "force 1x".
    const result = await chrome.debugger.sendCommand(
      debuggee,
      "Page.captureScreenshot",
      {
        format: "png",
        clip: { x: 0, y: 0, width: captureWidth, height: height, scale: 1 }
      }
    );

    return result.data;
  } finally {
    // Guarantee cleanup runs regardless of where a failure occurred.
    // Each step is wrapped individually so a failure in one doesn't
    // prevent the others from running.
    if (attached) {
      try {
        await chrome.debugger.sendCommand(
          debuggee,
          "Emulation.clearDeviceMetricsOverride"
        );
      } catch (_) {}

      try {
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
      } catch (_) {}

      try {
        await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
          expression: `typeof restoreExpandedContainers === 'function' && restoreExpandedContainers()`,
          returnByValue: true
        });
      } catch (_) {}

      try {
        await chrome.debugger.detach(debuggee);
      } catch (_) {}
    }
  }
}

async function copyToClipboard(tabId, base64Data) {
  // Focus the window and tab so the page has clipboard access.
  // Both must complete before injecting the clipboard script,
  // otherwise "Document is not focused" errors can occur.
  const tab = await chrome.tabs.get(tabId);
  await Promise.all([
    chrome.windows.update(tab.windowId, { focused: true }),
    chrome.tabs.update(tabId, { active: true })
  ]);

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
      img.style.cssText = `
        display: block; width: 100%;
        border-radius: 0 0 8px 8px;
      `;
      img.addEventListener("load", () => {
        labelDims.textContent = `${img.naturalWidth} \u00d7 ${img.naturalHeight} px`;
      });

      // Convert base64 to a blob URL to avoid keeping the large string
      // in the DOM as a data: URI (which doubles memory usage on tall pages).
      try {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: "image/png" });
        img.src = URL.createObjectURL(blob);
        // Revoke the blob URL once the image has loaded to free memory
        img.addEventListener("load", () => URL.revokeObjectURL(img.src), { once: true });
        img.addEventListener("error", () => URL.revokeObjectURL(img.src), { once: true });
      } catch (_) {
        // Fallback to data URI if blob creation fails
        img.src = `data:image/png;base64,${b64}`;
      }

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
