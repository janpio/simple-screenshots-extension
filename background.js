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
    let warning = null;

    if (fullPage) {
      showPreFlash(tab.id);
      const result = await captureFullPage(tab);
      base64Data = result.data;
      warning = result.warning;
    } else {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "png"
      });
      base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");
    }

    // Flash + preview in a single executeScript call so there's no
    // gap between the flash animation ending and the preview appearing.
    await showFlashAndPreview(tab.id, base64Data, warning);

    // Write to clipboard in the background — don't block the preview.
    // If it fails, update the preview label to reflect the error.
    copyToClipboard(tab.id, base64Data).then(
      () => {
        showBadge("✓", "#22c55e");
        updatePreviewLabel(tab.id, "Copied to clipboard \u2713", "#4ade80", true);
      },
      (clipErr) => {
        console.error("Clipboard error:", clipErr);
        showBadge("✗", "#ef4444");
        updatePreviewLabel(tab.id,
          "Clipboard failed — click tab and retry",
          "#f87171"
        );
      }
    );
  } catch (err) {
    console.error("Screenshot error:", err);
    showBadge("✗", "#ef4444");
    // Clean up any leftover flash/preview overlays
    removeOverlay(tab.id, "__screenshot-preflash__");
    removeOverlay(tab.id, "__screenshot-preview__");
    // Show a helpful message when the failure is due to the tab losing
    // visibility or focus (user switched away during capture/copy).
    const msg = String(err?.message ?? err ?? "");
    if (
      msg.includes("Unable to capture screenshot") ||
      msg.includes("not focused") ||
      msg.includes("No tab with given id") ||
      msg.includes("Cannot access") ||
      msg.includes("Clipboard write failed")
    ) {
      showError(
        tab.id,
        "Screenshot failed — the tab must stay visible during capture. " +
          "Please try again without switching away."
      );
    }
  }
}

// Maximum width to prevent Chrome from hanging on extreme pages.
const MAX_CAPTURE_WIDTH = 10000;
// Chrome's GPU texture limit — physical pixels (CSS px × DPR) beyond this
// threshold cause tiling/repeating artifacts in the captured image.
const GPU_TEXTURE_LIMIT = 16384;

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

    // Get the native device pixel ratio so we can decide whether it's
    // safe to capture at native resolution.
    const { result: dprResult } = await chrome.debugger.sendCommand(
      debuggee,
      "Runtime.evaluate",
      {
        expression: `window.devicePixelRatio || 1`,
        returnByValue: true
      }
    );
    const nativeDPR = dprResult.value;

    // Ensure height is at least 1
    height = Math.max(height, 1);
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

    // Decide DPR strategy based on whether the physical pixel height
    // would exceed Chrome's GPU texture limit (16384px).
    // - Native DPR (0) for sharp output when the page fits.
    // - DPR=1 when the page is too tall at native resolution.
    // If even at DPR=1 the page exceeds the limit, we still capture
    // but warn the user that the image may contain tiling artifacts.
    const physicalHeightAtNative = height * nativeDPR;
    const needsDPRFallback =
      hasExpandedContainers || physicalHeightAtNative > GPU_TEXTURE_LIMIT;
    const dpr = needsDPRFallback ? 1 : 0;

    let warning = null;
    if (height > GPU_TEXTURE_LIMIT) {
      warning =
        "Page is extremely tall — the screenshot may contain " +
        "repeating/tiled sections near the bottom.";
    } else if (needsDPRFallback && !hasExpandedContainers) {
      warning =
        "Captured at reduced resolution (page too tall for native DPR).";
    }

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

    return { data: result.data, warning };
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
          expression: `document.getElementById('__screenshot-hide-scrollbars__')?.remove()`,
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
  // Write the PNG to the clipboard via a content script injected into
  // the active tab.  navigator.clipboard.write() requires the document
  // to have focus.  If the user has switched away, the write will fail
  // and the caller shows an explanatory error toast — we never steal
  // window or tab focus.
  await clipboardWriteViaScript(tabId, base64Data);
}

// Inject a content script that writes a PNG blob to the clipboard.
// Returns a promise that resolves on success, rejects on failure.
async function clipboardWriteViaScript(tabId, base64Data) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (b64) => {
      if (!document.hasFocus()) {
        throw new Error("Document is not focused");
      }
      const res = await fetch(`data:image/png;base64,${b64}`);
      const blob = await res.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob })
      ]);
      return { ok: true };
    },
    args: [base64Data]
  });

  if (!result?.result?.ok) {
    throw new Error("Clipboard write did not complete successfully");
  }
}

// Remove a named overlay element from the page (cleanup helper).
function removeOverlay(tabId, elementId) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: (id) => { document.getElementById(id)?.remove(); },
    args: [elementId]
  }).catch(() => {});
}

let _badgeClearTimer = null;
let _badgeAnimTimer = null;
function showBadge(text, color) {
  clearTimeout(_badgeClearTimer);
  clearInterval(_badgeAnimTimer);
  _badgeAnimTimer = null;
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  if (text === "...") {
    // Pulse the badge background between two shades while working
    const colors = ["#6b7280", "#3b82f6"];
    let ci = 0;
    _badgeAnimTimer = setInterval(() => {
      ci = (ci + 1) % colors.length;
      chrome.action.setBadgeBackgroundColor({ color: colors[ci] });
    }, 500);
  } else {
    // Final states auto-clear after 2s.
    _badgeClearTimer = setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2000);
  }
}

