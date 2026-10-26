import {
  DEFAULT_SETTINGS,
  PRESETS,
  clampMinutes,
  dayKey,
  formatMinutes,
  hostOf,
  isSharing,
  normalizeHost,
  tabStatus,
} from "./lib/core.js";

const SWEEP_ALARM = "siesta-sweep";
const NEXT_ALARM = "siesta-next";
const TAB_KEY = "minutes"; // per-tab override, kept by Firefox's session store
const SLEPT_KEY = "sleptAt"; // set when Siesta unloaded the tab
const LOG_SIZE = 40;
const KEEP_DAYS = 60;

// Serialise read-modify-write cycles on storage so concurrent events don't lose updates.
let chain = Promise.resolve();
function locked(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

async function loadState() {
  const [{ settings = {}, siteRules = {} }, { lastLeft = {} }] = await Promise.all([
    browser.storage.local.get(["settings", "siteRules"]),
    browser.storage.session.get("lastLeft"),
  ]);
  return { settings: { ...DEFAULT_SETTINGS, ...settings }, siteRules, lastLeft };
}

function emptyStats() {
  return { since: Date.now(), auto: 0, manual: 0, restored: 0, days: {}, sites: {}, log: [] };
}

async function loadStats() {
  const { stats } = await browser.storage.local.get("stats");
  return stats || emptyStats();
}

async function readTabValues(tabs, key) {
  const values = await Promise.all(
    tabs.map((t) => browser.sessions.getTabValue(t.id, key).catch(() => undefined)),
  );
  return new Map(tabs.map((t, i) => [t.id, values[i] ?? null]));
}

function markLeft(tabIds) {
  const ids = tabIds.filter((id) => id != null && id !== browser.tabs.TAB_ID_NONE);
  if (!ids.length) return Promise.resolve();
  return locked(async () => {
    const { lastLeft = {} } = await browser.storage.session.get("lastLeft");
    const now = Date.now();
    for (const id of ids) lastLeft[id] = now;
    await browser.storage.session.set({ lastLeft });
  });
}

function forgetTab(tabId) {
  return locked(async () => {
    const { lastLeft = {} } = await browser.storage.session.get("lastLeft");
    if (!(tabId in lastLeft)) return;
    delete lastLeft[tabId];
    await browser.storage.session.set({ lastLeft });
  });
}

// ---------------------------------------------------------------- unloading

function recordUnload(tab, kind) {
  return locked(async () => {
    const stats = await loadStats();
    const now = Date.now();
    const key = dayKey(now);
    const day = stats.days[key] || [0, 0];
    day[kind === "auto" ? 0 : 1] += 1;
    stats.days[key] = day;
    stats[kind] += 1;
    const host = hostOf(tab.url) || "Sonstige";
    stats.sites[host] = (stats.sites[host] || 0) + 1;
    stats.log.unshift({ t: now, kind, host, title: tab.title || host });
    stats.log.length = Math.min(stats.log.length, LOG_SIZE);
    const cutoff = dayKey(now - KEEP_DAYS * 86400000);
    for (const k of Object.keys(stats.days)) if (k < cutoff) delete stats.days[k];
    await browser.storage.local.set({ stats });
  });
}

async function discardTab(tab, kind) {
  try {
    await browser.tabs.discard(tab.id);
    const after = await browser.tabs.get(tab.id);
    if (!after.discarded) return false;
  } catch {
    return false;
  }
  await browser.sessions.setTabValue(tab.id, SLEPT_KEY, Date.now()).catch(() => {});
  await recordUnload(tab, kind);
  return true;
}

// Firefox refuses to unload the selected tab, so move to the most recently used one first.
async function discardNow(tabId) {
  const tab = await browser.tabs.get(tabId);
  if (tab.discarded) return { ok: true };
  if (tab.active) {
    const others = (await browser.tabs.query({ windowId: tab.windowId, hidden: false }))
      .filter((t) => t.id !== tab.id)
      .sort((a, b) => a.discarded - b.discarded || (b.lastAccessed || 0) - (a.lastAccessed || 0));
    if (!others.length) return { ok: false, reason: "only-tab" };
    await browser.tabs.update(others[0].id, { active: true });
  }
  const ok = await discardTab(tab, "manual");
  return ok ? { ok: true } : { ok: false, reason: "refused" };
}

async function discardAllInactive() {
  const state = await loadState();
  const tabs = await browser.tabs.query({ active: false, discarded: false });
  let count = 0;
  for (const tab of tabs) {
    if (state.settings.protectAudible && tab.audible) continue;
    if (state.settings.protectSharing && isSharing(tab)) continue;
    if (state.settings.protectPinned && tab.pinned) continue;
    if (await discardTab(tab, "manual")) count += 1;
  }
  return { ok: true, count };
}

// The sweep unloads every tab whose timer ran out and books an alarm for the next one.
// Requests that arrive while a sweep runs are folded into one follow-up pass.
let sweeping = null;
let sweepAgain = false;
function sweep() {
  if (sweeping) {
    sweepAgain = true;
    return sweeping;
  }
  sweeping = (async () => {
    do {
      sweepAgain = false;
      await runSweep().catch((e) => console.error("Siesta sweep failed", e));
    } while (sweepAgain);
  })().finally(() => {
    sweeping = null;
  });
  return sweeping;
}

async function runSweep() {
  const [state, tabs] = await Promise.all([loadState(), browser.tabs.query({})]);
  const overrides = await readTabValues(tabs, TAB_KEY);
  const now = Date.now();
  let next = Infinity;
  for (const tab of tabs) {
    const st = tabStatus(tab, { ...state, override: overrides.get(tab.id) }, now);
    if (st.state !== "counting") continue;
    if (st.due <= now + 500) await discardTab(tab, "auto");
    else next = Math.min(next, st.due);
  }
  await browser.alarms.clear(NEXT_ALARM);
  if (Number.isFinite(next)) browser.alarms.create(NEXT_ALARM, { when: next + 250 });
  await updateBadge(state.settings);
}

// ---------------------------------------------------------------- badge

async function updateBadge(settings) {
  settings ??= (await loadState()).settings;
  if (settings.paused) {
    await browser.action.setBadgeBackgroundColor({ color: "#6F6B9C" });
    await browser.action.setBadgeText({ text: "II" });
    await browser.action.setTitle({ title: "Siesta: automatisches Entladen pausiert" });
    return;
  }
  await browser.action.setTitle({ title: "Siesta" });
  if (!settings.badge) {
    await browser.action.setBadgeText({ text: "" });
    return;
  }
  const asleep = await browser.tabs.query({ discarded: true });
  await browser.action.setBadgeBackgroundColor({ color: "#7C77F0" });
  await browser.action.setBadgeTextColor({ color: "#FFFFFF" });
  await browser.action.setBadgeText({ text: asleep.length ? String(asleep.length) : "" });
}

let badgeTimer = null;
function badgeSoon() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => updateBadge().catch(() => {}), 300);
}

