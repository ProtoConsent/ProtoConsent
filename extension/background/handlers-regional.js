// ProtoConsent regional list fetch handler
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Handles FETCH and storage-change logic for regional_cosmetic and
// regional_blocking enhanced lists. Extracted from handlers.js.

import { REGIONAL_IDS, DEBUG_RULES } from "./config-bridge.js";
import { loadRegionalLanguagesConfig } from "./config-loader.js";
import {
  getEnhancedListsFromStorage, getEnhancedPresetFromStorage, withEnhancedStorageLock,
} from "./storage.js";
import { rebuildAllDynamicRules } from "./rebuild.js";
import { fetchAndEnableRegionalList } from "./auto-refresh.js";
import { fetchEnhancedList } from "./handlers.js";

const CDN_PREFIX = "https://cdn.jsdelivr.net/gh/ProtoConsent/data@main/";
const RAW_PREFIX = "https://raw.githubusercontent.com/ProtoConsent/data/main/";

function fetchWithFallback(url, opts) {
  return fetch(url, opts).then(res => {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res;
  }).catch(err => {
    if (url.startsWith(CDN_PREFIX)) {
      return fetch(url.replace(CDN_PREFIX, RAW_PREFIX), opts).then(res => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res;
      });
    }
    throw err;
  });
}

// Fetch and merge regional list data for the given catalog entry.
// Calls sendResponse with the result (ok/error).
export async function handleRegionalFetch(listId, listDef, sendResponse) {
  const [storageData, rlConfig] = await Promise.all([
    new Promise(r => chrome.storage.local.get("regionalLanguages", r)),
    loadRegionalLanguagesConfig(),
  ]);
  const configRegions = new Set(Object.keys(rlConfig));
  // Catalog regions (from merged catalog, CDN-authoritative) take precedence
  const catalogRegions = Array.isArray(listDef.regions) ? new Set(listDef.regions) : null;
  const rawLangs = storageData.regionalLanguages;
  if (!Array.isArray(rawLangs) || !rawLangs.length) {
    sendResponse({ ok: false, error: "No regional languages selected" }); return;
  }
  const langs = rawLangs.filter(r =>
    configRegions.has(r) && (!catalogRegions || catalogRegions.has(r))
  );
  if (!langs.length) {
    sendResponse({ ok: false, error: "No valid regional languages selected" }); return;
  }
  const fetchBase = listDef.fetch_base;
  const suffix = listDef.type === "regional_cosmetic" ? "_cosmetic" : "_blocking";

  if (listDef.type === "regional_cosmetic") {
    await fetchRegionalCosmetic(listId, langs, fetchBase, suffix, sendResponse);
  } else {
    await fetchRegionalBlocking(listId, langs, fetchBase, suffix, sendResponse);
  }
}

// --- Cosmetic ---

