// ProtoConsent background session persistence + badge
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Throttled persistence of per-tab blocked/GPC/TCF data to
// chrome.storage.session (survives SW restarts). Badge text updates.

import {
  tabBlockedDomains, tabGpcDomains, tabTcfData, tabCosmeticData, tabCmpData,
  tabCmpDetectData, tabGppData,
  tabCoverageMetrics,
  blockerDetection, updateBlockerDetection,
  unattributedBuffer, UNATTRIBUTED_BUFFER_CAP,
  setOperatingMode,
  _extEventLog,
} from "./state.js";
import { restoreWarningBadge } from "./blocker-detection.js";

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
  const cosmetic = {};
  for (const [tabId, data] of tabCosmeticData) {
    cosmetic[tabId] = data;
  }
  const cmp = {};
  for (const [tabId, data] of tabCmpData) {
    cmp[tabId] = data;
  }
  const cmpDetect = {};
  for (const [tabId, data] of tabCmpDetectData) {
    cmpDetect[tabId] = data;
  }
  const gpp = {};
  for (const [tabId, data] of tabGppData) {
    gpp[tabId] = data;
  }
  const coverage = {};
  for (const [tabId, data] of tabCoverageMetrics) {
    coverage[tabId] = data;
  }
  chrome.storage.session.set({
    _tabBlocked: blocked, _tabGpc: gpc, _tabCosmetic: cosmetic, _tabCmp: cmp,
    _tabCmpDetect: cmpDetect, _tabGpp: gpp, _tabCoverage: coverage,
    _extEventLog: _extEventLog,
    _blockerDetect: {
      navCount: blockerDetection.navCount,
      totalObserved: blockerDetection.totalObserved,
      behavioralSignal: blockerDetection.behavioralSignal,
      noBlockerWarning: blockerDetection.noBlockerWarning,
      unattributedHostnames: Array.from(blockerDetection.unattributedHostnames),
    },
    _unattributedBuffer: unattributedBuffer.slice(),
  });
}

export async function restoreTabDataFromSession() {
  if (!chrome.storage.session) return;
  // Restore operatingMode early so blocker detection evaluates under the correct mode
  try {
    const { operatingMode } = await chrome.storage.local.get("operatingMode");
    if (operatingMode) setOperatingMode(operatingMode);
  } catch (_) {}
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
    if (result._tabCosmetic) {
      for (const [tabId, data] of Object.entries(result._tabCosmetic)) {
        tabCosmeticData.set(Number(tabId), data);
      }
    }
    if (result._tabCmp) {
      for (const [tabId, data] of Object.entries(result._tabCmp)) {
        tabCmpData.set(Number(tabId), data);
      }
    }
    if (result._tabCmpDetect) {
      for (const [tabId, data] of Object.entries(result._tabCmpDetect)) {
        tabCmpDetectData.set(Number(tabId), data);
      }
    }
    if (result._tabGpp) {
      for (const [tabId, data] of Object.entries(result._tabGpp)) {
        tabGppData.set(Number(tabId), data);
      }
    }
    if (result._tabCoverage) {
      for (const [tabId, data] of Object.entries(result._tabCoverage)) {
        tabCoverageMetrics.set(Number(tabId), data);
      }
    }
    // Restore inter-extension event log
    if (Array.isArray(result._extEventLog)) {
      _extEventLog.length = 0;
      for (const evt of result._extEventLog) _extEventLog.push(evt);
    }
    // Restore blocker detection state
    if (result._blockerDetect) {
      const bd = result._blockerDetect;
      updateBlockerDetection({
        navCount: bd.navCount || 0,
        totalObserved: bd.totalObserved || 0,
        behavioralSignal: !!bd.behavioralSignal,
        noBlockerWarning: !!bd.noBlockerWarning,
      });
      if (Array.isArray(bd.unattributedHostnames)) {
        blockerDetection.unattributedHostnames = new Set(bd.unattributedHostnames);
      }
      restoreWarningBadge(!!bd.noBlockerWarning);
    }
    // Restore unattributed buffer
    if (Array.isArray(result._unattributedBuffer)) {
      unattributedBuffer.length = 0;
      for (const entry of result._unattributedBuffer.slice(-UNATTRIBUTED_BUFFER_CAP)) {
        unattributedBuffer.push(entry);
      }
    }
    // Prune orphan tabs from blocked/GPC/cosmetic data
    const existingTabs = new Set();
    try {
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) existingTabs.add(t.id);
    } catch (_) {}
    if (existingTabs.size > 0) {
      for (const tabId of tabBlockedDomains.keys()) {
        if (!existingTabs.has(tabId)) tabBlockedDomains.delete(tabId);
      }
      for (const tabId of tabGpcDomains.keys()) {
        if (!existingTabs.has(tabId)) tabGpcDomains.delete(tabId);
      }
      for (const tabId of tabCosmeticData.keys()) {
        if (!existingTabs.has(tabId)) tabCosmeticData.delete(tabId);
      }
      for (const tabId of tabCmpData.keys()) {
        if (!existingTabs.has(tabId)) tabCmpData.delete(tabId);
      }
      for (const tabId of tabCmpDetectData.keys()) {
        if (!existingTabs.has(tabId)) tabCmpDetectData.delete(tabId);
      }
      for (const tabId of tabGppData.keys()) {
        if (!existingTabs.has(tabId)) tabGppData.delete(tabId);
      }
      for (const tabId of tabCoverageMetrics.keys()) {
        if (!existingTabs.has(tabId)) tabCoverageMetrics.delete(tabId);
      }
    }
    // Restore per-tab TCF detection data (keys: "tcf_<tabId>")
    // and prune orphan keys for tabs that no longer exist.
    const tcfKeys = Object.keys(result).filter(k => k.startsWith("tcf_"));
    if (tcfKeys.length > 0) {
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
// setBadgeText can throw "No tab with id: N" if the tab closed between
// event capture and badge update. This is a harmless race condition.
export function updateBadgeForTab(tabId) {
  const tabData = tabBlockedDomains.get(tabId);
  if (!tabData) {
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
    return;
  }
  let total = 0;
  for (const domains of Object.values(tabData)) {
    for (const count of Object.values(domains)) {
      total += count;
    }
  }
  chrome.action.setBadgeText({ tabId, text: total > 0 ? String(total) : "" }).catch(() => {});
}
