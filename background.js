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
  return RESTRICTED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

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

    // Measure the true scrollable content height.
    // Some pages (SPAs, etc.) use overflow:hidden on the body and scroll
    // inside a nested container. We detect that and expand it for capture.
    const { result: dims } = await chrome.debugger.sendCommand(
      debuggee,
      "Runtime.evaluate",
      {
        expression: `(() => {
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
          const els = document.querySelectorAll('*');
          for (const el of els) {
            if (el.scrollHeight > el.clientHeight + 10) {
              const s = getComputedStyle(el);
              if (s.overflowY === 'auto' || s.overflowY === 'scroll' || s.overflowY === 'overlay') {
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
            scrollContainer.dataset.__screenshotOldOverflow = scrollContainer.style.overflow;
            scrollContainer.dataset.__screenshotOldHeight = scrollContainer.style.height;
            scrollContainer.dataset.__screenshotOldMaxHeight = scrollContainer.style.maxHeight;
            scrollContainer.style.overflow = 'visible';
            scrollContainer.style.height = 'auto';
            scrollContainer.style.maxHeight = 'none';
            scrollContainer.classList.add('__screenshot-expanded__');

            // Also expand ancestors that might clip the container
            let parent = scrollContainer.parentElement;
            while (parent && parent !== document.documentElement) {
              const ps = getComputedStyle(parent);
              if (ps.overflow === 'hidden' || ps.overflowY === 'hidden') {
                parent.dataset.__screenshotOldOverflow = parent.style.overflow;
                parent.dataset.__screenshotOldHeight = parent.style.height;
                parent.dataset.__screenshotOldMaxHeight = parent.style.maxHeight;
                parent.style.overflow = 'visible';
                parent.style.height = 'auto';
                parent.style.maxHeight = 'none';
                parent.classList.add('__screenshot-expanded__');
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

          return JSON.stringify({ width: w, height: h });
        })()`,
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
        expression: `(() => {
          document.getElementById('__screenshot-hide-scrollbars__')?.remove();
          document.querySelectorAll('.__screenshot-expanded__').forEach(el => {
            el.style.overflow = el.dataset.__screenshotOldOverflow || '';
            el.style.height = el.dataset.__screenshotOldHeight || '';
            el.style.maxHeight = el.dataset.__screenshotOldMaxHeight || '';
            delete el.dataset.__screenshotOldOverflow;
            delete el.dataset.__screenshotOldHeight;
            delete el.dataset.__screenshotOldMaxHeight;
            el.classList.remove('__screenshot-expanded__');
          });
        })()`,
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
        background: white;
        opacity: 0.7;
        z-index: 2147483647;
        pointer-events: none;
        transition: opacity 0.3s ease-out;
      `;
      document.documentElement.appendChild(overlay);
      requestAnimationFrame(() => {
        overlay.style.opacity = "0";
        overlay.addEventListener("transitionend", () => overlay.remove());
      });
    }
  }).catch(() => {}); // ignore errors on restricted pages
}
