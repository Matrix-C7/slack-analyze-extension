// Shared between the background worker and the popup (both load this as an ES module).

export const DEFAULT_SETTINGS = {
  backendUrl: 'http://localhost:4000',
  apiKey: '',
  rangeValue: 30,
  rangeUnit: 'days', // 'days' | 'months' | 'all'
  selectedChannelIds: [],
  autoEnabled: false,
  autoIntervalMinutes: 60,
  incremental: true,
  liveCapture: true,
  keepSlackActive: true, // re-select the Slack tab in its window when another tab is selected, so Chrome doesn't throttle or discard it
  keepSlackActiveMinutes: 5,
  scrollDelayMs: 1200, // minimum wait after each scroll step; the scraper also waits for Slack to finish rendering
  loadPatienceSec: 60, // keep waiting this long for older history before deciding there is none
  verifyPass: true, // after scrolling up, scroll back down once to pick up rows that rendered late
  captureThreads: true, // open each thread with replies and capture the replies
  collectorLabel: '', // name for this browser install, shown in the web UI (e.g. "Edge — Jane's laptop")
  archiveFiles: true, // download attached files with this browser's Slack session and store them in the backend
  fileTypes: ['image', 'video', 'pdf', 'doc', 'other'], // which kinds to archive
  fileMaxMb: 50, // larger files keep only Slack's preview image (when there is one)
};

/** Best-effort browser name; Chromium forks mostly report themselves via userAgentData brands. */
export function browserName() {
  if (navigator.brave) return 'Brave';
  const brands = (navigator.userAgentData?.brands ?? []).map((b) => b.brand);
  for (const [brand, name] of [['Microsoft Edge', 'Edge'], ['Opera', 'Opera'], ['Vivaldi', 'Vivaldi'], ['Google Chrome', 'Chrome']]) {
    if (brands.includes(brand)) return name;
  }
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  return 'Chromium';
}

/**
 * Identity of this extension install. Each browser (or browser profile) gets its own id, so the backend
 * can tell several installs apart even when they capture the same workspace.
 */
export async function getCollector() {
  let { collectorId } = await chrome.storage.local.get('collectorId');
  if (!collectorId) {
    collectorId = crypto.randomUUID();
    await chrome.storage.local.set({ collectorId });
  }
  const s = await getSettings();
  return {
    id: collectorId,
    label: s.collectorLabel || null,
    browser: browserName(),
    version: chrome.runtime.getManifest().version,
  };
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

/** Oldest Slack ts (epoch seconds) to capture, or null for all history. */
export function cutoffFromRange(value, unit) {
  const n = Number(value);
  if (unit === 'all' || !n || n < 0) return null;
  const d = new Date();
  if (unit === 'months') d.setMonth(d.getMonth() - n);
  else d.setDate(d.getDate() - n);
  return Math.floor(d.getTime() / 1000);
}
