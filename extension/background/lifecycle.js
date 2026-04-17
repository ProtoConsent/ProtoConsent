// ProtoConsent background lifecycle events
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Tab navigation/removal cleanup, onStartup rebuild and onInstalled
// handler (rebuild + first-install onboarding redirect).

import {
  tabBlockedDomains, tabGpcDomains, tabParamStrips, tabTcfData, tabCosmeticData, tabCmpData,
  tabCmpDetectData, tabGppData,
  tabNavigating, tabLastUrl,
  tabCoverageMetrics,
  unattributedBuffer,
} from "./state.js";
import { scheduleSessionPersist } from "./session.js";
import { rebuildAllDynamicRules } from "./rebuild.js";
import { onNavigation, applyWarningBadgeForTab } from "./blocker-detection.js";
import { clearPendingNavUrl } from "./tracking.js";
import { DEBUG_RULES } from "./config-bridge.js";

// Clear per-tab tracking on navigation and tab close.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    if (!tabNavigating.has(tabId)) {
      tabNavigating.add(tabId);
      onNavigation(tabId, tabCoverageMetrics, changeInfo.url);
      tabBlockedDomains.delete(tabId);
      tabGpcDomains.delete(tabId);
      tabParamStrips.delete(tabId);
      tabTcfData.delete(tabId);
      tabCosmeticData.delete(tabId);
      tabCmpData.delete(tabId);
      tabCmpDetectData.delete(tabId);
      tabGppData.delete(tabId);
      tabCoverageMetrics.delete(tabId);
      // Remove stale unattributed entries for this tab
      for (let i = unattributedBuffer.length - 1; i >= 0; i--) {
        if (unattributedBuffer[i].tabId === tabId) unattributedBuffer.splice(i, 1);
      }
      if (chrome.storage.session) chrome.storage.session.remove("tcf_" + tabId).catch(() => {});
      scheduleSessionPersist();
      chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
      applyWarningBadgeForTab(tabId, changeInfo.url);
    }
  } else if (changeInfo.status === "complete") {
    tabNavigating.delete(tabId);
  }
  // SPA navigation: URL changed without "loading" status
  if (changeInfo.url && !tabNavigating.has(tabId)) {
    const prev = tabLastUrl.get(tabId);
    if (prev && prev !== changeInfo.url) {
      tabTcfData.delete(tabId);
      if (chrome.storage.session) chrome.storage.session.remove("tcf_" + tabId).catch(() => {});
    }
    tabLastUrl.set(tabId, changeInfo.url);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabBlockedDomains.delete(tabId);
  tabGpcDomains.delete(tabId);
  tabParamStrips.delete(tabId);
  clearPendingNavUrl(tabId);
  tabNavigating.delete(tabId);
  tabTcfData.delete(tabId);
  tabCosmeticData.delete(tabId);
  tabCmpData.delete(tabId);
  tabCmpDetectData.delete(tabId);
  tabGppData.delete(tabId);
  tabCoverageMetrics.delete(tabId);
  tabLastUrl.delete(tabId);
  for (let i = unattributedBuffer.length - 1; i >= 0; i--) {
    if (unattributedBuffer[i].tabId === tabId) unattributedBuffer.splice(i, 1);
  }
  if (chrome.storage.session) chrome.storage.session.remove("tcf_" + tabId).catch(() => {});
  scheduleSessionPersist();
});

// --- Toolbar icon theme ---

function applyThemeIcon(dark) {
  var suffix = dark ? "_dark" : "";
  chrome.action.setIcon({
    path: {
      "16": "icons/protoconsent_icon_16" + suffix + ".png",
      "24": "icons/protoconsent_icon_24" + suffix + ".png",
      "32": "icons/protoconsent_icon_32" + suffix + ".png",
      "48": "icons/protoconsent_icon_48" + suffix + ".png",
      "64": "icons/protoconsent_icon_64" + suffix + ".png",
      "128": "icons/protoconsent_icon_128" + suffix + ".png"
    }
  });
}

// Apply on service worker startup
chrome.storage.local.get("_themeIconDark", function (r) {
  applyThemeIcon(!!r._themeIconDark);
});

// React to theme changes (written by theme.js in popup/settings)
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === "local" && changes._themeIconDark) {
    applyThemeIcon(!!changes._themeIconDark.newValue);
  }
});

// Rebuild once on service worker startup
chrome.runtime.onStartup?.addListener(() => {
  rebuildAllDynamicRules();
});

// Also rebuild when the extension is installed or updated
chrome.runtime.onInstalled.addListener(async (details) => {
  // On install or update: force reload CMP data from bundled.
  // On update: protects against stale/bad data.
  // On install: Chrome may preserve storage across reinstall if extension ID
  // is unchanged (unpacked load from same folder), so clear stale entries.
  if (details.reason === 'update' || details.reason === 'install') {
    await new Promise(resolve => {
      chrome.storage.local.remove([
        "enhancedData_protoconsent_cmp_signatures",
        "enhancedData_protoconsent_cmp_detectors",
        "enhancedData_protoconsent_cmp_signatures_site",
        "_cmpSignatures",
        "_cmpDetectors",
        "_cmpSiteSignatures",
      ], resolve);
    });
  }

  // Load bundled cosmetic data if not yet downloaded remotely
  await initBundledCosmeticData();
  // Load bundled CMP signatures (always fresh after update)
  await initBundledCmpData();
  // Load bundled CMP detectors (always fresh after update)
  await initBundledCmpDetectors();
  // Load bundled CMP site-specific signatures (always fresh after update)
  await initBundledCmpSiteSignatures();

  rebuildAllDynamicRules();

  if (details.reason === 'install') {
    chrome.storage.local.get(['onboardingComplete'], (result) => {
      if (!result.onboardingComplete) {
        chrome.tabs.create({ url: chrome.runtime.getURL('pages/onboarding.html') });
      }
    });
  }
});

