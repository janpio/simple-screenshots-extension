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
    forcePopupFailure = false,
  } = options;

  if (forcePopupFailure) {
    throw new Error("Forced popup failure for fallback coverage");
  }

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
  const { mode, context, extensionId, serviceWorker } = options;
  const page = resolveLiveFixturePage(context, extensionId, options.page);
  let sender = findPopupPage(context, extensionId);
  let createdSender = false;

  if (!sender) {
    sender = await context.newPage();
    createdSender = true;
    await sender.goto(`chrome-extension://${extensionId}/popup.html`);
    await sender.waitForLoadState("domcontentloaded");
  }

  // Keep the real fixture tab active for captureVisibleTab + clipboard focus.
  await page.bringToFront();

  const targetTabId = await serviceWorker.evaluate(async ({ url }) => {
    const byUrl = await chrome.tabs.query({ url });
    if (byUrl[0]?.id) {
      return byUrl[0].id;
    }
    const active = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return active[0]?.id ?? null;
  }, { url: page.url() });
  if (!Number.isInteger(targetTabId)) {
    throw new Error("Unable to resolve target tab ID for runtime-message trigger");
  }

  await sender.evaluate(({ fullPage, tabId }) => {
    return chrome.runtime.sendMessage({ action: "capture", fullPage, tabId });
  }, { fullPage: mode === "full", tabId: targetTabId });

  // Runtime-message sender is an extension page and can steal focus from the
  // target tab. Refocus deterministically so captureVisibleTab/clipboard paths
  // operate against the fixture tab in CI.
  await page.bringToFront().catch(() => {});
  for (let attempt = 0; attempt < 5; attempt++) {
    const hasFocus = await page.evaluate(() => document.hasFocus()).catch(() => true);
    if (hasFocus) break;
    await delay(50);
    await page.bringToFront().catch(() => {});
  }

  if (createdSender && sender && !sender.isClosed()) {
    await sender.close().catch(() => {});
  }

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

  if (strategy === "popup-only") {
    return tryPopupTrigger(options);
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
