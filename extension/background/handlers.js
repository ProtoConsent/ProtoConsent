// ProtoConsent background message handlers
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// chrome.runtime.onMessage listener: handles all popup, content-script
// and SDK bridge messages (rules, whitelist, enhanced, debug, .well-known).

 // Resolve the correct Enhanced preset based on current list enabled states.
 // @param {Object} lists - enhancedLists metadata from storage
 // @param {Object} catalog - enhanced-lists.json catalog
 // @returns {string} "off" | "basic" | "full" | "custom"
 
function resolveEnhancedPreset(lists, catalog) {
  const downloaded = Object.keys(lists);
  if (downloaded.length === 0) return "off";
  const allDisabled = downloaded.every(id => !lists[id]?.enabled);
  if (allDisabled) return "off";
  const catalogIds = Object.keys(catalog);
  if (catalogIds.length === 0) return "custom";
  const allDownloaded = catalogIds.every(id => !!lists[id]);
  const allEnabled = allDownloaded && catalogIds.every(id => !!lists[id]?.enabled);
  if (allEnabled) return "full";
  // Check if enabled set matches "basic" among all catalog entries
  let matchesBasic = true;
  for (const id of catalogIds) {
    const shouldBeEnabled = catalog[id] ? catalog[id].preset === "basic" : false;
    const isEnabled = !!lists[id]?.enabled;
    if (isEnabled !== shouldBeEnabled) { matchesBasic = false; break; }
  }
  if (matchesBasic) return "basic";
  return "custom";
}

