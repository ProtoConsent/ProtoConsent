// ProtoConsent regional list fetch handler
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Handles FETCH and storage-change logic for regional_cosmetic and
// regional_blocking enhanced lists. Extracted from handlers.js.

import { REGIONAL_IDS } from "./config-bridge.js";
import { loadRegionalLanguagesConfig } from "./config-loader.js";
import {
  getEnhancedListsFromStorage, withEnhancedStorageLock,
} from "./storage.js";
import { rebuildAllDynamicRules } from "./rebuild.js";

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
  const mergedGeneric = [];
  const mergedDomains = {};
  let totalGenericCount = 0;
  let totalDomainRuleCount = 0;
  let latestVersion = null;
  const fetchedRegions = [];

  for (const region of langs) {
    const url = fetchBase + "regional_" + region + suffix + ".json";
    try {
      const res = await fetchWithFallback(url, { credentials: "omit", cache: "no-store" });
      const data = await res.json();
      fetchedRegions.push(region);
      if (Array.isArray(data.generic)) mergedGeneric.push(...data.generic);
      if (data.domains && typeof data.domains === "object") {
        for (const [dom, sels] of Object.entries(data.domains)) {
          if (mergedDomains[dom]) mergedDomains[dom] = mergedDomains[dom].concat(sels);
          else mergedDomains[dom] = sels;
        }
      }
      totalGenericCount += data.generic_count || (Array.isArray(data.generic) ? data.generic.length : 0);
      if (data.domains) {
        for (const sels of Object.values(data.domains)) totalDomainRuleCount += sels.length;
      }
      if (data.version && (!latestVersion || data.version > latestVersion)) latestVersion = data.version;
    } catch (_) { /* skip failed region */ }
  }

  if (!fetchedRegions.length) {
    sendResponse({ ok: false, error: "No regional files could be downloaded" }); return;
  }

  await withEnhancedStorageLock(() => {
    return getEnhancedListsFromStorage().then(lists => {
      const existing = lists[listId];
      if (existing && latestVersion && existing.version === latestVersion) {
        sendResponse({ ok: true, skipped: true, genericCount: existing.genericCount, domainCount: existing.domainCount });
        return;
      }
      lists[listId] = {
        enabled: existing?.enabled !== undefined ? existing.enabled : true,
        version: latestVersion,
        lastFetched: Date.now(),
        genericCount: totalGenericCount,
        domainCount: Object.keys(mergedDomains).length,
        domainRuleCount: totalDomainRuleCount,
        pathRuleCount: 0,
        type: "cosmetic",
        regions: fetchedRegions,
      };
      const storageUpdate = {
        enhancedLists: lists,
        ["enhancedData_" + listId]: { generic: mergedGeneric, domains: mergedDomains },
      };
      return new Promise(resolve => {
        chrome.storage.local.set(storageUpdate, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            resolve(); return;
          }
          rebuildAllDynamicRules();
          sendResponse({ ok: true, genericCount: totalGenericCount, domainCount: Object.keys(mergedDomains).length, regions: fetchedRegions });
          resolve();
        });
      });
    });
  });
}

// --- Blocking ---

async function fetchRegionalBlocking(listId, langs, fetchBase, suffix, sendResponse) {
  const allDomains = [];
  const allPathRules = [];
  let latestVersion = null;
  const fetchedRegions = [];

  for (const region of langs) {
    const url = fetchBase + "regional_" + region + suffix + ".json";
    try {
      const res = await fetchWithFallback(url, { credentials: "omit", cache: "no-store" });
      const data = await res.json();
      fetchedRegions.push(region);
      if (Array.isArray(data.rules)) {
        for (const rule of data.rules) {
          if (rule.condition?.requestDomains) {
            for (const d of rule.condition.requestDomains) allDomains.push(d);
          }
          if (rule.condition?.urlFilter) {
            allPathRules.push({ urlFilter: rule.condition.urlFilter });
          }
        }
      }
      if (data.version && (!latestVersion || data.version > latestVersion)) latestVersion = data.version;
    } catch (_) { /* skip failed region */ }
  }

  if (!fetchedRegions.length) {
    sendResponse({ ok: false, error: "No regional files could be downloaded" }); return;
  }

  await withEnhancedStorageLock(() => {
    return getEnhancedListsFromStorage().then(lists => {
      const existing = lists[listId];
      if (existing && latestVersion && existing.version === latestVersion) {
        sendResponse({ ok: true, skipped: true, domainCount: existing.domainCount });
        return;
      }
      lists[listId] = {
        enabled: existing?.enabled !== undefined ? existing.enabled : true,
        version: latestVersion,
        lastFetched: Date.now(),
        domainCount: allDomains.length,
        pathRuleCount: allPathRules.length,
        regions: fetchedRegions,
      };
      const storageUpdate = {
        enhancedLists: lists,
        ["enhancedData_" + listId]: {
          domains: allDomains,
          pathRules: allPathRules.length > 0 ? allPathRules : undefined,
        },
      };
      return new Promise(resolve => {
        chrome.storage.local.set(storageUpdate, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            resolve(); return;
          }
          rebuildAllDynamicRules();
          sendResponse({ ok: true, domainCount: allDomains.length, pathRuleCount: allPathRules.length, regions: fetchedRegions });
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

      // Languages selected: re-fetch enabled regional lists
      getEnhancedListsFromStorage().then(lists => {
        for (const id of REGIONAL_IDS) {
          if (!lists[id] || !lists[id].enabled) continue;
          chrome.runtime.sendMessage({
            type: "PROTOCONSENT_ENHANCED_FETCH",
            listId: id,
          }).catch(() => {});
        }
      });
    }, 100);
  });
}
