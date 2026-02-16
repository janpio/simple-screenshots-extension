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
  return !url || RESTRICTED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (isRestrictedUrl(tab?.url)) {
    document.getElementById("visible").disabled = true;
    document.getElementById("full").disabled = true;
    document.getElementById("notice").hidden = false;
  }
});

document.getElementById("visible").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "capture", fullPage: false });
  window.close();
});

document.getElementById("full").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "capture", fullPage: true });
  window.close();
});