import {
  PURPOSES_FOR_ENFORCEMENT,
  operatingMode, setOperatingMode,
  tabBlockedDomains, tabGpcDomains, tabTcfData, tabCosmeticData, tabCmpData,
  tabCmpDetectData, tabGppData,
  tabCoverageMetrics, unattributedBuffer, blockerDetection,
  lastRebuildDebug, lastConsentLinkedListIds, lastCelPendingDownload,
  tabNavigating, logPorts, sessionRestoreReady,
  _catalogSource, _catalogLastFetched, _catalogError,
  _catalogLocalCount, _catalogRemoteCount, _catalogLastRemoteFetch,
} from "./state.js";
import {
  getDefaultProfileConfig, resolvePurposes, getAllRulesFromStorage,
  getWhitelistFromStorage, isValidHostname,
  getEnhancedListsFromStorage, getEnhancedPresetFromStorage,
  withEnhancedStorageLock, withWhitelist,
} from "./storage.js";
import {
  loadBlocklistsConfig, loadPresetsConfig, loadPurposesConfig,
  loadEnhancedListsCatalog,
} from "./config-loader.js";
import { rebuildAllDynamicRules } from "./rebuild.js";
import { invalidateCmpSignaturesCache } from "./cmp-injection.js";
import { decodeCmpCookies, decodeCmpStorage } from "./cmp-cookie-decode.js";
import { scheduleSessionPersist } from "./session.js";
import { getBlockerDetectionState, resetBehavioralCounters, dismissBlockerDetection } from "./blocker-detection.js";

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
      sendResponse({
        data: tabBlockedDomains.get(message.tabId) || {},
        purposeDomainCounts,
        purposePathCounts,
        gpcDomains: gpcDomains ? Object.keys(gpcDomains) : [],
        gpcDomainCounts: gpcDomains || {},
        whitelist,
        operatingMode,
        coverage: tabCoverageMetrics.get(message.tabId) || null,
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
        coverage: tabCoverageMetrics.get(tabId) || null,
        blocked: tabBlockedDomains.get(tabId) || {},
        gpcDomains: tabGpcDomains.get(tabId) || {},
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
        ts: Date.now(),
      });
      scheduleSessionPersist();
      for (const port of logPorts) {
        try {
          port.postMessage({
            type: "cosmetic",
            domain: message.domain,
            siteRules: message.siteRules || 0,
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

  // Popup requests cosmetic state for a tab
  if (message.type === "PROTOCONSENT_GET_COSMETIC") {
    const info = tabCosmeticData.get(message.tabId) || null;
    sendResponse({ cosmetic: info });
    return;
  }

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
      Promise.all([p1, p2, p3]).then(([sessionKeys, ext, p3Result]) => {
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
        };
        sendResponse(debugData);
      });
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

  // Whitelist: add domain
  if (message.type === "PROTOCONSENT_WHITELIST_ADD") {
    const { domain, purpose, site } = message;
    if (!domain || !purpose || !isValidHostname(domain)) {
      sendResponse({ ok: false }); return;
    }
    const siteKey = (site && isValidHostname(site)) ? site : "*";
    withWhitelist(whitelist => {
      if (!whitelist[domain]) whitelist[domain] = {};
      if (siteKey === "*") {
        whitelist[domain] = {};
      } else {
        delete whitelist[domain]["*"];
      }
      whitelist[domain][siteKey] = purpose;
      return new Promise(resolve => {
        chrome.storage.local.set({ whitelist }, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            rebuildAllDynamicRules();
            sendResponse({ ok: true });
          }
          resolve();
        });
      });
    });
    return true;
  }

  // Whitelist: remove domain
  if (message.type === "PROTOCONSENT_WHITELIST_REMOVE") {
    const { domain, site } = message;
    if (!domain) { sendResponse({ ok: false }); return; }
    withWhitelist(whitelist => {
      if (whitelist[domain]) {
        if (site) {
          delete whitelist[domain][site];
          if (Object.keys(whitelist[domain]).length === 0) {
            delete whitelist[domain];
          }
        } else {
          delete whitelist[domain];
        }
      }
      return new Promise(resolve => {
        chrome.storage.local.set({ whitelist }, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            rebuildAllDynamicRules();
            sendResponse({ ok: true });
          }
          resolve();
        });
      });
    });
    return true;
  }

  // Whitelist: toggle scope
  if (message.type === "PROTOCONSENT_WHITELIST_TOGGLE_SCOPE") {
    const { domain, site } = message;
    if (!domain || !site) { sendResponse({ ok: false }); return; }
    withWhitelist(whitelist => {
      if (!whitelist[domain]) { sendResponse({ ok: false }); return Promise.resolve(); }
      if (site === "*") {
        sendResponse({ ok: false });
        return Promise.resolve();
      }
      const purpose = whitelist[domain][site];
      if (!purpose) {
        sendResponse({ ok: false });
        return Promise.resolve();
      }
      whitelist[domain] = { "*": purpose };
      return new Promise(resolve => {
        chrome.storage.local.set({ whitelist }, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            rebuildAllDynamicRules();
            sendResponse({ ok: true, whitelist });
          }
          resolve();
        });
      });
    });
    return true;
  }

  // Enhanced: get current state
  if (message.type === "PROTOCONSENT_ENHANCED_GET_STATE") {
    const forceRefresh = message.forceRefresh === true;
    Promise.all([
      loadEnhancedListsCatalog(forceRefresh ? { forceRefresh: true } : undefined),
      getEnhancedListsFromStorage(),
      getEnhancedPresetFromStorage(),
      new Promise(r => chrome.storage.local.get("dynamicListsConsent", d => r(d.dynamicListsConsent === true))),
      new Promise(r => chrome.storage.local.get(
        ["consentEnhancedLink", "celMode", "celCustomPurposes"],
        d => r({
          consentEnhancedLink: d.consentEnhancedLink === true,
          celMode: d.celMode || "profile",
          celCustomPurposes: d.celCustomPurposes || null,
        })
      )),
    ]).then(([catalog, lists, preset, dynamicConsent, celData]) => {
      sendResponse({ catalog, lists, preset, dynamicConsent,
        consentEnhancedLink: celData.consentEnhancedLink,
        celMode: celData.celMode,
        celCustomPurposes: celData.celCustomPurposes,
        consentLinkedListIds: lastConsentLinkedListIds,
        celPendingDownload: lastCelPendingDownload });
    });
    return true;
  }

  // Enhanced: set preset
  if (message.type === "PROTOCONSENT_ENHANCED_SET_PRESET") {
    const preset = message.preset;
    if (!["off", "basic", "full", "custom"].includes(preset)) {
      sendResponse({ ok: false }); return;
    }
    loadEnhancedListsCatalog().then(catalog => {
      withEnhancedStorageLock(() => {
        return getEnhancedListsFromStorage().then(lists => {
          for (const [listId, listDef] of Object.entries(catalog)) {
            if (!lists[listId]) continue;
            if (preset === "off") {
              lists[listId].enabled = false;
            } else if (preset === "basic") {
              lists[listId].enabled = listDef.preset === "basic";
            } else if (preset === "full") {
              lists[listId].enabled = true;
            }
          }
          return new Promise(resolve => {
            chrome.storage.local.set({ enhancedLists: lists, enhancedPreset: preset }, () => {
              if (chrome.runtime.lastError) {
                sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                resolve();
                return;
              }
              rebuildAllDynamicRules();
              sendResponse({ ok: true });
              resolve();
            });
          });
        });
      });
    });
    return true;
  }

  // Enhanced: toggle a single list
  if (message.type === "PROTOCONSENT_ENHANCED_TOGGLE") {
    const { listId, enabled } = message;
    if (!listId || typeof enabled !== "boolean") {
      sendResponse({ ok: false }); return;
    }
    loadEnhancedListsCatalog().then(catalog => {
      withEnhancedStorageLock(() => {
        return getEnhancedListsFromStorage().then(lists => {
          if (!lists[listId]) {
            sendResponse({ ok: false, error: "List not downloaded" }); return;
          }
          lists[listId].enabled = enabled;
          const newPreset = resolveEnhancedPreset(lists, catalog);
          return new Promise(resolve => {
            chrome.storage.local.set({
              enhancedLists: lists,
              enhancedPreset: newPreset,
            }, () => {
              if (chrome.runtime.lastError) {
                sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                resolve();
                return;
              }
              rebuildAllDynamicRules();
              sendResponse({ ok: true });
              resolve();
            });
          });
        });
      });
    });
    return true;
  }

  // Enhanced: fetch (download) a list
  if (message.type === "PROTOCONSENT_ENHANCED_FETCH") {
    const { listId } = message;
    if (!listId) { sendResponse({ ok: false }); return; }
    Promise.all([
      loadEnhancedListsCatalog(),
    ]).then(([catalog]) => {
      const listDef = catalog[listId];
      if (!listDef || !listDef.fetch_url) {
        sendResponse({ ok: false, error: "Unknown list or no fetch URL" }); return;
      }
      const fetchUrl = listDef.fetch_url.startsWith("http")
        ? listDef.fetch_url
        : chrome.runtime.getURL(listDef.fetch_url);
      const fallbackUrl = fetchUrl.includes("cdn.jsdelivr.net/gh/")
        ? fetchUrl.replace("https://cdn.jsdelivr.net/gh/ProtoConsent/data@main/", "https://raw.githubusercontent.com/ProtoConsent/data/main/")
        : null;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      const fetchOpts = { credentials: "omit", signal: controller.signal, cache: "no-store" };
      const tryFetch = (url) => fetch(url, fetchOpts).then(res => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      });
      (tryFetch(fetchUrl).catch(err => {
        if (fallbackUrl && err.name !== "AbortError") return tryFetch(fallbackUrl);
        throw err;
      }))
        .then(data => {
          clearTimeout(timeoutId);
          if (listDef.type === "informational") {
            if (!data.map || typeof data.map !== "object" || !Array.isArray(data.trackers)) {
              throw new Error("Invalid informational list format: missing map or trackers");
            }
            const domainCount = data.domain_count || Object.keys(data.map).length;
            return withEnhancedStorageLock(() => {
              return getEnhancedListsFromStorage().then(lists => {
                const existing = lists[listId];
                if (existing && data.version && existing.version === data.version) {
                  sendResponse({ ok: true, skipped: true, domainCount: existing.domainCount });
                  return;
                }
                const existingEnabled = existing?.enabled;
                let shouldEnable;
                if (existingEnabled !== undefined) {
                  shouldEnable = existingEnabled;
                } else {
                  shouldEnable = true;
                  return getEnhancedPresetFromStorage().then(preset => {
                    if (preset === "off") shouldEnable = false;
                    else if (preset === "basic") shouldEnable = listDef.preset === "basic";
                    return storeInformational(lists, shouldEnable);
                  });
                }
                return storeInformational(lists, shouldEnable);
                function storeInformational(lists, enabled) {
                  lists[listId] = {
                    enabled,
                    version: data.version || null,
                    lastFetched: Date.now(),
                    domainCount,
                    pathRuleCount: 0,
                    type: "informational",
                  };
                  const storageUpdate = {
                    enhancedLists: lists,
                    ["enhancedData_" + listId]: { map: data.map, trackers: data.trackers },
                  };
                  return new Promise(resolve => {
                    chrome.storage.local.set(storageUpdate, () => {
                      if (chrome.runtime.lastError) {
                        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                        resolve();
                        return;
                      }
                      sendResponse({ ok: true, domainCount });
                      resolve();
                    });
                  });
                }
              });
            });
          }
          if (listDef.type === "cosmetic") {
            if (!Array.isArray(data.generic) || !data.domains || typeof data.domains !== "object") {
              throw new Error("Invalid cosmetic list format: missing generic or domains");
            }
            const genericCount = data.generic_count || data.generic.length;
            const domainCount = data.domain_count || Object.keys(data.domains).length;
            let domainRuleCount = data.domain_rule_count || 0;
            if (!domainRuleCount) {
              for (const sels of Object.values(data.domains)) domainRuleCount += sels.length;
            }
            return withEnhancedStorageLock(() => {
              return getEnhancedListsFromStorage().then(lists => {
                const existing = lists[listId];
                if (existing && data.version && existing.version === data.version) {
                  sendResponse({ ok: true, skipped: true, genericCount: existing.genericCount, domainCount: existing.domainCount });
                  return;
                }
                const existingEnabled = existing?.enabled;
                let shouldEnable;
                if (existingEnabled !== undefined) {
                  shouldEnable = existingEnabled;
                } else {
                  shouldEnable = true;
                  return getEnhancedPresetFromStorage().then(preset => {
                    if (preset === "off") shouldEnable = false;
                    else if (preset === "basic") shouldEnable = listDef.preset === "basic";
                    return storeCosmetic(lists, shouldEnable);
                  });
                }
                return storeCosmetic(lists, shouldEnable);
                function storeCosmetic(lists, enabled) {
                  lists[listId] = {
                    enabled,
                    version: data.version || null,
                    lastFetched: Date.now(),
                    genericCount,
                    domainCount,
                    domainRuleCount,
                    pathRuleCount: 0,
                    type: "cosmetic",
                  };
                  const storageUpdate = {
                    enhancedLists: lists,
                    ["enhancedData_" + listId]: { generic: data.generic, domains: data.domains },
                  };
                  return new Promise(resolve => {
                    chrome.storage.local.set(storageUpdate, () => {
                      if (chrome.runtime.lastError) {
                        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                        resolve();
                        return;
                      }
                      rebuildAllDynamicRules();
                      sendResponse({ ok: true, genericCount, domainCount, domainRuleCount });
                      resolve();
                    });
                  });
                }
              });
            });
          }
          if (listDef.type === "cmp") {
            if (!data.signatures || typeof data.signatures !== "object") {
              throw new Error("Invalid CMP list format: missing signatures");
            }
            const cmpCount = data.cmp_count || Object.keys(data.signatures).length;
            return withEnhancedStorageLock(() => {
              return getEnhancedListsFromStorage().then(lists => {
                const existing = lists[listId];
                if (existing && data.version && existing.version === data.version) {
                  sendResponse({ ok: true, skipped: true, cmpCount: existing.cmpCount });
                  return;
                }
                const existingEnabled = existing?.enabled;
                let shouldEnable;
                if (existingEnabled !== undefined) {
                  shouldEnable = existingEnabled;
                } else {
                  shouldEnable = true;
                  return getEnhancedPresetFromStorage().then(preset => {
                    if (preset === "off") shouldEnable = false;
                    else if (preset === "basic") shouldEnable = listDef.preset === "basic";
                    return storeCmp(lists, shouldEnable);
                  });
                }
                return storeCmp(lists, shouldEnable);
                function storeCmp(lists, enabled) {
                  lists[listId] = {
                    enabled,
                    version: data.version || null,
                    lastFetched: Date.now(),
                    cmpCount,
                    type: "cmp",
                  };
                  const storageUpdate = {
                    enhancedLists: lists,
                    ["enhancedData_" + listId]: { signatures: data.signatures },
                    _cmpSignatures: data.signatures,
                  };
                  return new Promise(resolve => {
                    chrome.storage.local.set(storageUpdate, () => {
                      if (chrome.runtime.lastError) {
                        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                        resolve();
                        return;
                      }
                      invalidateCmpSignaturesCache();
                      sendResponse({ ok: true, cmpCount });
                      resolve();
                    });
                  });
                }
              });
            });
          }
          if (listDef.type === "cmp_detectors") {
            if (!data.detectors || typeof data.detectors !== "object") {
              throw new Error("Invalid CMP detectors list format: missing detectors");
            }
            const cmpCount = data.cmp_count || Object.keys(data.detectors).length;
            return withEnhancedStorageLock(() => {
              return getEnhancedListsFromStorage().then(lists => {
                const existing = lists[listId];
                if (existing && data.version && existing.version === data.version) {
                  sendResponse({ ok: true, skipped: true, cmpCount: existing.cmpCount });
                  return;
                }
                const existingEnabled = existing?.enabled;
                let shouldEnable;
                if (existingEnabled !== undefined) {
                  shouldEnable = existingEnabled;
                } else {
                  shouldEnable = true;
                  return getEnhancedPresetFromStorage().then(preset => {
                    if (preset === "off") shouldEnable = false;
                    else if (preset === "basic") shouldEnable = listDef.preset === "basic";
                    return storeCmpDetectors(lists, shouldEnable);
                  });
                }
                return storeCmpDetectors(lists, shouldEnable);
                function storeCmpDetectors(lists, enabled) {
                  lists[listId] = {
                    enabled,
                    version: data.version || null,
                    lastFetched: Date.now(),
                    cmpCount,
                    type: "cmp_detectors",
                  };
                  const storageUpdate = {
                    enhancedLists: lists,
                    ["enhancedData_" + listId]: { detectors: data.detectors },
                    _cmpDetectors: data.detectors,
                  };
                  return new Promise(resolve => {
                    chrome.storage.local.set(storageUpdate, () => {
                      if (chrome.runtime.lastError) {
                        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                        resolve();
                        return;
                      }
                      sendResponse({ ok: true, cmpCount });
                      resolve();
                    });
                  });
                }
              });
            });
          }
          if (listDef.type === "cmp_site") {
            if (!data.signatures || typeof data.signatures !== "object") {
              throw new Error("Invalid CMP site list format: missing signatures");
            }
            const cmpCount = data.cmp_count || Object.keys(data.signatures).length;
            return withEnhancedStorageLock(() => {
              return getEnhancedListsFromStorage().then(lists => {
                const existing = lists[listId];
                if (existing && data.version && existing.version === data.version) {
                  sendResponse({ ok: true, skipped: true, cmpCount: existing.cmpCount });
                  return;
                }
                const existingEnabled = existing?.enabled;
                let shouldEnable;
                if (existingEnabled !== undefined) {
                  shouldEnable = existingEnabled;
                } else {
                  shouldEnable = true;
                  return getEnhancedPresetFromStorage().then(preset => {
                    if (preset === "off") shouldEnable = false;
                    else if (preset === "basic") shouldEnable = listDef.preset === "basic";
                    return storeCmpSite(lists, shouldEnable);
                  });
                }
                return storeCmpSite(lists, shouldEnable);
                function storeCmpSite(lists, enabled) {
                  lists[listId] = {
                    enabled,
                    version: data.version || null,
                    lastFetched: Date.now(),
                    cmpCount,
                    type: "cmp_site",
                  };
                  const storageUpdate = {
                    enhancedLists: lists,
                    ["enhancedData_" + listId]: { signatures: data.signatures },
                    _cmpSiteSignatures: data.signatures,
                  };
                  return new Promise(resolve => {
                    chrome.storage.local.set(storageUpdate, () => {
                      if (chrome.runtime.lastError) {
                        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                        resolve();
                        return;
                      }
                      sendResponse({ ok: true, cmpCount });
                      resolve();
                    });
                  });
                }
              });
            });
          }
          if (!data.rules || !Array.isArray(data.rules)) {
            throw new Error("Invalid list format: missing rules array");
          }
          const domains = [];
          const pathRules = [];
          for (const rule of data.rules) {
            if (rule.condition?.requestDomains) {
              for (const d of rule.condition.requestDomains) domains.push(d);
            }
            if (rule.condition?.urlFilter) {
              pathRules.push({ urlFilter: rule.condition.urlFilter });
            }
          }
          return withEnhancedStorageLock(() => {
            return Promise.all([
              getEnhancedListsFromStorage(),
              getEnhancedPresetFromStorage(),
            ]).then(([lists, preset]) => {
              const existing = lists[listId];
              if (existing && data.version && existing.version === data.version) {
                sendResponse({ ok: true, skipped: true, domainCount: existing.domainCount, pathRuleCount: existing.pathRuleCount });
                return;
              }
              const existingEnabled = existing?.enabled;
              let shouldEnable;
              if (existingEnabled !== undefined) {
                shouldEnable = existingEnabled;
              } else {
                shouldEnable = true;
                if (preset === "off") shouldEnable = false;
                else if (preset === "basic") shouldEnable = listDef.preset === "basic";
              }
              lists[listId] = {
                enabled: shouldEnable,
                version: data.version || null,
                lastFetched: Date.now(),
                domainCount: domains.length,
                pathRuleCount: pathRules.length,
              };
              const storageUpdate = {
                enhancedLists: lists,
                ["enhancedData_" + listId]: {
                  domains,
                  pathRules: pathRules.length > 0 ? pathRules : undefined,
                },
              };
              return new Promise(resolve => {
                chrome.storage.local.set(storageUpdate, () => {
                  if (chrome.runtime.lastError) {
                    sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                    resolve();
                    return;
                  }
                  rebuildAllDynamicRules();
                  sendResponse({ ok: true, domainCount: domains.length, pathRuleCount: pathRules.length });
                  resolve();
                });
              });
            });
          });
        })
        .catch(err => {
          clearTimeout(timeoutId);
          sendResponse({ ok: false, error: err.name === "AbortError" ? "Download timed out" : err.message });
        });
    });
    return true;
  }

  // Enhanced: remove downloaded list
  if (message.type === "PROTOCONSENT_ENHANCED_REMOVE") {
    const { listId } = message;
    if (!listId) { sendResponse({ ok: false }); return; }
    withEnhancedStorageLock(() => {
      return Promise.all([
        getEnhancedListsFromStorage(),
        loadEnhancedListsCatalog(),
        getEnhancedPresetFromStorage(),
      ]).then(([lists, catalog, preset]) => {
        if (!lists[listId]) {
          sendResponse({ ok: true }); return;
        }
        const removedType = lists[listId].type;
        delete lists[listId];
        const newPreset = resolveEnhancedPreset(lists, catalog);
        return new Promise(resolve => {
          chrome.storage.local.set({ enhancedLists: lists, enhancedPreset: newPreset }, () => {
            if (chrome.runtime.lastError) {
              sendResponse({ ok: false, error: chrome.runtime.lastError.message });
              resolve();
              return;
            }
            chrome.storage.local.remove("enhancedData_" + listId, () => {
              if (chrome.runtime.lastError) {
                // Data key removal failed - log but still report success
              }
              // CMP bridge cleanup: clear _cmpSignatures so next rebuild falls back to bundled
              if (removedType === "cmp") {
                chrome.storage.local.remove("_cmpSignatures", () => {
                  invalidateCmpSignaturesCache();
                  rebuildAllDynamicRules();
                  sendResponse({ ok: true });
                  resolve();
                });
                return;
              }
              if (removedType === "cmp_detectors") {
                chrome.storage.local.remove("_cmpDetectors", () => {
                  sendResponse({ ok: true });
                  resolve();
                });
                return;
              }
              if (removedType === "cmp_site") {
                chrome.storage.local.remove("_cmpSiteSignatures", () => {
                  sendResponse({ ok: true });
                  resolve();
                });
                return;
              }
              rebuildAllDynamicRules();
              sendResponse({ ok: true });
              resolve();
            });
          });
        });
      });
    });
    return true;
  }
});
