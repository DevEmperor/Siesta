import {
  MAX_MINUTES,
  PRESETS,
  chipLabel,
  dayKey,
  formatAgo,
  formatClock,
  formatMinutes,
} from "../lib/core.js";

const send = (type, data = {}) => browser.runtime.sendMessage({ type, ...data });
const $ = (id) => document.getElementById(id);

let S = null; // last state snapshot from the background script
let clockSkew = 0; // background "now" minus popup "now"
let currentTabId = null;
let ownTabId = null; // set when this page is open in a normal tab instead of the popup
const ui = {
  view: "tabs",
  filter: "all",
  query: "",
  expanded: null,
  scope: {}, // tabId -> "tab" | "site"
  custom: {}, // picker key -> true while the custom field is open
  confirmReset: false,
};

// ---------------------------------------------------------------- DOM helpers

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children);
  return el;
}

const ICONS = {
  clock: ["M12 7.5V12l3 2", { circle: [12, 12, 8.2] }],
  sleep: ["M19.5 14.2A7.8 7.8 0 1 1 9.8 4.5a6.3 6.3 0 0 0 9.7 9.7Z"],
  x: ["M7 7l10 10M17 7 7 17"],
  plus: ["M12 6v12M6 12h12"],
  switchTo: ["M14 5h5v5M19 5l-8 8M10 6H6a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-4"],
};

function icon(name) {
  const [d, extra] = ICONS[name];
  const el = s("svg", { viewBox: "0 0 24 24", class: "ico", "aria-hidden": "true" });
  if (extra?.circle) {
    const [cx, cy, r] = extra.circle;
    el.append(s("circle", { cx, cy, r }));
  }
  el.append(s("path", { d }));
  return el;
}

// Waning moon: `lit` is the share of time left (1 = full moon, 0 = new moon).
function moonPath(lit, r = 9, cx = 12, cy = 12) {
  const f = Math.min(1, Math.max(0, lit));
  if (f >= 0.995) return `M${cx} ${cy - r}a${r} ${r} 0 1 0 0.001 0Z`;
  if (f <= 0.005) return "";
  const rx = Math.abs(1 - 2 * f) * r;
  const sweep = f > 0.5 ? 0 : 1;
  return `M${cx} ${cy - r}A${r} ${r} 0 0 0 ${cx} ${cy + r}A${rx} ${r} 0 0 ${sweep} ${cx} ${cy - r}Z`;
}

function moon(status, now) {
  const el = s("svg", { viewBox: "0 0 24 24", class: "moon", "aria-hidden": "true" });
  el.append(s("circle", { class: "shade", cx: 12, cy: 12, r: 9 }));
  if (status.state === "asleep") {
    // A thin lavender crescent: the moon has set.
    el.classList.add("is-asleep");
    el.append(s("path", { class: "lit", d: moonPath(0.22) }));
    return el;
  }
  const lit = s("path", { class: "lit" });
  el.append(lit);
  if (status.state === "counting") {
    el.dataset.due = status.due;
    el.dataset.total = status.total;
    updateMoon(el, now);
  } else {
    lit.setAttribute("d", moonPath(1));
    if (status.state === "active") el.prepend(s("circle", { class: "halo", cx: 12, cy: 12, r: 11 }));
    else el.classList.add("is-idle");
  }
  return el;
}

function updateMoon(el, now) {
  const left = Number(el.dataset.due) - now;
  const frac = left / Number(el.dataset.total);
  el.querySelector(".lit").setAttribute("d", moonPath(frac));
  el.classList.toggle("is-due", frac < 0.15);
}

function favicon(tab) {
  const letter = h("span", { class: "fav-letter", "aria-hidden": "true", text: (tab.host || tab.title || "?")[0].toUpperCase() });
  const url = tab.favIconUrl;
  if (!url || !/^(https?:|data:image\/)/.test(url)) return letter;
  const img = h("img", { class: "fav", src: url, alt: "", loading: "lazy" });
  img.addEventListener("error", () => img.replaceWith(letter), { once: true });
  return img;
}

