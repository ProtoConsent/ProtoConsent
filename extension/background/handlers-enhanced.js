// ProtoConsent enhanced lists message handlers
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { isRegionalEntry } from "./config-bridge.js";
import { lastConsentLinkedListIds, lastCelPendingDownload } from "./state.js";
import {
  getEnhancedListsFromStorage, getEnhancedPresetFromStorage,
  withEnhancedStorageLock,
} from "./storage.js";
import { loadEnhancedListsCatalog } from "./config-loader.js";
import { rebuildCategories } from "./rebuild.js";
import { invalidateCmpSignaturesCache } from "./cmp-injection.js";
import { refreshLists } from "./auto-refresh.js";

// --- Enhanced preset resolution ---

function resolveEnhancedPreset(lists, catalog) {
  const downloaded = Object.keys(lists);
  if (downloaded.length === 0) return "off";
  const allDisabled = downloaded.every(id => !lists[id]?.enabled);
  if (allDisabled) return "off";
  const catalogIds = Object.keys(catalog).filter(id => !isRegionalEntry(catalog[id]) && catalog[id].preset !== "optional" && catalog[id].version);
  if (catalogIds.length === 0) return "custom";
  const allDownloaded = catalogIds.every(id => !!lists[id]);
  const allEnabled = allDownloaded && catalogIds.every(id => !!lists[id]?.enabled);
  if (allEnabled) return "full";
  let matchesBasic = true;
  for (const id of catalogIds) {
    const shouldBeEnabled = catalog[id] ? catalog[id].preset === "basic" : false;
    const isEnabled = !!lists[id]?.enabled;
    if (isEnabled !== shouldBeEnabled) { matchesBasic = false; break; }
  }
  if (matchesBasic) return "basic";
  return "custom";
}

// --- Fetch infrastructure ---

let _activeFetchCount = 0;
export function getActiveFetchCount() { return _activeFetchCount; }

export function fetchEnhancedList(listId, listsCache) {
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
      const lists = listsCache || await getEnhancedListsFromStorage();
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
        if (fallbackUrl && existing && _isUnchanged(existing, data)) {
          const catalogTS = listDef.generated || listDef.version;
          const downloadedTS = data.generated || data.version;
          if (catalogTS && downloadedTS && catalogTS > downloadedTS) {
            const ctrl2 = new AbortController();
            const tid2 = setTimeout(() => ctrl2.abort(), 15000);
            try {
              data = await fetch(fallbackUrl, { credentials: "omit", signal: ctrl2.signal, cache: "no-store" }).then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
            } catch (_) { /* keep primary */ }
            clearTimeout(tid2);
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

// --- Storage helpers ---

function _isUnchanged(existing, data) {
  if (!existing) return false;
  const remote = data.generated || data.version;
  const local = existing.generated || existing.version;
  return remote && local && remote === local;
}

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

function _writeStorage(update) {
  return new Promise(resolve => {
    chrome.storage.local.set(update, () => {
      resolve(chrome.runtime.lastError ? chrome.runtime.lastError.message : null);
    });
  });
}

// --- List type handlers ---

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
    if (!domains.length && !pathExceptions.length)
      return { counts: { hotfixCount: 0 }, payload: null };
    const payload = { domains };
    if (pathExceptions.length) payload.pathExceptions = pathExceptions;
    return {
      counts: { hotfixCount: domains.length, pathExceptionCount: pathExceptions.length },
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

// --- Message handlers ---

// Handle enhanced-list messages (get state, set preset, toggle, fetch, remove).
// @returns {boolean|undefined} true if handled (async response), undefined if not an enhanced message

export function handleEnhancedMessage(message, _sender, sendResponse) {

  if (message.type === "PROTOCONSENT_ENHANCED_GET_FETCH_COUNT") {
    sendResponse({ activeFetches: _activeFetchCount });
    return;
  }

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

  if (message.type === "PROTOCONSENT_ENHANCED_SET_PRESET") {
    const preset = message.preset;
    if (!["off", "basic", "full", "custom"].includes(preset)) {
      sendResponse({ ok: false }); return true;
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
              if (preset === "basic" || preset === "full") {
                refreshLists("all", { initialDownload: true });
              }
              sendResponse({ ok: true });
              resolve();
            });
          });
          });
        });
      });
    });
    return true;
  }

  if (message.type === "PROTOCONSENT_ENHANCED_TOGGLE") {
    const { listId, enabled } = message;
    if (!listId || typeof enabled !== "boolean") {
      sendResponse({ ok: false }); return true;
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

  if (message.type === "PROTOCONSENT_ENHANCED_FETCH") {
    const { listId } = message;
    if (!listId) { sendResponse({ ok: false }); return true; }
    fetchEnhancedList(listId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (message.type === "PROTOCONSENT_ENHANCED_REMOVE") {
    const { listId } = message;
    if (!listId) { sendResponse({ ok: false }); return true; }
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
}
