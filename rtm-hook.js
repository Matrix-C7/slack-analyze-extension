// Slack History Capture — real-time hook (runs in the page's MAIN world at document_start).
// Slack's web client receives every new message for every channel, DM and thread the signed-in user belongs to
// over its real-time WebSocket (wss://wss-primary.slack.com/...). This wraps window.WebSocket before Slack's code
// loads, so frames on Slack's sockets are also handed to the isolated content script (content.js) via
// window.postMessage. Nothing is sent or changed on the socket itself.

(() => {
  if (window.__slackCaptureRtmHook) return;
  window.__slackCaptureRtmHook = true;

  const NativeWebSocket = window.WebSocket;
  const SLACK_SOCKET = /^wss:\/\/([^/]+\.)?(slack|slack-edge|slackb)\.com\//i;

  function forward(data) {
    // Cheap pre-filter: most frames are presence, typing and pings.
    if (typeof data !== 'string' || !data.includes('"message')) return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (event?.type !== 'message') return;
    window.postMessage({ __slackCapture: 'rtm', event }, location.origin);
  }

  class CapturingWebSocket extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      try {
        if (SLACK_SOCKET.test(String(url))) {
          this.addEventListener('message', (e) => forward(e.data));
          // The DOM is shared with the content script, which may load after the socket opens.
          document.documentElement.setAttribute('data-slack-capture-rtm', '1');
        }
      } catch {
        // never break Slack's own socket
      }
    }
  }

  window.WebSocket = CapturingWebSocket;
})();
