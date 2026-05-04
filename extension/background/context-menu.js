// ProtoConsent context menu
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  operatingMode, setOperatingMode,
  tabBlockedDomains,
} from "./state.js";
import { withWhitelist, isValidHostname } from "./storage.js";
import { rebuildAllDynamicRules } from "./rebuild.js";
import { resetBehavioralCounters } from "./blocker-detection.js";

const MENU_MODE       = "pc-mode";
const MENU_BANNERS    = "pc-banners";
const MENU_COSMETIC   = "pc-cosmetic";
const MENU_SIGNALS    = "pc-signals";
const MENU_WL_SITE    = "pc-whitelist-site";
const MENU_SETTINGS   = "pc-settings";

const SIGNAL_KEYS = ["gpcEnabled", "chStrippingEnabled", "paramStrippingEnabled", "paramStrippingSitesEnabled"];

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    const create = (props) => {
      chrome.contextMenus.create(props, () => {
        if (chrome.runtime.lastError) {
          console.warn("[ProtoConsent] contextMenus.create failed:", props.id, chrome.runtime.lastError.message);
        }
      });
    };

    create({
      id: MENU_MODE, title: "Blocking mode", type: "checkbox", checked: true,
      contexts: ["action"],
    });
    create({
      id: MENU_BANNERS, title: "Cookie banner management", type: "checkbox", checked: true,
      contexts: ["action"],
    });
    create({
      id: MENU_COSMETIC, title: "Cosmetic filters (hide ads, banners, annoyances)", type: "checkbox", checked: true,
      contexts: ["action"],
    });
    create({
      id: MENU_SIGNALS, title: "Privacy signals (GPC, Client Hints, URL params)", type: "checkbox", checked: true,
      contexts: ["action"],
    });
    create({
      id: MENU_WL_SITE, title: "Whitelist site",
      contexts: ["action"],
    });
    create({
      id: MENU_SETTINGS, title: "ProtoConsent settings",
      contexts: ["action"],
    });

    refreshMenuAndWhitelistState();
  });
}

function refreshMenuState() {
  const keys = ["cmpAutoResponse", "enhancedCosmeticEnabled", ...SIGNAL_KEYS];
  chrome.storage.local.get(keys, (data) => {
    const bannersOn = data.cmpAutoResponse !== false;
    const cosmeticOn = data.enhancedCosmeticEnabled !== false;
    let onCount = 0;
    for (const k of SIGNAL_KEYS) { if (data[k] !== false) onCount++; }
    const signalsOn = onCount === SIGNAL_KEYS.length;
    const blocking = operatingMode === "standalone";

    chrome.contextMenus.update(MENU_MODE, {
      checked: blocking,
      title: blocking ? "Blocking mode" : "Monitoring mode - not blocking",
    });
    chrome.contextMenus.update(MENU_BANNERS, {
      checked: bannersOn,
      title: bannersOn ? "Cookie banner management (enabled)" : "Cookie banner management (paused)",
    });
    chrome.contextMenus.update(MENU_COSMETIC, {
      checked: cosmeticOn,
      title: cosmeticOn ? "Cosmetic filters (hide ads, banners, annoyances)" : "Cosmetic filters (show ads, banners, annoyances)",
    });
    chrome.contextMenus.update(MENU_SIGNALS, {
      checked: signalsOn,
      title: signalsOn
        ? "Privacy signals (GPC, Client Hints, URL params)"
        : onCount > 0
          ? "Privacy signals (partial)"
          : "Privacy signals (disabled)",
    });
  });
}

function refreshMenuAndWhitelistState() {
  refreshMenuState();
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) return;
    let isWeb = false;
    try {
      const p = new URL(tabs[0].url || "").protocol;
      isWeb = p === "http:" || p === "https:";
    } catch {}
    chrome.contextMenus.update(MENU_WL_SITE, { enabled: isWeb });
  });
}

