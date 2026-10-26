// End-to-end test in a headless Firefox (WebDriver BiDi via puppeteer-core).
//
//   npm run test:e2e                         run the checks (takes about 90 s)
//   node tests/e2e.mjs --shots <dir> [--dark] render the demo screenshots instead
//
// Needs Firefox 142+ on PATH (or FIREFOX=/path/to/firefox).
import { execSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UUID = "5e1e57a0-0000-4000-8000-000000000001";
const argv = process.argv.slice(2);
const SHOTS = argv.includes("--shots") ? path.resolve(argv[argv.indexOf("--shots") + 1]) : null;
const DARK = argv.includes("--dark");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// BiDi may not open or capture moz-extension pages, so the test runs a copy of the
// add-on that opens its popup page in a tab and may use tabs.captureTab.
function testCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "siesta-e2e-"));
  for (const f of ["manifest.json", "background.js", "lib", "popup", "icons", "fonts"]) {
    fs.cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
  }
  fs.appendFileSync(
    path.join(dir, "background.js"),
    '\nbrowser.runtime.onInstalled.addListener(() => browser.tabs.create({ url: "/popup/popup.html", active: false }));\n',
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  manifest.host_permissions = ["<all_urls>"];
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

// Local pages with a title and a coloured letter favicon, served under made-up host names.
const SITES = {
  teams: ["teams.microsoft.com", "Chat | Microsoft Teams", "#4b53bc"],
  github: ["github.com", "Pull requests · acme/webshop", "#24292f"],
  wikipedia: ["en.wikipedia.org", "Siesta – Wikipedia", "#5f6368"],
  gmail: ["mail.google.com", "Inbox (12) – Gmail", "#d93025"],
  youtube: ["www.youtube.com", "Lo-fi beats to study to – YouTube", "#ff0033"],
  stackoverflow: ["stackoverflow.com", "How do I discard a tab from a WebExtension? – Stack Overflow", "#f48024"],
  python: ["docs.python.org", "asyncio — Asynchronous I/O — Python 3.14 documentation", "#3776ab"],
  weather: ["www.weather.gov", "7-day forecast for Portland, OR", "#0b8043"],
  news: ["www.theguardian.com", "Live: the latest news – The Guardian", "#052962"],
};
const HOSTS = Object.values(SITES).map(([host]) => host);

const server = http.createServer((req, res) => {
  const host = (req.headers.host || "").split(":")[0];
  const site = Object.values(SITES).find(([h]) => h === host) || [host, host, "#666"];
  if (req.url.startsWith("/fav.svg")) {
    res.writeHead(200, { "content-type": "image/svg+xml" });
    const letter = host.replace(/^(www|en|mail|docs)\./, "")[0].toUpperCase();
    res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="${site[2]}"/><text x="8" y="12" font-size="10" font-family="sans-serif" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text></svg>`);
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>${site[1]}</title><link rel="icon" href="/fav.svg"><h1>${site[1]}</h1>`);
});

let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures += 1;
}

async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const firefox = process.env.FIREFOX || execSync("command -v firefox").toString().trim();
  const browser = await puppeteer.launch({
    browser: "firefox",
    executablePath: firefox,
    headless: true,
    args: ["-remote-allow-system-access"],
    extraPrefsFirefox: {
      "extensions.webextensions.uuids": JSON.stringify({ "siesta@devemperor.net": UUID }),
      "network.dns.localDomains": HOSTS.join(","),
      "network.stricttransportsecurity.preloadlist": false,
      "dom.security.https_only_mode": false,
      "layout.css.prefers-color-scheme.content-override": DARK ? 0 : 1,
      "ui.systemUsesDarkTheme": DARK ? 1 : 0,
    },
  });

  try {
    await browser.installExtension(testCopy());

    const keys = SHOTS ? Object.keys(SITES) : ["teams", "github", "wikipedia", "gmail", "youtube", "stackoverflow", "python"];
    const [first] = await browser.pages();
    for (const [i, key] of keys.entries()) {
      const page = i === 0 ? first : await browser.newPage();
      await page.goto(`http://${SITES[key][0]}:${port}/`);
    }

    const ctx = { ctl: await findExtensionPage(browser) };
    ctx.rebind = async () => {
      ctx.ctl = await findExtensionPage(browser);
    };
    const api = (fn, ...a) => ctx.ctl.evaluate(fn, ...a);
    const send = (type, data = {}) => api((m) => browser.runtime.sendMessage(m), { type, ...data });
    const activate = (id) => api((x) => browser.tabs.update(x, { active: true }), id);
    const tabs = await api(() => browser.tabs.query({}));
    const idOf = (key) => tabs.find((t) => t.url.includes(SITES[key][0])).id;
    const ctlId = tabs.find((t) => t.url.startsWith("moz-extension")).id;
    Object.assign(ctx, { api, send, activate, idOf, ctlId });

    if (SHOTS) await demo(ctx);
    else await checks(ctx);
  } finally {
    await browser.close();
    server.close();
  }
}

