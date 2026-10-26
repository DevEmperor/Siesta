// Unit tests for the shared logic: node --test tests/core.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as c from "../lib/core.js";

const S = { ...c.DEFAULT_SETTINGS };
const tab = (o) => ({ id: 1, url: "https://www.teams.microsoft.com/x", active: false, discarded: false, lastAccessed: 1000, ...o });

test("host normalisation", () => {
  assert.equal(c.hostOf("https://www.github.com/a"), "github.com");
  assert.equal(c.hostOf("about:blank"), null);
  assert.equal(c.normalizeHost("Teams.Microsoft.com/foo"), "teams.microsoft.com");
  assert.equal(c.normalizeHost("  "), null);
});

test("rule priority: tab beats site beats default", () => {
  const rules = { "teams.microsoft.com": 10 };
  assert.deepEqual(c.resolveRule(tab(), 5, rules, S), { minutes: 5, source: "tab" });
  assert.equal(c.resolveRule(tab(), 0, rules, S).minutes, 0);
  assert.equal(c.resolveRule(tab(), null, rules, S).source, "site");
  assert.equal(c.resolveRule(tab({ url: "https://x.org" }), null, rules, { ...S, defaultMinutes: 30 }).minutes, 30);
});

test("status and protections", () => {
  const ctx = { override: 10, siteRules: {}, settings: S, lastLeft: { 1: 5000 } };
  const st = c.tabStatus(tab(), ctx, 6000);
  assert.equal(st.state, "counting");
  assert.equal(st.due, 5000 + 600000, "idle clock uses the later of lastLeft and lastAccessed");
  assert.equal(c.tabStatus(tab({ active: true }), ctx, 0).state, "active");
  assert.equal(c.tabStatus(tab({ discarded: true }), ctx, 0).state, "asleep");
  assert.equal(c.tabStatus(tab({ audible: true }), ctx, 0).reason, "audio");
  assert.equal(c.tabStatus(tab({ sharingState: { camera: true } }), ctx, 0).reason, "sharing");
  assert.equal(c.tabStatus(tab({ audible: true }), { ...ctx, settings: { ...S, protectAudible: false } }, 0).state, "counting");
  const pinnedDefault = { override: null, siteRules: {}, settings: { ...S, defaultMinutes: 5 }, lastLeft: {} };
  assert.equal(c.tabStatus(tab({ pinned: true }), pinnedDefault, 0).reason, "pinned");
  assert.equal(c.tabStatus(tab({ pinned: true }), { ...pinnedDefault, override: 5 }, 0).state, "counting", "an explicit rule beats pin protection");
  assert.equal(c.tabStatus(tab(), { ...ctx, settings: { ...S, paused: true } }, 0).state, "paused");
  assert.equal(c.tabStatus(tab(), { ...ctx, override: 0 }, 0).state, "untimed");
});

test("formatting", () => {
  assert.equal(c.formatClock(61000), "1:01");
  assert.equal(c.formatClock(3725000), "1:02:05");
  assert.equal(c.formatClock(-5), "0:00");
  assert.equal(c.formatMinutes(90), "1 h 30 min");
  assert.equal(c.formatMinutes(0), "never");
  assert.equal(c.chipLabel(120), "2 h");
  assert.equal(c.chipLabel(45), "45 min");
  assert.equal(c.chipLabel(0), "Never");
  assert.equal(c.formatAgo(3 * 60000), "3 min ago");
  assert.equal(c.formatAgo(26 * 3600000), "1 day ago");
  assert.equal(c.clampMinutes(99999), c.MAX_MINUTES);
  assert.equal(c.clampMinutes(-1), null);
});

test("no RAM estimate", () => {
  assert.equal("mbPerTab" in c.DEFAULT_SETTINGS, false);
});