// replaceChildren() would print null/false as text; skip them.
function put(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c != null && c !== false));
}

let toastTimer = null;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

// ---------------------------------------------------------------- data

const now = () => Date.now() + clockSkew;

async function refresh() {
  const state = await send("getState");
  clockSkew = state.now - Date.now();
  // The page never lists itself when it is opened in a tab.
  S = { ...state, tabs: state.tabs.filter((t) => t.id !== ownTabId) };
  render();
}

let refreshTimer = null;
function refreshSoon(delay = 120) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch(console.error), delay);
}

const tabById = (id) => S.tabs.find((t) => t.id === id);

function describeRule(rule) {
  const when = rule.minutes > 0 ? `after ${formatMinutes(rule.minutes)} without use` : null;
  const who = rule.source === "tab" ? "Own rule" : rule.source === "site" ? `Rule for ${rule.host}` : "Default";
  if (when) return [`${who}: unloads `, h("strong", { text: when }), "."];
  if (rule.source === "default") return ["Default: no automatic unloading. Pick a time for this tab or the whole site."];
  return [`${who}: `, h("strong", { text: "never" }), " unloaded automatically."];
}

function stateLine(tab) {
  const st = tab.status;
  switch (st.state) {
    case "active":
      return st.rule.minutes > 0
        ? ["You're on this tab. The countdown starts when you leave it."]
        : ["You're on this tab."];
    case "counting":
      return ["Unloads in ", h("strong", { class: "clock-text", "data-due": st.due, text: formatClock(st.due - now()) }), "."];
    case "asleep":
      return ["This tab is unloaded and reloads when you open it."];
    case "protected":
      return [protectText(st.reason)];
    case "paused":
      return ["Auto-unload is paused."];
    default:
      return [];
  }
}

function protectText(reason) {
  if (reason === "audio") return "Playing audio, so it stays loaded.";
  if (reason === "sharing") return "Sharing camera, microphone or screen, so it stays loaded.";
  return "Pinned: only unloaded with its own rule or a site rule.";
}

// ---------------------------------------------------------------- timer picker

