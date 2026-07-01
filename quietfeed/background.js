/* Quietfeed background service worker.
   Fetches X's cross-origin client JS (abs.twimg.com) so the content script can
   discover the current GraphQL query IDs for bookmark/repost/like. Extensions
   with host permissions can read these cross-origin bodies; content scripts,
   subject to page CORS, generally can't. */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "zf:fetchText" && msg.url) {
    fetch(msg.url)
      .then((r) => (r.ok ? r.text() : ""))
      .then((t) => sendResponse(t))
      .catch(() => sendResponse(""));
    return true; // keep the message channel open for the async response
  }
});
