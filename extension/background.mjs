// A full tab keeps long scans and photo editing alive when the toolbar closes.
// No tabs permission is needed: we only query this extension's own URL.
let opening;
chrome.action.onClicked.addListener(() => {
  if (opening) return;
  opening = (async () => {
    const url = chrome.runtime.getURL('index.html');
    const existing = (await chrome.tabs.query({ url }))[0];
    if (existing) {
      await chrome.tabs.update(existing.id, { active: true });
      await chrome.windows.update(existing.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url });
    }
  })().catch(console.error).finally(() => { opening = null; });
});
