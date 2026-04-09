// ProtoConsent background lifecycle events
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Tab navigation/removal cleanup, onStartup rebuild and onInstalled
// handler (rebuild + first-install onboarding redirect).

import {
  tabBlockedDomains, tabGpcDomains, tabTcfData,
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
      if (chrome.storage.session) chrome.storage.session.remove("tcf_" + tabId).catch(() => {});
      scheduleSessionPersist();
      chrome.action.setBadgeText({ tabId, text: "" });
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
  tabLastUrl.delete(tabId);
  if (chrome.storage.session) chrome.storage.session.remove("tcf_" + tabId).catch(() => {});
  scheduleSessionPersist();
});

// Rebuild once on service worker startup
chrome.runtime.onStartup?.addListener(() => {
  rebuildAllDynamicRules();
});

// Also rebuild when the extension is installed or updated
chrome.runtime.onInstalled.addListener((details) => {
  rebuildAllDynamicRules();

  if (details.reason === 'install') {
    chrome.storage.local.get(['onboardingComplete'], (result) => {
      if (!result.onboardingComplete) {
        chrome.tabs.create({ url: chrome.runtime.getURL('pages/onboarding.html') });
      }
    });
  }
});
