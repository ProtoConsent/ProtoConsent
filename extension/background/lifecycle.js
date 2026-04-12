// ProtoConsent background lifecycle events
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Tab navigation/removal cleanup, onStartup rebuild and onInstalled
// handler (rebuild + first-install onboarding redirect).

import {
  tabBlockedDomains, tabGpcDomains, tabTcfData, tabCosmeticData,
  tabNavigating, tabLastUrl,
} from "./state.js";
import { scheduleSessionPersist } from "./session.js";
import { rebuildAllDynamicRules } from "./rebuild.js";

// Clear per-tab tracking on navigation and tab close.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    if (!tabNavigating.has(tabId)) {
      tabNavigating.add(tabId);
      tabBlockedDomains.delete(tabId);
      tabGpcDomains.delete(tabId);
      tabTcfData.delete(tabId);
      tabCosmeticData.delete(tabId);
      if (chrome.storage.session) chrome.storage.session.remove("tcf_" + tabId).catch(() => {});
      scheduleSessionPersist();
      chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
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
  tabTcfData.delete(tabId);
  tabCosmeticData.delete(tabId);
  tabLastUrl.delete(tabId);
  if (chrome.storage.session) chrome.storage.session.remove("tcf_" + tabId).catch(() => {});
  scheduleSessionPersist();
});

// Rebuild once on service worker startup
chrome.runtime.onStartup?.addListener(() => {
  rebuildAllDynamicRules();
});

// Also rebuild when the extension is installed or updated
chrome.runtime.onInstalled.addListener(async (details) => {
  // Load bundled cosmetic data if not yet downloaded remotely
  await initBundledCosmeticData();
  // Load bundled CMP signatures if not yet downloaded remotely
  await initBundledCmpData();

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
    console.warn("ProtoConsent: failed to load bundled cosmetic data:", e);
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
    console.warn("ProtoConsent: failed to load bundled CMP data:", e);
  }
}
