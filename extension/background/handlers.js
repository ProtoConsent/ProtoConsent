// ProtoConsent background message handlers
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// chrome.runtime.onMessage listener: handles all popup, content-script
// and SDK bridge messages (rules, whitelist, enhanced, debug, .well-known).

import { WELL_KNOWN_SKIP_DOMAINS } from "./config-bridge.js";
import { getLifetimeTotal } from "./tracking.js";

import {
  PURPOSES_FOR_ENFORCEMENT,
  operatingMode, setOperatingMode,
  tabBlockedDomains, tabGpcDomains, tabParamStrips, tabWhitelistHits, tabTcfData, tabCosmeticData, tabCmpData,
  tabCmpDetectData, tabGppData, tabPathDetails,
  tabCoverageMetrics, unattributedBuffer, blockerDetection, tabHotfixHits, hotfixDomainSet,
  pathOnlyUrlFilters, pathAttributionIndex,
  lastRebuildDebug, lastConsentLinkedListIds, lastCelPendingDownload,
  tabNavigating, logPorts, sessionRestoreReady,
  _catalogSource, _catalogLastFetched, _catalogError,
  _catalogLocalCount, _catalogRemoteCount, _catalogLastRemoteFetch,
} from "./state.js";
import {
  getDefaultProfileConfig, resolvePurposes, getAllRulesFromStorage,
  getWhitelistFromStorage, isValidHostname,
} from "./storage.js";
import {
  loadBlocklistsConfig, loadPresetsConfig, loadPurposesConfig,
} from "./config-loader.js";
import { initRegionalStorageListener } from "./handlers-regional.js";
import { handlePickerMessage } from "./handlers-picker.js";
import { handleCosmeticMessage } from "./handlers-cosmetic.js";
import { handleWhitelistMessage } from "./handlers-whitelist.js";
import { handleEnhancedMessage } from "./handlers-enhanced.js";
import { rebuildAllDynamicRules, rebuildCategories } from "./rebuild.js";
import { decodeCmpCookies, decodeCmpStorage } from "./cmp-cookie-decode.js";
import { scheduleSessionPersist } from "./session.js";
import { getBlockerDetectionState, resetBehavioralCounters, dismissBlockerDetection, isBrave } from "./blocker-detection.js";
import { getErrorLog, clearErrorLog } from "./error-log.js";

// Handle a bridge query from the content script.
export async function handleBridgeQuery(message) {
  const { domain, action, purpose } = message;

  const [rules, presets, defaultConfig] = await Promise.all([
    getAllRulesFromStorage(),
    loadPresetsConfig(),
    getDefaultProfileConfig(),
    loadPurposesConfig()
  ]);

  const siteConfig = rules[domain] || {};
  const resolved = resolvePurposes(siteConfig, presets, defaultConfig);

  switch (action) {
    case 'get':
      return (purpose in resolved) ? resolved[purpose] : null;
    case 'getAll':
      return resolved;
    case 'getProfile':
      return siteConfig.profile || (defaultConfig && defaultConfig.profile) || 'balanced';
    default:
      return null;
  }
}

