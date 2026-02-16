document.getElementById("visible").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "capture", fullPage: false });
  window.close();
});

document.getElementById("full").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "capture", fullPage: true });
  window.close();
});