function picker(tab, key) {
  const hasHost = Boolean(tab.host);
  const scope = ui.scope[tab.id] || (tab.override == null && hasHost && S.siteRules[tab.host] != null ? "site" : "tab");
  const current = scope === "tab" ? tab.override : (S.siteRules[tab.host] ?? null);
  const isCustom = current != null && current > 0 && !PRESETS.includes(current);
  const customOpen = Boolean(ui.custom[key]);

  const apply = async (minutes) => {
    ui.custom[key] = false;
    if (scope === "tab") {
      await send("setTabTimer", { tabId: tab.id, minutes });
    } else {
      // A site rule set from this tab should also govern this tab.
      if (tab.override != null) await send("setTabTimer", { tabId: tab.id, minutes: null });
      await send("setSiteRule", { host: tab.host, minutes });
    }
    await refresh();
  };

  const scopeBtn = (value, label, extra = {}) =>
    h("button", {
      type: "button",
      "aria-pressed": String(scope === value),
      "data-key": `${key}-scope-${value}`,
      onclick: () => {
        ui.scope[tab.id] = value;
        render();
      },
      ...extra,
    }, label);

  const chip = (minutes, label, pressed, extra = {}) =>
    h("button", {
      type: "button",
      class: extra.class ? `chip ${extra.class}` : "chip",
      "aria-pressed": String(pressed),
      "data-key": `${key}-chip-${label}`,
      title: extra.title,
      onclick: extra.onclick || (() => apply(minutes)),
    }, label);

  const chips = h("div", { class: "chips", role: "group", "aria-label": "Unload after" },
    chip(null, "Default", current == null, {
      class: "quiet",
      title: scope === "tab" ? "Use the site rule or the default" : "Remove the site rule",
    }),
    chip(0, "Never", current === 0),
    PRESETS.map((m) => chip(m, chipLabel(m), current === m)),
    chip(null, isCustom ? chipLabel(current) : "Custom", isCustom || customOpen, {
      onclick: () => {
        ui.custom[key] = !customOpen;
        render();
        $(`${key}-custom`)?.focus();
      },
    }),
  );

  let custom = null;
  if (customOpen) {
    const input = h("input", {
      id: `${key}-custom`,
      type: "number",
      min: 1,
      max: MAX_MINUTES,
      step: 1,
      value: isCustom ? current : "",
      placeholder: "45",
      "aria-label": "Minutes",
      "data-key": `${key}-custom`,
    });
    const submit = () => {
      const n = Math.round(Number(input.value));
      if (!(n >= 1 && n <= MAX_MINUTES)) {
        toast(`Enter 1 to ${MAX_MINUTES} minutes`);
        return;
      }
      apply(n);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    custom = h("div", { class: "custom" }, input, h("span", { text: "minutes" }),
      h("button", { type: "button", class: "btn", onclick: submit, "data-key": `${key}-custom-ok` }, "Apply"));
  }

  const notes = [];
  if (scope === "site") notes.push(` Site rules apply to every tab from ${tab.host}.`);
  if (scope === "site" && tab.override != null) {
    notes.push(" This tab's own rule wins until you pick a time for the site.");
  }

  return h("div", { class: "picker" },
    h("div", { class: "scope", role: "group", "aria-label": "Applies to" },
      scopeBtn("tab", "This tab only"),
      scopeBtn("site", "Whole site", {
        disabled: !hasHost,
        title: hasHost ? `Every tab from ${tab.host}` : "Site rules only work for web pages",
      }),
    ),
    chips,
    custom,
    h("p", { class: "explain" }, describeRule(tab.status.rule), notes),
  );
}

// ---------------------------------------------------------------- actions

async function unload(tab) {
  const res = await send("discard", { tabId: tab.id });
  if (res?.ok) toast("Tab unloaded");
  else if (res?.reason === "only-tab") toast("The only tab in a window can't be unloaded");
  else toast("Firefox refused to unload this tab");
  await refresh();
}

async function focusTab(tab) {
  await browser.tabs.update(tab.id, { active: true });
  await browser.windows.update(tab.windowId, { focused: true });
  window.close();
}

// ---------------------------------------------------------------- rendering

function render() {
  if (!S) return;
  const focusKey = document.activeElement?.dataset?.key;
  const scrollTop = $("main").scrollTop;

  $("auto").checked = !S.settings.paused;
  $("count-all").textContent = S.tabs.length;
  for (const btn of document.querySelectorAll(".views button")) {
    const on = btn.dataset.view === ui.view;
    btn.setAttribute("aria-selected", String(on));
    $(`view-${btn.dataset.view}`).hidden = !on;
  }

  if (ui.view === "tabs") renderTabs();
  if (ui.view === "stats") renderStats();
  if (ui.view === "settings") renderSettings();

  $("main").scrollTop = scrollTop;
  if (focusKey) document.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
}

function renderTabs() {
  const t = now();
  put($("paused-note"),
    S.settings.paused
      ? h("div", { class: "note" }, "Auto-unload is paused. You can still unload tabs by hand.",
          h("button", { type: "button", class: "btn", onclick: () => setSetting({ paused: false }), "data-key": "resume" }, "Resume"))
      : null,
  );

  // Current tab
  const cur = tabById(currentTabId);
  const nowEl = $("now");
  if (cur) {
    nowEl.hidden = false;
    put(nowEl,
      h("div", { class: "now-head" },
        moon(cur.status, t),
        h("div", { class: "now-text" },
          h("h1", { class: "now-title", text: cur.title || cur.url }),
          h("div", { class: "now-host", text: cur.host || cur.url }),
        ),
        h("button", {
          type: "button",
          class: "icon-btn solid",
          title: "Unload now",
          "aria-label": "Unload this tab now",
          disabled: cur.discarded,
          "data-key": "now-unload",
          onclick: () => unload(cur),
        }, icon("sleep")),
      ),
      h("p", { class: "now-state" }, stateLine(cur)),
      picker(cur, "now"),
    );
  } else {
    nowEl.hidden = true;
  }

  // Loaded vs unloaded
  const asleep = S.tabs.filter((x) => x.discarded);
  const awake = S.tabs.length - asleep.length;
  const bar = h("div", { class: "split-bar", role: "img", "aria-label": `${awake} geladen, ${asleep.length} entladen` });
  if (awake) bar.append(h("span", { class: "awake", style: `flex-grow:${awake}` }));
  if (asleep.length) bar.append(h("span", { class: "asleep", style: `flex-grow:${asleep.length}` }));
  if (!S.tabs.length) bar.append(h("span", { class: "none" }));
  put($("split"),
    h("div", { class: "split-legend" },
      h("span", {}, h("b", { text: awake }), "loaded"),
      h("span", {}, h("b", { text: asleep.length }), "unloaded"),
    ),
    bar,
    h("div", { class: "split-actions" },
      nextUnload(),
      h("button", {
        type: "button",
        class: "btn",
        "data-key": "unload-all",
        disabled: !S.tabs.some((x) => !x.discarded && !x.active),
        onclick: async () => {
          const res = await send("discardAll");
          toast(res.count ? `${res.count} ${res.count === 1 ? "tab" : "tabs"} unloaded` : "No other tabs to unload");
          await refresh();
        },
        title: "Unload every tab except the one open in each window",
      }, icon("sleep"), "Unload inactive"),
    ),
  );

  for (const btn of $("filter").children) btn.setAttribute("aria-pressed", String(btn.dataset.filter === ui.filter));

  // List
  const q = ui.query.trim().toLowerCase();
  const visible = S.tabs.filter((x) => {
    if (ui.filter === "awake" && x.discarded) return false;
    if (ui.filter === "asleep" && !x.discarded) return false;
    if (!q) return true;
    return `${x.title} ${x.url}`.toLowerCase().includes(q);
  });

  const order = { counting: 0, active: 1, protected: 2, paused: 2, untimed: 3 };
  const loaded = visible
    .filter((x) => !x.discarded)
    .sort((a, b) => {
      const oa = order[a.status.state];
      const ob = order[b.status.state];
      if (oa !== ob) return oa - ob;
      if (oa === 0) return a.status.due - b.status.due;
      return a.windowId - b.windowId || a.index - b.index;
    });
  const unloaded = visible
    .filter((x) => x.discarded)
    .sort((a, b) => (b.sleptAt || 0) - (a.sleptAt || 0) || a.index - b.index);

  const list = $("list");
  list.replaceChildren();
  if (!visible.length) {
    list.append(h("p", { class: "empty", text: q ? "No tab matches your search." : ui.filter === "asleep" ? "No tabs are unloaded right now." : "No tabs." }));
    return;
  }
  if (loaded.length) list.append(group("Loaded", loaded, t));
  if (unloaded.length) list.append(group("Unloaded", unloaded, t));
}

// The tab whose timer runs out first, with a live countdown.
function nextUnload() {
  const next = S.tabs
    .filter((x) => x.status.state === "counting")
    .sort((a, b) => a.status.due - b.status.due)[0];
  if (!next) return h("p", { text: "No timer running" });
  const label = next.title || next.url;
  return h("p", { title: label },
    "Next in ",
    h("span", { class: "clock-text", "data-due": next.status.due, text: formatClock(next.status.due - now()) }),
    ": ", label);
}

function group(title, tabs, t) {
  return h("section", {},
    h("h2", { class: "group" }, title, h("span", { text: tabs.length })),
    h("ul", { class: "rows" }, tabs.map((tab) => row(tab, t))),
  );
}

function metaFor(tab, t) {
  const st = tab.status;
  if (st.state === "counting") {
    return h("span", { class: "clock", "data-due": st.due, text: formatClock(st.due - t) });
  }
  const words = {
    active: "active",
    untimed: "no timer",
    paused: "paused",
    protected: { audio: "playing", sharing: "sharing", pinned: "pinned" }[st.reason],
    asleep: tab.sleptAt ? formatAgo(t - tab.sleptAt) : "unloaded",
  };
  return h("span", { text: words[st.state] });
}

function rulePill(rule) {
  if (rule.source === "default") {
    return rule.minutes > 0 ? h("span", { class: "pill default", title: "Default time", text: chipLabel(rule.minutes) }) : null;
  }
  const title = rule.source === "tab" ? "This tab's own rule" : `Rule for ${rule.host}`;
  return h("span", { class: `pill ${rule.source}`, title, text: chipLabel(rule.minutes) });
}

function row(tab, t) {
  const open = ui.expanded === tab.id;
  const label = tab.title || tab.url;
  const li = h("li", {},
    h("div", { class: `row${tab.discarded ? " asleep" : ""}${open ? " open" : ""}` },
      h("button", {
        type: "button",
        class: "row-main",
        title: `${label}\n${tab.url}`,
        "data-key": `row-${tab.id}`,
        onclick: () => focusTab(tab),
      },
        favicon(tab),
        h("span", { class: "row-text" },
          h("span", { class: "row-title", text: label }),
          h("span", { class: "row-sub" },
            h("span", { class: "host", text: tab.host || tab.url.split(":")[0] }),
            rulePill(tab.status.rule),
          ),
        ),
        h("span", { class: "row-meta" }, metaFor(tab, t), moon(tab.status, t)),
      ),
      h("div", { class: "row-tools" },
        tab.discarded
          ? null
          : h("button", {
              type: "button",
              class: "icon-btn quick",
              title: "Unload now",
              "aria-label": `Unload ${label} now`,
              "data-key": `unload-${tab.id}`,
              onclick: () => unload(tab),
            }, icon("sleep")),
        h("button", {
          type: "button",
          class: "icon-btn",
          title: "Set timer",
          "aria-label": `Set timer for ${label}`,
          "aria-expanded": String(open),
          "data-key": `edit-${tab.id}`,
          onclick: () => {
            ui.expanded = open ? null : tab.id;
            render();
          },
        }, icon("clock")),
      ),
    ),
  );
  if (open) {
    li.append(h("div", { class: "editor" },
      picker(tab, `row${tab.id}`),
      h("div", { class: "editor-actions" },
        h("button", { type: "button", class: "btn", onclick: () => focusTab(tab), "data-key": `go-${tab.id}` }, icon("switchTo"), "Go to tab"),
        tab.discarded
          ? null
          : h("button", { type: "button", class: "btn primary", onclick: () => unload(tab), "data-key": `unload2-${tab.id}` }, icon("sleep"), "Unload now"),
      ),
    ));
  }
  return li;
}

// ---------------------------------------------------------------- statistics

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function renderStats() {
  const st = S.stats;
  const t = now();
  const asleep = S.tabs.filter((x) => x.discarded).length;
  const total = st.auto + st.manual;
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const ts = t - i * 86400000;
    const [auto = 0, manual = 0] = st.days[dayKey(ts)] || [];
    days.push({ ts, auto, manual, label: i === 0 ? "Today" : WEEKDAYS[new Date(ts).getDay()] });
  }
  const week = days.reduce((a, d) => a + d.auto + d.manual, 0);
  const today = days[6].auto + days[6].manual;
  const max = Math.max(1, ...days.map((d) => d.auto + d.manual));

  const lead = asleep
    ? h("p", { class: "lead", text: `${asleep} of ${S.tabs.length} tabs ${asleep === 1 ? "is" : "are"} unloaded right now.` })
    : h("p", { class: "lead", text: "No tabs are unloaded right now." });

  const tip = h("div", { class: "tip", hidden: true });
  const bars = h("div", { class: "bars" },
    days.map((d) => {
      const sum = d.auto + d.manual;
      const bar = h("div", {
        class: "bar",
        tabindex: 0,
        "aria-label": `${d.label}: ${sum} unloaded, ${d.auto} automatically and ${d.manual} by hand`,
      },
        d.auto ? h("span", { class: `seg auto${d.manual ? "" : " top"}`, style: `height:${(d.auto / max) * 86}%` }) : null,
        d.manual ? h("span", { class: "seg manual top", style: `height:${(d.manual / max) * 86}%` }) : null,
        sum ? h("span", { class: "val", text: sum }) : null,
      );
      const show = () => {
        const box = bar.getBoundingClientRect();
        const host = bars.parentElement.getBoundingClientRect();
        tip.replaceChildren(h("strong", { text: d.label === "Today" ? "Today" : new Date(d.ts).toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "short" }) }),
          h("br"), `${d.auto} automatic`, h("br"), `${d.manual} by hand`);
        tip.style.left = `${box.left - host.left + box.width / 2}px`;
        tip.style.top = `${box.top - host.top + 6}px`;
        tip.hidden = false;
      };
      bar.addEventListener("mouseenter", show);
      bar.addEventListener("focus", show);
      bar.addEventListener("mouseleave", () => (tip.hidden = true));
      bar.addEventListener("blur", () => (tip.hidden = true));
      return bar;
    }),
  );

  const sites = Object.entries(st.sites).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topN = sites[0]?.[1] || 1;
  const restoredShare = total ? Math.round((st.restored / total) * 100) : 0;

  put($("view-stats"),
    lead,
    h("h2", { text: "Unloads in the last 7 days" }),
    h("div", { class: "chart" },
      h("div", { class: "chart-legend" },
        h("span", { style: "--c: var(--chart-auto)", text: "automatic" }),
        h("span", { style: "--c: var(--chart-manual)", text: "by hand" }),
      ),
      bars,
      h("div", { class: "bar-labels" }, days.map((d, i) => h("span", { class: i === 6 ? "today" : null, text: d.label }))),
      tip,
    ),
    h("dl", { class: "facts" },
      h("div", {}, h("dt", { text: "today" }), h("dd", { text: today })),
      h("div", {}, h("dt", { text: "last 7 days" }), h("dd", { text: week })),
      h("div", {}, h("dt", { text: `total since ${new Date(st.since).toLocaleDateString("en-US", { day: "numeric", month: "short" })}` }), h("dd", { text: total })),
      h("div", {}, h("dt", { text: "reopened later" }), h("dd", { text: `${restoredShare}%` })),
    ),
    h("h2", { text: "Unloaded most often" }),
    sites.length
      ? h("ul", { class: "sites" }, sites.map(([host, n]) =>
          h("li", {}, h("span", { text: host }), h("span", { class: "n", text: n }),
            h("span", { class: "track" }, h("span", { style: `width:${(n / topN) * 100}%` })))))
      : h("p", { class: "empty", text: "Sites show up here once tabs get unloaded." }),
    h("h2", { text: "Recently unloaded" }),
    st.log.length
      ? h("ul", { class: "log" }, st.log.slice(0, 12).map((e) =>
          h("li", {},
            h("span", { class: "t", text: e.title }),
            h("span", { class: "when", text: formatAgo(t - e.t) }),
            h("span", { class: "how", text: `${e.host}, ${e.kind === "auto" ? "automatic" : "by hand"}` }))))
      : h("p", { class: "empty", text: "Nothing yet." }),
    h("div", { class: "reset" },
      h("button", {
        type: "button",
        class: "btn danger",
        "data-key": "reset",
        onclick: async () => {
          if (!ui.confirmReset) {
            // Second click within a few seconds confirms.
            ui.confirmReset = true;
            render();
            setTimeout(() => {
              if (!ui.confirmReset) return;
              ui.confirmReset = false;
              render();
            }, 4000);
            return;
          }
          ui.confirmReset = false;
          await send("resetStats");
          toast("Stats reset");
          await refresh();
        },
      }, ui.confirmReset ? "Really reset?" : "Reset stats"),
    ),
  );
}

