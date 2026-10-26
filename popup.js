import { cutoffFromRange, getCollector, getSettings, saveSettings } from './shared.js';

const $ = (id) => document.getElementById(id);
let settings = await getSettings();
let channelCache = null;

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
document.querySelectorAll('.tabs button').forEach((btn) =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button, .tab').forEach((el) => el.classList.remove('active'));
    btn.classList.add('active');
    $(`tab-${btn.dataset.tab}`).classList.add('active');
  }),
);

// ---------------------------------------------------------------------------
// Settings-bound controls
// ---------------------------------------------------------------------------
function fillControls() {
  $('rangeValue').value = settings.rangeValue;
  $('rangeUnit').value = settings.rangeUnit;
  $('rangeValue').disabled = settings.rangeUnit === 'all';
  $('autoEnabled').checked = settings.autoEnabled;
  $('autoIntervalMinutes').value = String(settings.autoIntervalMinutes);
  $('incremental').checked = settings.incremental;
  $('liveCapture').checked = settings.liveCapture;
  $('keepSlackActive').checked = settings.keepSlackActive;
  $('keepSlackActiveMinutes').value = String(settings.keepSlackActiveMinutes);
  $('keepSlackActiveMinutes').disabled = !settings.keepSlackActive;
  $('backendUrl').value = settings.backendUrl;
  $('apiKey').value = settings.apiKey;
  $('scrollDelayMs').value = settings.scrollDelayMs;
  $('loadPatienceSec').value = settings.loadPatienceSec;
  $('verifyPass').checked = settings.verifyPass;
  $('captureThreads').checked = settings.captureThreads;
  $('collectorLabel').value = settings.collectorLabel;
  $('archiveFiles').checked = settings.archiveFiles;
  $('fileMaxMb').value = settings.fileMaxMb;
  $('fileMaxMb').disabled = !settings.archiveFiles;
  for (const b of $('fileTypes').querySelectorAll('button')) {
    b.classList.toggle('active', settings.fileTypes.includes(b.dataset.kind));
    b.disabled = !settings.archiveFiles;
  }
  $('autoIntervalMinutes').disabled = !settings.autoEnabled;
  renderRangeHint();
  renderSelectionCount();
}

function renderRangeHint() {
  const cutoff = cutoffFromRange(settings.rangeValue, settings.rangeUnit);
  $('rangeHint').textContent = cutoff
    ? `Captures messages since ${new Date(cutoff * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' })}`
    : 'Scrolls back to the very beginning of each conversation (can take a while).';
  const current = settings.rangeUnit === 'all' ? '0:all' : `${settings.rangeValue}:${settings.rangeUnit}`;
  for (const b of $('rangePresets').querySelectorAll('button')) b.classList.toggle('active', b.dataset.range === current);
}

$('rangePresets').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-range]');
  if (!b) return;
  const [value, unit] = b.dataset.range.split(':');
  settings = await saveSettings(unit === 'all' ? { rangeUnit: 'all' } : { rangeValue: Number(value), rangeUnit: unit });
  fillControls();
});

function renderSelectionCount() {
  const n = settings.selectedChannelIds.length;
  $('selCount').textContent = n;
  $('selCount2').textContent = n;
  $('syncSelected').disabled = n === 0;
  $('autoHint').textContent = n
    ? `Re-syncs the ${n} selected conversation${n === 1 ? '' : 's'} on a timer`
    : 'No conversations selected — auto-sync captures whichever one is open in Slack';
}

const bindSetting = (id, key, parse = (v) => v, event = 'change') =>
  $(id).addEventListener(event, async (e) => {
    const el = e.target;
    settings = await saveSettings({ [key]: parse(el.type === 'checkbox' ? el.checked : el.value) });
    fillControls();
  });

bindSetting('rangeValue', 'rangeValue', (v) => Math.max(1, Number(v) || 1));
bindSetting('rangeUnit', 'rangeUnit');
bindSetting('autoEnabled', 'autoEnabled');
bindSetting('autoIntervalMinutes', 'autoIntervalMinutes', Number);
bindSetting('incremental', 'incremental');
bindSetting('liveCapture', 'liveCapture');
bindSetting('keepSlackActive', 'keepSlackActive');
bindSetting('keepSlackActiveMinutes', 'keepSlackActiveMinutes', Number);
bindSetting('archiveFiles', 'archiveFiles');
bindSetting('fileMaxMb', 'fileMaxMb', (v) => Math.min(100, Math.max(1, Math.round(Number(v)) || 50)));

$('fileTypes').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-kind]');
  if (!b) return;
  const kinds = new Set(settings.fileTypes);
  if (kinds.has(b.dataset.kind)) kinds.delete(b.dataset.kind);
  else kinds.add(b.dataset.kind);
  settings = await saveSettings({ fileTypes: [...kinds] });
  fillControls();
});

