const path = require("node:path");
const { test, expect } = require("@playwright/test");

const {
  launchExtensionHarness,
  closeExtensionHarness,
  ensureServiceWorker,
} = require("./helpers/extension");
const { startFixtureServer } = require("./helpers/server");
const { openFixturePage } = require("./helpers/fixtures");
const { triggerCapture } = require("./helpers/trigger");
const { waitForBadge } = require("./helpers/badge");

let fixtureServer;
let harness;

function logRun(label, details) {
  console.log(`[e2e:plumbing:${label}] ${JSON.stringify(details)}`);
}

async function activeServiceWorker() {
  harness.serviceWorker = await ensureServiceWorker(
    harness.context,
    harness.serviceWorker,
    15000
  );
  return harness.serviceWorker;
}

async function clearBadge(serviceWorker) {
  await serviceWorker.evaluate(() => chrome.action.setBadgeText({ text: "" }));
}

test.beforeAll(async () => {
  fixtureServer = await startFixtureServer();
  harness = await launchExtensionHarness({
    extensionPath: path.resolve(__dirname, "..", ".."),
  });
  harness.keepAlivePage =
    harness.context.pages()[0] || await harness.context.newPage();
  await harness.keepAlivePage.goto("about:blank");

  await harness.context.grantPermissions(
    ["clipboard-read", "clipboard-write"],
    { origin: fixtureServer.baseURL }
  );
});

test.afterEach(async () => {
  if (!harness?.context) return;

  const pages = harness.context.pages();
  for (const page of pages) {
    if (page === harness.keepAlivePage) continue;
    await page.close().catch(() => {});
  }

  if (!harness.keepAlivePage || harness.keepAlivePage.isClosed()) {
    harness.keepAlivePage = await harness.context.newPage().catch(() => null);
  }
  await harness.keepAlivePage?.goto("about:blank").catch(() => {});
});

test.afterAll(async () => {
  await closeExtensionHarness(harness);
  await fixtureServer.close();
});

test("plumbing: service worker can resolve fixture tab", async () => {
  const page = await openFixturePage(
    harness.context,
    fixtureServer.baseURL,
    "standard.html"
  );
  const serviceWorker = await activeServiceWorker();
  await page.bringToFront();

  const result = await serviceWorker.evaluate(async ({ url }) => {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    const byUrl = await chrome.tabs.query({ url });
    return {
      activeId: active?.id ?? null,
      activeUrl: active?.url ?? null,
      byUrlCount: byUrl.length,
      byUrlId: byUrl[0]?.id ?? null,
      byUrlUrl: byUrl[0]?.url ?? null,
    };
  }, { url: page.url() });

  logRun("tab-resolution", result);
  expect(result.byUrlCount).toBeGreaterThan(0);
  expect(result.byUrlId).toBeTruthy();
});

test("plumbing: raw captureVisibleTab works for fixture tab window", async () => {
  const page = await openFixturePage(
    harness.context,
    fixtureServer.baseURL,
    "standard.html"
  );
  const serviceWorker = await activeServiceWorker();
  await page.bringToFront();

  const result = await serviceWorker.evaluate(async ({ url }) => {
    const [tab] = await chrome.tabs.query({ url });
    if (!tab) {
      return { ok: false, error: "No tab resolved from fixture URL" };
    }

    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "png",
      });
      return {
        ok: typeof dataUrl === "string" && dataUrl.startsWith("data:image/png;base64,"),
        dataUrlLength: dataUrl?.length ?? 0,
        tabId: tab.id,
        windowId: tab.windowId,
      };
    } catch (err) {
      return {
        ok: false,
        error: String(err?.message ?? err),
        tabId: tab.id,
        windowId: tab.windowId,
      };
    }
  }, { url: page.url() });

  logRun("raw-capture-visible", result);
  expect(result.ok).toBe(true);
  expect(result.dataUrlLength).toBeGreaterThan(5000);
});

test("plumbing: runtime-message capture reaches success with clipboard stub", async () => {
  const page = await openFixturePage(
    harness.context,
    fixtureServer.baseURL,
    "standard.html"
  );
  const serviceWorker = await activeServiceWorker();
  await clearBadge(serviceWorker);

  await serviceWorker.evaluate(() => {
    globalThis.__origClipboardWriteViaScript = clipboardWriteViaScript;
    clipboardWriteViaScript = async () => ({ ok: true, stale: false });
  });

  try {
    const trigger = await triggerCapture({
      mode: "visible",
      strategy: "runtime-message",
      page,
      context: harness.context,
      serviceWorker,
      extensionId: harness.extensionId,
    });

    const badge = await waitForBadge({
      serviceWorker,
      expectedText: "✓",
      timeoutMs: 20000,
      requireSeen: "...",
    });

    logRun("runtime-stubbed-clipboard", {
      trigger: trigger.triggerUsed,
      fallbackReason: trigger.fallbackReason || null,
      badgeTimeline: badge.timeline,
    });
  } finally {
    await serviceWorker.evaluate(() => {
      if (globalThis.__origClipboardWriteViaScript) {
        clipboardWriteViaScript = globalThis.__origClipboardWriteViaScript;
        delete globalThis.__origClipboardWriteViaScript;
      }
    });
  }
});

test("plumbing: fixture page clipboard text roundtrip works when focused", async () => {
  const page = await openFixturePage(
    harness.context,
    fixtureServer.baseURL,
    "standard.html"
  );
  await page.bringToFront();

  const result = await page.evaluate(async () => {
    const focused = document.hasFocus();
    const marker = `plumbing-${Date.now()}`;
    try {
      await navigator.clipboard.writeText(marker);
      const readBack = await navigator.clipboard.readText();
      return {
        focused,
        ok: readBack === marker,
        readBack,
      };
    } catch (err) {
      return {
        focused,
        ok: false,
        error: String(err?.message ?? err),
      };
    }
  });

  logRun("clipboard-roundtrip", result);
  expect(result.focused).toBe(true);
  expect(result.ok).toBe(true);
});