function getActiveTabDomain() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0] || !tabs[0].url) { resolve(null); return; }
      try {
        const url = new URL(tabs[0].url);
        if (url.protocol !== "http:" && url.protocol !== "https:") { resolve(null); return; }
        resolve({ tabId: tabs[0].id, domain: url.hostname.replace(/^www\./, "") });
      } catch { resolve(null); }
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === MENU_MODE) {
    const newMode = info.checked ? "standalone" : "protoconsent";
    chrome.storage.local.set({ operatingMode: newMode }, () => {
      setOperatingMode(newMode);
      resetBehavioralCounters();
      rebuildAllDynamicRules();
      refreshMenuState();
    });
    return;
  }

  if (info.menuItemId === MENU_BANNERS) {
    chrome.storage.local.set({ cmpAutoResponse: info.checked }, () => {
      refreshMenuState();
    });
    return;
  }

  if (info.menuItemId === MENU_COSMETIC) {
    chrome.storage.local.set({ enhancedCosmeticEnabled: info.checked }, () => {
      rebuildAllDynamicRules();
      refreshMenuState();
    });
    return;
  }

  if (info.menuItemId === MENU_SIGNALS) {
    const update = {};
    for (const k of SIGNAL_KEYS) { update[k] = info.checked; }
    chrome.storage.local.set(update, () => {
      rebuildAllDynamicRules();
      refreshMenuState();
    });
    return;
  }

  if (info.menuItemId === MENU_WL_SITE) {
    const tab = await getActiveTabDomain();
    if (!tab) return;
    whitelistAllForSite(tab.tabId, tab.domain);
    return;
  }

  if (info.menuItemId === MENU_SETTINGS) {
    chrome.runtime.openOptionsPage();
    return;
  }
});

chrome.tabs.onActivated.addListener(() => { refreshMenuAndWhitelistState(); });
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === "complete") refreshMenuAndWhitelistState();
});
chrome.storage.onChanged.addListener((changes) => {
  const relevant = ["operatingMode", "cmpAutoResponse", "enhancedCosmeticEnabled", ...SIGNAL_KEYS];
  if (relevant.some(k => k in changes)) refreshMenuState();
});

export function whitelistAllForSite(tabId, site) {
  if (!site || !isValidHostname(site)) return Promise.resolve({ ok: false });
  const blocked = tabBlockedDomains.get(tabId) || {};
  const entries = [];
  for (const [purpose, domains] of Object.entries(blocked)) {
    for (const domain of Object.keys(domains)) {
      entries.push({ domain, purpose });
    }
  }
  if (entries.length === 0) return Promise.resolve({ ok: true, count: 0 });

  return withWhitelist(whitelist => {
    for (const { domain, purpose } of entries) {
      if (!whitelist[domain]) whitelist[domain] = {};
      delete whitelist[domain]["*"];
      whitelist[domain][site] = purpose;
    }
    return new Promise(resolve => {
      chrome.storage.local.set({ whitelist }, () => {
        if (chrome.runtime.lastError) { resolve(); return; }
        rebuildAllDynamicRules();
        resolve();
      });
    });
  });
}

export function removeWhitelistAllForSite(site) {
  if (!site || !isValidHostname(site)) return Promise.resolve({ ok: false });
  return withWhitelist(whitelist => {
    for (const [domain, siteMap] of Object.entries(whitelist)) {
      delete siteMap[site];
      if (Object.keys(siteMap).length === 0) delete whitelist[domain];
    }
    return new Promise(resolve => {
      chrome.storage.local.set({ whitelist }, () => {
        if (chrome.runtime.lastError) { resolve(); return; }
        rebuildAllDynamicRules();
        resolve();
      });
    });
  });
}

export function clearWhitelistAll() {
  return withWhitelist(whitelist => {
    for (const [domain, siteMap] of Object.entries(whitelist)) {
      for (const key of Object.keys(siteMap)) {
        if (key === "_hotfix") continue;
        delete siteMap[key];
      }
      if (Object.keys(siteMap).length === 0) delete whitelist[domain];
    }
    return new Promise(resolve => {
      chrome.storage.local.set({ whitelist }, () => {
        if (chrome.runtime.lastError) { resolve(); return; }
        rebuildAllDynamicRules();
        resolve();
      });
    });
  });
}

setupMenus();