async function findExtensionPage(browser) {
  for (let i = 0; i < 30; i++) {
    for (const page of await browser.pages()) {
      const href = await page.evaluate(() => location.href).catch(() => "");
      if (href.startsWith("moz-extension://")) return page;
    }
    await sleep(500);
  }
  throw new Error("extension page not found");
}

async function open(ctl, query = "") {
  await ctl.evaluate((q) => {
    location.href = `/popup/popup.html${q}`;
  }, query).catch(() => {});
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const ok = await ctl
      .evaluate((q) => location.search === q && document.readyState === "complete" && !!document.querySelector("#list"), query)
      .catch(() => false);
    if (ok) return;
  }
  throw new Error("popup page did not load");
}

async function checks({ ctl, api, send, activate, idOf, ctlId }) {
  const tab = (id) => api((x) => browser.tabs.get(x), id);
  await open(ctl);

  // Firefox keeps lastAccessed at the moment a tab was left.
  await activate(idOf("teams"));
  await sleep(2000);
  const leftAt = Date.now();
  await activate(ctlId);
  await sleep(1000);
  const left = await tab(idOf("teams"));
  check(Math.abs(left.lastAccessed - leftAt) < 1000, "lastAccessed marks the moment the tab was left");

  await send("setTabTimer", { tabId: idOf("teams"), minutes: 1 });
  const site = await send("setSiteRule", { host: "https://github.com/foo", minutes: 1 });
  check(site.ok && site.host === "github.com", `site rule is normalised to ${site.host}`);
  await send("setTabTimer", { tabId: idOf("wikipedia"), minutes: 0 });

  let st = await send("getState");
  const status = (key) => st.tabs.find((t) => t.id === idOf(key)).status;
  check(status("teams").state === "counting" && status("teams").rule.source === "tab", "teams counts down with its own rule");
  check(status("github").state === "counting" && status("github").rule.source === "site", "github counts down via the site rule");
  check(status("wikipedia").state === "untimed" && status("wikipedia").rule.source === "tab", "wikipedia has its own rule 'never'");
  check(status("gmail").state === "untimed", "gmail has no timer (default is off)");
  check(st.tabs.find((t) => t.id === ctlId).status.state === "active", "the popup tab is active");

  log("waiting 65 s for the 1-minute timers");
  await sleep(65000);
  st = await send("getState");
  const asleep = (key) => st.tabs.find((t) => t.id === idOf(key)).discarded;
  check(asleep("teams"), "teams was unloaded after 1 min");
  check(asleep("github"), "github was unloaded via the site rule");
  check(!asleep("wikipedia"), "wikipedia ('never') stays loaded");
  check(!asleep("gmail"), "gmail (no timer) stays loaded");
  check(st.stats.auto === 2, `2 automatic unloads counted (got ${st.stats.auto})`);
  check((await api(() => browser.action.getBadgeText({}))) === "2", "the toolbar badge shows 2");

  let r = await send("discard", { tabId: idOf("stackoverflow") });
  check(r.ok && (await tab(idOf("stackoverflow"))).discarded, "unloads a background tab by hand");

  await activate(idOf("python"));
  await sleep(500);
  r = await send("discard", { tabId: idOf("python") });
  const py = await tab(idOf("python"));
  check(r.ok && py.discarded && !py.active, "unloading the active tab switches away first");

  await activate(idOf("teams"));
  await sleep(2500);
  st = await send("getState");
  check(!asleep("teams"), "teams reloads when activated");
  check(st.stats.restored === 1, `1 reopened tab counted (got ${st.stats.restored})`);
  check(st.stats.manual === 2, `2 unloads by hand counted (got ${st.stats.manual})`);

  await activate(ctlId);
  await sleep(300);
  r = await send("discardAll");
  st = await send("getState");
  check(st.tabs.filter((t) => !t.discarded).length === 1, `'unload inactive' leaves only the active tab (unloaded ${r.count})`);

  await send("setSettings", { patch: { paused: true } });
  check((await api(() => browser.action.getBadgeText({}))) === "II", "pausing shows II on the toolbar badge");
  await api(() => browser.storage.local.get("settings").then(({ settings }) => browser.storage.local.set({ settings: { ...settings, mbPerTab: 120 } })));
  await send("setSettings", { patch: { paused: false, bogus: 1, badge: "x" } });
  st = await send("getState");
  const saved = await api(() => browser.storage.local.get("settings").then((x) => x.settings));
  check(!("bogus" in st.settings) && st.settings.badge === true, "settings ignore unknown keys and wrong types");
  check(!("mbPerTab" in saved), "settings from older versions are dropped");
  check((await api((id) => browser.sessions.getTabValue(id, "minutes"), idOf("teams"))) === 1, "the tab rule lives in the session store");

  await open(ctl, `?tab=${idOf("teams")}`);
  const errors = await ctl.evaluate(() => document.body.textContent.includes("couldn't load"));
  check(!errors, "the popup renders without errors");
}