const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Files archived by this browser since it started. */
function renderFileStats(st) {
  const el = $('fileStats');
  if (!st || !(st.stored || st.failed || st.skipped || st.running)) {
    el.textContent = "Larger files keep only Slack's preview image, when it has one.";
    el.title = '';
    return;
  }
  const parts = [`${st.stored} archived (${fmtBytes(st.bytes)})`];
  if (st.skipped) parts.push(`${st.skipped} over the size limit`);
  if (st.failed) parts.push(`${st.failed} failed`);
  el.textContent = `${st.running ? 'Downloading… ' : ''}This session: ${parts.join(' · ')}`;
  el.title = st.lastError ? `Last error — ${st.lastError}` : '';
}
$('liveCapture').addEventListener('change', () => setTimeout(() => renderRealtime(lastPing?.rtm ?? null, Boolean(lastPing)), 50));

// ---------------------------------------------------------------------------
// Sync actions
// ---------------------------------------------------------------------------
$('syncCurrent').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'syncCurrent' }));
$('syncSelected').addEventListener('click', () =>
  chrome.runtime.sendMessage({ type: 'syncSelected', channelIds: settings.selectedChannelIds }),
);
$('stop').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'stop' }));

const PHASES = {
  waiting: (cur) => `Waiting for Slack to load older messages · ${cur.waitedSec ?? 0}s`,
  verifying: () => 'Verification pass',
  threads: (cur) => `Capturing threads · ${cur.threads ?? 0} done`,
};

