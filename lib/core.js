// Shared logic for the background script and the popup: defaults, rule
// resolution, per-tab status and German formatting helpers.

export const PRESETS = [5, 10, 15, 30, 60, 120];

export const DEFAULT_SETTINGS = {
  defaultMinutes: 0, // 0 = never unload tabs without their own rule
  paused: false,
  protectAudible: true,
  protectSharing: true,
  protectPinned: true, // pinned tabs only unload with a tab or site rule
  badge: true,
};

export const MAX_MINUTES = 24 * 60;

export function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function normalizeHost(input) {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) return null;
  const withScheme = /^[a-z]+:\/\//.test(raw) ? raw : `https://${raw}`;
  return hostOf(withScheme);
}

export function clampMinutes(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, MAX_MINUTES);
}

// Which timer applies to a tab: its own setting beats a site rule beats the default.
export function resolveRule(tab, override, siteRules, settings) {
  if (override != null) return { minutes: override, source: "tab" };
  const host = hostOf(tab.url);
  if (host && siteRules[host] != null) return { minutes: siteRules[host], source: "site", host };
  return { minutes: settings.defaultMinutes, source: "default" };
}

export function isSharing(tab) {
  const s = tab.sharingState;
  return Boolean(s && (s.camera || s.microphone || s.screen));
}

export function idleSince(tab, lastLeft) {
  return Math.max(lastLeft[tab.id] || 0, tab.lastAccessed || 0);
}

// States: active, asleep, protected (reason), untimed, paused, counting.
export function tabStatus(tab, ctx, now) {
  const rule = resolveRule(tab, ctx.override, ctx.siteRules, ctx.settings);
  const s = ctx.settings;
  if (tab.discarded) return { state: "asleep", rule };
  if (tab.active) return { state: "active", rule };
  if (s.protectSharing && isSharing(tab)) return { state: "protected", reason: "sharing", rule };
  if (s.protectAudible && tab.audible) return { state: "protected", reason: "audio", rule };
  if (!(rule.minutes > 0)) return { state: "untimed", rule };
  if (rule.source === "default" && tab.pinned && s.protectPinned) {
    return { state: "protected", reason: "pinned", rule };
  }
  if (s.paused) return { state: "paused", rule };
  const total = rule.minutes * 60000;
  const since = idleSince(tab, ctx.lastLeft);
  return { state: "counting", rule, since, total, due: since + total };
}

export function dayKey(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function formatMinutes(min) {
  if (!(min > 0)) return "nie";
  if (min < 60) return `${min} Min.`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} Std. ${rest} Min.` : `${h} Std.`;
}

export function chipLabel(min) {
  if (!(min > 0)) return "Nie";
  if (min < 60) return `${min} min`;
  return min % 60 ? formatMinutes(min) : `${min / 60} h`;
}

export function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function formatAgo(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 45) return "gerade eben";
  const min = Math.round(sec / 60);
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.round(min / 60);
  if (h < 24) return `vor ${h} Std.`;
  const d = Math.round(h / 24);
  return d === 1 ? "vor 1 Tag" : `vor ${d} Tagen`;
}

export function formatSpan(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} Min.`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} Std.`;
  return `${Math.round(h / 24)} Tagen`;
}