// A realistic scene for the README and store screenshots.
async function demo(ctx) {
  const { api, send, activate, idOf } = ctx;
  fs.mkdirSync(SHOTS, { recursive: true });
  const suffix = DARK ? "-dark" : "";
  const shot = async (name) => {
    await sleep(400);
    const data = await api(
      (id) => browser.tabs.captureTab(id, { rect: { x: 0, y: 0, width: 384, height: 590 }, scale: 2 }),
      ctx.ctlId,
    );
    fs.writeFileSync(path.join(SHOTS, `${name}${suffix}.png`), Buffer.from(data.split(",")[1], "base64"));
    log("saved", `${name}${suffix}.png`);
  };

  // The popup gets its own window so Teams can stay the active tab of the main window.
  await api((id) => browser.windows.create({ tabId: id, width: 900, height: 900 }), ctx.ctlId).catch(() => {});
  await sleep(1000);
  await ctx.rebind();
  for (const key of ["youtube", "python", "news"]) await send("discard", { tabId: idOf(key) });
  await send("setSettings", { patch: { defaultMinutes: 60 } });
  await send("setTabTimer", { tabId: idOf("teams"), minutes: 10 });
  await send("setTabTimer", { tabId: idOf("gmail"), minutes: 5 });
  await send("setTabTimer", { tabId: idOf("stackoverflow"), minutes: 3 });
  await send("setTabTimer", { tabId: idOf("wikipedia"), minutes: 0 });
  await send("setSiteRule", { host: "github.com", minutes: 30 });
  await activate(idOf("teams"));

  await api(() => {
    const day = (offset) => {
      const x = new Date(Date.now() - offset * 86400000);
      return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
    };
    const vals = [[6, 2], [11, 1], [4, 0], [9, 3], [14, 2], [7, 1], [5, 3]];
    const days = Object.fromEntries(vals.map((v, i) => [day(6 - i), v]));
    const min = 60000;
    const log = [
      { t: Date.now() - 4 * min, kind: "auto", host: "teams.microsoft.com", title: "Chat | Microsoft Teams" },
      { t: Date.now() - 19 * min, kind: "auto", host: "github.com", title: "Issues · acme/webshop" },
      { t: Date.now() - 47 * min, kind: "auto", host: "www.youtube.com", title: "Conference talk: The event loop, explained – YouTube" },
      { t: Date.now() - 95 * min, kind: "manual", host: "mail.google.com", title: "Inbox (9) – Gmail" },
      { t: Date.now() - 180 * min, kind: "auto", host: "teams.microsoft.com", title: "Calendar | Microsoft Teams" },
    ];
    return browser.storage.local.get("stats").then(({ stats }) =>
      browser.storage.local.set({
        stats: {
          ...stats,
          since: Date.now() - 6 * 86400000,
          auto: 56,
          manual: 12,
          restored: 17,
          days,
          sites: { "teams.microsoft.com": 21, "www.youtube.com": 14, "github.com": 11, "mail.google.com": 7, "en.wikipedia.org": 4 },
          log: [...stats.log, ...log],
        },
      }),
    );
  });

  log("letting the timers run for 150 s");
  await sleep(150000);

  const ctl = ctx.ctl;
  await open(ctl, `?tab=${idOf("teams")}`);
  await shot("popup-tabs");
  await ctl.evaluate(() => document.getElementById("main").scrollTo(0, 318));
  await shot("popup-list");
  await ctl.evaluate((id) => document.querySelector(`[data-key="edit-${id}"]`).click(), idOf("gmail"));
  await ctl.evaluate((id) => {
    document.querySelector(`[data-key="edit-${id}"]`).closest("li").scrollIntoView({ block: "start" });
    document.getElementById("main").scrollBy(0, -52); // room for the sticky search bar
  }, idOf("gmail"));
  await shot("popup-editor");
  await ctl.evaluate(() => document.getElementById("tab-stats").click());
  await shot("popup-stats");
  await ctl.evaluate(() => document.getElementById("tab-settings").click());
  await shot("popup-settings");
}

main()
  .catch((e) => {
    console.error(e);
    failures += 1;
  })
  .finally(() => {
    if (!SHOTS) console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
    process.exit(failures ? 1 : 0);
  });