async function fetchRegionalCosmetic(listId, langs, fetchBase, suffix, sendResponse) {
  const versions = {};
  const fetchedRegions = [];
  let totalGenericCount = 0;
  let totalDomainCount = 0;
  let totalDomainRuleCount = 0;
  const storageUpdates = {};

  for (const region of langs) {
    const url = fetchBase + "regional_" + region + suffix + ".json";
    try {
      const res = await fetchWithFallback(url, { credentials: "omit", cache: "no-store" });
      const data = await res.json();
      fetchedRegions.push(region);
      if (data.version) versions[region] = data.version;
      storageUpdates["enhancedData_" + listId + "_" + region] = {
        generic: data.generic || [],
        domains: data.domains || {},
        exceptions: data.exceptions || {},
      };
      totalGenericCount += data.generic_count || (Array.isArray(data.generic) ? data.generic.length : 0);
      if (data.domains && typeof data.domains === "object") {
        totalDomainCount += Object.keys(data.domains).length;
        for (const sels of Object.values(data.domains)) totalDomainRuleCount += sels.length;
      }
    } catch (_) { /* skip failed region - its stored data remains untouched */ }
  }

  if (!fetchedRegions.length) {
    sendResponse({ ok: false, error: "No regional files could be downloaded" }); return;
  }

  const latestVersion = Object.values(versions).reduce((max, v) => v > max ? v : max, null);

  await withEnhancedStorageLock(() => {
    return getEnhancedListsFromStorage().then(lists => {
      const existing = lists[listId];
      const existingVersions = existing?.versions || {};
      const allMatch = Object.entries(versions).every(([r, v]) => existingVersions[r] === v);
      if (existing && Object.keys(versions).length && allMatch) {
        sendResponse({ ok: true, skipped: true, genericCount: existing.genericCount, domainCount: existing.domainCount });
        return;
      }
      const allRegions = Array.from(new Set([...(existing?.regions || []), ...fetchedRegions]));
      lists[listId] = {
        enabled: existing?.enabled !== undefined ? existing.enabled : true,
        version: latestVersion,
        versions: { ...existingVersions, ...versions },
        lastFetched: Date.now(),
        genericCount: totalGenericCount,
        domainCount: totalDomainCount,
        domainRuleCount: totalDomainRuleCount,
        pathRuleCount: 0,
        type: "cosmetic",
        regions: allRegions,
      };
      storageUpdates.enhancedLists = lists;
      return new Promise(resolve => {
        chrome.storage.local.set(storageUpdates, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            resolve(); return;
          }
          rebuildAllDynamicRules();
          sendResponse({ ok: true, genericCount: totalGenericCount, domainCount: totalDomainCount, regions: fetchedRegions });
          resolve();
        });
      });
    });
  });
}

// --- Blocking ---

async function fetchRegionalBlocking(listId, langs, fetchBase, suffix, sendResponse) {
  const versions = {};
  const fetchedRegions = [];
  const storageUpdates = {};

  for (const region of langs) {
    const url = fetchBase + "regional_" + region + suffix + ".json";
    try {
      const res = await fetchWithFallback(url, { credentials: "omit", cache: "no-store" });
      const data = await res.json();
      fetchedRegions.push(region);
      if (data.version) versions[region] = data.version;
      const domains = [];
      const pathRules = [];
      if (Array.isArray(data.rules)) {
        for (const rule of data.rules) {
          if (rule.condition?.requestDomains) {
            for (const d of rule.condition.requestDomains) domains.push(d);
          }
          if (rule.condition?.urlFilter) {
            pathRules.push({ urlFilter: rule.condition.urlFilter });
          }
        }
      }
      storageUpdates["enhancedData_" + listId + "_" + region] = {
        domains,
        pathRules: pathRules.length > 0 ? pathRules : undefined,
      };
    } catch (_) { /* skip failed region - its stored data remains untouched */ }
  }

  if (!fetchedRegions.length) {
    sendResponse({ ok: false, error: "No regional files could be downloaded" }); return;
  }

  const latestVersion = Object.values(versions).reduce((max, v) => v > max ? v : max, null);

  await withEnhancedStorageLock(() => {
    return getEnhancedListsFromStorage().then(lists => {
      const existing = lists[listId];
      const existingVersions = existing?.versions || {};
      const allMatch = Object.entries(versions).every(([r, v]) => existingVersions[r] === v);
      if (existing && Object.keys(versions).length && allMatch) {
        sendResponse({ ok: true, skipped: true, domainCount: existing.domainCount });
        return;
      }
      const allRegions = Array.from(new Set([...(existing?.regions || []), ...fetchedRegions]));
      const totalDomains = Object.values(storageUpdates).reduce((sum, d) => sum + (d?.domains?.length || 0), 0);
      const totalPathRules = Object.values(storageUpdates).reduce((sum, d) => sum + (d?.pathRules?.length || 0), 0);
      lists[listId] = {
        enabled: existing?.enabled !== undefined ? existing.enabled : true,
        version: latestVersion,
        versions: { ...existingVersions, ...versions },
        lastFetched: Date.now(),
        domainCount: totalDomains,
        pathRuleCount: totalPathRules,
        regions: allRegions,
      };
      storageUpdates.enhancedLists = lists;
      return new Promise(resolve => {
        chrome.storage.local.set(storageUpdates, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            resolve(); return;
          }
          rebuildAllDynamicRules();
          sendResponse({ ok: true, domainCount: totalDomains, pathRuleCount: totalPathRules, regions: fetchedRegions });
          resolve();
        });
      });
    });
  });
}

