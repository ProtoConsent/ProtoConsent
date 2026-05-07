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
 
import { WELL_KNOWN_SKIP_DOMAINS, isRegionalEntry } from "./config-bridge.js";
import { getLifetimeTotal } from "./tracking.js";

function resolveEnhancedPreset(lists, catalog) {
  const downloaded = Object.keys(lists);
  if (downloaded.length === 0) return "off";
  const allDisabled = downloaded.every(id => !lists[id]?.enabled);
  if (allDisabled) return "off";
  // Exclude regional and optional lists from preset resolution (they are user-managed)
  const catalogIds = Object.keys(catalog).filter(id => !isRegionalEntry(catalog[id]) && catalog[id].preset !== "optional" && catalog[id].version);
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
  getEnhancedListsFromStorage, getEnhancedPresetFromStorage,
  withEnhancedStorageLock, withWhitelist,
  withCosmeticExceptions, withCosmeticExcludedSites,
} from "./storage.js";
import {
  loadBlocklistsConfig, loadPresetsConfig, loadPurposesConfig,
  loadEnhancedListsCatalog,
} from "./config-loader.js";
import { initRegionalStorageListener } from "./handlers-regional.js";
import { rebuildAllDynamicRules, rebuildCategories } from "./rebuild.js";
import { invalidateCmpSignaturesCache } from "./cmp-injection.js";
import { decodeCmpCookies, decodeCmpStorage } from "./cmp-cookie-decode.js";
import { scheduleSessionPersist } from "./session.js";
import { getBlockerDetectionState, resetBehavioralCounters, dismissBlockerDetection, isBrave } from "./blocker-detection.js";
import { refreshLists } from "./auto-refresh.js";
import { whitelistAllForSite, removeWhitelistAllForSite, clearWhitelistAll } from "./context-menu.js";

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

// Fetch (download) a single enhanced list by ID.
// Returns a Promise that resolves with { ok, skipped?, ...counts } or rejects on error.
// Used by the PROTOCONSENT_ENHANCED_FETCH message handler and by auto-refresh.js.
let _activeFetchCount = 0;
export function getActiveFetchCount() { return _activeFetchCount; }

export function fetchEnhancedList(listId) {
  _activeFetchCount++;
  return loadEnhancedListsCatalog().then(async (catalog) => {
    try {
      const listDef = catalog[listId];
      if (!listDef || !listDef.fetch_url) {
        return { ok: false, error: "Unknown list or no fetch URL" };
      }
      const fetchUrl = listDef.fetch_url.startsWith("http")
        ? listDef.fetch_url
        : chrome.runtime.getURL(listDef.fetch_url);
      const fallbackUrl = fetchUrl.includes("cdn.jsdelivr.net/gh/")
        ? fetchUrl.replace("https://cdn.jsdelivr.net/gh/ProtoConsent/data@main/", "https://raw.githubusercontent.com/ProtoConsent/data/main/")
        : null;
      // Skip fetch if catalog metadata matches what we already have stored
      const lists = await getEnhancedListsFromStorage();
      const existing = lists[listId];
      if (existing) {
        const catalogTS = listDef.generated || listDef.version;
        const localTS = existing.generated || existing.version;
        if (catalogTS && localTS && catalogTS === localTS) {
          return { ok: true, skipped: true };
        }
      }
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      const fetchOpts = { credentials: "omit", signal: controller.signal, cache: "no-store" };
      const tryFetch = (url) => fetch(url, fetchOpts).then(res => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      });
      try {
        let data = await tryFetch(fetchUrl).catch(err => {
          if (fallbackUrl && err.name !== "AbortError") return tryFetch(fallbackUrl);
          throw err;
        });
        // If primary CDN returned stale data (matches stored but catalog is newer), try fallback
        if (fallbackUrl && existing && _isUnchanged(existing, data)) {
          const catalogTS = listDef.generated || listDef.version;
          const downloadedTS = data.generated || data.version;
          if (catalogTS && downloadedTS && catalogTS > downloadedTS) {
            try { data = await tryFetch(fallbackUrl); } catch (_) { /* keep primary */ }
          }
        }
        clearTimeout(timeoutId);
        return _storeEnhancedListData(listId, listDef, data);
      } catch (err) {
        clearTimeout(timeoutId);
        return { ok: false, error: err.name === "AbortError" ? "Download timed out" : err.message };
      }
    } finally {
      _activeFetchCount = Math.max(0, _activeFetchCount - 1);
    }
  }).catch(err => {
    _activeFetchCount = Math.max(0, _activeFetchCount - 1);
    return { ok: false, error: err.message || "catalog load failed" };
  });
}

