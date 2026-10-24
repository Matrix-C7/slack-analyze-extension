// Slack History Capture — background service worker.
// Orchestrates sync jobs across channels, forwards captured batches to the backend,
// keeps a retry queue when the backend is unreachable, and runs timed auto-sync.

import { DEFAULT_SETTINGS, cutoffFromRange, getCollector, getSettings, saveSettings } from './shared.js';

const SLACK_URL = 'https://app.slack.com/*';
const QUEUE_LIMIT = 2000;
const LOG_LIMIT = 80;

// ---------------------------------------------------------------------------
// Job state (mirrored to chrome.storage.session so the popup can render it)
// ---------------------------------------------------------------------------

let job = null; // { id, trigger, channels, index, current, sent, startedAt, stopRequested }

async function publishState(patch = {}) {
  const state = {
    running: Boolean(job),
    trigger: job?.trigger ?? null,
    index: job?.index ?? 0,
    total: job?.channels.length ?? 0,
    current: job?.current ?? null,
    sent: job?.sent ?? 0,
    startedAt: job?.startedAt ?? null,
    ...patch,
  };
  await chrome.storage.session.set({ jobState: state });
}

async function log(level, text) {
  const { logs = [] } = await chrome.storage.session.get('logs');
  logs.unshift({ at: Date.now(), level, text });
  await chrome.storage.session.set({ logs: logs.slice(0, LOG_LIMIT) });
}

// ---------------------------------------------------------------------------
// Backend I/O
// ---------------------------------------------------------------------------

