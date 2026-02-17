// isRestrictedUrl is provided by lib.js (loaded before this script)

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

document.getElementById("expand").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "debug-expand" }, (resp) => {
    if (resp?.dims) {
      document.getElementById("expand").disabled = true;
      document.getElementById("restore").disabled = false;
      document.getElementById("expand").querySelector("span:last-child").textContent =
        `🔧 Expanded: ${resp.dims.width} × ${resp.dims.height}`;
    }
  });
});

document.getElementById("restore").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "debug-restore" }, () => {
    document.getElementById("expand").disabled = false;
    document.getElementById("restore").disabled = true;
    document.getElementById("expand").querySelector("span:last-child").textContent =
      "🔧 Debug: Expand";
  });
});
