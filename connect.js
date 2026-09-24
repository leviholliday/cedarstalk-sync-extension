// Runs on localhost pages only. When a cedarstalk /setup page asks, save its
// address and token so nobody has to paste them into the popup by hand.
let done = false;
window.addEventListener("message", (event) => {
  if (done || event.source !== window || location.pathname !== "/setup") return;
  if (event.data?.type !== "cedarstalk-connect" || typeof event.data.token !== "string") return;
  done = true;
  chrome.runtime.sendMessage({ type: "connect", engine: location.origin, token: event.data.token }, (reply) => {
    if (chrome.runtime.lastError || !reply?.ok) {
      done = false;
      return;
    }
    window.postMessage({ type: "cedarstalk-connected", firstTime: reply.result.firstTime }, location.origin);
  });
});
