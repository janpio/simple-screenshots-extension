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
const {
  readClipboardPngMetrics,
  assertColorBandSamples,
} = require("./helpers/clipboard");

test.describe.configure({ mode: "serial" });

let fixtureServer;
let harness;

function scalePoints(points, scale) {
  return points.map((point) => ({
    ...point,
    x: point.x * scale,
    y: point.y * scale,
  }));
}

function logRun(label, details) {
  // Keep CI logs concise but actionable on failures/flakes.
  console.log(`[e2e:${label}] ${JSON.stringify(details)}`);
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
  harness.keepAlivePage = harness.context.pages()[0] || await harness.context.newPage();
  await harness.keepAlivePage.goto("about:blank");

  await harness.context.grantPermissions(
    ["clipboard-read", "clipboard-write"],
    { origin: fixtureServer.baseURL }
  );
});

test.afterEach(async () => {
  if (!harness?.context) {
    return;
  }

  let pages;
  try {
    pages = harness.context.pages();
  } catch (_) {
    return;
  }

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

test("visible capture on standard fixture copies viewport-sized non-blank image", async () => {
  const page = await openFixturePage(harness.context, fixtureServer.baseURL, "standard.html");
  const serviceWorker = await activeServiceWorker();
  await clearBadge(serviceWorker);

  const captureViewport = await serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return {
      width: tab?.width ?? 0,
      height: tab?.height ?? 0,
    };
  });
  const pageViewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const dpr = await page.evaluate(() => window.devicePixelRatio || 1);

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

  const metrics = await readClipboardPngMetrics(page);

  logRun("visible-standard", {
    trigger: trigger.triggerUsed,
    fallbackReason: trigger.fallbackReason || null,
    badgeTimeline: badge.timeline,
    image: { width: metrics.width, height: metrics.height, variance: metrics.variance },
    expected: {
      tab: {
        width: Math.round(captureViewport.width * dpr),
        height: Math.round(captureViewport.height * dpr),
      },
      page: {
        width: Math.round(pageViewport.width * dpr),
        height: Math.round(pageViewport.height * dpr),
      },
    },
  });

  const expectedWidths = [
    Math.round(captureViewport.width * dpr),
    Math.round(pageViewport.width * dpr),
  ];
  const expectedHeights = [
    Math.round(captureViewport.height * dpr),
    Math.round(pageViewport.height * dpr),
  ];
  const widthDelta = Math.min(
    ...expectedWidths.map((value) => Math.abs(metrics.width - value))
  );
  const heightDelta = Math.min(
    ...expectedHeights.map((value) => Math.abs(metrics.height - value))
  );

  // Cross-platform window managers can report slightly different visible-tab
  // sizes via tabs.query vs DOM viewport APIs.
  expect(widthDelta).toBeLessThanOrEqual(4);
  expect(heightDelta).toBeLessThanOrEqual(12);
  expect(metrics.variance).toBeGreaterThan(30);
  expect(metrics.pngBytes).toBeGreaterThan(5000);
});

