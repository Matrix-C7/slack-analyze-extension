// Slack History Capture — content script (runs inside https://app.slack.com).
// Reads messages straight from Slack's rendered DOM, auto-scrolls up through history,
// and streams batches to the background service worker.
//
// Slack does not publish its DOM, so every selector lives in SEL below. If Slack changes
// its markup and capture stops working, this table is the place to fix it.

(() => {
  if (window.__slackHistoryCapture) return;
  window.__slackHistoryCapture = true;

  const SEL = {
    // Main message pane (excludes the thread / side panel)
    primaryPane: ['.p-workspace__primary_view_contents', '.p-workspace__primary_view', '[data-qa="message_pane"]'],
    secondaryPane: '.p-workspace__secondary_view, .p-flexpane, [data-qa="threads_flexpane"]',
    message: '[data-qa="message_container"]',
    listItem: '[data-item-key]',
    timestamp: 'a.c-timestamp[data-ts], [data-ts]',
    senderName: '[data-qa="message_sender_name"]',
    senderId: '[data-message-sender]',
    avatar: 'img.c-base_icon, [data-qa="message_sender_avatar"] img, .c-message_kit__avatar img',
    botBadge: '.c-app_badge, [data-qa="bot_badge"]',
    text: '[data-qa="message-text"]',
    textFallback: '.c-message_kit__blocks, .c-message__body',
    attachmentText: '.c-message_attachment__body, .c-message_attachment__text',
    edited: '.c-message__edited_label',
    replyCount: '[data-qa="reply_bar_count"]',
    replyBar: '[data-qa="reply_bar_count"], [data-qa="reply_bar"], .c-message__reply_bar',
    // Thread side panel and its controls
    threadPane: '[data-qa="threads_flexpane"], .p-flexpane, .p-workspace__secondary_view',
    closePane: '[data-qa="close_flexpane"], [data-qa="flexpane_close_button"], button[aria-label="Close"]',
    threadMore: '[data-qa="thread_show_more"], [data-qa="show_more_replies"], .c-message_list__thread_show_more',
    // Collapsed long messages / attachments ("Show more"); a text match is the fallback (see expandTruncated)
    showMore:
      '[data-qa="message_content_show_more"], [data-qa="show_more_button"], button.c-message_kit__show_more, .c-rich_text_section__expand, .c-message_attachment__text_expander',
    // Parts of a row that are still loading (placeholder/skeleton blocks)
    placeholder: '.c-message_kit__skeleton, [data-qa="message_placeholder"], [class*="skeleton"]',
    reaction: 'button.c-reaction, [data-qa="reactji"]',
    reactionCount: '.c-reaction__count',
    mention: '[data-member-id]',
    fileLink: 'a[href*="files.slack.com"], a[href*="slack-files.com"], a[href*="/files/"]',
    filePreview: 'img[src^="https://files.slack.com/files-tmb/"], video[poster^="https://files.slack.com/"]',
    channelName: ['[data-qa="channel_name"]', 'button[data-qa="channel_name_button"]', '.p-view_header__channel_title'],
    channelTopic: ['[data-qa="channel_topic"]', '.p-view_header__topic'],
    beginning: '.p-message_pane__foreword, [data-qa="foreword"], [data-qa="channel_intro"]',
    // Spinners / placeholder rows Slack shows while fetching older history. Only used to wait longer
    // (each wait is capped), so a stale selector costs time, never data.
    loading: [
      '[data-qa="message_pane_loading"]',
      '[data-qa="loading_spinner"]',
      '.c-message_list__spinner',
      '.p-message_pane__loading',
      '.c-infinite_spinner',
      '.c-message_list__loading',
      '[class*="message_skeleton"]',
      '[aria-busy="true"]',
    ].join(', '),
    sidebarItem: '[data-qa-channel-sidebar-channel-id]',
    userButton: '[data-qa="user-button"]', // signed-in user's avatar (top right / bottom left)
    // Workspace logo in the team switcher / header (fallback when localConfig has no icon)
    teamIcon: '[data-qa="team-menu-trigger"] img, [data-qa="team-icon"] img, .p-ia4_home_header_menu__team_icon img, .p-team_sidebar__team_icon img',
  };

  const TS_RE = /^\d{9,11}\.\d{1,6}$/;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const first = (selectors, root = document) => {
    for (const s of [].concat(selectors)) {
      const el = root.querySelector(s);
      if (el) return el;
    }
    return null;
  };
  const clean = (s) => (s || '').replace(/​/g, '').trim();

  // ---------------------------------------------------------------------------
  // Page context
  // ---------------------------------------------------------------------------

  function routeIds() {
    // https://app.slack.com/client/T0123/C0456[/thread/...]
    const m = location.pathname.match(/\/client\/([A-Z0-9]+)\/([A-Z0-9]+)/);
    return m ? { teamId: m[1], channelId: m[2] } : { teamId: null, channelId: null };
  }

  /** Slack's own client config (same origin, so readable here): teams this browser is signed in to. */
  function slackTeam(teamId) {
    try {
      const teams = JSON.parse(localStorage.getItem('localConfig_v2') || 'null')?.teams ?? {};
      // Enterprise Grid routes use the org id (E…) rather than the workspace id.
      return teams[teamId] ?? Object.values(teams).find((t) => t?.enterprise_id === teamId) ?? null;
    } catch {
      return null;
    }
  }

  function workspaceInfo() {
    const { teamId } = routeIds();
    const team = slackTeam(teamId);
    // Title looks like "general (Channel) - Acme - Slack"
    const parts = document.title.split(' - ').map((s) => s.trim());
    const name = team?.name || (parts.length >= 3 ? parts[parts.length - 2] : null);
    return { id: teamId, name, domain: team?.domain || null, iconUrl: teamIconUrl(team) };
  }

  /** The workspace logo. Slack's config lists it in several sizes; `image_default` means no custom logo was set. */
  function teamIconUrl(team) {
    const icon = team?.icon;
    if (icon && !icon.image_default) {
      const url = icon.image_132 || icon.image_230 || icon.image_102 || icon.image_88 || icon.image_68 || icon.image_original;
      if (url) return url;
    }
    const src = document.querySelector(SEL.teamIcon)?.getAttribute('src');
    return src && /^https:\/\//.test(src) ? src : null;
  }

  /** The Slack user signed in to this browser, or null if it can't be detected. */
  function accountInfo() {
    const { teamId } = routeIds();
    const userId = slackTeam(teamId)?.user_id;
    if (!userId) return null;
    const button = document.querySelector(SEL.userButton);
    // aria-label is e.g. "User: Jane Doe"; the backend falls back to the name seen on Jane's messages.
    const label = clean(button?.getAttribute('aria-label')).replace(/^[^:]*:\s*/, '');
    return {
      userId,
      name: label || null,
      avatarUrl: button?.querySelector('img')?.getAttribute('src') || null,
    };
  }

  function typeFromSidebar(attr, id) {
    switch ((attr || '').toLowerCase()) {
      case 'im':
      case 'dm':
        return 'dm';
      case 'mpim':
      case 'mpdm':
        return 'group_dm';
      case 'private':
      case 'private_channel':
        return 'private';
      case 'channel':
      case 'public':
      case 'public_channel':
        return 'public';
    }
    if (id?.startsWith('D')) return 'dm';
    if (id?.startsWith('G')) return 'private';
    return 'unknown';
  }

  function currentChannel() {
    const { channelId } = routeIds();
    if (!channelId) return null;
    const side = document.querySelector(`[data-qa-channel-sidebar-channel-id="${channelId}"]`);
    let name = clean(first(SEL.channelName)?.innerText);
    if (!name) name = clean(document.title.split(' - ')[0]);
    name = name.replace(/^#\s*/, '').replace(/\s*\((Channel|DM|Private channel)\)\s*$/i, '').split('\n')[0];
    const topic = clean(first(SEL.channelTopic)?.innerText) || null;
    return {
      id: channelId,
      name: name || channelId,
      type: typeFromSidebar(side?.getAttribute('data-qa-channel-sidebar-channel-type'), channelId),
      topic,
    };
  }

  function findScroller(fromEl) {
    for (let el = fromEl; el && el !== document.body; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 10) return el;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Sidebar → list of conversations
  // ---------------------------------------------------------------------------

  function readSidebarItems(into) {
    for (const el of document.querySelectorAll(SEL.sidebarItem)) {
      const id = el.getAttribute('data-qa-channel-sidebar-channel-id');
      if (!id || into.has(id)) continue;
      const label = clean(el.querySelector('.p-channel_sidebar__name, [data-qa="channel_sidebar_name"]')?.innerText || el.innerText);
      into.set(id, {
        id,
        name: label.split('\n')[0] || id,
        type: typeFromSidebar(el.getAttribute('data-qa-channel-sidebar-channel-type'), id),
      });
    }
  }

  /** The sidebar is virtualized, so scroll it top → bottom to see every entry. */
  async function listChannels() {
    const found = new Map();
    readSidebarItems(found);
    const anyItem = document.querySelector(SEL.sidebarItem);
    const scroller = anyItem && findScroller(anyItem);
    if (scroller) {
      const original = scroller.scrollTop;
      scroller.scrollTop = 0;
      await sleep(300);
      for (let i = 0; i < 200; i++) {
        readSidebarItems(found);
        const before = scroller.scrollTop;
        scroller.scrollTop += scroller.clientHeight * 0.8;
        await sleep(250);
        if (scroller.scrollTop === before) break;
      }
      readSidebarItems(found);
      scroller.scrollTop = original;
    }
    return { workspace: workspaceInfo(), account: accountInfo(), channels: [...found.values()] };
  }

  // ---------------------------------------------------------------------------
  // Message extraction
  // ---------------------------------------------------------------------------

  function primaryPane() {
    return first(SEL.primaryPane) || document;
  }

  function messageTs(node) {
    const direct = node.getAttribute('data-msg-ts');
    if (direct && TS_RE.test(direct)) return direct;
    const key = node.closest(SEL.listItem)?.getAttribute('data-item-key');
    if (key && TS_RE.test(key)) return key;
    const stamp = node.querySelector(SEL.timestamp)?.getAttribute('data-ts');
    if (stamp && TS_RE.test(stamp)) return stamp;
    const idMatch = node.closest('[id^="message-list_"]')?.id.match(/_(\d+\.\d+)$/);
    return idMatch ? idMatch[1] : null;
  }

  // F0123ABCD in permalinks (/files/U…/F…/name), originals (/files-pri/T…-F…/name) and previews (/files-tmb/T…-F…-hash/…)
  const FILE_ID_RE = /(?:\/files-(?:pri|tmb)\/T[A-Z0-9]+-|\/files\/[A-Z0-9]+\/)(F[A-Z0-9]{6,})/;
  const slackFileId = (url) => (url || '').match(FILE_ID_RE)?.[1] || null;

  function fileKind(name, url, mimeType) {
    const mime = (mimeType || '').toLowerCase();
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime === 'application/pdf') return 'pdf';
    const s = `${name || ''} ${url || ''}`.toLowerCase();
    if (/\.(png|jpe?g|gif|webp|heic|svg)\b/.test(s)) return 'image';
    if (/\.(mp4|mov|webm|m4v)\b/.test(s)) return 'video';
    if (/\.pdf\b/.test(s)) return 'pdf';
    if (/\.(docx?|xlsx?|pptx?|csv|txt|zip)\b/.test(s)) return 'doc';
    return 'other';
  }

  function extractMessage(node) {
    const ts = messageTs(node);
    if (!ts) return null;

    const textEl = node.querySelector(SEL.text) || node.querySelector(SEL.textFallback);
    let text = clean(textEl?.innerText);
    const attachments = [...node.querySelectorAll(SEL.attachmentText)].map((e) => clean(e.innerText)).filter(Boolean);
    for (const a of attachments) if (!text.includes(a)) text = text ? `${text}\n\n${a}` : a;

    const senderEl = node.querySelector(SEL.senderName);
    const userName = clean(senderEl?.innerText) || null;
    const userId = node.querySelector(SEL.senderId)?.getAttribute('data-message-sender') || null;
    const avatarUrl = node.querySelector(SEL.avatar)?.getAttribute('src') || null;

    const reactions = [];
    for (const r of node.querySelectorAll(SEL.reaction)) {
      const img = r.querySelector('img');
      const raw =
        img?.getAttribute('data-stringify-emoji') ||
        img?.getAttribute('alt') ||
        r.querySelector('[data-stringify-emoji]')?.getAttribute('data-stringify-emoji') ||
        clean(r.querySelector('.c-emoji')?.innerText);
      const emoji = clean(raw).replace(/^:|:$/g, '');
      const count = parseInt(clean(r.querySelector(SEL.reactionCount)?.innerText), 10) || 1;
      if (emoji && !reactions.some((x) => x.emoji === emoji)) reactions.push({ emoji, count });
    }

    // A file shows up as several links (name, preview, download button): merge them by Slack file id.
    const files = [];
    const fileFor = (url) => {
      const id = slackFileId(url);
      return files.find((f) => (id && f.slackFileId === id) || f.url === url);
    };
    for (const a of node.querySelectorAll(SEL.fileLink)) {
      const url = a.href;
      if (!url) continue;
      const name = clean(a.getAttribute('aria-label') || a.innerText || a.querySelector('img')?.alt) || null;
      const known = fileFor(url);
      if (known) {
        known.name ??= name;
        // Prefer the file itself over the permalink page.
        if (url.includes('/files-pri/') && !known.downloadUrl) known.downloadUrl = url;
        continue;
      }
      files.push({ name, url, kind: fileKind(name, url), slackFileId: slackFileId(url), downloadUrl: url.includes('/files-pri/') ? url : null });
    }
    for (const el of node.querySelectorAll(SEL.filePreview)) {
      const thumb = el.getAttribute('src') || el.getAttribute('poster');
      const known = fileFor(thumb);
      if (known) known.thumbUrl ??= thumb;
      else {
        const name = clean(el.getAttribute('alt')) || null;
        files.push({ name, url: thumb, kind: el.tagName === 'VIDEO' ? 'video' : 'image', slackFileId: slackFileId(thumb), thumbUrl: thumb });
      }
    }
    for (const f of files) if (f.kind === 'other' && f.thumbUrl) f.kind = 'image';

    const mentions = [...new Set([...(textEl?.querySelectorAll(SEL.mention) || [])].map((e) => e.getAttribute('data-member-id')).filter(Boolean))];
    const replyText = clean(node.querySelector(SEL.replyCount)?.innerText);

    // Captured half-loaded: placeholder blocks, still-collapsed text, or an empty body with nothing else in it.
    const partial =
      Boolean(node.querySelector(SEL.placeholder)) ||
      showMoreButtons(node).length > 0 ||
      (!text && files.length === 0 && !node.querySelector('img:not(.c-base_icon), video'));

    return {
      partial,
      ts,
      userId,
      userName,
      avatarUrl,
      isBot: Boolean(node.querySelector(SEL.botBadge)),
      text,
      replyCount: parseInt(replyText, 10) || 0,
      isEdited: Boolean(node.querySelector(SEL.edited)),
      reactions,
      files,
      mentions,
    };
  }

  function visibleMessages() {
    const out = [];
    for (const node of primaryPane().querySelectorAll(SEL.message)) {
      if (node.closest(SEL.secondaryPane)) continue;
      const m = extractMessage(node);
      if (m) out.push(m);
    }
    return out;
  }

  /** Messages rendered inside `root` (used for the thread pane). */
  function messagesIn(root) {
    const out = [];
    for (const node of root.querySelectorAll(SEL.message)) {
      const m = extractMessage(node);
      if (m) out.push(m);
    }
    return out;
  }

  const SHOW_MORE_TEXT = /^(show|see|read) more$/i;
  function showMoreButtons(root) {
    const found = [...root.querySelectorAll(SEL.showMore)];
    for (const b of root.querySelectorAll('button, [role="button"]')) {
      if (!found.includes(b) && SHOW_MORE_TEXT.test(clean(b.innerText))) found.push(b);
    }
    return found.filter((b) => b.isConnected && b.offsetParent !== null);
  }

  /** Expands collapsed long messages / attachments so their full text is captured. Returns how many were clicked. */
  const expanded = new WeakSet();
  function expandTruncated(root) {
    let n = 0;
    for (const b of showMoreButtons(root)) {
      if (expanded.has(b)) continue;
      expanded.add(b);
      b.click();
      n++;
    }
    return n;
  }

  /**
   * Accumulates messages for one channel. Slack hides the sender on consecutive messages
   * from the same person, so a message is only "ready" once an earlier message from the
   * group head has been seen and its sender copied forward.
   */
  class Collector {
    constructor() {
      this.byTs = new Map();
      this.sent = new Map(); // ts -> fingerprint of what we last sent
    }
    add(list) {
      for (const m of list) {
        const prev = this.byTs.get(m.ts);
        if (!prev) {
          this.byTs.set(m.ts, { ...m, inheritedSender: false });
          continue;
        }
        // Keep the richest version (e.g. the row re-rendered with reactions loaded).
        for (const k of ['userId', 'userName', 'avatarUrl']) if (m[k] && (!prev[k] || prev.inheritedSender)) prev[k] = m[k];
        if (m.userName || m.userId) prev.inheritedSender = false;
        if (m.text.length >= prev.text.length) prev.text = m.text;
        prev.reactions = m.reactions.length ? m.reactions : prev.reactions;
        prev.files = m.files.length ? m.files : prev.files;
        prev.mentions = m.mentions.length ? m.mentions : prev.mentions;
        prev.replyCount = Math.max(prev.replyCount, m.replyCount);
        prev.isEdited = prev.isEdited || m.isEdited;
        prev.isBot = prev.isBot || m.isBot;
        prev.partial = prev.partial && m.partial; // once seen fully loaded, it stays complete
      }
    }
    resolveSenders() {
      let last = null;
      for (const ts of [...this.byTs.keys()].sort((a, b) => Number(a) - Number(b))) {
        const m = this.byTs.get(ts);
        if ((m.userName || m.userId) && !m.inheritedSender) {
          last = m;
        } else if (last) {
          m.userId = last.userId;
          m.userName = last.userName;
          m.avatarUrl = m.avatarUrl || last.avatarUrl;
          m.isBot = m.isBot || last.isBot;
          m.inheritedSender = true;
        }
      }
    }
    /** Messages that are new or changed since last send. With force, include ones still missing a sender. */
    takeReady(force = false) {
      this.resolveSenders();
      const out = [];
      for (const m of this.byTs.values()) {
        if (!force && !m.userName && !m.userId) continue;
        const { inheritedSender, ...payload } = m;
        const fp = JSON.stringify(payload);
        if (this.sent.get(m.ts) === fp) continue;
        this.sent.set(m.ts, fp);
        out.push(payload);
      }
      return out;
    }
    oldestTs() {
      let min = null;
      for (const ts of this.byTs.keys()) if (min === null || Number(ts) < Number(min)) min = ts;
      return min;
    }
  }

  const collectors = new Map(); // channelId -> Collector
  const collectorFor = (channelId) => {
    if (!collectors.has(channelId)) collectors.set(channelId, new Collector());
    return collectors.get(channelId);
  };

  function send(msg) {
    return chrome.runtime.sendMessage(msg).catch(() => null);
  }

  async function flush(kind, channelId, extra = {}, force = false) {
    const ch = currentChannel();
    if (!ch || ch.id !== channelId) return 0;
    const messages = collectorFor(channelId).takeReady(force);
    if (!messages.length && !extra.reachedStart) return 0;
    for (let i = 0; i < Math.max(messages.length, 1); i += 200) {
      await send({
        type: kind,
        workspace: workspaceInfo(),
        account: accountInfo(),
        channel: ch,
        messages: messages.slice(i, i + 200),
        ...extra,
      });
    }
    return messages.length;
  }

  // ---------------------------------------------------------------------------
  // History scrape: scroll up until the cutoff or the beginning of the channel
  // ---------------------------------------------------------------------------

  let activeScrape = null;

  const isLoading = () => Boolean(primaryPane().querySelector(SEL.loading));

  /**
   * Waits until Slack has finished rendering after a scroll: no DOM changes in the message pane for
   * `quietMs` and no loading spinner, but never less than `minMs` or more than `maxMs`.
   * Measured in wall-clock time, so it stays correct when Chrome throttles timers in a background tab.
   */
  function waitForSettle(state, { minMs, quietMs, maxMs }) {
    return new Promise((resolve) => {
      const root = primaryPane();
      const start = Date.now();
      let lastChange = start;
      const obs = new MutationObserver(() => {
        lastChange = Date.now();
      });
      obs.observe(root === document ? document.body : root, { childList: true, subtree: true });
      const tick = () => {
        const now = Date.now();
        const settled = now - start >= minMs && now - lastChange >= quietMs && !isLoading();
        if (settled || now - start >= maxMs || state.aborted) {
          obs.disconnect();
          resolve({ timedOut: !settled });
        } else {
          setTimeout(tick, 100);
        }
      };
      setTimeout(tick, 100);
    });
  }

  async function waitForMessages(timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (primaryPane().querySelector(SEL.message)) return true;
      if (primaryPane().querySelector(SEL.beginning)) return true; // empty channel
      await sleep(300);
    }
    return false;
  }

  const tsRange = (list) => {
    let min = null;
    let max = null;
    for (const m of list) {
      if (min === null || Number(m.ts) < Number(min)) min = m.ts;
      if (max === null || Number(m.ts) > Number(max)) max = m.ts;
    }
    return { min, max };
  };

  /**
   * Scrolling up should always land on rows that overlap what we just read. If Slack jumped the scroll
   * position while inserting older history, rows were skipped: step back down until the views overlap.
   */
  async function closeGap(scroller, collector, newerTs, state, settle) {
    for (let i = 0; i < 15 && !state.aborted; i++) {
      scroller.scrollTop += Math.max(100, scroller.clientHeight * 0.3);
      await waitForSettle(state, settle);
      const view = visibleMessages();
      collector.add(view);
      if (view.some((m) => Number(m.ts) >= Number(newerTs))) return true;
    }
    return false;
  }

  /** Waits for rendering, expands any collapsed "Show more" content in view, and waits again if something expanded. */
  async function settleAndExpand(state, settle, root = primaryPane()) {
    const r = await waitForSettle(state, settle);
    if (expandTruncated(root)) await waitForSettle(state, settle);
    return r;
  }

  const partialCount = (collector) => {
    let n = 0;
    for (const m of collector.byTs.values()) if (m.partial) n++;
    return n;
  };

  /**
   * Re-reads the current view until a read adds nothing new and no visible row is still half-loaded —
   * used at the ends of the list and wherever late content was spotted.
   */
  async function readUntilStable(collector, state, settle, maxReads = 6, read = visibleMessages, root = primaryPane()) {
    for (let i = 0; i < maxReads && !state.aborted; i++) {
      await settleAndExpand(state, settle, root);
      const before = collector.byTs.size;
      const view = read();
      collector.add(view);
      // Keep waiting (up to maxReads) while a row in view is still half-loaded.
      const stillLoading = view.some((m) => collector.byTs.get(m.ts)?.partial);
      if (i > 0 && collector.byTs.size === before && !stillLoading) return;
    }
  }

  async function waitFor(fn, timeoutMs, state) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs && !state?.aborted) {
      const v = fn();
      if (v) return v;
      await sleep(200);
    }
    return null;
  }

  const openThreadPane = () => {
    const pane = document.querySelector(SEL.threadPane);
    return pane && pane.querySelector(SEL.message) ? pane : null;
  };

  async function closeThreadPane(state) {
    const pane = document.querySelector(SEL.threadPane);
    if (!pane) return;
    const close = pane.querySelector(SEL.closePane);
    if (close) close.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    await waitFor(() => !openThreadPane(), 5000, state);
  }

  /**
   * Opens one thread in Slack's side panel, scrolls through it (expanding "show more replies" / "Show more"),
   * and sends every reply with threadTs = parent ts. Returns how many replies were captured.
   */
  async function captureThread(ch, node, parentTs, expected, state, settle, runId) {
    await closeThreadPane(state);
    const bar = node.querySelector(SEL.replyBar);
    // The reply bar may be the button itself, a wrapper around it, or text inside it.
    const clickable = 'button, a, [role="button"]';
    const target = bar && (bar.matches(clickable) ? bar : bar.querySelector(clickable) || bar.closest(clickable) || bar);
    if (!target) return { ok: false, error: 'reply bar not found' };
    target.click();
    const pane = await waitFor(openThreadPane, Math.max(15000, settle.maxMs * 2), state);
    if (!pane) return { ok: false, error: 'thread did not open' };

    const tc = new Collector();
    const read = () => messagesIn(pane);
    let sc = findScroller(pane.querySelector(SEL.message));
    if (sc) sc.scrollTop = 0;
    for (let i = 0; i < 5000 && !state.aborted; i++) {
      for (const b of pane.querySelectorAll(SEL.threadMore)) b.click();
      await readUntilStable(tc, state, settle, 3, read, pane);
      if (!sc || !sc.isConnected) sc = findScroller(pane.querySelector(SEL.message));
      if (!sc) break;
      const top = sc.scrollTop;
      sc.scrollTop = top + sc.clientHeight * 0.5;
      if (sc.scrollTop === top) break;
    }
    await readUntilStable(tc, state, settle, 4, read, pane);
    // Slack shows the reply count, so keep reading until every reply has rendered (bounded wait).
    const repliesSeen = () => [...tc.byTs.keys()].filter((ts) => ts !== parentTs).length;
    const deadline = Date.now() + Math.max(15000, settle.maxMs * 2);
    while (repliesSeen() < expected && Date.now() < deadline && !state.aborted) {
      for (const b of pane.querySelectorAll(SEL.threadMore)) b.click();
      if (sc?.isConnected) sc.scrollTop = sc.scrollHeight;
      await readUntilStable(tc, state, settle, 2, read, pane);
    }

    const replies = tc
      .takeReady(true)
      .filter((m) => m.ts !== parentTs)
      .map((m) => ({ ...m, threadTs: parentTs }));
    for (let i = 0; i < replies.length; i += 200) {
      await send({ type: 'batch', workspace: workspaceInfo(), account: accountInfo(), channel: ch, runId, messages: replies.slice(i, i + 200) });
    }
    await closeThreadPane(state);
    return { ok: true, count: replies.length };
  }

  /**
   * Captures the threads of parent messages currently rendered in the main pane. `ctx.marks` remembers how
   * many replies were captured per thread, so unchanged threads are skipped on later runs.
   */
  async function captureVisibleThreads(ch, collector, state, settle, runId, ctx, stats, report) {
    for (let guard = 0; guard < 200 && !state.aborted; guard++) {
      let next = null;
      for (const node of primaryPane().querySelectorAll(SEL.message)) {
        if (node.closest(SEL.secondaryPane)) continue;
        const ts = messageTs(node);
        const count = ts && collector.byTs.get(ts)?.replyCount;
        if (!count || ctx.done.has(ts)) continue;
        if ((ctx.marks[`${ctx.teamId}/${ch.id}/${ts}`] ?? 0) >= count) {
          ctx.done.add(ts); // every reply already captured on an earlier run
          continue;
        }
        // Row still loading (no reply button yet): leave it for when it is seen again further down.
        if (!node.querySelector(SEL.replyBar)) continue;
        next = { node, ts, count };
        break;
      }
      if (!next) return;
      report('threads', { threads: stats.threads });
      const r = await captureThread(ch, next.node, next.ts, next.count, state, settle, runId);
      ctx.attempts[next.ts] = (ctx.attempts[next.ts] ?? 0) + 1;
      if (!r.ok) {
        // One retry; after that count it as an error (the next sync tries again).
        if (ctx.attempts[next.ts] >= 2) {
          ctx.done.add(next.ts);
          stats.threadErrors++;
        }
        continue;
      }
      ctx.done.add(next.ts);
      stats.threads++;
      stats.threadReplies += r.count;
      if (r.count >= next.count) {
        ctx.marks[`${ctx.teamId}/${ch.id}/${next.ts}`] = next.count;
        // Only an optimisation for later runs; never let it abort the capture.
        await chrome.storage.local.set({ threadMarks: ctx.marks }).catch(() => {});
      } else {
        stats.threadsIncomplete++;
      }
    }
  }

  async function scrapeHistory({ channelId, cutoffTs, runId, scrollDelayMs = 1200, patienceSec = 60, verifyPass = true, captureThreads = true }) {
    const state = { aborted: false };
    activeScrape = state;
    // How long to keep waiting for older history before concluding there is none (doubled while Slack shows a spinner).
    const patienceMs = Math.max(10, Number(patienceSec) || 60) * 1000;
    const settle = {
      minMs: scrollDelayMs,
      quietMs: Math.min(800, Math.max(300, scrollDelayMs / 2)),
      maxMs: Math.max(8000, scrollDelayMs * 6),
    };
    try {
      const ch = currentChannel();
      if (!ch || (channelId && ch.id !== channelId)) {
        return { ok: false, error: `Expected channel ${channelId}, Slack is showing ${ch?.id ?? 'nothing'}` };
      }
      if (!(await waitForMessages(patienceMs))) return { ok: false, error: 'No messages rendered (is the channel loaded?)' };
      await waitForSettle(state, settle);

      // Fresh collector so a manual re-sync re-sends everything in range.
      const collector = new Collector();
      collectors.set(ch.id, collector);
      const cutoff = cutoffTs ? Number(cutoffTs) : null;
      const stats = {
        gaps: 0,
        unresolvedGaps: 0,
        slowLoads: 0,
        verifiedExtra: 0,
        partialLeft: 0,
        threads: 0,
        threadReplies: 0,
        threadErrors: 0,
        threadsIncomplete: 0,
      };
      let sentTotal = 0;
      let stopReason = 'no_more_history';
      let lastGrowthAt = Date.now();
      let stepFactor = 0.7;
      let cleanRounds = 0;

      const report = (phase, extra = {}) =>
        send({
          type: 'progress',
          channelId: ch.id,
          channelName: ch.name,
          collected: collector.byTs.size,
          oldestTs: collector.oldestTs(),
          phase,
          ...extra,
        });

      await readUntilStable(collector, state, settle);
      let view = visibleMessages();
      collector.add(view);
      let scroller = view.length ? findScroller(primaryPane().querySelector(SEL.message)) : null;

      for (let round = 0; round < 50000 && !state.aborted; round++) {
        if (collector.byTs.size >= 50 || round % 3 === 0) sentTotal += await flush('batch', ch.id, { runId });
        report('loading');

        const oldest = collector.oldestTs();
        if (cutoff && oldest && Number(oldest) <= cutoff) {
          stopReason = 'cutoff';
          break;
        }
        // The intro block can be in the DOM while the oldest rows are still above the viewport, so only
        // stop once it is actually scrolled into view.
        const beginning = primaryPane().querySelector(SEL.beginning);
        if (beginning && (!scroller || scroller.scrollTop <= 1 || beginning.getBoundingClientRect().bottom >= scroller.getBoundingClientRect().top)) {
          // Let the last rows finish rendering, grab them and stop.
          await readUntilStable(collector, state, settle);
          stopReason = 'start';
          break;
        }

        if (!scroller || !scroller.isConnected) {
          const node = primaryPane().querySelector(SEL.message);
          scroller = node && findScroller(node);
          if (!scroller) break;
        }

        const sizeBefore = collector.byTs.size;
        const oldestVisible = tsRange(view).min;
        const topBefore = scroller.scrollTop;

        // Step up less than one screen so the virtual list renders every row on the way.
        scroller.scrollTop = Math.max(0, topBefore - Math.max(150, scroller.clientHeight * stepFactor));
        const s = await settleAndExpand(state, settle);
        if (s.timedOut) stats.slowLoads++;
        view = visibleMessages();
        collector.add(view);

        // Gap check: the newest row now rendered must be at least as new as the oldest row we saw before.
        const { max: newestVisible } = tsRange(view);
        if (oldestVisible && newestVisible && Number(newestVisible) < Number(oldestVisible)) {
          stats.gaps++;
          if (!(await closeGap(scroller, collector, oldestVisible, state, settle))) stats.unresolvedGaps++;
          view = visibleMessages();
          stepFactor = 0.35; // smaller steps until things are stable again
          cleanRounds = 0;
        } else if (++cleanRounds >= 5) {
          stepFactor = 0.7;
        }

        if (collector.byTs.size > sizeBefore) {
          lastGrowthAt = Date.now();
          continue;
        }

        // Nothing new. At the top this usually means Slack is still fetching older history: wait for it.
        const atTop = scroller.scrollTop <= 1 || scroller.scrollTop === topBefore;
        const loading = isLoading();
        const waited = Date.now() - lastGrowthAt;
        if (waited >= patienceMs * (loading ? 2 : 1)) break; // stopReason stays 'no_more_history'
        if (atTop) {
          report('waiting', { waitedSec: Math.round(waited / 1000) });
          // Nudge: Slack loads older history on scroll/wheel events near the top; back off as we wait longer.
          scroller.scrollTop = 40;
          await sleep(250);
          scroller.scrollTop = 0;
          scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true, cancelable: true }));
          await waitForSettle(state, { ...settle, minMs: Math.min(5000, settle.minMs + waited / 10) });
          view = visibleMessages();
          collector.add(view);
          if (collector.byTs.size > sizeBefore) lastGrowthAt = Date.now();
        }
      }

      if (state.aborted) stopReason = 'aborted';
      collector.add(visibleMessages());
      sentTotal += await flush('batch', ch.id, { runId });

      // Downward pass: scroll back down over what was loaded. It re-reads rows that rendered too late on the
      // way up (verification), waits on rows that were captured half-loaded, and opens threads to capture
      // replies. History is already in memory, so this is much faster than the upward pass.
      if ((verifyPass || captureThreads) && !state.aborted && scroller?.isConnected) {
        const before = collector.byTs.size;
        const quick = { minMs: 250, quietMs: 300, maxMs: Math.max(3000, scrollDelayMs * 2) };
        const { threadMarks = {} } = captureThreads ? await chrome.storage.local.get('threadMarks') : {};
        const threadCtx = { teamId: routeIds().teamId, marks: threadMarks, done: new Set(), attempts: {} };
        let view = visibleMessages();
        for (let i = 0; i < 50000 && !state.aborted; i++) {
          if (verifyPass) {
            await readUntilStable(collector, state, quick, 3);
            // Rows still half-loaded in view: give Slack the full settle time to finish them.
            if (visibleMessages().some((m) => collector.byTs.get(m.ts)?.partial)) await readUntilStable(collector, state, settle, 4);
          }
          if (captureThreads) await captureVisibleThreads(ch, collector, state, settle, runId, threadCtx, stats, report);
          if (i % 5 === 0) {
            sentTotal += await flush('batch', ch.id, { runId });
            report('verifying');
          }

          const prevNewest = tsRange(view).max;
          const top = scroller.scrollTop;
          // Half-screen steps so every row is read from two positions.
          scroller.scrollTop = top + scroller.clientHeight * 0.5;
          if (!verifyPass) await settleAndExpand(state, quick);
          view = visibleMessages();
          collector.add(view);
          // Gap check (downward): the oldest row now rendered must not be newer than the newest row seen before.
          const oldestNow = tsRange(view).min;
          if (prevNewest && oldestNow && Number(oldestNow) > Number(prevNewest)) {
            stats.gaps++;
            for (let k = 0; k < 15 && !state.aborted; k++) {
              scroller.scrollTop -= Math.max(100, scroller.clientHeight * 0.3);
              await waitForSettle(state, quick);
              view = visibleMessages();
              collector.add(view);
              if (view.some((m) => Number(m.ts) <= Number(prevNewest))) break;
            }
          }
          if (scroller.scrollTop === top || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) break;
        }
        await readUntilStable(collector, state, settle);
        if (captureThreads) await captureVisibleThreads(ch, collector, state, settle, runId, threadCtx, stats, report);
        stats.verifiedExtra = collector.byTs.size - before;
      }
      stats.partialLeft = partialCount(collector);

      const reachedStart = stopReason === 'start';
      sentTotal += await flush('batch', ch.id, { runId, reachedStart }, true);

      return {
        ok: true,
        aborted: state.aborted,
        reachedStart,
        reachedCutoff: stopReason === 'cutoff',
        stopReason,
        collected: collector.byTs.size,
        sent: sentTotal,
        oldestTs: collector.oldestTs(),
        ...stats,
      };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    } finally {
      if (activeScrape === state) activeScrape = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Live capture: send new/changed messages as Slack renders them
  // ---------------------------------------------------------------------------

  let liveEnabled = false;
  let liveTimer = null;

  const observer = new MutationObserver(() => {
    if (!liveEnabled || activeScrape) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(async () => {
      const ch = currentChannel();
      if (!ch) return;
      collectorFor(ch.id).add(visibleMessages());
      await flush('live', ch.id);
    }, 1500);
  });

  function setLive(enabled) {
    liveEnabled = enabled;
    if (enabled) observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    else observer.disconnect();
  }

  // ---------------------------------------------------------------------------
  // Real-time capture: new messages in every channel, DM and thread, read from Slack's own WebSocket
  // (rtm-hook.js forwards the frames). The DOM observer above only sees the conversation that is open.
  // ---------------------------------------------------------------------------

  const rtmStats = { socket: false, messages: 0, lastAt: null };
  const rtmPending = new Map(); // channelId -> Map(ts -> message)
  let rtmTimer = null;

  // Message subtypes that change nothing worth storing.
  const RTM_SKIP = new Set(['message_deleted', 'tombstone', 'reminder_add', 'assistant_app_thread']);

  /** Slack mrkdwn → the plain text Slack renders. User mentions stay as @U… and are named by the backend. */
  function mrkdwnToText(s) {
    return (s || '')
      .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id, label) => `@${label || id}`)
      .replace(/<#([CGD][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id, label) => `#${label || sidebarChannel(id)?.name || id}`)
      .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g, (_, label) => label || '@group')
      .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
      .replace(/<!date\^[^|>]*\|([^>]+)>/g, '$1')
      .replace(/<((?:https?|mailto|tel):[^|>]+)\|([^>]+)>/g, '$2')
      .replace(/<((?:https?|mailto|tel):[^>]+)>/g, '$1')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  function sidebarChannel(id) {
    const el = document.querySelector(`[data-qa-channel-sidebar-channel-id="${id}"]`);
    if (!el) return null;
    const label = clean(el.querySelector('.p-channel_sidebar__name, [data-qa="channel_sidebar_name"]')?.innerText || el.innerText);
    return { name: label.split('\n')[0] || null, type: typeFromSidebar(el.getAttribute('data-qa-channel-sidebar-channel-type'), id) };
  }

  /** Name and type for a conversation that may not be open. The backend keeps a known name when only the id is sent. */
  function conversationInfo(id, sample) {
    if (routeIds().channelId === id) {
      const cur = currentChannel();
      if (cur) return cur;
    }
    const side = sidebarChannel(id);
    let name = side?.name || id;
    const type = side?.type || typeFromSidebar(null, id);
    // A DM we have never seen is named after the other person, like Slack does.
    const me = slackTeam(routeIds().teamId)?.user_id;
    if (name === id && type === 'dm' && sample?.userName && sample.userId !== me) name = sample.userName;
    return { id, name, type, topic: null };
  }

  function fromRtm(event) {
    let msg = event;
    if (event.subtype === 'message_changed' || event.subtype === 'message_replied') msg = event.message;
    if (!msg || RTM_SKIP.has(event.subtype) || RTM_SKIP.has(msg.subtype)) return null;
    if (!TS_RE.test(msg.ts || '')) return null;

    const profile = msg.user_profile || {};
    let text = mrkdwnToText(msg.text);
    for (const a of msg.attachments || []) {
      const t = clean(mrkdwnToText(a.text || a.fallback || a.title));
      if (t && !text.includes(t)) text = text ? `${text}\n\n${t}` : t;
    }
    const files = [];
    for (const f of msg.files || []) {
      const url = f.permalink || f.url_private;
      if (!url || files.some((x) => x.url === url)) continue;
      const name = f.name || f.title || null;
      // External (Google Drive …), deleted, or beyond the free plan's visible history: nothing to download.
      const unavailable = f.is_external || ['external', 'tombstone', 'hidden_by_limit'].includes(f.mode);
      files.push({
        name,
        url,
        kind: fileKind(name, url, f.mimetype),
        slackFileId: /^F[A-Z0-9]{6,}$/.test(f.id || '') ? f.id : slackFileId(url),
        downloadUrl: unavailable ? null : f.url_private || null,
        thumbUrl: unavailable ? null : f.thumb_1024 || f.thumb_720 || f.thumb_480 || f.thumb_360 || f.thumb_video || null,
        mimeType: f.mimetype || null,
        size: Number.isInteger(f.size) ? f.size : null,
      });
    }
    const mentions = [...new Set([...(msg.text || '').matchAll(/<@([UW][A-Z0-9]+)/g)].map((x) => x[1]))];
    return {
      ts: msg.ts,
      userId: msg.user || msg.bot_id || null,
      userName: clean(profile.display_name) || clean(profile.real_name) || clean(msg.bot_profile?.name) || clean(msg.username) || null,
      avatarUrl: profile.image_72 || msg.bot_profile?.icons?.image_72 || msg.icons?.image_72 || null,
      isBot: Boolean(msg.bot_id) || msg.subtype === 'bot_message',
      text,
      threadTs: msg.thread_ts && msg.thread_ts !== msg.ts ? msg.thread_ts : null,
      replyCount: msg.reply_count || 0,
      isEdited: Boolean(msg.edited),
      subtype: msg.subtype || null,
      ...(msg.reactions ? { reactions: msg.reactions.map((r) => ({ emoji: r.name, count: r.count || 1 })) } : {}),
      files,
      mentions,
    };
  }

  async function flushRtm() {
    rtmTimer = null;
    const batches = [...rtmPending.entries()];
    rtmPending.clear();
    const workspace = workspaceInfo();
    if (!workspace.id) return;
    const account = accountInfo();
    for (const [channelId, byTs] of batches) {
      const messages = [...byTs.values()];
      await send({ type: 'live', origin: 'rtm', workspace, account, channel: conversationInfo(channelId, messages[0]), messages });
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    if (e.data?.__slackCapture !== 'rtm' || !liveEnabled) return;
    const event = e.data.event;
    const channelId = event?.channel;
    if (typeof channelId !== 'string' || !/^[CDG][A-Z0-9]+$/.test(channelId)) return;
    const m = fromRtm(event);
    if (!m) return;
    rtmStats.socket = true;
    rtmStats.messages++;
    rtmStats.lastAt = Date.now();
    if (!rtmPending.has(channelId)) rtmPending.set(channelId, new Map());
    const pending = rtmPending.get(channelId);
    // An edit right after the message: keep the sender details only the original event carried.
    const prev = pending.get(m.ts);
    pending.set(m.ts, prev ? { ...m, userName: m.userName ?? prev.userName, avatarUrl: m.avatarUrl ?? prev.avatarUrl } : m);
    // Short delay so a burst (message + its edit, several replies) goes out as one request per conversation.
    rtmTimer ??= setTimeout(flushRtm, 700);
  });

  chrome.storage.local.get('settings').then(({ settings }) => setLive(Boolean(settings?.liveCapture)));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) setLive(Boolean(changes.settings.newValue?.liveCapture));
  });

  // ---------------------------------------------------------------------------
  // Commands from the background worker
  // ---------------------------------------------------------------------------

  async function openChannel(channelId) {
    if (routeIds().channelId === channelId) return { ok: true };
    const item = document.querySelector(`[data-qa-channel-sidebar-channel-id="${channelId}"]`);
    const link = item?.matches('a, button') ? item : item?.querySelector('a, button, [role="treeitem"]') || item;
    if (!link) return { ok: false };
    link.click();
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      if (routeIds().channelId === channelId) return { ok: true };
    }
    return { ok: false };
  }

  /**
   * Fallback download for the file archive: fetched from the Slack page itself, where the browser always sends
   * the Slack session. Returned base64-encoded because extension messaging only carries JSON.
   */
  async function fetchFile(url, maxBytes) {
    if (!/^https:\/\/files\.slack\.com\//.test(url || '')) return { ok: false, error: 'not a Slack file URL' };
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return { ok: false, status: res.status, error: `${res.status} ${res.statusText}` };
    const type = res.headers.get('content-type') || '';
    const declared = Number(res.headers.get('content-length'));
    if (declared > maxBytes) return { ok: false, tooLarge: true, error: 'larger than the size limit' };
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > maxBytes) return { ok: false, tooLarge: true, error: 'larger than the size limit' };
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { ok: true, type, base64: btoa(bin) };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const reply = (p) => p.then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    switch (msg?.type) {
      case 'ping':
        sendResponse({ ok: true, ...routeIds(), workspace: workspaceInfo(), account: accountInfo(), channel: currentChannel(),
          rtm: { ...rtmStats, socket: rtmStats.socket || document.documentElement.hasAttribute('data-slack-capture-rtm') },
        });
        return false;
      case 'listChannels':
        reply(listChannels());
        return true;
      case 'openChannel':
        reply(openChannel(msg.channelId));
        return true;
      case 'scrape':
        reply(scrapeHistory(msg));
        return true;
      case 'fetchFile':
        reply(fetchFile(msg.url, msg.maxBytes));
        return true;
      case 'abort':
        if (activeScrape) activeScrape.aborted = true;
        sendResponse({ ok: true });
        return false;
    }
    return false;
  });
})();