async function api(path, { method = 'POST', body } = {}) {
  const s = await getSettings();
  const res = await fetch(`${s.backendUrl.replace(/\/+$/, '')}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(s.apiKey ? { 'X-API-Key': s.apiKey } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`${res.status} ${res.statusText} ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function setBackendStatus(ok, error = null) {
  await chrome.storage.session.set({ backend: { ok, error, at: Date.now() } });
}

async function enqueue(path, body, method) {
  const { queue = [] } = await chrome.storage.local.get('queue');
  queue.push({ path, body, method, at: Date.now() });
  await chrome.storage.local.set({ queue: queue.slice(-QUEUE_LIMIT) });
}

/** Sends to the backend; on network/server failure the payload is queued for retry. */
async function deliver(path, body, method = 'POST') {
  try {
    const result = await api(path, { method, body });
    await setBackendStatus(true);
    return result;
  } catch (err) {
    await setBackendStatus(false, String(err.message || err));
    // 4xx (other than auth/timeouts) means the payload itself is bad; retrying won't help.
    if (err.status && err.status >= 400 && err.status < 500 && ![401, 408, 429].includes(err.status)) {
      await log('error', `Backend rejected ${path}: ${err.message}`);
      return null;
    }
    await enqueue(path, body, method);
    return null;
  }
}

/** Tags a payload with this install and the Slack account it was captured as (multi-browser capture). */
async function withSource(body, account) {
  return { ...body, source: { collector: await getCollector(), account: account ?? null } };
}

/** Tells the backend which Slack accounts this browser is signed in to right now (one call per open workspace). */
async function sendHeartbeats() {
  const tabs = await chrome.tabs.query({ url: SLACK_URL });
  const targets = [];
  const seen = new Set();
  for (const tab of tabs) {
    const p = await ping(tab.id);
    if (!p?.teamId || seen.has(p.teamId)) continue;
    seen.add(p.teamId);
    targets.push(p);
  }
  // No Slack tab: still check in, so the dashboard sees the browser and its commands get delivered.
  if (!targets.length) targets.push(null);
  for (const p of targets) {
    try {
      const res = await api('/api/ingest/heartbeat', { body: await withSource({ workspace: p?.workspace ?? null }, p?.account) });
      await setBackendStatus(true);
      await applyHeartbeat(res, p?.teamId);
    } catch (err) {
      await setBackendStatus(false, String(err.message || err));
      if (err.status === 403) await setRemoteStatus('revoked');
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Admin control (from the dashboard, delivered with each heartbeat)
// ---------------------------------------------------------------------------

async function setRemoteStatus(status) {
  const { remote = {} } = await chrome.storage.local.get('remote');
  if ((remote.status ?? 'active') !== status) await log(status === 'active' ? 'info' : 'warn', `Admin set this browser to: ${status}`);
  await chrome.storage.local.set({ remote: { ...remote, status, at: Date.now() } });
}

async function remoteState() {
  const { remote = {} } = await chrome.storage.local.get('remote');
  return { status: remote.status ?? 'active', excluded: remote.excluded ?? {} };
}

async function applyHeartbeat(res, teamId) {
  const { remote = {} } = await chrome.storage.local.get('remote');
  const excluded = { ...(remote.excluded ?? {}) };
  if (teamId) excluded[teamId] = res.excludedChannelIds ?? [];
  await chrome.storage.local.set({ remote: { ...remote, excluded } });
  await setRemoteStatus(res.status ?? 'active');
  if (res.status !== 'active' && job) await stopJob();
  if (res.commands?.length) {
    const { commandQueue = [] } = await chrome.storage.local.get('commandQueue');
    const known = new Set(commandQueue.map((c) => c.id));
    for (const c of res.commands) if (!known.has(c.id)) commandQueue.push(c);
    await chrome.storage.local.set({ commandQueue });
  }
  processCommands();
}

async function reportCommand(id, status, result) {
  await api(`/api/ingest/commands/${id}`, { body: { status, result: String(result ?? '').slice(0, 4000) } }).catch(() => {});
}

let processingCommands = false;
/** Runs queued admin commands one at a time. "stop" and settings changes run even while a sync is busy. */
async function processCommands() {
  if (processingCommands) return;
  processingCommands = true;
  try {
    for (;;) {
      const { commandQueue = [] } = await chrome.storage.local.get('commandQueue');
      const idx = commandQueue.findIndex((c) => !job || c.type === 'stop' || c.type === 'set_settings');
      if (idx < 0) return; // only syncs left and one is running: picked up on a later heartbeat
      const [cmd] = commandQueue.splice(idx, 1);
      await chrome.storage.local.set({ commandQueue });
      await log('info', `Admin command: ${cmd.type.replace('_', ' ')}`);
      try {
        let r;
        if (cmd.type === 'stop') {
          const wasRunning = Boolean(job);
          await stopJob();
          r = { ok: true, summary: wasRunning ? 'stop requested' : 'nothing was running' };
        } else if (cmd.type === 'set_settings') {
          await saveSettings(cmd.payload ?? {});
          r = { ok: true, summary: `updated ${Object.keys(cmd.payload ?? {}).join(', ') || 'nothing'}` };
        } else if (cmd.type === 'refresh_channels') {
          const res = await loadChannels();
          r = { ok: res.ok, summary: res.ok ? `${res.count} conversations found` : res.error };
        } else if (cmd.type === 'sync_open' || cmd.type === 'sync_channels') {
          const res = await runJob('manual', cmd.type === 'sync_channels' ? (cmd.payload?.channelIds ?? []) : null);
          r = { ok: res.ok, summary: res.ok ? res.summary : res.error };
        } else {
          r = { ok: false, summary: `unknown command ${cmd.type}` };
        }
        await reportCommand(cmd.id, r.ok ? 'done' : 'failed', r.summary);
      } catch (e) {
        await reportCommand(cmd.id, 'failed', e?.message || e);
      }
    }
  } finally {
    processingCommands = false;
  }
}

let flushing = false;
async function flushQueue() {
  if (flushing) return;
  flushing = true;
  try {
    const { queue = [] } = await chrome.storage.local.get('queue');
    if (!queue.length) return;
    let sent = 0;
    for (const item of queue) {
      try {
        await api(item.path, { method: item.method ?? 'POST', body: item.body });
        sent++;
      } catch (err) {
        await setBackendStatus(false, String(err.message || err));
        break;
      }
    }
    // Re-read so items queued while we were flushing are kept.
    const { queue: latest = [] } = await chrome.storage.local.get('queue');
    await chrome.storage.local.set({ queue: latest.slice(sent) });
    if (sent) {
      await setBackendStatus(true);
      await log('info', `Delivered ${sent} queued batch(es)`);
    }
  } finally {
    flushing = false;
  }
}

// ---------------------------------------------------------------------------
// File archive: download files attached to captured messages with this browser's
// Slack session and upload them to the backend. The backend leases each file to one
// browser at a time, so several browsers on the same workspace never fetch it twice.
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;
const FILE_BATCH = 4; // files claimed (and downloaded in parallel) per round
const FILE_ROUNDS = 25; // rounds per pump; the next alarm continues where this one stopped

class FileError extends Error {
  constructor(message, { status = null, tooLarge = false } = {}) {
    super(message);
    this.status = status;
    this.tooLarge = tooLarge;
  }
}

/** Session counters shown in the popup. Numbers are added; other values replace. */
async function updateFileStats(patch) {
  const { fileStats = {} } = await chrome.storage.session.get('fileStats');
  const next = { stored: 0, bytes: 0, failed: 0, skipped: 0, ...fileStats };
  for (const [k, v] of Object.entries(patch)) next[k] = typeof v === 'number' && k !== 'lastAt' ? next[k] + v : v;
  await chrome.storage.session.set({ fileStats: next });
}

/** Reads a response body, giving up as soon as it passes the size limit. */
async function readLimited(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (declared > maxBytes) throw new FileError('larger than the size limit', { tooLarge: true });
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new FileError('larger than the size limit', { tooLarge: true });
    }
    chunks.push(value);
  }
  return new Blob(chunks, { type: res.headers.get('content-type') || '' });
}

/**
 * Downloads a files.slack.com URL. First from the worker (host permission: no CORS, Slack cookies sent);
 * if that is refused or returns Slack's sign-in page, from inside the Slack tab, where the session always applies.
 */
async function downloadSlackFile(url, maxBytes, tabId, expectHtml) {
  let firstError;
  try {
    const res = await fetch(url, { credentials: 'include', redirect: 'follow' });
    if (!res.ok) throw new FileError(`${res.status} ${res.statusText}`, { status: res.status });
    if (!expectHtml && /text\/html/i.test(res.headers.get('content-type') || '')) throw new FileError('Slack returned a sign-in page');
    return await readLimited(res, maxBytes);
  } catch (err) {
    if (err.tooLarge || err.status === 404 || err.status === 410) throw err;
    firstError = err;
  }
  if (!tabId) throw firstError;
  const r = await chrome.tabs
    .sendMessage(tabId, { type: 'fetchFile', url, maxBytes })
    .catch((e) => ({ ok: false, error: String(e.message || e) }));
  if (!r?.ok) throw new FileError(r?.error || firstError.message, { status: r?.status ?? firstError.status, tooLarge: r?.tooLarge });
  if (!expectHtml && /text\/html/i.test(r.type)) throw new FileError('Slack returned a sign-in page');
  const bin = atob(r.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: r.type });
}

async function uploadFile(file, blob, variant) {
  const s = await getSettings();
  const collector = await getCollector();
  const res = await fetch(`${s.backendUrl.replace(/\/+$/, '')}/api/ingest/files/${file.id}/content?variant=${variant}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-File-Type': (blob.type || file.mimeType || '').split(';')[0].trim(),
      'X-Collector-Id': collector.id,
      ...(s.apiKey ? { 'X-API-Key': s.apiKey } : {}),
    },
    body: blob,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new FileError(`upload ${res.status}: ${text.slice(0, 200)}`, { status: res.status, tooLarge: res.status === 413 });
  }
  return res.json();
}

/** Downloads one claimed file (original, else Slack's preview) and uploads it; reports what went wrong otherwise. */
async function archiveFile(file, ctx) {
  const tooBigForOriginal = file.size != null && file.size > ctx.maxBytes;
  const sources = [];
  if (file.downloadUrl && !tooBigForOriginal) sources.push({ url: file.downloadUrl, variant: 'original' });
  if (file.thumbUrl) sources.push({ url: file.thumbUrl, variant: 'preview' });

  const errors = [];
  for (const src of sources) {
    let blob;
    try {
      blob = await downloadSlackFile(src.url, ctx.maxBytes, ctx.tabId, /\.html?$/i.test(file.name || ''));
    } catch (err) {
      errors.push(err);
      continue;
    }
    try {
      const res = await uploadFile(file, blob, src.variant);
      await updateFileStats({ stored: 1, bytes: res.alreadyStored ? 0 : blob.size, lastAt: Date.now() });
      return true;
    } catch (err) {
      // Backend unreachable or failing: leave the lease to expire so the file is retried later.
      if (!err.status || err.status >= 500) throw err;
      errors.push(err);
    }
  }

  const tooLarge = tooBigForOriginal || (errors.length > 0 && errors.every((e) => e.tooLarge));
  const gone = errors.some((e) => e.status === 404 || e.status === 410);
  const limit = `${ctx.maxBytes / MB} MB`;
  const error = !sources.length
    ? `larger than ${limit} and Slack has no preview`
    : tooLarge
      ? `larger than ${limit}`
      : errors.map((e) => e.message).join('; ') || 'download failed';
  await api(`/api/ingest/files/${file.id}/failure`, {
    body: await withSource({ error, retryable: !gone && !tooLarge, skip: tooLarge }, ctx.account),
  }).catch(() => {});
  await updateFileStats(tooLarge ? { skipped: 1 } : { failed: 1, lastError: `${file.name || 'file'}: ${error}` });
  return false;
}

let filePump = null;
/** Works through the backend's download queue for every open Slack workspace. Single-flight. */
function pumpFiles() {
  filePump ??= runFilePump()
    .catch((err) => log('warn', `File archive paused: ${err.message || err}`))
    .finally(async () => {
      filePump = null;
      await updateFileStats({ running: false });
    });
  return filePump;
}

async function runFilePump() {
  const s = await getSettings();
  if (!s.archiveFiles || !s.fileTypes?.length) return;
  if ((await remoteState()).status !== 'active') return;
  const maxBytes = Math.max(1, Number(s.fileMaxMb) || DEFAULT_SETTINGS.fileMaxMb) * MB;

  const targets = new Map();
  for (const tab of await chrome.tabs.query({ url: SLACK_URL })) {
    const p = await ping(tab.id);
    if (p?.teamId && !targets.has(p.teamId)) targets.set(p.teamId, { tabId: tab.id, account: p.account ?? null });
  }
  if (!targets.size) return;

  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  let stored = 0;
  try {
    for (const [workspaceId, target] of targets) {
      for (let round = 0; round < FILE_ROUNDS; round++) {
        const { files = [] } = await api('/api/ingest/files/claim', {
          body: await withSource({ workspaceId, kinds: s.fileTypes, maxBytes, limit: FILE_BATCH }, target.account),
        });
        if (!files.length) break;
        await updateFileStats({ running: true });
        const results = await Promise.all(files.map((f) => archiveFile(f, { ...target, maxBytes })));
        stored += results.filter(Boolean).length;
      }
    }
  } finally {
    clearInterval(keepAlive);
  }
  if (stored) await log('info', `Archived ${stored} file(s)`);
}

// ---------------------------------------------------------------------------
// Slack tab helpers
// ---------------------------------------------------------------------------

async function findSlackTab() {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: SLACK_URL });
  if (active) return active;
  const tabs = await chrome.tabs.query({ url: SLACK_URL });
  return tabs[0] ?? null;
}

async function ping(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'ping' });
  } catch {
    return null;
  }
}

async function waitForContent(tabId, channelId, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const p = await ping(tabId);
    if (p?.ok && (!channelId || p.channelId === channelId)) return p;
    await new Promise((r) => setTimeout(r, 750));
  }
  return null;
}

async function navigateTo(tab, teamId, channelId) {
  const res = await chrome.tabs.sendMessage(tab.id, { type: 'openChannel', channelId }).catch(() => null);
  if (res?.ok) return true;
  // Not in the (virtualized) sidebar: load the channel URL directly.
  await chrome.tabs.update(tab.id, { url: `https://app.slack.com/client/${teamId}/${channelId}` });
  return Boolean(await waitForContent(tab.id, channelId));
}

// ---------------------------------------------------------------------------
// Sync jobs
// ---------------------------------------------------------------------------

/**
 * @param {'manual'|'auto'} trigger
 * @param {string[]|null} channelIds  null = just the channel currently open in Slack
 */
async function runJob(trigger, channelIds) {
  if (job) return { ok: false, error: 'A sync is already running' };
  const remote = await remoteState();
  if (remote.status !== 'active') {
    await log('warn', `Sync refused: this browser is ${remote.status} by an admin.`);
    return { ok: false, error: `browser is ${remote.status}` };
  }
  const tab = await findSlackTab();
  if (!tab) {
    await log('error', 'No Slack tab found. Open https://app.slack.com and sign in.');
    return { ok: false, error: 'No Slack tab open' };
  }
  const p = await waitForContent(tab.id, null, 10000);
  if (!p?.teamId) {
    await log('error', 'Slack tab is not ready (open a channel first, or reload the tab).');
    return { ok: false, error: 'Slack tab not ready' };
  }

  const settings = await getSettings();
  const { channelCache } = await chrome.storage.local.get('channelCache');
  const known = new Map((channelCache?.channels ?? []).map((c) => [c.id, c]));
  const excluded = new Set(remote.excluded[p.teamId] ?? []);
  const requested = channelIds?.length
    ? channelIds.map((id) => known.get(id) ?? { id, name: id, type: 'unknown' })
    : [p.channel ?? { id: p.channelId, name: p.channelId, type: 'unknown' }];
  const channels = requested.filter((c) => !excluded.has(c.id));
  if (channels.length < requested.length) await log('warn', `Skipped ${requested.length - channels.length} conversation(s) excluded by an admin`);
  if (!channels.length) return { ok: false, error: 'every requested conversation is excluded' };
  let failures = 0;
  let threadReplies = 0;

  job = { id: crypto.randomUUID(), trigger, channels, index: 0, current: null, sent: 0, startedAt: Date.now(), stopRequested: false };
  await publishState();
  await log('info', `${trigger === 'auto' ? 'Auto' : 'Manual'} sync started: ${channels.length} conversation(s)`);
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  // A long sync must not lose its tab to Chrome's memory saver.
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});

  try {
    await flushQueue();
    const { syncMarks = {} } = await chrome.storage.local.get('syncMarks');
    const rangeCutoff = cutoffFromRange(settings.rangeValue, settings.rangeUnit);

    for (let i = 0; i < channels.length && !job.stopRequested; i++) {
      const ch = channels[i];
      job.index = i;
      job.current = { id: ch.id, name: ch.name, collected: 0, oldestTs: null };
      await publishState();

      const ok = await navigateTo(tab, p.teamId, ch.id);
      if (!ok) {
        await log('error', `Could not open ${ch.name}`);
        continue;
      }

      // Auto runs are incremental: stop at the newest message we already hold (minus 1h overlap).
      let cutoffTs = rangeCutoff;
      const markKey = `${p.teamId}/${ch.id}`;
      if (trigger === 'auto' && settings.incremental && syncMarks[markKey]) {
        cutoffTs = Math.max(rangeCutoff ?? 0, Number(syncMarks[markKey]) - 3600);
      }

      const runId = crypto.randomUUID();
      const live = await ping(tab.id);
      await deliver(
        '/api/ingest/runs',
        await withSource(
          {
            id: runId,
            workspace: live?.workspace ?? { id: p.teamId },
            channel: live?.channel ?? ch,
            trigger,
            rangeFrom: cutoffTs ? new Date(cutoffTs * 1000).toISOString() : null,
          },
          live?.account ?? p.account,
        ),
      );

      const result = await chrome.tabs
        .sendMessage(tab.id, {
          type: 'scrape',
          channelId: ch.id,
          cutoffTs: cutoffTs ? String(cutoffTs) : null,
          runId,
          scrollDelayMs: settings.scrollDelayMs,
          patienceSec: settings.loadPatienceSec,
          verifyPass: settings.verifyPass,
          captureThreads: settings.captureThreads,
        })
        .catch((e) => ({ ok: false, error: String(e.message || e) }));

      const status = !result?.ok ? 'failed' : result.aborted || job.stopRequested ? 'cancelled' : 'completed';
      await deliver(`/api/ingest/runs/${runId}`, {
        status,
        error: result?.ok ? null : result?.error,
        oldestSeenAt: result?.oldestTs ? new Date(Number(result.oldestTs) * 1000).toISOString() : null,
      }, 'PATCH');

      if (result?.ok) {
        // Remember the newest ts we hold for incremental auto-sync.
        const { syncMarks: marks = {} } = await chrome.storage.local.get('syncMarks');
        if (job.newestByChannel?.[ch.id]) marks[markKey] = job.newestByChannel[ch.id];
        await chrome.storage.local.set({ syncMarks: marks });
        const why = result.reachedStart ? 'reached channel start' : result.reachedCutoff ? 'reached date range' : 'no more history loaded';
        const notes = [];
        if (result.verifiedExtra) notes.push(`${result.verifiedExtra} recovered by verification pass`);
        if (result.gaps) notes.push(`${result.gaps} scroll jump(s) re-read`);
        if (result.slowLoads) notes.push(`${result.slowLoads} slow load(s)`);
        await log('info', `${ch.name}: ${result.collected} messages (${why})${notes.length ? ` — ${notes.join(', ')}` : ''}`);
        // Stopped without reaching the channel start or the date range: Slack may just have been too slow.
        if (result.stopReason === 'no_more_history' && !result.aborted) {
          await log('warn', `${ch.name}: Slack stopped loading older messages after ${settings.loadPatienceSec}s — history may be incomplete. Re-sync, or raise "Load patience" in Settings.`);
        }
        threadReplies += result.threadReplies ?? 0;
        if (result.threadErrors || result.threadsIncomplete) {
          await log('warn', `${ch.name}: ${result.threadErrors ?? 0} thread(s) could not be opened, ${result.threadsIncomplete ?? 0} captured partly — retried on the next sync.`);
        }
        if (result.partialLeft) {
          await log('warn', `${ch.name}: ${result.partialLeft} message(s) were still loading when captured — re-sync to complete them.`);
        }
        if (result.unresolvedGaps) {
          await log('warn', `${ch.name}: ${result.unresolvedGaps} gap(s) could not be re-read — re-sync this conversation.`);
        }
      } else {
        failures++;
        await log('error', `${ch.name}: ${result?.error ?? 'unknown error'}`);
      }
    }
    const summary = `${job.sent} messages sent (${threadReplies} thread replies) from ${channels.length} conversation(s)${failures ? `, ${failures} failed` : ''}`;
    await log('info', job.stopRequested ? 'Sync stopped' : `Sync finished — ${summary}`);
    await chrome.storage.local.set({ lastSyncAt: Date.now() });
    return { ok: true, summary: job.stopRequested ? `stopped — ${summary}` : summary };
  } finally {
    clearInterval(keepAlive);
    await chrome.tabs.update(tab.id, { autoDiscardable: true }).catch(() => {});
    job = null;
    await publishState();
    // Admin sync commands that arrived while this job ran.
    setTimeout(processCommands, 0);
  }
}

async function stopJob() {
  if (!job) return;
  job.stopRequested = true;
  const tab = await findSlackTab();
  if (tab) await chrome.tabs.sendMessage(tab.id, { type: 'abort' }).catch(() => {});
}

async function loadChannels() {
  const tab = await findSlackTab();
  if (!tab) return { ok: false, error: 'No Slack tab open' };
  const res = await chrome.tabs.sendMessage(tab.id, { type: 'listChannels' }).catch((e) => ({ error: String(e.message || e) }));
  if (!res?.channels) return { ok: false, error: res?.error ?? 'Could not read the Slack sidebar (reload the Slack tab)' };
  await chrome.storage.local.set({ channelCache: { ...res, fetchedAt: Date.now() } });
  if (res.workspace?.id) {
    await deliver('/api/ingest/channels', await withSource({ workspace: res.workspace, channels: res.channels }, res.account));
  }
  await log('info', `Loaded ${res.channels.length} conversations from the sidebar`);
  return { ok: true, count: res.channels.length };
}

// ---------------------------------------------------------------------------
// Alarms: auto-sync + queue retry
// ---------------------------------------------------------------------------

async function scheduleAlarms() {
  const s = await getSettings();
  await chrome.alarms.clear('autoSync');
  if (s.autoEnabled) {
    chrome.alarms.create('autoSync', { periodInMinutes: Math.max(5, Number(s.autoIntervalMinutes) || 60), delayInMinutes: 1 });
  }
  if (!(await chrome.alarms.get('flushQueue'))) chrome.alarms.create('flushQueue', { periodInMinutes: 0.5 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'flushQueue') {
    await flushQueue();
    await sendHeartbeats();
    return pumpFiles();
  }
  if (alarm.name === 'autoSync') {
    const s = await getSettings();
    if (!s.autoEnabled || job) return;
    await runJob('auto', s.selectedChannelIds.length ? s.selectedChannelIds : null);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...settings } });
  await scheduleAlarms();
});
chrome.runtime.onStartup.addListener(scheduleAlarms);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  scheduleAlarms();
  const { oldValue, newValue } = changes.settings;
  const archiveChanged =
    !oldValue?.archiveFiles || String(oldValue.fileTypes) !== String(newValue.fileTypes) || oldValue.fileMaxMb !== newValue.fileMaxMb;
  if (newValue?.archiveFiles && archiveChanged) pumpFiles();
});

