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
    if (typeof data !== 'string' || !(data.includes('"message') || data.includes('"reaction_'))) return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    // Reactions added / removed on a message: forwarded as they are (no sender lookup needed).
    if ((event?.type === 'reaction_added' || event?.type === 'reaction_removed') && event.item?.type === 'message') {
      window.postMessage({ __slackCapture: 'rtm', event }, location.origin);
      return;
    }
    if (event?.type !== 'message') return;
    try {
      attachSender(event);
    } catch {
      // a failed name lookup must not drop the message
    }
    window.postMessage({ __slackCapture: 'rtm', event }, location.origin);
  }

  // Slack's live events usually include a user id and not the display name. The open client already
  // has that person loaded; read the name from its store when the event doesn't carry one.
  let slackStore = null;
  let storeMissAt = 0;
  const seenProfiles = new Map();

  function hasName(profile) {
    if (!profile || typeof profile !== 'object') return false;
    const nested = profile.profile && typeof profile.profile === 'object' ? profile.profile : {};
    return Boolean(
      profile.display_name || nested.display_name || profile.real_name || nested.real_name || profile.name || nested.name,
    );
  }

  function fiberOf(el) {
    if (!el) return null;
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$') || k.startsWith('__reactInternalInstance$'));
    return key ? el[key] : null;
  }

  function storeFrom(fiber) {
    const props = fiber?.memoizedProps || fiber?.pendingProps;
    const candidates = [props?.value?.store, props?.value, props?.store, props?.teamStore, fiber?.stateNode?.store];
    for (const c of candidates) {
      if (c && typeof c.getState === 'function' && typeof c.subscribe === 'function') return c;
    }
    return null;
  }

  function findStore() {
    const starts = ['.p-client_container', '#react-root', '#client-ui', 'body']
      .map((sel) => fiberOf(document.querySelector(sel)))
      .filter(Boolean);
    for (const start of starts) {
      let fiber = start;
      for (let n = 0; fiber && n < 60; n++) {
        const found = storeFrom(fiber);
        if (found) return found;
        fiber = fiber.return;
      }
    }
    return null;
  }

  function getStore() {
    if (slackStore) {
      try {
        if (slackStore.getState() && typeof slackStore.getState() === 'object') return slackStore;
      } catch {
        slackStore = null;
      }
    }
    if (Date.now() - storeMissAt < 5000) return null;
    slackStore = findStore();
    if (!slackStore) storeMissAt = Date.now();
    return slackStore;
  }

  function looksLikeMember(m, userId) {
    if (!m || typeof m !== 'object' || (!hasName(m) && !hasName(m.profile))) return false;
    const id = m.id || m.user_id || m.userId;
    return !id || id === userId;
  }

  function memberFromState(state, userId) {
    if (!state || typeof state !== 'object') return null;
    const candidates = [
      state.members?.[userId],
      state.users?.[userId],
      state.bots?.[userId],
      state.members?.byId?.[userId],
      state.users?.byId?.[userId],
      state.users?.userById?.[userId],
      state.entities?.members?.[userId],
      state.entities?.users?.[userId],
    ];
    for (const m of candidates) if (looksLikeMember(m, userId)) return m;
    return null;
  }

  function bestProfile(member) {
    const p = member?.profile && typeof member.profile === 'object' ? member.profile : {};
    return {
      display_name: p.display_name || member.display_name || '',
      real_name: p.real_name || member.real_name || '',
      name: member.name || p.name || '',
      first_name: p.first_name || '',
      image_72: p.image_72 || p.image_48 || null,
    };
  }

  function userIdOf(msg) {
    if (!msg) return null;
    if (typeof msg.user === 'string') return msg.user;
    if (msg.user && typeof msg.user.id === 'string') return msg.user.id;
    if (typeof msg.user_id === 'string') return msg.user_id;
    if (typeof msg.bot_id === 'string') return msg.bot_id;
    return null;
  }

  function attachSender(event) {
    const msg = (event.subtype === 'message_changed' || event.subtype === 'message_replied') && event.message ? event.message : event;
    const id = userIdOf(msg);
    if (!id) return;
    if (hasName(msg.user_profile) || hasName(msg.bot_profile)) {
      seenProfiles.set(id, msg.user_profile || msg.bot_profile);
      return;
    }
    let profile = seenProfiles.get(id) || null;
    if (!profile) {
      const state = getStore()?.getState?.();
      const member = memberFromState(state, id);
      if (member) profile = bestProfile(member);
    }
    if (!profile || !hasName(profile)) return;
    msg.user_profile = profile;
    seenProfiles.set(id, profile);
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

  // ---- Browser notifications (backup signal) ----
  // When Slack shows a desktop notification from this page, hand its title / text / tag / data to content.js.
  // content.js uses it only as a signal: if live capture missed that message, it fetches the conversation.
  // The notification itself is shown exactly as before.
  function plain(value) {
    try {
      const json = JSON.stringify(value ?? null);
      return json && json.length < 20000 ? JSON.parse(json) : null;
    } catch {
      return null;
    }
  }

  function reportNotification(title, options) {
    try {
      window.postMessage(
        {
          __slackCapture: 'notification',
          title: String(title ?? ''),
          body: String(options?.body ?? ''),
          tag: options?.tag != null ? String(options.tag) : null,
          data: plain(options?.data),
          at: Date.now(),
        },
        location.origin,
      );
    } catch {
      // never get in the way of Slack's notification
    }
  }

  const NativeNotification = window.Notification;
  if (typeof NativeNotification === 'function') {
    window.Notification = new Proxy(NativeNotification, {
      construct(target, args, newTarget) {
        reportNotification(args[0], args[1]);
        return Reflect.construct(target, args, newTarget === window.Notification ? target : newTarget);
      },
      // Static members (permission, requestPermission, maxActions) must run against the real constructor.
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' && prop !== 'prototype' ? value.bind(target) : value;
      },
    });
  }

  const swProto = window.ServiceWorkerRegistration?.prototype;
  if (swProto && typeof swProto.showNotification === 'function') {
    const nativeShow = swProto.showNotification;
    swProto.showNotification = function showNotification(title, options) {
      reportNotification(title, options);
      return nativeShow.call(this, title, options);
    };
  }

  window.WebSocket = CapturingWebSocket;
})();