// Initialize bundled cosmetic filter data on first install or update.
// If remote data has already been fetched, this is a no-op.
async function initBundledCosmeticData() {
  const result = await new Promise(resolve => {
    chrome.storage.local.get(["enhancedData_easylist_cosmetic", "enhancedLists"], resolve);
  });
  if (chrome.runtime.lastError || result.enhancedData_easylist_cosmetic) return;

  try {
    const res = await fetch(chrome.runtime.getURL("rules/easylist_cosmetic.json"));
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!Array.isArray(data.generic) || !data.domains) return;
    const lists = result.enhancedLists || {};
    lists.easylist_cosmetic = {
      enabled: true,
      version: data.version || "bundled",
      lastFetched: Date.now(),
      genericCount: data.generic_count || data.generic.length,
      domainCount: data.domain_count || Object.keys(data.domains).length,
      domainRuleCount: data.domain_rule_count || 0,
      pathRuleCount: 0,
      type: "cosmetic",
      bundled: true,
    };
    await new Promise(resolve => {
      chrome.storage.local.set({
        enhancedLists: lists,
        enhancedData_easylist_cosmetic: { generic: data.generic, domains: data.domains },
      }, resolve);
    });
  } catch (e) {
    if (DEBUG_RULES) console.warn("ProtoConsent: failed to load bundled cosmetic data:", e);
  }
}

// Initialize bundled CMP signature data on first install or update.
// If remote data has already been fetched, this is a no-op.
async function initBundledCmpData() {
  const result = await new Promise(resolve => {
    chrome.storage.local.get(["enhancedData_protoconsent_cmp_signatures", "enhancedLists"], resolve);
  });
  if (chrome.runtime.lastError || result.enhancedData_protoconsent_cmp_signatures) return;

  try {
    const res = await fetch(chrome.runtime.getURL("rules/protoconsent_cmp_signatures.json"));
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!data.signatures || typeof data.signatures !== "object") return;
    const lists = result.enhancedLists || {};
    lists.protoconsent_cmp_signatures = {
      enabled: true,
      version: data.version || "bundled",
      lastFetched: Date.now(),
      cmpCount: data.cmp_count || Object.keys(data.signatures).length,
      type: "cmp",
      bundled: true,
    };
    await new Promise(resolve => {
      chrome.storage.local.set({
        enhancedLists: lists,
        enhancedData_protoconsent_cmp_signatures: { signatures: data.signatures },
        _cmpSignatures: data.signatures,
      }, resolve);
    });
  } catch (e) {
    if (DEBUG_RULES) console.warn("ProtoConsent: failed to load bundled CMP data:", e);
  }
}

// Initialize bundled CMP detector data on first install or update.
// If remote data has already been fetched, this is a no-op.
async function initBundledCmpDetectors() {
  const result = await new Promise(resolve => {
    chrome.storage.local.get(["enhancedData_protoconsent_cmp_detectors", "enhancedLists"], resolve);
  });
  if (chrome.runtime.lastError || result.enhancedData_protoconsent_cmp_detectors) return;

  try {
    const res = await fetch(chrome.runtime.getURL("rules/protoconsent_cmp_detectors.json"));
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!data.detectors || typeof data.detectors !== "object") return;
    const lists = result.enhancedLists || {};
    lists.protoconsent_cmp_detectors = {
      enabled: true,
      version: data.version || "bundled",
      lastFetched: Date.now(),
      cmpCount: data.cmp_count || Object.keys(data.detectors).length,
      type: "cmp_detectors",
      bundled: true,
    };
    await new Promise(resolve => {
      chrome.storage.local.set({
        enhancedLists: lists,
        enhancedData_protoconsent_cmp_detectors: { detectors: data.detectors },
        _cmpDetectors: data.detectors,
      }, resolve);
    });
  } catch (e) {
    if (DEBUG_RULES) console.warn("ProtoConsent: failed to load bundled CMP detectors:", e);
  }
}

// Initialize bundled CMP site-specific signature data on first install or update.
// If remote data has already been fetched, this is a no-op.
async function initBundledCmpSiteSignatures() {
  const result = await new Promise(resolve => {
    chrome.storage.local.get(["enhancedData_protoconsent_cmp_signatures_site", "enhancedLists"], resolve);
  });
  if (chrome.runtime.lastError || result.enhancedData_protoconsent_cmp_signatures_site) return;

  try {
    const res = await fetch(chrome.runtime.getURL("rules/protoconsent_cmp_signatures_site.json"));
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!data.signatures || typeof data.signatures !== "object") return;
    const lists = result.enhancedLists || {};
    lists.protoconsent_cmp_signatures_site = {
      enabled: true,
      version: data.version || "bundled",
      lastFetched: Date.now(),
      cmpCount: data.cmp_count || Object.keys(data.signatures).length,
      type: "cmp_site",
      bundled: true,
    };
    await new Promise(resolve => {
      chrome.storage.local.set({
        enhancedLists: lists,
        enhancedData_protoconsent_cmp_signatures_site: { signatures: data.signatures },
        _cmpSiteSignatures: data.signatures,
      }, resolve);
    });
  } catch (e) {
    if (DEBUG_RULES) console.warn("ProtoConsent: failed to load bundled CMP site signatures:", e);
  }
}