// ---------------------------------------------------------------- popup API

async function getState() {
  const [state, stats, tabs, windows] = await Promise.all([
    loadState(),
    loadStats(),
    browser.tabs.query({}),
    browser.windows.getAll({ windowTypes: ["normal"] }),
  ]);
  const [overrides, sleptAt] = await Promise.all([
    readTabValues(tabs, TAB_KEY),
    readTabValues(tabs, SLEPT_KEY),
  ]);
  const now = Date.now();
  const focused = windows.find((w) => w.focused)?.id ?? null;
  const list = tabs
    .filter((t) => !t.hidden)
    .map((t) => ({
      id: t.id,
      windowId: t.windowId,
      index: t.index,
      title: t.title,
      url: t.url,
      host: hostOf(t.url),
      favIconUrl: t.favIconUrl || null,
      active: t.active,
      pinned: t.pinned,
      audible: t.audible,
      discarded: t.discarded,
      override: overrides.get(t.id),
      sleptAt: sleptAt.get(t.id),
      status: tabStatus(t, { ...state, override: overrides.get(t.id) }, now),
    }));
  return {
    now,
    focusedWindowId: focused,
    windowCount: windows.length,
    settings: state.settings,
    siteRules: state.siteRules,
    stats,
    tabs: list,
  };
}

async function setTabTimer(tabIds, minutes) {
  for (const id of tabIds) {
    if (minutes == null) await browser.sessions.removeTabValue(id, TAB_KEY);
    else await browser.sessions.setTabValue(id, TAB_KEY, minutes);
  }
}

function setSiteRule(host, minutes) {
  return locked(async () => {
    const { siteRules = {} } = await browser.storage.local.get("siteRules");
    if (minutes == null) delete siteRules[host];
    else siteRules[host] = minutes;
    await browser.storage.local.set({ siteRules });
  });
}

function patchSettings(patch) {
  return locked(async () => {
    const { settings = {} } = await browser.storage.local.get("settings");
    const next = { ...DEFAULT_SETTINGS, ...settings };
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_SETTINGS) || typeof v !== typeof DEFAULT_SETTINGS[k]) continue;
      next[k] = v;
    }
    next.defaultMinutes = clampMinutes(next.defaultMinutes) ?? 0;
    next.mbPerTab = Math.min(2000, Math.max(10, Math.round(next.mbPerTab)));
    await browser.storage.local.set({ settings: next });
    return next;
  });
}