// Store fetched list data by type. Returns a Promise<result>.
function _isUnchanged(existing, data) {
  if (!existing) return false;
  const remote = data.generated || data.version;
  const local = existing.generated || existing.version;
  return remote && local && remote === local;
}

const _listTypeHandlers = {
  informational(data) {
    if (!data.map || typeof data.map !== "object" || !Array.isArray(data.trackers))
      throw new Error("Invalid informational list format: missing map or trackers");
    const domainCount = data.domain_count || Object.keys(data.map).length;
    return {
      counts: { domainCount, pathRuleCount: 0 },
      payload: { map: data.map, trackers: data.trackers },
    };
  },

  cosmetic(data) {
    if (!Array.isArray(data.generic) || !data.domains || typeof data.domains !== "object")
      throw new Error("Invalid cosmetic list format: missing generic or domains");
    const genericCount = data.generic_count || data.generic.length;
    const domainCount = data.domain_count || Object.keys(data.domains).length;
    let domainRuleCount = data.domain_rule_count || 0;
    if (!domainRuleCount) {
      for (const sels of Object.values(data.domains)) domainRuleCount += sels.length;
    }
    return {
      counts: { genericCount, domainCount, domainRuleCount, pathRuleCount: 0 },
      payload: { generic: data.generic, domains: data.domains, exceptions: data.exceptions || {} },
      afterWrite: () => rebuildCategories(new Set(["cosmetic"])),
    };
  },

  cmp(data) {
    if (!data.signatures || typeof data.signatures !== "object")
      throw new Error("Invalid CMP list format: missing signatures");
    const cmpCount = data.cmp_count || Object.keys(data.signatures).length;
    return {
      counts: { cmpCount },
      payload: { signatures: data.signatures },
      extraKeys: { _cmpSignatures: data.signatures },
      afterWrite: invalidateCmpSignaturesCache,
    };
  },

  cmp_detectors(data) {
    if (!data.detectors || typeof data.detectors !== "object")
      throw new Error("Invalid CMP detectors list format: missing detectors");
    const cmpCount = data.cmp_count || Object.keys(data.detectors).length;
    return {
      counts: { cmpCount },
      payload: { detectors: data.detectors },
      extraKeys: { _cmpDetectors: data.detectors },
    };
  },

  cmp_site(data) {
    if (!data.signatures || typeof data.signatures !== "object")
      throw new Error("Invalid CMP site list format: missing signatures");
    const cmpCount = data.cmp_count || Object.keys(data.signatures).length;
    return {
      counts: { cmpCount },
      payload: { signatures: data.signatures },
      extraKeys: { _cmpSiteSignatures: data.signatures },
    };
  },

  tracking_params(data) {
    if (!Array.isArray(data.params) || !data.params.length)
      throw new Error("Invalid tracking_params format: missing or empty params array");
    const params = data.params.filter(p => typeof p === "string" && p.length > 0);
    if (!params.length)
      throw new Error("Invalid tracking_params format: no valid string params");
    return {
      counts: { paramCount: params.length },
      payload: { params },
      afterWrite: () => rebuildCategories(new Set(["enhanced"])),
    };
  },

  tracking_params_sites(data) {
    if (!data.sites || typeof data.sites !== "object" || Array.isArray(data.sites))
      throw new Error("Invalid tracking_params_sites format: missing sites object");
    const cleanSites = {};
    for (const [domain, vals] of Object.entries(data.sites)) {
      if (typeof domain !== "string" || !domain) continue;
      if (!Array.isArray(vals)) continue;
      const cleaned = vals.filter(p => typeof p === "string" && p.length > 0);
      if (cleaned.length) cleanSites[domain] = cleaned;
    }
    if (!Object.keys(cleanSites).length)
      throw new Error("Invalid tracking_params_sites format: no valid site entries");
    return {
      counts: { paramCount: new Set(Object.values(cleanSites).flat()).size, domainCount: Object.keys(cleanSites).length },
      payload: { sites: cleanSites },
      afterWrite: () => rebuildCategories(new Set(["enhanced"])),
    };
  },

  revoke(data) {
    if (!data.revocations || !Array.isArray(data.revocations))
      throw new Error("Invalid revoke format: missing revocations array");
    const domains = data.revocations.filter(d => typeof d === "string" && d.length > 0);
    const pathRules = [];
    if (Array.isArray(data.path_additions)) {
      for (const pa of data.path_additions) {
        if (pa && typeof pa.urlFilter === "string" && pa.urlFilter.length > 0)
          pathRules.push({ urlFilter: pa.urlFilter });
      }
    }
    const pathExceptions = [];
    if (Array.isArray(data.path_exceptions)) {
      for (const pe of data.path_exceptions) {
        if (pe && typeof pe.urlFilter === "string" && pe.urlFilter.length > 0) {
          const entry = { urlFilter: pe.urlFilter };
          if (Array.isArray(pe.initiatorDomains) && pe.initiatorDomains.length > 0)
            entry.initiatorDomains = pe.initiatorDomains;
          if (pe.firstParty) entry.firstParty = true;
          pathExceptions.push(entry);
        }
      }
    }
    if (!domains.length && !pathRules.length && !pathExceptions.length)
      return { counts: { hotfixCount: 0 }, payload: null };
    const payload = { domains };
    if (pathRules.length) payload.pathRules = pathRules;
    if (pathExceptions.length) payload.pathExceptions = pathExceptions;
    return {
      counts: { hotfixCount: domains.length, pathRuleCount: pathRules.length, pathExceptionCount: pathExceptions.length },
      payload,
      afterWrite: () => rebuildCategories(new Set(["enhanced"])),
    };
  },
};