// Re-fetch regional lists when user changes their language selection in settings.
// If all languages removed, disable regional lists and rebuild rules.
let _regionalDebounceTimer = null;
export function initRegionalStorageListener() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.regionalLanguages) return;
    const newLangs = changes.regionalLanguages.newValue;
    const oldLangs = changes.regionalLanguages.oldValue || [];

    // Clean up per-language storage keys for removed languages
    const removed = Array.isArray(oldLangs) ? oldLangs.filter(l => !Array.isArray(newLangs) || !newLangs.includes(l)) : [];
    if (removed.length) {
      const keysToRemove = [];
      for (const id of REGIONAL_IDS) {
        for (const lang of removed) keysToRemove.push("enhancedData_" + id + "_" + lang);
      }
      chrome.storage.local.remove(keysToRemove);
      // Clean metadata: remove from regions and versions
      withEnhancedStorageLock(() => {
        return getEnhancedListsFromStorage().then(lists => {
          let changed = false;
          for (const id of REGIONAL_IDS) {
            if (!lists[id]) continue;
            if (lists[id].regions) {
              lists[id].regions = lists[id].regions.filter(r => !removed.includes(r));
              changed = true;
            }
            if (lists[id].versions) {
              for (const lang of removed) delete lists[id].versions[lang];
              changed = true;
            }
          }
          if (!changed) return;
          return new Promise(resolve => chrome.storage.local.set({ enhancedLists: lists }, resolve));
        });
      });
    }

    // Debounce rapid toggles (100ms)
    if (_regionalDebounceTimer) clearTimeout(_regionalDebounceTimer);
    _regionalDebounceTimer = setTimeout(() => {
      _regionalDebounceTimer = null;

      if (!Array.isArray(newLangs) || !newLangs.length) {
        // No languages: disable all regional lists
        withEnhancedStorageLock(() => {
          return getEnhancedListsFromStorage().then(lists => {
            let changed = false;
            for (const id of REGIONAL_IDS) {
              if (lists[id] && lists[id].enabled) {
                lists[id].enabled = false;
                changed = true;
              }
            }
            if (!changed) return;
            return new Promise(resolve => {
              chrome.storage.local.set({ enhancedLists: lists }, () => {
                rebuildAllDynamicRules();
                resolve();
              });
            });
          });
        });
        return;
      }

      // Languages selected: re-fetch enabled regional lists + download missing ones
      if (DEBUG_RULES) console.log("ProtoConsent regional: languages changed to", newLangs);
      Promise.all([
        getEnhancedListsFromStorage(),
        new Promise(r => chrome.storage.local.get("dynamicListsConsent", d => r(d.dynamicListsConsent !== false))),
        getEnhancedPresetFromStorage(),
      ]).then(([lists, syncEnabled, preset]) => {
        if (preset === "off") return;
        const reEnabled = [];
        for (const id of REGIONAL_IDS) {
          if (lists[id] && lists[id].enabled) {
            // Already downloaded + enabled: re-fetch with new languages
            if (DEBUG_RULES) console.log("ProtoConsent regional: re-fetching", id);
            fetchEnhancedList(id).catch(() => {});
          } else if (lists[id] && !lists[id].enabled) {
            // Downloaded but disabled: re-enable and re-fetch
            lists[id].enabled = true;
            reEnabled.push(id);
          } else if (!lists[id] && syncEnabled) {
            // Not yet downloaded + sync enabled: trigger initial download
            if (DEBUG_RULES) console.log("ProtoConsent regional: initial download of", id);
            fetchAndEnableRegionalList(id).catch(e => console.warn("ProtoConsent regional: download error for", id, e));
          }
        }
        if (reEnabled.length) {
          chrome.storage.local.set({ enhancedLists: lists }, () => {
            for (const id of reEnabled) {
              fetchEnhancedList(id).catch(() => {});
            }
            rebuildAllDynamicRules();
          });
        }
      });
    }, 100);
  });
}
