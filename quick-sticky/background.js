chrome.commands.onCommand.addListener((command) => {
  if (command !== "quick-sticky-new-note") {
    return;
  }

  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) {
      console.warn("Quick Sticky: failed to query active tab.", chrome.runtime.lastError.message);
      return;
    }

    const tabId = tabs && tabs[0] ? tabs[0].id : null;
    if (typeof tabId !== "number") {
      return;
    }

    chrome.tabs.sendMessage(tabId, { type: "QS_CREATE_NOTE" }, () => {
      if (chrome.runtime.lastError) {
        console.warn("Quick Sticky: failed to send shortcut message.", chrome.runtime.lastError.message);
      }
    });
  });
});