function _handleDefaultBlocking(data) {
  if (!data.rules || !Array.isArray(data.rules))
    throw new Error("Invalid list format: missing rules array");
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
  return {
    counts: { domainCount: domains.length, pathRuleCount: pathRules.length },
    payload: { domains, pathRules: pathRules.length > 0 ? pathRules : undefined },
    afterWrite: () => rebuildCategories(new Set(["enhanced"])),
  };
}

function _storeEnhancedListData(listId, listDef, data) {
  const handler = _listTypeHandlers[listDef.type] || _handleDefaultBlocking;
  const { counts, payload, extraKeys, afterWrite } = handler(data);
  if (!payload) return Promise.resolve({ ok: true, skipped: true, ...counts });

  return withEnhancedStorageLock(() => {
    return getEnhancedListsFromStorage().then(lists => {
      const existing = lists[listId];
      if (_isUnchanged(existing, data)) {
        return { ok: true, skipped: true, ...counts };
      }
      return _resolveEnabled(existing, listDef).then(shouldEnable => {
        lists[listId] = {
          enabled: shouldEnable,
          version: data.version || null,
          generated: data.generated || null,
          lastFetched: Date.now(),
          ...counts,
        };
        if (listDef.type) lists[listId].type = listDef.type;
        if (listDef.category) lists[listId].category = listDef.category;
        const storageUpdate = {
          enhancedLists: lists,
          ["enhancedData_" + listId]: payload,
          ...extraKeys,
        };
        return _writeStorage(storageUpdate).then(err => {
          if (err) return { ok: false, error: err };
          if (afterWrite) afterWrite();
          return { ok: true, ...counts };
        });
      });
    });
  });
}

// Resolve whether a list should be enabled based on existing state and preset.
function _resolveEnabled(existing, listDef) {
  if (existing?.enabled !== undefined) {
    return Promise.resolve(existing.enabled);
  }
  return getEnhancedPresetFromStorage().then(preset => {
    if (preset === "off") return false;
    if (preset === "basic") return listDef.preset === "basic";
    return true;
  });
}