const handlers = {
  getState,
  async setTabTimer({ tabId, minutes }) {
    await setTabTimer([tabId], minutes == null ? null : clampMinutes(minutes));
  },
  async setSiteRule({ host, minutes }) {
    const h = normalizeHost(host);
    if (!h) return { ok: false, reason: "host" };
    await setSiteRule(h, minutes == null ? null : clampMinutes(minutes));
    return { ok: true, host: h };
  },
  async setSettings({ patch }) {
    return patchSettings(patch || {});
  },
  discard: ({ tabId }) => discardNow(tabId),
  discardAll: () => discardAllInactive(),
  async resetStats() {
    await locked(() => browser.storage.local.set({ stats: emptyStats() }));
  },
};

// Commands that change rules or tabs re-run the sweep so timers take effect at once.
const MUTATING = new Set(["setTabTimer", "setSiteRule", "setSettings", "discard", "discardAll"]);

browser.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== browser.runtime.id) return undefined;
  const handler = handlers[msg?.type];
  if (!handler) return undefined;
  return Promise.resolve(handler(msg)).then(async (result) => {
    if (MUTATING.has(msg.type)) await sweep();
    return result ?? { ok: true };
  });
});

// ---------------------------------------------------------------- tab context menu

const MENU_ROOT = "siesta";
const MENU_VALUES = [
  ["inherit", "Standard bzw. Website-Regel verwenden"],
  ["0", "Nie entladen"],
  ...PRESETS.map((m) => [String(m), `Nach ${formatMinutes(m)} entladen`]),
];

async function setupMenus() {
  await browser.menus.removeAll();
  browser.menus.create({ id: MENU_ROOT, title: "Siesta", contexts: ["tab"] });
  browser.menus.create({ id: "now", parentId: MENU_ROOT, title: "Jetzt entladen", contexts: ["tab"] });
  browser.menus.create({ id: "sep", parentId: MENU_ROOT, type: "separator", contexts: ["tab"] });
  for (const [value, title] of MENU_VALUES) {
    browser.menus.create({
      id: `set:${value}`,
      parentId: MENU_ROOT,
      type: "radio",
      title,
      contexts: ["tab"],
      checked: value === "inherit",
    });
  }
}

// Right-clicking one tab of a multi-selection applies the choice to all selected tabs.
async function menuTargets(tab) {
  if (!tab.highlighted) return [tab];
  const selected = await browser.tabs.query({ windowId: tab.windowId, highlighted: true });
  return selected.length ? selected : [tab];
}

browser.menus.onShown.addListener(async (info, tab) => {
  if (!info.contexts.includes("tab") || !tab) return;
  const value = await browser.sessions.getTabValue(tab.id, TAB_KEY).catch(() => undefined);
  const key = value == null ? "inherit" : String(value);
  const known = MENU_VALUES.some(([v]) => v === key);
  await Promise.all(
    MENU_VALUES.map(([v]) => browser.menus.update(`set:${v}`, { checked: known && v === key })),
  );
  browser.menus.refresh();
});

browser.menus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;
  const targets = await menuTargets(tab);
  if (info.menuItemId === "now") {
    for (const t of targets) await discardNow(t.id);
  } else if (String(info.menuItemId).startsWith("set:")) {
    const raw = String(info.menuItemId).slice(4);
    await setTabTimer(
      targets.map((t) => t.id),
      raw === "inherit" ? null : Number(raw),
    );
  }
  await sweep();
});

// ---------------------------------------------------------------- tab events

browser.tabs.onActivated.addListener(({ previousTabId }) => {
  markLeft([previousTabId]).then(sweep);
});

browser.tabs.onCreated.addListener((tab) => {
  if (!tab.active) markLeft([tab.id]).then(sweep);
  badgeSoon();
});

browser.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId);
  badgeSoon();
});

browser.tabs.onUpdated.addListener(
  async (tabId, change, tab) => {
    if (change.discarded === false) {
      const slept = await browser.sessions.getTabValue(tabId, SLEPT_KEY).catch(() => undefined);
      if (slept) {
        await browser.sessions.removeTabValue(tabId, SLEPT_KEY).catch(() => {});
        await locked(async () => {
          const stats = await loadStats();
          stats.restored += 1;
          await browser.storage.local.set({ stats });
        });
      }
    }
    // Sound or a camera/mic/screen share counts as use: restart the idle clock when it ends.
    if (!tab.active && (change.audible === false || "sharingState" in change)) {
      await markLeft([tabId]);
    }
    if ("discarded" in change) badgeSoon();
    if (!change.discarded) sweep();
  },
  { properties: ["discarded", "audible", "pinned", "url", "sharingState"] },
);

browser.tabs.onAttached.addListener(() => sweep());

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SWEEP_ALARM || alarm.name === NEXT_ALARM) sweep();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) badgeSoon();
});

browser.runtime.onInstalled.addListener(() => setupMenus());
browser.runtime.onStartup.addListener(() => setupMenus());

// Alarms don't survive a browser restart; make sure the safety sweep exists on every wake-up.
browser.alarms.get(SWEEP_ALARM).then((a) => {
  if (!a) browser.alarms.create(SWEEP_ALARM, { periodInMinutes: 1 });
});
sweep();