// Inject an error toast into the page so the user knows what went wrong.
// The toast stays visible until the user clicks it (or presses Escape).
function showError(tabId, message) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: (msg) => {
      document.getElementById("__screenshot-error__")?.remove();

      const toast = document.createElement("div");
      toast.id = "__screenshot-error__";
      toast.style.cssText =
        "position:fixed;top:16px;left:50%;transform:translateX(-50%);" +
        "z-index:2147483647;background:#1a1a1a;color:#f87171;" +
        "font-family:system-ui,sans-serif;font-size:13px;font-weight:500;" +
        "padding:10px 18px;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,0.4);" +
        "opacity:0;transition:opacity 0.2s ease-out;max-width:480px;" +
        "text-align:center;line-height:1.4;cursor:pointer;";
      toast.textContent = msg;
      document.documentElement.appendChild(toast);

      requestAnimationFrame(() => { toast.style.opacity = "1"; });

      function dismiss() {
        toast.style.opacity = "0";
        toast.addEventListener("transitionend", () => toast.remove(), { once: true });
        document.removeEventListener("keydown", onKey);
      }
      function onKey(e) {
        if (e.key === "Escape") dismiss();
      }
      toast.addEventListener("click", dismiss);
      document.addEventListener("keydown", onKey);
    },
    args: [message]
  }).catch(() => {}); // ignore if we can't reach the tab
}

// Soft pre-flash for full-page capture: a gentle white blink that says
// "capture started".  Fire-and-forget — it completes on its own.
function showPreFlash(tabId) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      document.getElementById("__screenshot-preflash__")?.remove();
      const el = document.createElement("div");
      el.id = "__screenshot-preflash__";
      el.style.cssText =
        "position:fixed;inset:0;z-index:2147483647;pointer-events:none;" +
        "background:white;opacity:0.5;transition:opacity 0.35s ease-out;";
      document.documentElement.appendChild(el);
      requestAnimationFrame(() => {
        el.style.opacity = "0";
        el.addEventListener("transitionend", () => el.remove(), { once: true });
      });
    }
  }).catch(() => {});
}

