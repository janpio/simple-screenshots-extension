function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function popupSelectorForMode(mode) {
  return mode === "full" ? "#full" : "#visible";
}

function findPopupPage(context, extensionId) {
  const targetPrefix = `chrome-extension://${extensionId}/popup.html`;
  return context
    .pages()
    .find((page) => !page.isClosed() && page.url().startsWith(targetPrefix));
}

function resolveLiveFixturePage(context, extensionId, preferredPage = null) {
  if (preferredPage && !preferredPage.isClosed()) {
    return preferredPage;
  }

  const extensionPrefix = `chrome-extension://${extensionId}/`;
  const livePage = context
    .pages()
    .find(
      (candidate) =>
        !candidate.isClosed() &&
        !candidate.url().startsWith(extensionPrefix)
    );

  if (!livePage) {
    throw new Error("No live fixture page available for runtime trigger");
  }

  return livePage;
}

async function tryPopupTrigger(options) {
  const {
    mode,
    context,
    serviceWorker,
    extensionId,
    popupTimeoutMs = 2000,
  } = options;

  const popupEventPromise = context
    .waitForEvent("page", { timeout: popupTimeoutMs })
    .catch(() => null);

  await serviceWorker.evaluate(async () => {
    if (!chrome.action || typeof chrome.action.openPopup !== "function") {
      throw new Error("chrome.action.openPopup is unavailable");
    }
    await chrome.action.openPopup();
  });

  const popupFromEvent = await popupEventPromise;
  let popup = popupFromEvent || findPopupPage(context, extensionId);

  // Popup can appear asynchronously without emitting a new-page event.
  if (!popup) {
    const deadline = Date.now() + popupTimeoutMs;
    while (!popup && Date.now() < deadline) {
      await delay(50);
      popup = findPopupPage(context, extensionId);
    }
  }

  if (!popup) {
    throw new Error("Popup page was not found");
  }

  await popup.waitForLoadState("domcontentloaded");
  await popup.click(popupSelectorForMode(mode));

  return { triggerUsed: "popup" };
}

async function triggerViaRuntimeMessage(options) {
  const { mode, context, extensionId } = options;
  const page = resolveLiveFixturePage(context, extensionId, options.page);
  let sender = findPopupPage(context, extensionId);

  if (!sender) {
    sender = await context.newPage();
    await sender.goto(`chrome-extension://${extensionId}/popup.html`);
    await sender.waitForLoadState("domcontentloaded");
  }

  // Keep the real fixture tab active because background.js resolves
  // the active tab when handling runtime messages from popup.
  await page.bringToFront();

  const tabUrl = page.url();
  const targetTabId = await sender.evaluate(async ({ url }) => {
    try {
      const byUrl = await chrome.tabs.query({ url });
      if (byUrl[0]?.id) return byUrl[0].id;
    } catch (_) {}

    try {
      const active = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (active[0]?.id) return active[0].id;
    } catch (_) {}

    return null;
  }, { url: tabUrl });

  await sender.evaluate(({ fullPage, tabId }) => {
    return chrome.runtime.sendMessage({ action: "capture", fullPage, tabId });
  }, { fullPage: mode === "full", tabId: targetTabId });

  return { triggerUsed: "runtime-message" };
}

async function triggerCapture(options) {
  const {
    strategy = "popup-first",
    context,
    extensionId,
  } = options;

  const page = resolveLiveFixturePage(context, extensionId, options.page);
  await page.bringToFront();

  if (strategy === "runtime-message") {
    return triggerViaRuntimeMessage(options);
  }

  if (strategy !== "popup-first") {
    throw new Error(`Unsupported trigger strategy: ${strategy}`);
  }

  try {
    return await tryPopupTrigger(options);
  } catch (popupErr) {
    const fallback = await triggerViaRuntimeMessage(options);
    return {
      ...fallback,
      fallbackReason: popupErr.message,
    };
  }
}

module.exports = {
  triggerCapture,
};