// Listen for messages from popup and content script
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return;

  // Popup notifies that rules were changed by the user
  if (message.type === "PROTOCONSENT_RULES_UPDATED") {
    rebuildAllDynamicRules().then(() => {
      sendResponse({ ok: true });
    }).catch(() => {
      sendResponse({ ok: false });
    });
    return true;
  }

  // Popup requests per-tab blocked domain detail + per-purpose counts
  if (message.type === "PROTOCONSENT_GET_BLOCKED_DOMAINS") {
    if (PURPOSES_FOR_ENFORCEMENT.length === 0) {
      rebuildAllDynamicRules();
    }
    Promise.all([sessionRestoreReady, loadBlocklistsConfig(), getWhitelistFromStorage()]).then(([, bl, whitelist]) => {
      const purposeDomainCounts = {};
      const purposePathCounts = {};
      for (const key of PURPOSES_FOR_ENFORCEMENT) {
        const dLen = bl[key]?.domains?.length;
        const pLen = bl[key]?.pathDomains?.length;
        if (dLen) purposeDomainCounts[key] = dLen;
        if (pLen) purposePathCounts[key] = pLen;
      }
      const gpcDomains = tabGpcDomains.get(message.tabId);
      const rawPaths = tabPathDetails.get(message.tabId);
      const pathDetails = {};
      if (rawPaths) {
        for (const [host, paths] of rawPaths) pathDetails[host] = Array.from(paths);
      }
      sendResponse({
        data: tabBlockedDomains.get(message.tabId) || {},
        pathDetails,
        purposeDomainCounts,
        purposePathCounts,
        gpcDomains: gpcDomains ? Object.keys(gpcDomains) : [],
        gpcDomainCounts: gpcDomains || {},
        whitelist,
        whitelistHitDomains: tabWhitelistHits.get(message.tabId) || {},
        operatingMode,
        coverage: tabCoverageMetrics.get(message.tabId) || null,
        hotfixHits: tabHotfixHits.has(message.tabId) ? Array.from(tabHotfixHits.get(message.tabId)) : [],
        hotfixActive: hotfixDomainSet.size > 0,
        lifetimeBlocked: getLifetimeTotal(),
      });
    });
    return true;
  }

  // Set operating mode (standalone / protoconsent)
  if (message.type === "PROTOCONSENT_SET_OPERATING_MODE") {
    const mode = message.mode;
    if (mode !== "standalone" && mode !== "protoconsent") {
      sendResponse({ ok: false, error: "Invalid mode" }); return;
    }
    chrome.storage.local.set({ operatingMode: mode }, () => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message }); return;
      }
      setOperatingMode(mode);
      resetBehavioralCounters();
      rebuildAllDynamicRules().then(() => {
        sendResponse({ ok: true, mode });
      }).catch(() => {
        sendResponse({ ok: true, mode });
      });
    });
    return true;
  }

  // Get current operating mode
  if (message.type === "PROTOCONSENT_GET_OPERATING_MODE") {
    sendResponse({ mode: operatingMode });
    return;
  }

  // Blocker detection state for popup
  if (message.type === "PROTOCONSENT_GET_BLOCKER_DETECTION") {
    getBlockerDetectionState((state) => sendResponse(state));
    return true;
  }

  // Dismiss blocker detection suggestion or warning
  if (message.type === "PROTOCONSENT_DISMISS_BLOCKER_DETECTION") {
    dismissBlockerDetection(message.target);
    sendResponse({ ok: true });
    return;
  }

  // Proto tab: comprehensive data for the active tab
  if (message.type === "PROTOCONSENT_GET_PROTO_DATA") {
    const tabId = message.tabId;
    chrome.storage.local.get(["operatingMode"], (res) => {
      const mode = res.operatingMode || "standalone";
      if (mode !== operatingMode) setOperatingMode(mode);
      sendResponse({
        mode,
        isBrave: isBrave(),
        coverage: tabCoverageMetrics.get(tabId) || null,
        blocked: tabBlockedDomains.get(tabId) || {},
        gpcDomains: tabGpcDomains.get(tabId) || {},
        paramStrips: tabParamStrips.get(tabId) || {},
        cmp: tabCmpData.get(tabId) || null,
        cmpDetect: tabCmpDetectData.get(tabId) || null,
        cosmetic: tabCosmeticData.get(tabId) || null,
        unattributed: unattributedBuffer.filter(e => e.tabId === tabId),
      });
    });
    return true;
  }

  // Content script forwards an SDK query
  if (message.type === "PROTOCONSENT_BRIDGE_QUERY") {
    handleBridgeQuery(message)
      .then((data) => sendResponse({ data }))
      .catch(() => sendResponse({ data: null }));
    return true;
  }

  // TCF detection from tcf-detect.js
  if (message.type === "PROTOCONSENT_TCF_DETECTED") {
    const tabId = _sender && _sender.tab ? _sender.tab.id : null;
    if (tabId) {
      const rawCmpId = message.cmpId;
      const rawCmpVer = message.cmpVersion;
      const rawPolicyVer = message.tcfPolicyVersion;
      const rawConsents = message.purposeConsents;

      const cmpId = (typeof rawCmpId === "number" && rawCmpId > 0 && rawCmpId < 10000) ? rawCmpId : null;
      const cmpVersion = (typeof rawCmpVer === "number" && rawCmpVer > 0 && rawCmpVer < 100) ? rawCmpVer : null;
      const tcfPolicyVersion = (typeof rawPolicyVer === "number" && rawPolicyVer > 0 && rawPolicyVer < 100) ? rawPolicyVer : null;

      let purposeConsents = null;
      if (rawConsents && typeof rawConsents === "object" && !Array.isArray(rawConsents)) {
        purposeConsents = {};
        const entries = Object.entries(rawConsents);
        const maxEntries = Math.min(entries.length, 20);
        for (let i = 0; i < maxEntries; i++) {
          const [key, val] = entries[i];
          if (/^\d{1,2}$/.test(key) && typeof val === "boolean") {
            purposeConsents[key] = val;
          }
        }
      }

      const tcfInfo = { detected: true, cmpId, cmpVersion, tcfPolicyVersion, purposeConsents };
      tabTcfData.set(tabId, tcfInfo);
      if (chrome.storage.session) {
        chrome.storage.session.set({ ["tcf_" + tabId]: tcfInfo }).catch(() => {});
      }
    }
    return;
  }

  // Cosmetic filtering applied notification from cosmetic-inject.js
  if (message.type === "PROTOCONSENT_COSMETIC_APPLIED") {
    const tabId = _sender && _sender.tab ? _sender.tab.id : null;
    if (tabId && message.domain) {
      tabCosmeticData.set(tabId, {
        domain: message.domain,
        siteRules: message.siteRules || 0,
        genericSelectors: message.genericSelectors || [],
        domainSelectors: message.domainSelectors || [],
        userSelectors: message.userSelectors || [],
        ts: Date.now(),
      });
      scheduleSessionPersist();
      for (const port of logPorts) {
        try {
          port.postMessage({
            type: "cosmetic",
            domain: message.domain,
            siteRules: message.siteRules || 0,
            genericSelectors: message.genericSelectors || [],
            domainSelectors: message.domainSelectors || [],
            userSelectors: message.userSelectors || [],
            tabId,
          });
        } catch (_) {}
      }
    }
    return;
  }

  // CMP auto-response applied notification from cmp-inject.js
  if (message.type === "PROTOCONSENT_CMP_APPLIED") {
    const tabId = _sender && _sender.tab ? _sender.tab.id : null;
    if (tabId && message.domain) {
      tabCmpData.set(tabId, {
        domain: message.domain,
        cmpIds: message.cmpIds || [],
        cookieCount: message.cookieCount || 0,
        selectorCount: message.selectorCount || 0,
        scrollUnlock: !!message.scrollUnlock,
        ts: Date.now(),
      });
      scheduleSessionPersist();
      for (const port of logPorts) {
        try {
          port.postMessage({
            type: "cmp",
            domain: message.domain,
            cmpIds: message.cmpIds || [],
            cookieCount: message.cookieCount || 0,
            selectorCount: message.selectorCount || 0,
            scrollUnlock: !!message.scrollUnlock,
            tabId,
          });
        } catch (_) {}
      }
    }
    return;
  }

  // Cosmetic handlers (get state, exceptions, exclude/restore selector & site)
  const cosmeticHandled = handleCosmeticMessage(message, _sender, sendResponse);
  if (cosmeticHandled) return true;

  // Element picker handlers (start, save, delete)
  const pickerHandled = handlePickerMessage(message, _sender, sendResponse);
  if (pickerHandled) return true;

  // Popup requests CMP auto-response state for a tab
  if (message.type === "PROTOCONSENT_GET_CMP") {
    const info = tabCmpData.get(message.tabId) || null;
    sendResponse({ cmp: info });
    return;
  }

  // Popup requests TCF data for a tab
  if (message.type === "PROTOCONSENT_GET_TCF") {
    const info = tabTcfData.get(message.tabId) || null;
    sendResponse({ tcf: info });
    return;
  }

  // CMP detection notification from cmp-detect.js
  if (message.type === "PROTOCONSENT_CMP_DETECTED") {
    const tabId = _sender && _sender.tab ? _sender.tab.id : null;
    if (tabId && message.domain) {
      const detected = Array.isArray(message.detected) ? message.detected.slice(0, 50) : [];
      const cookies = Array.isArray(message.cookies) ? message.cookies.slice(0, 50) : [];
      const siteHidden = Array.isArray(message.siteHidden) ? message.siteHidden.slice(0, 50) : [];

      const finalize = (observation) => {
        // Merge into existing entry to preserve storageObservation from earlier probe
        const existing = tabCmpDetectData.get(tabId);
        const detectData = {
          domain: String(message.domain).slice(0, 200),
          detected: detected.length > 0 ? detected : (existing?.detected || []),
          cookies: cookies.length > 0 ? cookies : (existing?.cookies || []),
          siteHidden: siteHidden.length > 0 ? siteHidden : (existing?.siteHidden || []),
          observation: observation.length > 0 ? observation : (existing?.observation || []),
          ts: Date.now(),
        };
        // Preserve storage observation fields if present
        if (existing?.storageObservation) detectData.storageObservation = existing.storageObservation;
        if (existing?.storageEntries) detectData.storageEntries = existing.storageEntries;
        tabCmpDetectData.set(tabId, detectData);
        scheduleSessionPersist();
        for (const port of logPorts) {
          try {
            port.postMessage({ type: "cmp_detect", tabId, ...detectData });
          } catch (_) {}
        }
      };

      if (cookies.length > 0) {
        chrome.storage.local.get("_userPurposes", (result) => {
          const userPurposes = result._userPurposes || null;
          finalize(decodeCmpCookies(cookies, userPurposes));
        });
      } else {
        finalize([]);
      }

      if (detected.length > 0) {
        chrome.storage.local.get(["_cmpSignatures", "_cmpDomainCache"], (r) => {
          const sigKeys = r._cmpSignatures ? Object.keys(r._cmpSignatures) : [];
          const resolved = new Set();
          for (const d of detected) {
            const id = d.cmpId;
            if (sigKeys.includes(id)) {
              resolved.add(id);
            } else {
              for (const sk of sigKeys) {
                if (id.startsWith(sk + '_') || (id.startsWith(sk) && id.length > sk.length && !/[a-z]/.test(id[sk.length]))) {
                  resolved.add(sk);
                  break;
                }
              }
            }
          }
          if (resolved.size === 0) return;
          const cache = (r._cmpDomainCache && typeof r._cmpDomainCache === 'object' && !Array.isArray(r._cmpDomainCache))
            ? r._cmpDomainCache : {};
          cache[message.domain] = [...resolved];
          const keys = Object.keys(cache);
          if (keys.length > 300) {
            for (const k of keys.slice(0, keys.length - 300)) delete cache[k];
          }
          chrome.storage.local.set({ _cmpDomainCache: cache });
        });
      }
    }
    return;
  }

  // GPP detection from tcf-detect.js
  if (message.type === "PROTOCONSENT_GPP_DETECTED") {
    const tabId = _sender && _sender.tab ? _sender.tab.id : null;
    if (tabId) {
      const gppData = {
        detected: true,
        gppVersion: (typeof message.gppVersion === "string" && message.gppVersion.length < 20) ? message.gppVersion : null,
        supportedAPIs: Array.isArray(message.supportedAPIs) ? message.supportedAPIs.slice(0, 20) : null,
        ts: Date.now(),
      };
      tabGppData.set(tabId, gppData);
      scheduleSessionPersist();
    }
    return;
  }

  // CMP localStorage observation from tcf-detect.js (MAIN world)
  if (message.type === "PROTOCONSENT_CMP_STORAGE_DETECTED") {
    const tabId = _sender && _sender.tab ? _sender.tab.id : null;
    if (tabId && Array.isArray(message.entries)) {
      const entries = message.entries.slice(0, 10).filter(e =>
        e && typeof e.cmpId === "string" && typeof e.key === "string" && typeof e.raw === "string"
      );
      if (entries.length > 0) {
        chrome.storage.local.get("_userPurposes", (result) => {
          const userPurposes = result._userPurposes || null;
          const observation = decodeCmpStorage(entries, userPurposes);
          // Derive domain from sender tab URL
          let senderDomain = "";
          try {
            if (_sender.tab && _sender.tab.url) senderDomain = new URL(_sender.tab.url).hostname.replace(/^www\./, "");
          } catch (_) {}
          // Merge into existing tabCmpDetectData (may already have CSS detect + cookies)
          const existing = tabCmpDetectData.get(tabId) || { domain: senderDomain, detected: [], cookies: [], siteHidden: [], observation: [], ts: Date.now() };
          if (!existing.domain) existing.domain = senderDomain;
          existing.storageObservation = observation;
          existing.storageEntries = entries.map(e => ({ cmpId: e.cmpId, key: e.key }));
          tabCmpDetectData.set(tabId, existing);
          scheduleSessionPersist();
          // Stream to log
          const domain = existing.domain || senderDomain;
          for (const port of logPorts) {
            try {
              port.postMessage({
                type: "cmp_detect",
                domain,
                detected: [],
                cookies: [],
                siteHidden: [],
                observation: [],
                storageObservation: observation,
                tabId,
              });
            } catch (_) {}
          }
        });
      }
    }
    return;
  }

  // Popup requests CMP detection state for a tab
  if (message.type === "PROTOCONSENT_GET_CMP_DETECT") {
    const info = tabCmpDetectData.get(message.tabId) || null;
    sendResponse({ cmpDetect: info });
    return;
  }

  // Popup requests last rebuild debug snapshot
  if (message.type === "PROTOCONSENT_GET_DEBUG") {
    const respond = () => {
      const debugData = Object.assign({}, lastRebuildDebug, {
        operatingMode,
        navigatingTabs: tabNavigating.size,
        logPorts: logPorts.size,
        catalogSource: _catalogSource,
        catalogLastFetched: _catalogLastFetched,
        catalogError: _catalogError,
        catalogLocalCount: _catalogLocalCount,
        catalogRemoteCount: _catalogRemoteCount,
        catalogLastRemoteFetch: _catalogLastRemoteFetch,
      });
      const p1 = (chrome.storage.session && chrome.storage.session.get)
        ? chrome.storage.session.get(null).then(s => Object.keys(s).length).catch(() => -1)
        : Promise.resolve(-1);
      const p2 = new Promise(r => chrome.storage.local.get(
        ["interExtEnabled", "interExtAllowlist", "interExtDenylist", "interExtPending"],
        r
      ));
      const p3 = new Promise(r => chrome.storage.local.get(
        ["dynamicListsConsent", "consentEnhancedLink", "celMode", "celCustomPurposes"], d => r({
          dynamicConsent: d.dynamicListsConsent === true,
          consentEnhancedLink: d.consentEnhancedLink === true,
          celMode: d.celMode || "profile",
          celCustomPurposes: d.celCustomPurposes || null,
        })
      ));
      const p4 = new Promise(r => chrome.storage.local.get("regionalLanguages", d => r(d.regionalLanguages || [])));
      Promise.all([p1, p2, p3, p4]).then(([sessionKeys, ext, p3Result, regionalLangs]) => {
        debugData.sessionKeys = sessionKeys;
        debugData.interExtEnabled = ext.interExtEnabled === true;
        debugData.interExtAllowlist = ext.interExtAllowlist || [];
        debugData.interExtDenylist = ext.interExtDenylist || [];
        debugData.interExtPending = ext.interExtPending || [];
        debugData.dynamicListsConsent = p3Result.dynamicConsent;
        debugData.consentEnhancedLink = p3Result.consentEnhancedLink;
        debugData.celMode = p3Result.celMode;
        debugData.celCustomPurposes = p3Result.celCustomPurposes;
        debugData.consentLinkedListIds = lastConsentLinkedListIds;
        debugData.celPendingDownload = lastCelPendingDownload;
        debugData.regionalLanguages = regionalLangs;
        // Hotfix diagnostics
        debugData.hotfixListenerActive = hotfixDomainSet.size > 0;
        // Blocker detection diagnostics
        debugData.blockerDetect = {
          navCount: blockerDetection.navCount,
          totalObserved: blockerDetection.totalObserved,
          behavioralSignal: blockerDetection.behavioralSignal,
          noBlockerWarning: blockerDetection.noBlockerWarning,
          unattributedHostnames: blockerDetection.unattributedHostnames.size,
          bufferLength: unattributedBuffer.length,
          bufferUniqueHostnames: new Set(unattributedBuffer.map(e => e.hostname)).size,
          liveCoverageEntries: tabCoverageMetrics.size,
          liveCoverageObserved: Array.from(tabCoverageMetrics.values()).reduce((s, m) => s + m.observed, 0),
          pathOnlyPatterns: pathOnlyUrlFilters.size,
          pathAttrIndexSize: pathAttributionIndex.size,
        };
        debugData.errors = getErrorLog();
        sendResponse(debugData);
      }).catch(() => sendResponse(debugData));
    };
    if (!lastRebuildDebug.enableIds) {
      rebuildAllDynamicRules().then(respond).catch(respond);
    } else {
      respond();
    }
    return true;
  }

  // Popup requests .well-known fetch
  if (message.type === "PROTOCONSENT_FETCH_WELL_KNOWN") {
    const domain = message.domain;
    if (!domain || typeof domain !== "string") {
      sendResponse({ data: null });
      return;
    }
    const host = (message.host && typeof message.host === "string") ? message.host : domain;
    if (WELL_KNOWN_SKIP_DOMAINS.has(host.toLowerCase())) {
      sendResponse({ data: null });
      return;
    }
    const protocol = message.protocol === "http:" ? "http://" : "https://";
    const url = protocol + host + "/.well-known/protoconsent.json";
    fetch(url, { credentials: "omit", redirect: "follow" })
      .then(res => {
        if (!res.ok) return null;
        return res.text().then(text => {
          if (text.length > 5000) return null;
          try { return JSON.parse(text); } catch (_) { return null; }
        });
      })
      .then(data => sendResponse({ data: data || null }))
      .catch(() => sendResponse({ data: null }));
    return true;
  }

  // Popup requests clearing the internal error log
  if (message.type === "PROTOCONSENT_CLEAR_ERRORS") {
    clearErrorLog();
    sendResponse({ ok: true });
    return true;
  }

  // Whitelist handlers (add, remove, toggle scope, all-site, clear)
  const whitelistHandled = handleWhitelistMessage(message, _sender, sendResponse);
  if (whitelistHandled) return true;

  // Enhanced list handlers (get state, set preset, toggle, fetch, remove)
  const enhancedHandled = handleEnhancedMessage(message, _sender, sendResponse);
  if (enhancedHandled) return true;
});

// Initialize regional language change listener
initRegionalStorageListener();