// Combined flash + preview in a single executeScript call.
// The flash animation plays, then the preview is built on the same
// backdrop element — no extra round-trip, no gap, no pointer-events issues.
function showFlashAndPreview(tabId, base64Data, warning) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: (b64, warn) => {
      return new Promise((resolve) => {
        // Remove leftovers
        document.getElementById("__screenshot-preflash__")?.remove();
        document.getElementById("__screenshot-preview__")?.remove();

        // Inject flash keyframes once
        if (!document.getElementById("__screenshot-flash-style__")) {
          const style = document.createElement("style");
          style.id = "__screenshot-flash-style__";
          style.textContent = `
            @keyframes __ss-flash__ {
              0%   { background: white; }
              25%  { background: rgba(0,0,0,0.6); }
              100% { background: rgba(0,0,0,0.5); }
            }
          `;
          document.documentElement.appendChild(style);
        }

        // --- Flash overlay ---
        const backdrop = document.createElement("div");
        backdrop.id = "__screenshot-preview__";
        backdrop.style.cssText =
          "position:fixed;inset:0;z-index:2147483647;pointer-events:none;" +
          "background:rgba(0,0,0,0.5);" +
          "animation:__ss-flash__ 0.35s ease-out;";
        document.documentElement.appendChild(backdrop);

        backdrop.addEventListener("animationend", () => buildPreview(), { once: true });

        function buildPreview() {
          // Switch backdrop to interactive preview mode
          backdrop.style.pointerEvents = "auto";
          backdrop.style.cursor = "not-allowed";
          backdrop.style.display = "flex";
          backdrop.style.alignItems = "flex-start";
          backdrop.style.justifyContent = "flex-end";
          backdrop.style.padding = "12px";
          backdrop.style.transition = "opacity 0.2s ease-out";
          backdrop.style.fontFamily =
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

          const FADE_TIMEOUT = 4000;
          let timer = null;

          // --- Panel ---
          const panel = document.createElement("div");
          panel.style.cssText = `
            background: #1a1a1a; border-radius: 8px; cursor: default;
            box-shadow: 0 8px 32px rgba(0,0,0,0.4);
            border: 1px solid rgba(255,255,255,0.15);
            display: flex; flex-direction: column;
            max-height: calc(100vh - 24px);
            width: 460px; overflow: hidden;
          `;

          // --- Label ---
          const label = document.createElement("div");
          label.style.cssText = `
            font-size: 12px; font-weight: 500;
            padding: 8px 12px; flex-shrink: 0;
            border-bottom: 1px solid rgba(255,255,255,0.1);
            display: flex; justify-content: space-between; align-items: center;
          `;

          // Spinner + status text
          const labelLeft = document.createElement("span");
          labelLeft.style.cssText = "display:flex;align-items:center;gap:6px;";

          // Inject keyframes once
          if (!document.getElementById("__screenshot-spin-style__")) {
            const style = document.createElement("style");
            style.id = "__screenshot-spin-style__";
            style.textContent =
              "@keyframes __ss-spin__ { to { transform: rotate(360deg) } }";
            document.documentElement.appendChild(style);
          }

          const spinner = document.createElement("span");
          spinner.id = "__screenshot-preview-spinner__";
          spinner.style.cssText =
            "display:inline-block;width:12px;height:12px;flex-shrink:0;" +
            "border:2px solid rgba(255,255,255,0.15);" +
            "border-top-color:#9ca3af;border-radius:50%;" +
            "animation:__ss-spin__ 0.6s linear infinite;";

          const labelText = document.createElement("span");
          labelText.id = "__screenshot-preview-label__";
          labelText.style.color = "#9ca3af";
          labelText.textContent = "Copying to clipboard\u2026";

          labelLeft.appendChild(spinner);
          labelLeft.appendChild(labelText);

          const labelDims = document.createElement("span");
          labelDims.style.cssText =
            "color: #9ca3af; font-size: 11px; font-weight: 400;";
          labelDims.textContent = "loading\u2026";

          label.appendChild(labelLeft);
          label.appendChild(labelDims);

          // --- Scrollable image container ---
          const imgWrap = document.createElement("div");
          imgWrap.tabIndex = -1;
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
            labelDims.textContent =
              `${img.naturalWidth} \u00d7 ${img.naturalHeight} px`;
          });

          // Convert base64 → blob URL to save memory
          try {
            const binary = atob(b64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++)
              bytes[i] = binary.charCodeAt(i);
            const blob = new Blob([bytes], { type: "image/png" });
            img.src = URL.createObjectURL(blob);
            img.addEventListener(
              "load", () => URL.revokeObjectURL(img.src), { once: true }
            );
            img.addEventListener(
              "error", () => URL.revokeObjectURL(img.src), { once: true }
            );
          } catch (_) {
            img.src = `data:image/png;base64,${b64}`;
          }

          imgWrap.appendChild(img);
          panel.appendChild(label);

          // Show a warning banner when the page exceeded GPU texture limits
          if (warn) {
            const warnEl = document.createElement("div");
            warnEl.style.cssText =
              "font-size:11px;padding:6px 12px;flex-shrink:0;" +
              "background:rgba(234,179,8,0.12);color:#facc15;" +
              "border-bottom:1px solid rgba(255,255,255,0.1);line-height:1.4;";
            warnEl.textContent = "\u26a0 " + warn;
            panel.appendChild(warnEl);
          }

          panel.appendChild(imgWrap);
          backdrop.appendChild(panel);

          // Focus scroll area
          requestAnimationFrame(() => imgWrap.focus());

          // --- Dismiss helpers ---
          function dismiss() {
            clearTimeout(timer);
            backdrop.style.opacity = "0";
            backdrop.addEventListener(
              "transitionend", () => backdrop.remove(), { once: true }
            );
          }

          function resetTimer() {
            clearTimeout(timer);
            timer = setTimeout(dismiss, FADE_TIMEOUT);
          }

          // --- Events ---
          for (const evt of [
            "click", "mousedown", "mouseup", "pointerdown", "pointerup"
          ]) {
            backdrop.addEventListener(evt, (e) => {
              e.stopPropagation();
              if (evt === "click" && e.target === backdrop) dismiss();
            }, true);
          }

          function onKey(e) {
            if (e.key === "Escape") {
              dismiss();
              document.removeEventListener("keydown", onKey);
            }
          }
          document.addEventListener("keydown", onKey);

          panel.addEventListener("wheel", (e) => {
            e.preventDefault();
            imgWrap.scrollTop += e.deltaY;
            // Scrolling = actively looking → pause the timer
            clearTimeout(timer);
          }, { passive: false });

          // Hovering the preview panel = actively looking → pause timer.
          // Leaving the panel restarts it.
          panel.addEventListener("mouseenter", () => clearTimeout(timer));
          panel.addEventListener("mouseleave", () => {
            if (backdrop.__timerStarted) resetTimer();
          });

          backdrop.__startDismissTimer = () => {
            backdrop.__timerStarted = true;
            resetTimer();
          };

          resolve();
        }
      });
    },
    args: [base64Data, warning ?? null]
  }).catch(() => {}); // ignore errors on restricted pages
}

// Update the preview panel's status label and optionally start the
// auto-dismiss timer (on clipboard success).
function updatePreviewLabel(tabId, text, color, startTimer = false) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: (txt, col, start) => {
      const el = document.getElementById("__screenshot-preview-label__");
      if (el) {
        el.textContent = txt;
        el.style.color = col;
      }
      // Remove spinner — clipboard operation is done
      document.getElementById("__screenshot-preview-spinner__")?.remove();
      if (start) {
        const bd = document.getElementById("__screenshot-preview__");
        if (bd?.__startDismissTimer) bd.__startDismissTimer();
      }
    },
    args: [text, color, startTimer]
  }).catch(() => {});
}
