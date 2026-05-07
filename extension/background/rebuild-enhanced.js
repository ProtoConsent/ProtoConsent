// ProtoConsent enhanced list rebuild helpers
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Incremental per-list data reading for reduced memory footprint.
// Instead of loading all enhanced data at once (~80 MB with 20 lists),
// reads one list at a time and builds rules + indexes in a single pass.

import { DEBUG_RULES } from "./config-bridge.js";
import {
  RULE_RANGES, BLOCK_RESOURCE_TYPES,
  bundledPathAttribution,
  can,
  setHotfixDomainSet,
} from "./state.js";
import { getEnhancedDataFromStorage } from "./storage.js";
import { parseUrlFilterForAttribution } from "./config-loader.js";
import { updateHotfixListener } from "./tracking.js";

class RangeOverflowError extends Error {
  constructor(rangeName, nextId) {
    super(`Rule ID overflow in range "${rangeName}": nextId=${nextId} exceeds end=${RULE_RANGES[rangeName].end}`);
    this.rangeName = rangeName;
  }
}

function nextIdInRange(currentId, rangeName) {
  if (currentId > RULE_RANGES[rangeName].end) throw new RangeOverflowError(rangeName, currentId);
  return currentId;
}

/**
 * Build enhanced blocking rules, reverse index, and path attribution
 * in a single per-list pass. Reads each list individually from storage
 * to keep peak memory at ~O(largest_list) instead of O(all_lists).
 *
 * @param {Object} enhancedListsMeta - from getEnhancedListsFromStorage()
 * @param {Set} consentLinkedListIds - CEL-linked list IDs
 * @param {string[]|undefined} enhancedExclude - permissive sites to exclude
 * @returns {{ rules, enhancedMap, reverseIndex, pathAttrIndex }}
 */
export async function buildEnhancedRulesIncremental(enhancedListsMeta, consentLinkedListIds, enhancedExclude) {
  const rules = [];
  const enhancedMap = {};
  let nextId = RULE_RANGES.enhanced.start;
  const takeId = () => { nextIdInRange(nextId, "enhanced"); return nextId++; };

  // Reverse index: domain → listId (prefer lists with category)
  const reverseIndex = new Map();
  const indexedHasCategory = new Set();

  // Path attribution: host → [{ prefix, source }]
  const pathAttrIndex = new Map();
  function addPathEntry(host, prefix, source) {
    let arr = pathAttrIndex.get(host);
    if (!arr) { arr = []; pathAttrIndex.set(host, arr); }
    arr.push({ prefix, source });
  }

  // Add bundled path attribution first (easylist/easyprivacy static paths)
  for (const [listId, hostMap] of bundledPathAttribution) {
    const lm = enhancedListsMeta[listId];
    if (!(can("enhancedDnr") && (lm?.enabled || consentLinkedListIds.has(listId)))) continue;
    for (const [host, entries] of hostMap) {
      for (const e of entries) addPathEntry(host, e.prefix, e.source);
    }
  }

  const useDirectUrlFilter = (chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES || 5000) >= 10000;
  const BUNDLED_PATH_LISTS = ["easyprivacy", "easylist"];

  // Single pass: for each blocking list, read data → generate rules → build indexes → release
  for (const [listId, listMeta] of Object.entries(enhancedListsMeta)) {
    if (!listMeta.enabled && !consentLinkedListIds.has(listId)) continue;
    // Only blocking lists (no type); skip cosmetic, cmp, informational, tracking_params
    if (listMeta.type) continue;

    const listData = await getEnhancedDataFromStorage(listId);
    if (!listData) continue;

    const hasCategory = !!(listMeta.category);

    // --- DNR rules ---
    if (can("enhancedDnr")) {
      if (listData.domains?.length) {
        const rId = takeId();
        enhancedMap[rId] = listId;
        const condition = { requestDomains: listData.domains, resourceTypes: BLOCK_RESOURCE_TYPES };
        if (enhancedExclude) condition.excludedInitiatorDomains = enhancedExclude;
        rules.push({ id: rId, priority: 2, action: { type: "block" }, condition });
      }

      if (listData.pathRules?.length && !BUNDLED_PATH_LISTS.includes(listId)) {
        _buildPathRules(listData.pathRules, listId, enhancedMap, rules, enhancedExclude, useDirectUrlFilter, takeId);
      }
    }

    // --- Reverse index (domain → listId) ---
    if (listData.domains?.length) {
      for (const d of listData.domains) {
        if (indexedHasCategory.has(d) && !hasCategory) continue;
        reverseIndex.set(d, listId);
        if (hasCategory) indexedHasCategory.add(d);
      }
    }

    // --- Path attribution ---
    if (listData.pathRules?.length && !BUNDLED_PATH_LISTS.includes(listId)) {
      for (const pr of listData.pathRules) {
        const p = parseUrlFilterForAttribution(pr.urlFilter);
        if (p) addPathEntry(p.hostname, p.prefix, "enhanced:" + listId);
      }
    }

    // listData goes out of scope here → eligible for GC
  }

  return { rules, enhancedMap, reverseIndex, pathAttrIndex };
}

