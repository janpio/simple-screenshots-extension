const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { URL } = require("node:url");
const { chromium } = require("@playwright/test");

async function ensureServiceWorker(context, knownWorker = null, timeoutMs = 10000) {
  if (knownWorker && context.serviceWorkers().includes(knownWorker)) {
    return knownWorker;
  }
  const active = context.serviceWorkers()[0];
  if (active) return active;
  return context.waitForEvent("serviceworker", { timeout: timeoutMs });
}

const EXTENSION_BUNDLE_ENTRIES = [
  "manifest.json",
  "background.js",
  "popup.html",
  "popup.js",
  "lib.js",
  "icons",
];

async function prepareExtensionPath(extensionPath, allowAllUrlsForE2E) {
  if (!allowAllUrlsForE2E) {
    return { loadPath: extensionPath, cleanupPath: null };
  }

  const tempExtensionDir = await fs.mkdtemp(path.join(os.tmpdir(), "ss-e2e-ext-"));
  for (const entry of EXTENSION_BUNDLE_ENTRIES) {
    const source = path.join(extensionPath, entry);
    const destination = path.join(tempExtensionDir, entry);
    await fs.cp(source, destination, { recursive: true, force: true });
  }

  const manifestPath = path.join(tempExtensionDir, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const hostPermissions = new Set(manifest.host_permissions || []);
  hostPermissions.add("<all_urls>");
  manifest.host_permissions = Array.from(hostPermissions);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return { loadPath: tempExtensionDir, cleanupPath: tempExtensionDir };
}

async function launchExtensionHarness(options = {}) {
  const extensionPath =
    options.extensionPath || path.resolve(__dirname, "..", "..", "..");
  const allowAllUrlsForE2E = options.allowAllUrlsForE2E !== false;
  const extensionBuild = await prepareExtensionPath(
    extensionPath,
    allowAllUrlsForE2E
  );
  const userDataDir =
    options.userDataDir ||
    (await fs.mkdtemp(path.join(os.tmpdir(), "ss-e2e-profile-")));

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: options.viewport || { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${extensionBuild.loadPath}`,
      `--load-extension=${extensionBuild.loadPath}`,
      "--force-device-scale-factor=1",
    ],
  });

  const serviceWorker = await ensureServiceWorker(context, null, 15000);
  const extensionId = new URL(serviceWorker.url()).host;

  return {
    context,
    serviceWorker,
    extensionId,
    userDataDir,
    extensionBundleDir: extensionBuild.cleanupPath,
  };
}

async function closeExtensionHarness(harness) {
  if (!harness) return;
  await harness.context.close().catch(() => {});
  if (harness.userDataDir) {
    await fs.rm(harness.userDataDir, { recursive: true, force: true }).catch(() => {});
  }
  if (harness.extensionBundleDir) {
    await fs.rm(harness.extensionBundleDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  launchExtensionHarness,
  closeExtensionHarness,
  ensureServiceWorker,
};
