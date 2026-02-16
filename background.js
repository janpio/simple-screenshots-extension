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
    showFlash(tab.id);
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

    // Hide the viewport dimensions overlay that appears during resize
    await chrome.debugger.sendCommand(
      debuggee,
      "Overlay.setShowViewportSizeOnResize",
      { show: false }
    );

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

    // Resize viewport to the full content height so the browser renders
    // everything in one pass.
    await chrome.debugger.sendCommand(
      debuggee,
      "Emulation.setDeviceMetricsOverride",
      {
        mobile: false,
        width: viewportWidth,
        height,
        deviceScaleFactor: 1
      }
    );

    const result = await chrome.debugger.sendCommand(
      debuggee,
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: true }
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

function showFlash(tabId) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const overlay = document.createElement("div");
      overlay.style.cssText = `
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        pointer-events: none;
      `;
      document.documentElement.appendChild(overlay);

      // Three-phase shutter: white → black → fade out
      // Visible on any background color.
      const phases = [
        { bg: "white", opacity: "1", duration: 0.1 },
        { bg: "black", opacity: "0.3", duration: 0.1 },
        { bg: "black", opacity: "0", duration: 0.3 },
      ];

      let i = 0;
      function nextPhase() {
        if (i >= phases.length) {
          overlay.remove();
          return;
        }
        const p = phases[i++];
        overlay.style.transition = "none";
        overlay.style.background = p.bg;
        overlay.style.opacity = p.opacity;

        requestAnimationFrame(() => {
          const next = phases[i];
          if (next) {
            overlay.style.transition = `opacity ${next.duration}s ease-out, background ${next.duration}s ease-out`;
            requestAnimationFrame(() => {
              overlay.style.background = next.bg;
              overlay.style.opacity = next.opacity;
              overlay.addEventListener("transitionend", () => {
                i++;
                nextPhase();
              }, { once: true });
            });
          } else {
            overlay.remove();
          }
        });
      }

      nextPhase();
    }
  }).catch(() => {}); // ignore errors on restricted pages
}