/**
 * Build hotfix rules from protoconsent_hotfix data.
 * Reads only the hotfix list from storage.
 *
 * @returns {{ rules, pathAttrEntries: Array<{host, prefix, source}> }}
 */
export async function buildHotfixRulesIncremental() {
  const rules = [];
  let nextId = RULE_RANGES.hotfix.start;
  const pathAttrEntries = [];

  if (!can("ownBlocking")) {
    setHotfixDomainSet(new Set());
    updateHotfixListener();
    return { rules, pathAttrEntries };
  }

  const hotfixData = await getEnhancedDataFromStorage("protoconsent_hotfix");

  if (hotfixData?.domains?.length) {
    nextIdInRange(nextId, "hotfix");
    rules.push({ id: nextId++, priority: 3, action: { type: "allow" }, condition: { requestDomains: hotfixData.domains, resourceTypes: BLOCK_RESOURCE_TYPES } });
    setHotfixDomainSet(new Set(hotfixData.domains));
    if (DEBUG_RULES) console.log("ProtoConsent rebuild: hotfix allow rule for", hotfixData.domains.length, "domains");
  } else {
    setHotfixDomainSet(new Set());
  }

  if (hotfixData?.pathRules?.length && can("enhancedDnr")) {
    for (const pr of hotfixData.pathRules) {
      if (!pr.urlFilter) continue;
      nextIdInRange(nextId, "hotfix");
      rules.push({ id: nextId++, priority: 2, action: { type: "block" }, condition: { urlFilter: pr.urlFilter, resourceTypes: BLOCK_RESOURCE_TYPES } });
    }
    if (DEBUG_RULES) console.log("ProtoConsent rebuild: hotfix path block rules:", hotfixData.pathRules.length);
    // Collect path attribution entries for hotfix
    for (const pr of hotfixData.pathRules) {
      const p = parseUrlFilterForAttribution(pr.urlFilter);
      if (p) pathAttrEntries.push({ host: p.hostname, prefix: p.prefix, source: "enhanced:protoconsent_hotfix" });
    }
  }

  if (hotfixData?.pathExceptions?.length && can("enhancedDnr")) {
    for (const pe of hotfixData.pathExceptions) {
      if (!pe.urlFilter) continue;
      nextIdInRange(nextId, "hotfix");
      const condition = { urlFilter: pe.urlFilter, resourceTypes: BLOCK_RESOURCE_TYPES };
      if (Array.isArray(pe.initiatorDomains) && pe.initiatorDomains.length > 0) {
        condition.initiatorDomains = pe.initiatorDomains;
      } else if (pe.firstParty) {
        const hostMatch = pe.urlFilter.match(/^\|\|([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\//i);
        if (hostMatch) condition.initiatorDomains = [hostMatch[1]];
      }
      rules.push({ id: nextId++, priority: 3, action: { type: "allow" }, condition });
    }
    if (DEBUG_RULES) console.log("ProtoConsent rebuild: hotfix path exception rules:", hotfixData.pathExceptions.length);
  }

  updateHotfixListener();
  return { rules, pathAttrEntries };
}

/**
 * Build param strip rules from tracking_params/tracking_params_sites lists.
 * Reads each param list individually.
 *
 * @returns {{ rules, paramStripIds, hasDynamicGlobalParams, hasDynamicSiteParams }}
 */
export async function buildParamStripRulesIncremental(enhancedListsMeta, paramStrippingEnabled, paramStrippingSitesEnabled) {
  const rules = [];
  const paramStripIds = new Set();
  let nextId = RULE_RANGES.paramStrip.start;
  const paramStripBudget = RULE_RANGES.paramStrip.end - RULE_RANGES.paramStrip.start + 1;
  let hasDynamicGlobalParams = false;
  let hasDynamicSiteParams = false;

  if (paramStrippingEnabled) {
    for (const [listId, listMeta] of Object.entries(enhancedListsMeta)) {
      if (listMeta.type !== "tracking_params" || !listMeta.enabled) continue;
      const listData = await getEnhancedDataFromStorage(listId);
      if (!listData?.params?.length) continue;
      if (paramStripIds.size >= paramStripBudget) break;
      hasDynamicGlobalParams = true;
      nextIdInRange(nextId, "paramStrip");
      const ruleId = nextId++;
      paramStripIds.add(ruleId);
      rules.push({
        id: ruleId, priority: 2,
        action: { type: "redirect", redirect: { transform: { queryTransform: { removeParams: listData.params } } } },
        condition: { urlFilter: "*", resourceTypes: ["main_frame", "sub_frame"] },
      });
    }
  }

  if (paramStrippingEnabled && paramStrippingSitesEnabled) {
    for (const [listId, listMeta] of Object.entries(enhancedListsMeta)) {
      if (listMeta.type !== "tracking_params_sites" || !listMeta.enabled) continue;
      const listData = await getEnhancedDataFromStorage(listId);
      if (!listData?.sites || !Object.keys(listData.sites).length) continue;
      hasDynamicSiteParams = true;
      const groups = new Map();
      for (const [domain, params] of Object.entries(listData.sites)) {
        const sorted = [...params].sort();
        const key = sorted.join("\0");
        if (!groups.has(key)) groups.set(key, { params: sorted, domains: [] });
        groups.get(key).domains.push(domain);
      }
      for (const g of groups.values()) {
        if (paramStripIds.size >= paramStripBudget) break;
        nextIdInRange(nextId, "paramStrip");
        const ruleId = nextId++;
        paramStripIds.add(ruleId);
        rules.push({
          id: ruleId, priority: 2,
          action: { type: "redirect", redirect: { transform: { queryTransform: { removeParams: g.params } } } },
          condition: { urlFilter: "*", requestDomains: g.domains, resourceTypes: ["main_frame", "sub_frame"] },
        });
      }
    }
  }

  return { rules, paramStripIds, hasDynamicGlobalParams, hasDynamicSiteParams };
}

// --- Internal helper for path rules generation ---

function _buildPathRules(pathRules, listId, enhancedMap, rules, enhancedExclude, useDirectUrlFilter, takeId) {
  if (useDirectUrlFilter) {
    for (const pr of pathRules) {
      if (!pr.urlFilter) continue;
      const rId = takeId();
      enhancedMap[rId] = listId;
      const condition = { urlFilter: pr.urlFilter, resourceTypes: BLOCK_RESOURCE_TYPES };
      if (enhancedExclude) condition.excludedInitiatorDomains = enhancedExclude;
      rules.push({ id: rId, priority: 2, action: { type: "block" }, condition });
    }
    return;
  }

  const byDomain = new Map();
  const ungroupable = [];
  for (const pr of pathRules) {
    const m = pr.urlFilter.match(/^\|\|([^/]+)\/(.*)/);
    if (m) {
      if (!byDomain.has(m[1])) byDomain.set(m[1], []);
      byDomain.get(m[1]).push(m[2]);
    } else {
      ungroupable.push(pr);
    }
  }

  const REGEX_BYTE_LIMIT = 1800;
  for (const [domain, paths] of byDomain) {
    if (paths.length === 1) {
      const rId = takeId();
      enhancedMap[rId] = listId;
      const condition = { urlFilter: `||${domain}/${paths[0]}`, resourceTypes: BLOCK_RESOURCE_TYPES };
      if (enhancedExclude) condition.excludedInitiatorDomains = enhancedExclude;
      rules.push({ id: rId, priority: 2, action: { type: "block" }, condition });
    } else {
      const escaped = domain.replace(/\./g, "\\.");
      const prefix = `^https?://(.*\\.)?${escaped}/(`;
      let chunk = [];
      let chunkLen = prefix.length + 1;
      for (const p of paths) {
        const ep = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const added = chunk.length === 0 ? ep.length : ep.length + 1;
        if (chunkLen + added > REGEX_BYTE_LIMIT) {
          if (chunk.length > 0) {
            const rId = takeId();
            enhancedMap[rId] = listId;
            const condition = { resourceTypes: BLOCK_RESOURCE_TYPES };
            if (enhancedExclude) condition.excludedInitiatorDomains = enhancedExclude;
            condition.regexFilter = prefix + chunk.join("|") + ")";
            condition.isUrlFilterCaseSensitive = false;
            rules.push({ id: rId, priority: 2, action: { type: "block" }, condition });
            chunk = [];
            chunkLen = prefix.length + 1;
          }
          if (prefix.length + 1 + ep.length > REGEX_BYTE_LIMIT) {
            const rId = takeId();
            enhancedMap[rId] = listId;
            const condition = { urlFilter: `||${domain}/${p}`, resourceTypes: BLOCK_RESOURCE_TYPES };
            if (enhancedExclude) condition.excludedInitiatorDomains = enhancedExclude;
            rules.push({ id: rId, priority: 2, action: { type: "block" }, condition });
            continue;
          }
        }
        chunk.push(ep);
        chunkLen += added;
      }
      if (chunk.length > 0) {
        const rId = takeId();
        enhancedMap[rId] = listId;
        const condition = { resourceTypes: BLOCK_RESOURCE_TYPES };
        if (enhancedExclude) condition.excludedInitiatorDomains = enhancedExclude;
        condition.regexFilter = prefix + chunk.join("|") + ")";
        condition.isUrlFilterCaseSensitive = false;
        rules.push({ id: rId, priority: 2, action: { type: "block" }, condition });
      }
    }
  }

  for (const pr of ungroupable) {
    const rId = takeId();
    enhancedMap[rId] = listId;
    const condition = { urlFilter: pr.urlFilter, resourceTypes: BLOCK_RESOURCE_TYPES };
    if (enhancedExclude) condition.excludedInitiatorDomains = enhancedExclude;
    rules.push({ id: rId, priority: 2, action: { type: "block" }, condition });
  }
}
