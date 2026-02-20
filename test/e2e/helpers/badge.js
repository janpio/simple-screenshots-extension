function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBadgeText(serviceWorker) {
  return serviceWorker.evaluate(() => chrome.action.getBadgeText({}));
}

async function waitForBadge(options) {
  const {
    serviceWorker,
    expectedText,
    timeoutMs = 15000,
    pollMs = 100,
    requireSeen = [],
  } = options;

  const deadline = Date.now() + timeoutMs;
  const timeline = [];
  const required = Array.isArray(requireSeen) ? requireSeen : [requireSeen];
  const seen = new Set();
  let last = null;

  while (Date.now() < deadline) {
    const text = await readBadgeText(serviceWorker);
    seen.add(text);
    if (text !== last) {
      timeline.push({ atMs: timeoutMs - (deadline - Date.now()), text });
      last = text;
    }
    if (text === expectedText) {
      const missing = required.filter((value) => !seen.has(value));
      if (missing.length === 0) {
        return { text, timeline };
      }
    }
    await delay(pollMs);
  }

  throw new Error(
    `Timed out waiting for badge '${expectedText}'. Timeline: ${JSON.stringify(timeline)}`
  );
}

module.exports = {
  waitForBadge,
  readBadgeText,
};