// ---------------------------------------------------------------- settings

async function setSetting(patch) {
  await send("setSettings", { patch });
  await refresh();
}

function toggle(key, title, help) {
  const id = `set-${key}`;
  return h("label", { class: "toggle", for: id },
    h("span", { text: title }),
    help ? h("small", { text: help }) : null,
    h("input", {
      id,
      type: "checkbox",
      class: "switch",
      role: "switch",
      checked: S.settings[key],
      "data-key": id,
      onchange: (e) => setSetting({ [key]: e.target.checked }),
    }),
  );
}

function defaultPicker() {
  const current = S.settings.defaultMinutes;
  const isCustom = current > 0 && !PRESETS.includes(current);
  const open = ui.custom.default || isCustom;
  const chip = (minutes, label) =>
    h("button", {
      type: "button",
      class: "chip",
      "aria-pressed": String(current === minutes),
      "data-key": `def-${label}`,
      onclick: () => {
        ui.custom.default = false;
        setSetting({ defaultMinutes: minutes });
      },
    }, label);
  const input = h("input", { type: "number", min: 1, max: MAX_MINUTES, value: isCustom ? current : "", placeholder: "45", "aria-label": "Minutes", "data-key": "def-custom", id: "def-custom" });
  const submit = () => {
    const n = Math.round(Number(input.value));
    if (!(n >= 1 && n <= MAX_MINUTES)) return toast(`Enter 1 to ${MAX_MINUTES} minutes`);
    ui.custom.default = false;
    setSetting({ defaultMinutes: n });
  };
  input.addEventListener("keydown", (e) => e.key === "Enter" && submit());
  return h("div", {},
    h("div", { class: "chips" },
      chip(0, "Never"),
      PRESETS.map((m) => chip(m, chipLabel(m))),
      h("button", {
        type: "button",
        class: "chip",
        "aria-pressed": String(open),
        "data-key": "def-Eigene",
        onclick: () => {
          ui.custom.default = !open;
          render();
          $("def-custom")?.focus();
        },
      }, isCustom ? chipLabel(current) : "Custom"),
    ),
    open ? h("div", { class: "custom" }, input, h("span", { text: "minutes" }), h("button", { type: "button", class: "btn", onclick: submit }, "Apply")) : null,
  );
}