test("popup-first visible capture smoke succeeds with popup or deterministic fallback", async () => {
  const page = await openFixturePage(harness.context, fixtureServer.baseURL, "standard.html");
  const serviceWorker = await activeServiceWorker();
  await clearBadge(serviceWorker);

  const trigger = await triggerCapture({
    mode: "visible",
    strategy: "popup-first",
    popupTimeoutMs: 750,
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

  const metrics = await readClipboardPngMetrics(page);

  logRun("popup-first-visible-smoke", {
    trigger: trigger.triggerUsed,
    fallbackReason: trigger.fallbackReason || null,
    badgeTimeline: badge.timeline,
    image: { width: metrics.width, height: metrics.height, variance: metrics.variance },
  });

  expect(["popup", "runtime-message"]).toContain(trigger.triggerUsed);
  if (trigger.triggerUsed === "runtime-message") {
    expect(typeof trigger.fallbackReason).toBe("string");
  }
  expect(metrics.variance).toBeGreaterThan(30);
  expect(metrics.pngBytes).toBeGreaterThan(5000);
});

test("full-page capture on standard fixture preserves dimensions and vertical band order", async () => {
  const page = await openFixturePage(harness.context, fixtureServer.baseURL, "standard.html");
  const serviceWorker = await activeServiceWorker();
  await clearBadge(serviceWorker);

  const cssDims = await page.evaluate(() => ({
    dpr: window.devicePixelRatio || 1,
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  }));
  const scale = cssDims.dpr;

  const trigger = await triggerCapture({
    mode: "full",
    strategy: "runtime-message",
    page,
    context: harness.context,
    serviceWorker,
    extensionId: harness.extensionId,
  });

  const badge = await waitForBadge({
    serviceWorker,
    expectedText: "✓",
    timeoutMs: 30000,
    requireSeen: "...",
  });

  const metrics = await readClipboardPngMetrics(page, {
    samplePoints: scalePoints(
      [
        { label: "b1", x: 200, y: 300 },
        { label: "b2", x: 200, y: 900 },
        { label: "b3", x: 200, y: 1500 },
        { label: "b4", x: 200, y: 2100 },
      ],
      scale
    ),
  });

  logRun("full-standard", {
    trigger: trigger.triggerUsed,
    fallbackReason: trigger.fallbackReason || null,
    badgeTimeline: badge.timeline,
    image: { width: metrics.width, height: metrics.height },
  });

  expect(metrics.height).toBe(Math.round(cssDims.height * scale));
  expect(metrics.width).toBeGreaterThan(400);

  assertColorBandSamples(metrics, [
    { label: "b1", r: 239, g: 68, b: 68 },
    { label: "b2", r: 34, g: 197, b: 94 },
    { label: "b3", r: 59, g: 130, b: 246 },
    { label: "b4", r: 234, g: 179, b: 8, tolerance: 24 },
  ]);
});

test("full-page capture on nested-scroll fixture captures inner scroller height", async () => {
  const page = await openFixturePage(harness.context, fixtureServer.baseURL, "nested-scroll.html");
  const serviceWorker = await activeServiceWorker();
  await clearBadge(serviceWorker);

  const expected = await page.evaluate(() => ({
    dpr: window.devicePixelRatio || 1,
    scrollHeight: document.getElementById("scroller").scrollHeight,
    appBorderY: (() => {
      const app = document.getElementById("app");
      const style = window.getComputedStyle(app);
      return (
        (parseFloat(style.borderTopWidth) || 0) +
        (parseFloat(style.borderBottomWidth) || 0)
      );
    })(),
  }));

  const trigger = await triggerCapture({
    mode: "full",
    strategy: "runtime-message",
    page,
    context: harness.context,
    serviceWorker,
    extensionId: harness.extensionId,
  });

  const badge = await waitForBadge({
    serviceWorker,
    expectedText: "✓",
    timeoutMs: 30000,
    requireSeen: "...",
  });

  const metrics = await readClipboardPngMetrics(page, {
    samplePoints: scalePoints(
      [
        { label: "n1", x: 220, y: 400 },
        { label: "n2", x: 220, y: 1200 },
        { label: "n3", x: 220, y: 2000 },
        { label: "n4", x: 220, y: 2800 },
      ],
      expected.dpr
    ),
  });

  logRun("full-nested-scroll", {
    trigger: trigger.triggerUsed,
    fallbackReason: trigger.fallbackReason || null,
    badgeTimeline: badge.timeline,
    image: { width: metrics.width, height: metrics.height },
  });

  expect(metrics.height).toBe(
    Math.round((expected.scrollHeight + expected.appBorderY) * expected.dpr)
  );

  assertColorBandSamples(metrics, [
    { label: "n1", r: 14, g: 165, b: 233 },
    { label: "n2", r: 16, g: 185, b: 129 },
    { label: "n3", r: 245, g: 158, b: 11, tolerance: 24 },
    { label: "n4", r: 239, g: 68, b: 68 },
  ]);
});

test("regression: fixed-header duplication - repeated runs preserve bottom content", async () => {
  test.setTimeout(180000);

  const page = await openFixturePage(harness.context, fixtureServer.baseURL, "fixed-header.html");
  const serviceWorker = await activeServiceWorker();
  await clearBadge(serviceWorker);

  const expected = await page.evaluate(() => ({
    dpr: window.devicePixelRatio || 1,
    height: document.documentElement.scrollHeight,
  }));

  for (let run = 1; run <= 5; run++) {
    await clearBadge(serviceWorker);
    const trigger = await triggerCapture({
      mode: "full",
      // This regression validates repeated full-page rendering integrity.
      // Use direct runtime-message triggering to avoid popup timing noise.
      strategy: "runtime-message",
      page,
      context: harness.context,
      serviceWorker,
      extensionId: harness.extensionId,
    });

    const badge = await waitForBadge({
      serviceWorker,
      expectedText: "✓",
      timeoutMs: 30000,
      requireSeen: "...",
    });

    const metrics = await readClipboardPngMetrics(page, {
      samplePoints: scalePoints(
        [
          { label: "top", x: 260, y: 260 },
          { label: "bottom", x: 260, y: expected.height - 260 },
        ],
        expected.dpr
      ),
    });

    logRun(`fixed-header-run-${run}`, {
      trigger: trigger.triggerUsed,
      fallbackReason: trigger.fallbackReason || null,
      badgeTimeline: badge.timeline,
      image: { width: metrics.width, height: metrics.height },
      bottomSample: metrics.samples.bottom,
    });

    expect(metrics.height).toBe(Math.round(expected.height * expected.dpr));
    assertColorBandSamples(metrics, [
      { label: "top", r: 239, g: 68, b: 68, tolerance: 24 },
      { label: "bottom", r: 20, g: 184, b: 166, tolerance: 24 },
    ]);
  }
});

test("restricted URL handling shows error badge without crashing", async () => {
  const page = await harness.context.newPage();
  await page.goto("chrome://extensions/");
  await page.bringToFront();

  const serviceWorker = await activeServiceWorker();
  await clearBadge(serviceWorker);

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
    expectedText: "✗",
    timeoutMs: 10000,
  });

  logRun("restricted-url", {
    trigger: trigger.triggerUsed,
    badgeTimeline: badge.timeline,
    title: await page.title(),
  });

  await expect(page).toHaveURL(/chrome:\/\/extensions\//);
});

test("large-height smoke shows tall-page warning and completes capture", async () => {
  test.setTimeout(180000);

  const page = await openFixturePage(harness.context, fixtureServer.baseURL, "large-height.html");
  const serviceWorker = await activeServiceWorker();
  await clearBadge(serviceWorker);

  const trigger = await triggerCapture({
    mode: "full",
    strategy: "runtime-message",
    page,
    context: harness.context,
    serviceWorker,
    extensionId: harness.extensionId,
  });

  const badge = await waitForBadge({
    serviceWorker,
    expectedText: "✓",
    timeoutMs: 60000,
    requireSeen: "...",
  });

  await page.waitForFunction(
    () => {
      const preview = document.getElementById("__screenshot-preview__");
      return preview?.textContent?.includes("Page is extremely tall");
    },
    null,
    { timeout: 15000 }
  );

  logRun("large-height", {
    trigger: trigger.triggerUsed,
    fallbackReason: trigger.fallbackReason || null,
    badgeTimeline: badge.timeline,
  });
});

test("focus-loss clipboard failure path surfaces expected error label", async () => {
  const page = await openFixturePage(harness.context, fixtureServer.baseURL, "standard.html");
  const serviceWorker = await activeServiceWorker();
  await clearBadge(serviceWorker);

  await serviceWorker.evaluate(() => {
    globalThis.__origClipboardWriteViaScript = clipboardWriteViaScript;
    clipboardWriteViaScript = async () => {
      throw new Error("Document is not focused");
    };
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
      expectedText: "✗",
      timeoutMs: 15000,
      requireSeen: "...",
    });

    await page.waitForFunction(
      () => {
        const label = document.getElementById("__screenshot-preview-label__");
        return label && label.textContent.includes("Clipboard failed");
      },
      null,
      { timeout: 10000 }
    );

    const labelText = await page.evaluate(() =>
      document.getElementById("__screenshot-preview-label__")?.textContent || ""
    );

    logRun("clipboard-focus-failure", {
      trigger: trigger.triggerUsed,
      fallbackReason: trigger.fallbackReason || null,
      badgeTimeline: badge.timeline,
      labelText,
    });

    expect(labelText).toContain("Clipboard failed");
  } finally {
    await serviceWorker.evaluate(() => {
      if (globalThis.__origClipboardWriteViaScript) {
        clipboardWriteViaScript = globalThis.__origClipboardWriteViaScript;
        delete globalThis.__origClipboardWriteViaScript;
      }
    });
  }
});