// ---------------------------------------------------------------------------
// Messages from popup and content script
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const reply = (promise) => {
    promise.then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  };

  switch (msg?.type) {
    // --- from content script ---
    case 'batch':
    case 'live': {
      const body = {
        workspace: msg.workspace,
        channel: msg.channel,
        runId: msg.runId ?? null,
        reachedStart: msg.reachedStart ?? false,
        origin: msg.origin ?? 'dom', // 'rtm' = from Slack's real-time socket (any conversation, not just the open one)
        messages: msg.messages,
      };
      return reply(
        (async () => {
          // Live capture respects admin controls; history batches are already gated in runJob.
          if (msg.type === 'live') {
            const remote = await remoteState();
            if (remote.status !== 'active' || (remote.excluded[msg.workspace?.id] ?? []).includes(msg.channel?.id)) return { ok: false };
          }
          const res = await deliver('/api/ingest/messages', await withSource(body, msg.account));
          if (res?.filesPending) pumpFiles();
          if (job && msg.type === 'batch') {
            job.sent += msg.messages.length;
            const newest = msg.messages.reduce((max, m) => (Number(m.ts) > Number(max ?? 0) ? m.ts : max), null);
            if (newest) {
              job.newestByChannel ??= {};
              const prev = job.newestByChannel[msg.channel.id];
              if (!prev || Number(newest) > Number(prev)) job.newestByChannel[msg.channel.id] = newest;
            }
            await publishState();
          }
          if (msg.type === 'live' && msg.messages.length) {
            await log('info', `Live${msg.origin === 'rtm' ? ' (real-time)' : ''}: ${msg.messages.length} message(s) from ${msg.channel.name}`);
          }
          return { ok: Boolean(res) };
        })(),
      );
    }
    case 'progress':
      if (job?.current && job.current.id === msg.channelId) {
        job.current = {
          ...job.current,
          collected: msg.collected,
          oldestTs: msg.oldestTs,
          phase: msg.phase ?? null,
          waitedSec: msg.waitedSec ?? null,
          threads: msg.threads ?? null,
        };
        publishState();
      }
      return false;

    // --- from popup ---
    case 'syncCurrent':
      runJob('manual', null);
      sendResponse({ ok: true });
      return false;
    case 'syncSelected':
      runJob('manual', msg.channelIds);
      sendResponse({ ok: true });
      return false;
    case 'stop':
      return reply(stopJob().then(() => ({ ok: true })));
    case 'loadChannels':
      return reply(loadChannels());
    case 'flushQueue':
      return reply(flushQueue().then(() => ({ ok: true })));
    case 'pumpFiles':
      pumpFiles();
      sendResponse({ ok: true });
      return false;
    case 'testConnection':
      return reply(
        api('/api/ingest/ping', { method: 'GET' })
          .then(async () => {
            await setBackendStatus(true);
            await sendHeartbeats();
            return { ok: true };
          })
          .catch(async (e) => {
            await setBackendStatus(false, String(e.message || e));
            return { ok: false, error: String(e.message || e) };
          }),
      );
  }
  return false;
});