// Write to chrome.storage.local, returning null on success or error message.
function _writeStorage(update) {
  return new Promise(resolve => {
    chrome.storage.local.set(update, () => {
      resolve(chrome.runtime.lastError ? chrome.runtime.lastError.message : null);
    });
  });
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

  // Popup requests user-defined cosmetic exceptions
  if (message.type === "PROTOCONSENT_GET_COSMETIC_EXCEPTIONS") {
    chrome.storage.local.get(["cosmeticUserExceptions"], (r) => {
      sendResponse({ exceptions: r.cosmeticUserExceptions || {} });
    });
    return true;
  }

  // Cosmetic whitelist: exclude a selector for a domain
  if (message.type === "PROTOCONSENT_COSMETIC_EXCLUDE") {
    const { domain, selector } = message;
    if (!domain || !selector || !isValidHostname(domain)) {
      sendResponse({ ok: false }); return;
    }
    withCosmeticExceptions(exc => {
      if (!exc[domain]) exc[domain] = [];
      if (!exc[domain].includes(selector)) exc[domain].push(selector);
      return new Promise(resolve => {
        chrome.storage.local.set({ cosmeticUserExceptions: exc }, () => {
          if (chrome.runtime.lastError) { sendResponse({ ok: false }); resolve(); return; }
          rebuildCategories(new Set(["cosmetic"]));
          sendResponse({ ok: true });
          resolve();
        });
      });
    });
    return true;
  }

  // Cosmetic whitelist: restore a previously excluded selector
  if (message.type === "PROTOCONSENT_COSMETIC_RESTORE") {
    const { domain, selector } = message;
    if (!domain || !selector || !isValidHostname(domain)) { sendResponse({ ok: false }); return; }
    withCosmeticExceptions(exc => {
      if (exc[domain]) {
        exc[domain] = exc[domain].filter(s => s !== selector);
        if (exc[domain].length === 0) delete exc[domain];
      }
      return new Promise(resolve => {
        chrome.storage.local.set({ cosmeticUserExceptions: exc }, () => {
          if (chrome.runtime.lastError) { sendResponse({ ok: false }); resolve(); return; }
          rebuildCategories(new Set(["cosmetic"]));
          sendResponse({ ok: true });
          resolve();
        });
      });
    });
    return true;
  }

  // Cosmetic whitelist: exclude all cosmetic filtering for a site
  if (message.type === "PROTOCONSENT_COSMETIC_EXCLUDE_SITE") {
    const { domain } = message;
    if (!domain || !isValidHostname(domain)) { sendResponse({ ok: false }); return; }
    withCosmeticExcludedSites(sites => {
      if (!sites.includes(domain)) sites.push(domain);
      return new Promise(resolve => {
        chrome.storage.local.set({ cosmeticExcludedSites: sites }, () => {
          if (chrome.runtime.lastError) { sendResponse({ ok: false }); resolve(); return; }
          rebuildCategories(new Set(["cosmetic"]));
          sendResponse({ ok: true });
          resolve();
        });
      });
    });
    return true;
  }

  // Cosmetic whitelist: restore cosmetic filtering for a site
  if (message.type === "PROTOCONSENT_COSMETIC_RESTORE_SITE") {
    const { domain } = message;
    if (!domain || !isValidHostname(domain)) { sendResponse({ ok: false }); return; }
    withCosmeticExcludedSites(sites => {
      const filtered = sites.filter(s => s !== domain);
      return new Promise(resolve => {
        chrome.storage.local.set({ cosmeticExcludedSites: filtered }, () => {
          if (chrome.runtime.lastError) { sendResponse({ ok: false }); resolve(); return; }
          rebuildCategories(new Set(["cosmetic"]));
          sendResponse({ ok: true });
          resolve();
        });
      });
    });
    return true;
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
            rebuildCategories(new Set(["whitelist"]));
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
            rebuildCategories(new Set(["whitelist"]));
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
            rebuildCategories(new Set(["whitelist"]));
            sendResponse({ ok: true, whitelist });
          }
          resolve();
        });
      });
    });
    return true;
  }

  // Whitelist: allow all blocked domains for a site
  if (message.type === "PROTOCONSENT_WHITELIST_ALL_SITE") {
    const { tabId, site } = message;
    if (!site || !isValidHostname(site)) { sendResponse({ ok: false }); return; }
    whitelistAllForSite(tabId, site).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  // Whitelist: remove all per-site whitelist entries
  if (message.type === "PROTOCONSENT_WHITELIST_REMOVE_ALL_SITE") {
    const { site } = message;
    if (!site || !isValidHostname(site)) { sendResponse({ ok: false }); return; }
    removeWhitelistAllForSite(site).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  // Whitelist: clear all entries (except hotfixes)
  if (message.type === "PROTOCONSENT_WHITELIST_CLEAR") {
    clearWhitelistAll().then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "PROTOCONSENT_ENHANCED_GET_FETCH_COUNT") {
    sendResponse({ activeFetches: _activeFetchCount });
    return;
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
        celPendingDownload: lastCelPendingDownload,
        activeFetches: _activeFetchCount });
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
          return new Promise(resolveRL => {
            chrome.storage.local.get(["regionalLanguages"], (rl) => {
              resolveRL(Array.isArray(rl.regionalLanguages) ? rl.regionalLanguages : []);
            });
          }).then(regionalLangs => {
          for (const [listId, listDef] of Object.entries(catalog)) {
            if (!lists[listId]) continue;
            if (preset === "off") {
              lists[listId].enabled = false;
            } else if (isRegionalEntry(listDef)) {
              // Regional lists follow preset only if their region is selected
              if (regionalLangs.includes(listDef.region)) {
                if (preset === "basic") {
                  lists[listId].enabled = listDef.preset === "basic";
                } else if (preset === "full") {
                  lists[listId].enabled = true;
                }
              }
            } else if (listDef.preset === "optional") {
              // Optional lists are never changed by preset switches
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
              rebuildCategories(new Set(["enhanced"]));
              // Auto-download missing lists for new preset
              if (preset === "basic" || preset === "full") {
                refreshLists("all", { initialDownload: true });
              }
              sendResponse({ ok: true });
              resolve();
            });
          });
          }); // end regionalLangs then
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
              rebuildCategories(new Set(["enhanced"]));
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
    fetchEnhancedList(listId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
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
                  rebuildCategories(new Set(["cmp"]));
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
              rebuildCategories(new Set(["enhanced"]));
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

// Initialize regional language change listener
initRegionalStorageListener();
