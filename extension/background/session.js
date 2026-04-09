// ProtoConsent background session persistence + badge
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Throttled persistence of per-tab blocked/GPC/TCF data to
// chrome.storage.session (survives SW restarts). Badge text updates.

import {
  tabBlockedDomains, tabGpcDomains, tabTcfData,
  _extEventLog,
} from "./state.js";

// Throttled write to chrome.storage.session (max once per 2s)
let sessionPersistTimer = null;

export function scheduleSessionPersist() {
  if (sessionPersistTimer) return;
  sessionPersistTimer = setTimeout(() => {
    sessionPersistTimer = null;
    persistTabDataToSession();
  }, 2000);
}

export function persistTabDataToSession() {
  if (!chrome.storage.session) return;
  const blocked = {};
  for (const [tabId, data] of tabBlockedDomains) {
    blocked[tabId] = data;
  }
  const gpc = {};
  for (const [tabId, domains] of tabGpcDomains) {
    gpc[tabId] = domains;
  }
  chrome.storage.session.set({ _tabBlocked: blocked, _tabGpc: gpc, _extEventLog: _extEventLog });
}

export async function restoreTabDataFromSession() {
  if (!chrome.storage.session) return;
  try {
    const result = await chrome.storage.session.get(null);
    if (result._tabBlocked) {
      for (const [tabId, data] of Object.entries(result._tabBlocked)) {
        tabBlockedDomains.set(Number(tabId), data);
      }
    }
    if (result._tabGpc) {
      for (const [tabId, domains] of Object.entries(result._tabGpc)) {
        tabGpcDomains.set(Number(tabId), domains);
      }
    }
    // Restore inter-extension event log
    if (Array.isArray(result._extEventLog)) {
      _extEventLog.length = 0;
      for (const evt of result._extEventLog) _extEventLog.push(evt);
    }
    // Restore per-tab TCF detection data (keys: "tcf_<tabId>")
    // and prune orphan keys for tabs that no longer exist.
    const tcfKeys = Object.keys(result).filter(k => k.startsWith("tcf_"));
    if (tcfKeys.length > 0) {
      const existingTabs = new Set();
      try {
        const tabs = await chrome.tabs.query({});
        for (const t of tabs) existingTabs.add(t.id);
      } catch (_) {}
      const orphanKeys = [];
      for (const key of tcfKeys) {
        const tabId = Number(key.slice(4));
        if (tabId > 0 && existingTabs.has(tabId) && result[key]?.detected) {
          tabTcfData.set(tabId, result[key]);
        } else {
          orphanKeys.push(key);
        }
      }
      if (orphanKeys.length > 0) {
        chrome.storage.session.remove(orphanKeys).catch(() => {});
      }
    }
  } catch (_) { /* session storage may be empty on first run */ }
}

// Badge: show blocked request count per tab on the extension icon.
export function updateBadgeForTab(tabId) {
  const tabData = tabBlockedDomains.get(tabId);
  if (!tabData) {
    chrome.action.setBadgeText({ tabId, text: "" });
    return;
  }
  let total = 0;
  for (const domains of Object.values(tabData)) {
    for (const count of Object.values(domains)) {
      total += count;
    }
  }
  chrome.action.setBadgeText({ tabId, text: total > 0 ? String(total) : "" });
}