function minutesSelect(value, onchange, label) {
  const values = [0, ...PRESETS];
  if (!values.includes(value)) values.push(value);
  values.sort((a, b) => a - b);
  return h("select", { "aria-label": label, onchange: (e) => onchange(Number(e.target.value)) },
    values.map((m) => h("option", { value: m, selected: m === value }, m > 0 ? `after ${formatMinutes(m)}` : "never")));
}

function renderSettings() {
  const rules = Object.entries(S.siteRules).sort((a, b) => a[0].localeCompare(b[0]));
  const hostInput = h("input", { type: "text", placeholder: "e.g. teams.microsoft.com", "aria-label": "Site", "data-key": "rule-host", spellcheck: "false" });
  let newMinutes = 10;
  const addRule = async () => {
    const res = await send("setSiteRule", { host: hostInput.value, minutes: newMinutes });
    if (!res.ok) return toast("That's not a valid site address");
    toast(`Rule for ${res.host} saved`);
    await refresh();
  };
  hostInput.addEventListener("keydown", (e) => e.key === "Enter" && addRule());


  put($("view-settings"),
    h("section", { class: "setting" },
      h("h2", { text: "Default for all other tabs" }),
      h("p", { text: "Applies to tabs without their own rule or a site rule." }),
      defaultPicker(),
    ),
    h("section", { class: "setting" },
      h("h2", { text: "Site rules" }),
      h("p", { text: "Apply to every tab of a site, also after a restart." }),
      rules.length
        ? h("ul", { class: "rules" }, rules.map(([host, m]) =>
            h("li", {},
              h("span", { class: "host", text: host, title: host }),
              minutesSelect(m, async (v) => {
                await send("setSiteRule", { host, minutes: v });
                await refresh();
              }, `Time for ${host}`),
              h("button", {
                type: "button",
                class: "icon-btn",
                title: "Remove rule",
                "aria-label": `Remove rule for ${host}`,
                onclick: async () => {
                  await send("setSiteRule", { host, minutes: null });
                  await refresh();
                },
              }, icon("x")))))
        : null,
      h("div", { class: "add-rule" },
        hostInput,
        minutesSelect(newMinutes, (v) => (newMinutes = v), "Time for the new rule"),
        h("button", { type: "button", class: "icon-btn", title: "Add rule", "aria-label": "Add rule", onclick: addRule }, icon("plus")),
      ),
    ),
    h("section", { class: "setting" },
      h("h2", { text: "Don't unload when …" }),
      toggle("protectAudible", "… a tab is playing audio", "Music, videos and calls keep running."),
      toggle("protectSharing", "… a tab shares your camera, microphone or screen"),
      toggle("protectPinned", "… a tab is pinned", "Only affects the default time; a tab's own rule or a site rule still applies."),
    ),
    h("section", { class: "setting" },
      h("h2", { text: "Display" }),
      toggle("badge", "Show the number of unloaded tabs on the toolbar icon"),
    ),
    h("section", { class: "setting about" },
      `Siesta ${browser.runtime.getManifest().version}. Also in the tab context menu: right-click any tab. `,
      h("a", { href: "https://github.com/DevEmperor/Siesta", target: "_blank", rel: "noopener" }, "Source code and help on GitHub"),
      ".",
    ),
  );
}