function renderJob(state) {
  const running = Boolean(state?.running);
  $('progress').classList.toggle('hidden', !running);
  $('runDot').classList.toggle('hidden', !running);
  $('syncCurrent').disabled = running;
  $('syncSelected').disabled = running || settings.selectedChannelIds.length === 0;
  if (!running) return;
  const cur = state.current;
  const name = cur?.name ? `${cur.type === 'dm' || cur.type === 'group_dm' ? '' : '#'}${cur.name}` : '…';
  $('progressLabel').textContent = state.total > 1 ? `${name} · ${state.index + 1} of ${state.total}` : name;
  $('progressPhase').textContent = (PHASES[cur?.phase] ?? (() => 'Scrolling back through history'))(cur ?? {});
  $('progressBar').style.width = `${Math.round(((state.index + 0.5) / Math.max(1, state.total)) * 100)}%`;
  $('statInView').textContent = (cur?.collected ?? 0).toLocaleString();
  const oldest = cur?.oldestTs ? new Date(Number(cur.oldestTs) * 1000) : null;
  $('statOldest').textContent = oldest ? oldest.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' }) : '—';
  $('statOldest').title = oldest ? oldest.toLocaleString() : '';
  $('statSent').textContent = (state.sent ?? 0).toLocaleString();
  $('progressDetail').textContent = state.startedAt
    ? `Started ${new Date(state.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : '';
}

function renderLogs(logs = []) {
  $('log').innerHTML = '';
  if (!logs.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.innerHTML = '<span class="hint">No activity yet — syncs and live captures show up here.</span>';
    $('log').append(li);
  }
  for (const l of logs) {
    const li = document.createElement('li');
    li.className = l.level;
    const t = document.createElement('time');
    t.textContent = new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const s = document.createElement('span');
    s.textContent = l.text;
    li.append(t, s);
    $('log').append(li);
  }
}

function renderBackend(b) {
  const el = $('backendStatus');
  el.classList.toggle('ok', b?.ok === true);
  el.classList.toggle('bad', b?.ok === false);
  el.title = b?.ok === false ? `Backend error: ${b.error}` : 'Backend reachable';
  el.querySelector('.label').textContent = b?.ok === false ? 'Backend offline' : b?.ok ? 'Connected' : 'Backend';
}

async function renderQueue() {
  const { queue = [] } = await chrome.storage.local.get('queue');
  $('queueInfo').textContent = queue.length ? `${queue.length} queued for retry` : '';
}

// ---------------------------------------------------------------------------
// Channels tab
// ---------------------------------------------------------------------------
const ICON = { public: 'i-hash', private: 'i-lock', dm: 'i-user', group_dm: 'i-users', unknown: 'i-hash' };
const KIND = { public: '', private: 'private', dm: 'DM', group_dm: 'group DM', unknown: '' };

function svgIcon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'i');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

function visibleChannels() {
  const q = $('channelFilter').value.trim().toLowerCase();
  const t = $('typeFilter').value;
  return (channelCache?.channels ?? []).filter((c) => {
    if (q && !c.name.toLowerCase().includes(q)) return false;
    if (t === 'dms' && !['dm', 'group_dm'].includes(c.type)) return false;
    if (t === 'channels' && ['dm', 'group_dm'].includes(c.type)) return false;
    return true;
  });
}

function renderChannels() {
  const list = $('channelList');
  list.innerHTML = '';
  const rows = visibleChannels();
  $('channelsFetched').textContent = channelCache?.fetchedAt
    ? `${rows.length} of ${channelCache.channels.length} shown · ${settings.selectedChannelIds.length} selected · read ${new Date(
        channelCache.fetchedAt,
      ).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`
    : '';
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = channelCache ? 'No conversations match the filter.' : 'Open Slack, then press ↻ to read the conversations in its sidebar.';
    list.append(li);
    return;
  }
  const selected = new Set(settings.selectedChannelIds);
  for (const c of rows) {
    const li = document.createElement('li');
    li.classList.toggle('selected', selected.has(c.id));
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(c.id);
    cb.addEventListener('change', async () => {
      const ids = new Set(settings.selectedChannelIds);
      cb.checked ? ids.add(c.id) : ids.delete(c.id);
      li.classList.toggle('selected', cb.checked);
      settings = await saveSettings({ selectedChannelIds: [...ids] });
      renderSelectionCount();
    });
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.append(svgIcon(ICON[c.type] ?? 'i-hash'));
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = c.name;
    name.title = `${c.name} (${c.id})`;
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = KIND[c.type] ?? '';
    li.append(cb, icon, name, kind);
    li.addEventListener('click', (e) => {
      if (e.target !== cb) cb.click();
    });
    list.append(li);
  }
}

$('channelFilter').addEventListener('input', renderChannels);
$('typeFilter').addEventListener('change', renderChannels);
$('typeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-type]');
  if (!b) return;
  for (const x of $('typeSeg').querySelectorAll('button')) x.classList.toggle('active', x === b);
  $('typeFilter').value = b.dataset.type;
  renderChannels();
});
$('selectAll').addEventListener('click', async (e) => {
  e.preventDefault();
  const ids = new Set([...settings.selectedChannelIds, ...visibleChannels().map((c) => c.id)]);
  settings = await saveSettings({ selectedChannelIds: [...ids] });
  renderChannels();
  renderSelectionCount();
});
$('selectNone').addEventListener('click', async (e) => {
  e.preventDefault();
  const hide = new Set(visibleChannels().map((c) => c.id));
  settings = await saveSettings({ selectedChannelIds: settings.selectedChannelIds.filter((id) => !hide.has(id)) });
  renderChannels();
  renderSelectionCount();
});
$('loadChannels').addEventListener('click', async () => {
  const btn = $('loadChannels');
  btn.disabled = true;
  btn.classList.add('busy');
  $('channelsFetched').textContent = 'Reading the Slack sidebar…';
  const res = await chrome.runtime.sendMessage({ type: 'loadChannels' });
  btn.disabled = false;
  btn.classList.remove('busy');
  if (!res?.ok) $('channelsFetched').textContent = res?.error ?? 'Failed';
  ({ channelCache } = await chrome.storage.local.get('channelCache'));
  renderChannels();
});

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------
function status(id, text, kind = '') {
  const el = $(id);
  el.textContent = text;
  el.className = `status-line ${kind}`;
}

$('revealKey').addEventListener('click', () => {
  const input = $('apiKey');
  input.type = input.type === 'password' ? 'text' : 'password';
});

$('saveSettings').addEventListener('click', async () => {
  const backendUrl = $('backendUrl').value.trim().replace(/\/+$/, '') || 'http://localhost:4000';
  // Hosts other than localhost need an explicit permission grant (must happen in this click).
  try {
    const origin = `${new URL(backendUrl).origin}/*`;
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/\*$/.test(origin)) {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        status('settingsMsg', 'Permission for that host was denied.', 'bad');
        return;
      }
    }
  } catch {
    status('settingsMsg', 'Backend URL is not a valid URL.', 'bad');
    return;
  }
  settings = await saveSettings({
    backendUrl,
    apiKey: $('apiKey').value.trim(),
    collectorLabel: $('collectorLabel').value.trim(),
    scrollDelayMs: Math.min(10000, Math.max(300, Number($('scrollDelayMs').value) || 1200)),
    loadPatienceSec: Math.min(600, Math.max(10, Number($('loadPatienceSec').value) || 60)),
    verifyPass: $('verifyPass').checked,
    captureThreads: $('captureThreads').checked,
  });
  fillControls();
  status('settingsMsg', 'Saved ✓', 'ok');
  setTimeout(() => status('settingsMsg', ''), 2500);
});
$('testConnection').addEventListener('click', async () => {
  status('connMsg', 'Testing…');
  const res = await chrome.runtime.sendMessage({ type: 'testConnection' });
  status('connMsg', res?.ok ? 'Connected ✓' : `Failed: ${res?.error ?? 'no response'}`, res?.ok ? 'ok' : 'bad');
  if (res?.ok) chrome.runtime.sendMessage({ type: 'flushQueue' });
});

// ---------------------------------------------------------------------------
// Slack tab status
// ---------------------------------------------------------------------------
/** Shows when an admin has paused or revoked this browser from the dashboard. */
function renderRemote(remote) {
  const status = remote?.status ?? 'active';
  const el = $('remoteBanner');
  el.classList.toggle('hidden', status === 'active');
  el.classList.toggle('revoked', status === 'revoked');
  el.textContent =
    status === 'paused'
      ? 'Capture is paused by an admin. Syncs and live capture are off until it is resumed in the dashboard.'
      : status === 'revoked'
        ? 'This browser was revoked by an admin. The backend refuses its uploads.'
        : '';
}

function initials(name) {
  return (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

function renderAccount(account) {
  const el = $('accountAvatar');
  el.textContent = '';
  if (account?.avatarUrl && /^https:\/\//.test(account.avatarUrl)) {
    const img = document.createElement('img');
    img.src = account.avatarUrl;
    img.alt = '';
    img.onerror = () => (el.textContent = initials(account.name));
    el.append(img);
  } else {
    el.textContent = account ? initials(account.name) : '?';
  }
  el.style.background = account ? '#611f69' : '';
  $('accountName').textContent = account ? (account.name ?? account.userId) : 'Not detected';
  $('tileAccount').title = account ? `${account.name ?? 'Slack user'} (${account.userId})` : 'Reload the Slack tab to detect the signed-in user';
}

/** Real-time tile: live (messages caught), waiting (socket seen), missing (no socket), off (no tab / disabled). */
function renderRealtime(rtm, hasTab) {
  let state = 'off';
  let value = hasTab ? '—' : 'No Slack tab';
  let detail = '';
  if (!settings.liveCapture) {
    value = 'Off';
  } else if (rtm?.messages) {
    state = 'live';
    value = `Live · ${rtm.messages.toLocaleString()} caught`;
    if (rtm.lastAt) {
      const at = new Date(rtm.lastAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      detail = `Last new message ${at} — watching all channels, DMs and threads`;
    }
  } else if (rtm?.socket) {
    state = 'waiting';
    value = 'Listening';
  } else if (hasTab && rtm) {
    state = 'missing';
    value = 'Not detected';
    detail = 'Slack’s real-time feed wasn’t seen — reload the Slack tab.';
  }
  $('tileRealtime').dataset.state = state;
  $('realtimeState').textContent = value;
  $('realtimeStatus').textContent = detail;
}

let lastPing = null;

async function renderSlackStatus() {
  const tabs = await chrome.tabs.query({ url: 'https://app.slack.com/*' });
  if (!tabs.length) {
    lastPing = null;
    $('slackStatus').textContent = 'No Slack tab — open app.slack.com';
    renderAccount(null);
    renderRealtime(null, false);
    await renderCollectorInfo(null);
    return;
  }
  const info = await chrome.tabs.sendMessage(tabs[0].id, { type: 'ping' }).catch(() => null);
  lastPing = info;
  $('slackStatus').textContent = info?.channel
    ? `${info.workspace?.name ?? info.teamId} · ${info.channel.type === 'dm' ? '' : '#'}${info.channel.name}`
    : 'Slack tab found (reload it if capture fails)';
  const who = info?.account ? `${info.account.name ?? 'Slack user'} (${info.account.userId})` : 'not detected — reload the Slack tab';
  renderAccount(info?.account ?? null);
  renderRealtime(info?.rtm ?? null, true);
  await renderCollectorInfo(who);
}

async function renderCollectorInfo(who) {
  const c = await getCollector();
  $('collectorInfo').textContent = `${c.browser} · v${c.version} · install ${c.id.slice(0, 8)} · ${who ?? 'no Slack account'}`;
}

// ---------------------------------------------------------------------------
// Init + live updates
// ---------------------------------------------------------------------------
fillControls();
({ channelCache } = await chrome.storage.local.get('channelCache'));
renderChannels();
const session = await chrome.storage.session.get(['jobState', 'logs', 'backend', 'fileStats']);
renderFileStats(session.fileStats);
renderJob(session.jobState);
renderLogs(session.logs);
renderBackend(session.backend);
renderQueue();
renderSlackStatus();
setInterval(renderSlackStatus, 3000); // keeps the real-time counter fresh while the popup is open
chrome.storage.local.get('remote').then(({ remote }) => renderRemote(remote));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session') {
    if (changes.jobState) renderJob(changes.jobState.newValue);
    if (changes.logs) renderLogs(changes.logs.newValue);
    if (changes.fileStats) renderFileStats(changes.fileStats.newValue);
    if (changes.backend) renderBackend(changes.backend.newValue);
  }
  if (area === 'local' && changes.queue) renderQueue();
  if (area === 'local' && changes.remote) renderRemote(changes.remote.newValue);
});
