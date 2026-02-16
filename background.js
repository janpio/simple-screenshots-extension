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
  const tabId = tab.id;
  const debuggee = { tabId };

  try {
    // Attach debugger
    await chrome.debugger.attach(debuggee, "1.3");

    let result;

    if (fullPage) {
      // Get full page dimensions and current viewport
      const layoutMetrics = await chrome.debugger.sendCommand(
        debuggee,
        "Page.getLayoutMetrics"
      );

      const fullHeight = Math.ceil(layoutMetrics.contentSize.height);
      const viewportWidth = Math.ceil(layoutMetrics.cssLayoutViewport.clientWidth);

      // Override only the height, keep original viewport width
      await chrome.debugger.sendCommand(
        debuggee,
        "Emulation.setDeviceMetricsOverride",
        {
          mobile: false,
          width: viewportWidth,
          height: fullHeight,
          deviceScaleFactor: 0  // 0 = use browser default
        }
      );

      // Capture full page
      result = await chrome.debugger.sendCommand(
        debuggee,
        "Page.captureScreenshot",
        {
          format: "png",
          captureBeyondViewport: true
        }
      );

      // Reset device metrics
      await chrome.debugger.sendCommand(
        debuggee,
        "Emulation.clearDeviceMetricsOverride"
      );
    } else {
      // Capture visible area only
      result = await chrome.debugger.sendCommand(
        debuggee,
        "Page.captureScreenshot",
        {
          format: "png"
        }
      );
    }

    // Detach debugger
    await chrome.debugger.detach(debuggee);

    // Copy to clipboard via offscreen or content script
    await copyToClipboard(tabId, result.data);

    // Notify user
    showBadge("✓", "#22c55e");
  } catch (err) {
    console.error("Screenshot error:", err);
    try {
      await chrome.debugger.detach(debuggee);
    } catch (_) {}
    showBadge("✗", "#ef4444");
  }
}

async function copyToClipboard(tabId, base64Data) {
  // Inject a content script to write the image to clipboard
  await chrome.scripting.executeScript({
    target: { tabId },
    func: async (b64) => {
      try {
        const res = await fetch(`data:image/png;base64,${b64}`);
        const blob = await res.blob();
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": blob })
        ]);
      } catch (e) {
        console.error("Clipboard write failed:", e);
        throw e;
      }
    },
    args: [base64Data]
  });
}

function showBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2000);
}