// ---------------------------------------------------------------- live updates

function tick() {
  const t = now();
  for (const el of document.querySelectorAll("[data-due]")) {
    if (el.tagName === "svg") updateMoon(el, t);
    else el.textContent = formatClock(Number(el.dataset.due) - t);
  }
}

function wire() {
  $("auto").addEventListener("change", (e) => setSetting({ paused: !e.target.checked }));
  for (const btn of document.querySelectorAll(".views button")) {
    btn.addEventListener("click", () => {
      ui.view = btn.dataset.view;
      ui.confirmReset = false;
      $("main").scrollTop = 0;
      render();
    });
  }
  $("search").addEventListener("input", (e) => {
    ui.query = e.target.value;
    render();
  });
  $("filter").addEventListener("click", (e) => {
    const f = e.target.closest("button")?.dataset.filter;
    if (!f) return;
    ui.filter = f;
    render();
  });

  const props = ["discarded", "audible", "pinned", "title", "favIconUrl", "url", "sharingState"];
  browser.tabs.onUpdated.addListener(() => refreshSoon(), { properties: props });
  browser.tabs.onRemoved.addListener(() => refreshSoon());
  browser.tabs.onCreated.addListener(() => refreshSoon());
  browser.tabs.onActivated.addListener(() => refreshSoon(250));
  browser.storage.onChanged.addListener(() => refreshSoon());

  setInterval(tick, 1000);
  setInterval(() => refreshSoon(0), 15000);
}

async function init() {
  // ?tab=<id> lets the popup page be opened in a normal tab for one specific tab.
  ownTabId = (await browser.tabs.getCurrent())?.id ?? null;
  const forced = Number(new URLSearchParams(location.search).get("tab"));
  if (forced) {
    currentTabId = forced;
  } else {
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    currentTabId = active?.id ?? null;
  }
  wire();
  await refresh();
}

init().catch((e) => {
  console.error(e);
  document.body.append(h("p", { class: "empty", text: "Siesta couldn't load. Please open the popup again." }));
});
