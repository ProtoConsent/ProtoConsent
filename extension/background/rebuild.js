// ProtoConsent background DNR rebuild
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Core enforcement engine: reads storage + blocklists and rebuilds all
// declarativeNetRequest rules (static rulesets, dynamic overrides,
// whitelist, enhanced lists, GPC headers, Client Hints stripping).

import { DEBUG_RULES, loadDebugFlag, initBrowser, getChStrippingEnabled, HIGH_ENTROPY_CH } from "./config-bridge.js";
import {
  BASE_RULE_ID, DYNAMIC_RULE_RESERVE, BLOCK_RESOURCE_TYPES, GPC_RESOURCE_TYPES,
  PURPOSES_FOR_ENFORCEMENT, gpcPurposes,
  setEnabledBlockRulesets,
  setDynamicBlockRuleMap, setDynamicGpcSetIds, setDynamicChRuleIds,
  setDynamicWhitelistMap, setDynamicEnhancedMap, setDynamicParamStripIds,
  setEnhancedReverseIndex,
  setPathAttributionIndex,
  bundledPathAttribution,
  setGpcGlobalActive, setGpcAddDomains, setGpcRemoveDomains,
  setLastRebuildDebug, lastRebuildDebug,
  setLastConsentLinkedListIds, setLastCelPendingDownload,
  _rebuildRunning, setRebuildRunning,
  _rebuildQueued, setRebuildQueued,
  GPC_SCRIPT_ID, COSMETIC_SCRIPT_ID,
  setOperatingMode, can,
  setHotfixDomainSet,
} from "./state.js";
import {
  getDefaultProfileConfig, resolvePurposes, getAllRulesFromStorage,
  getWhitelistFromStorage, isValidHostname,
  getEnhancedListsFromStorage, getAllEnhancedDataFromStorage, getEnhancedDataFromStorage,
  getEnhancedPresetFromStorage,
} from "./storage.js";
import {
  loadBlocklistsConfig, loadPresetsConfig, loadPurposesConfig,
  loadEnhancedListsCatalog, loadBundledPathAttribution,
  parseUrlFilterForAttribution,
} from "./config-loader.js";
import { updateCmpInjectionData } from "./cmp-injection.js";
import { updateHotfixListener } from "./tracking.js";
import { consumeCelPendingDownloads } from "./auto-refresh.js";

// Main function: rebuild all DNR enforcement from current storage + blocklists.
export async function rebuildAllDynamicRules() {
  if (_rebuildRunning) {
    setRebuildQueued(true);
    return;
  }
  setRebuildRunning(true);

  await loadDebugFlag();
  await initBrowser();

  try {
    await _rebuildAllDynamicRulesImpl();
  } finally {
    setRebuildRunning(false);
    if (_rebuildQueued) {
      setRebuildQueued(false);
      rebuildAllDynamicRules();
    }
  }
}

async function _rebuildAllDynamicRulesImpl() {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) {
    console.warn("ProtoConsent: declarativeNetRequest not available in this browser.");
    return;
  }

  try {
    await loadPurposesConfig();

    // Load operating mode before any gating decisions
    const storedMode = await new Promise(r =>
      chrome.storage.local.get(["operatingMode"], res => r(res.operatingMode || "standalone"))
    );
    setOperatingMode(storedMode);

    const [rulesByDomain, blocklists, presets, defaultConfig, whitelist, enhancedListsMeta] = await Promise.all([
      getAllRulesFromStorage(),
      loadBlocklistsConfig(),
      loadPresetsConfig(),
      getDefaultProfileConfig(),
      getWhitelistFromStorage(),
      getEnhancedListsFromStorage(),
    ]);
    await loadBundledPathAttribution();
    const enhancedData = await getAllEnhancedDataFromStorage(enhancedListsMeta);

    const gpcEnabled = await new Promise(resolve => {
      chrome.storage.local.get(["gpcEnabled"], r => resolve(r.gpcEnabled !== false));
    });

    const paramStrippingEnabled = await new Promise(resolve => {
      chrome.storage.local.get(["paramStrippingEnabled"], r => resolve(r.paramStrippingEnabled !== false));
    });

    const paramStrippingSitesEnabled = await new Promise(resolve => {
      chrome.storage.local.get(["paramStrippingSitesEnabled"], r => resolve(r.paramStrippingSitesEnabled !== false));
    });

    const chStrippingEnabled = await new Promise(resolve => {
      getChStrippingEnabled(resolve);
    });

    const consentEnhancedLink = await new Promise(resolve => {
      chrome.storage.local.get(["consentEnhancedLink", "dynamicListsConsent", "celMode", "celCustomPurposes"], r => resolve({
        cel: r.consentEnhancedLink === true,
        sync: r.dynamicListsConsent === true,
        mode: r.celMode || "profile",
        customPurposes: r.celCustomPurposes || null,
      }));
    });

    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const existingIds = existingRules.map((r) => r.id);

    let newRules = [];
    let nextRuleId = BASE_RULE_ID;
    const newDynamicBlockMap = {};
    const newGpcSetIds = new Set();
    const newWhitelistMap = {};
    const newEnhancedMap = {};

    // 1. Resolve global default purposes
    const globalPurposes = resolvePurposes({}, presets, defaultConfig);

    // 2. Compute which static rulesets to enable/disable.
    const enableIds = [];
    const disableIds = [];
    for (const purposeKey of PURPOSES_FOR_ENFORCEMENT) {
      const hasDomains = blocklists[purposeKey]?.domains?.length > 0;
      const hasPaths = blocklists[purposeKey]?.pathDomains?.length > 0;
      if (!hasDomains && !hasPaths) continue;
      const rulesetId = "protoconsent_" + purposeKey;
      if (can("ownBlocking")) {
        if (!globalPurposes[purposeKey]) {
          if (hasDomains) enableIds.push(rulesetId);
          if (hasPaths) enableIds.push(rulesetId + "_paths");
        } else {
          if (hasDomains) disableIds.push(rulesetId);
          if (hasPaths) disableIds.push(rulesetId + "_paths");
        }
      } else {
        // Monitoring mode: disable all static blocking rulesets
        if (hasDomains) disableIds.push(rulesetId);
        if (hasPaths) disableIds.push(rulesetId + "_paths");
      }
    }

    setEnabledBlockRulesets(can("ownBlocking") ? new Set(enableIds) : new Set());

    // URL tracking parameter stripping (static rulesets, independent of mode)
    if (paramStrippingEnabled) enableIds.push("strip_tracking_params");
    else disableIds.push("strip_tracking_params");

    if (paramStrippingEnabled && paramStrippingSitesEnabled) enableIds.push("strip_tracking_params_sites");
    else disableIds.push("strip_tracking_params_sites");

    // 3. Per-site overrides (priority 2) - standalone only
    const allowOverrides = {};
    const blockOverrides = {};
    const permissiveSites = [];

    if (can("ownBlocking")) {
    for (const [domain, siteConfig] of Object.entries(rulesByDomain)) {
      const sitePurposes = resolvePurposes(siteConfig, presets, defaultConfig);

      let allAllowed = true;
      for (const purposeKey of PURPOSES_FOR_ENFORCEMENT) {
        const siteAllows = sitePurposes[purposeKey];
        const globalAllows = globalPurposes[purposeKey];
        if (!siteAllows) allAllowed = false;

        if (siteAllows === globalAllows) continue;

        if (siteAllows) {
          if (!allowOverrides[purposeKey]) allowOverrides[purposeKey] = [];
          allowOverrides[purposeKey].push(domain);
        } else {
          if (!blockOverrides[purposeKey]) blockOverrides[purposeKey] = [];
          blockOverrides[purposeKey].push(domain);
        }
      }
      if (allAllowed) permissiveSites.push(domain);
    }

    for (const purposeKey of PURPOSES_FOR_ENFORCEMENT) {
      const domainList = blocklists[purposeKey]?.domains || [];
      const pathDomainList = blocklists[purposeKey]?.pathDomains || [];
      const domains = pathDomainList.length ? [...domainList, ...pathDomainList] : domainList;
      if (!domains.length) continue;

      if (allowOverrides[purposeKey]?.length) {
        newRules.push({
          id: nextRuleId++,
          priority: 2,
          action: { type: "allow" },
          condition: {
            requestDomains: domains,
            initiatorDomains: allowOverrides[purposeKey],
            resourceTypes: BLOCK_RESOURCE_TYPES,
          },
        });
      }

      if (blockOverrides[purposeKey]?.length) {
        const initiators = blockOverrides[purposeKey];
        let effectiveDomains = domains;
        if (pathDomainList.length) {
          const safePathDomains = pathDomainList.filter(pd =>
            !initiators.some(id => pd === id || pd.endsWith("." + id) || id.endsWith("." + pd))
          );
          effectiveDomains = safePathDomains.length
            ? [...domainList, ...safePathDomains]
            : domainList;
        }
        if (effectiveDomains.length) {
          newDynamicBlockMap[nextRuleId] = purposeKey;
          newRules.push({
            id: nextRuleId++,
            priority: 2,
            action: { type: "block" },
            condition: {
              requestDomains: effectiveDomains,
              initiatorDomains: initiators,
              resourceTypes: BLOCK_RESOURCE_TYPES,
            },
          });
        }
      }
    }
    } // end can("ownBlocking")

    // 4. Whitelist allow rules (priority 3) - standalone only
    const globalWhitelistDomains = [];
    const perSiteWhitelist = {};

    if (can("whitelistOverrides")) {
    for (const [domain, siteMap] of Object.entries(whitelist)) {
      if (!isValidHostname(domain)) continue;
      for (const site of Object.keys(siteMap)) {
        if (site === "*") {
          globalWhitelistDomains.push(domain);
        } else if (isValidHostname(site)) {
          if (!perSiteWhitelist[site]) perSiteWhitelist[site] = [];
          perSiteWhitelist[site].push(domain);
        }
      }
    }

    const maxDynamic = chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES || 5000;
    const coreRuleCount = newRules.length;
    const whitelistBudget = maxDynamic - coreRuleCount - DYNAMIC_RULE_RESERVE;
    const whitelistRulesNeeded = (globalWhitelistDomains.length > 0 ? 1 : 0) +
      Object.keys(perSiteWhitelist).length;

    if (whitelistRulesNeeded > whitelistBudget) {
      if (DEBUG_RULES) console.warn("ProtoConsent: whitelist needs " + whitelistRulesNeeded +
        " rules but budget is " + whitelistBudget +
        " (core: " + coreRuleCount + ", reserve: " + DYNAMIC_RULE_RESERVE + "). " +
        "Some per-site whitelist entries will be dropped.");
    }

    let whitelistRulesAdded = 0;

    if (globalWhitelistDomains.length > 0 && whitelistRulesAdded < whitelistBudget) {
      const wlId = nextRuleId++;
      newWhitelistMap[wlId] = globalWhitelistDomains;
      newRules.push({
        id: wlId,
        priority: 3,
        action: { type: "allow" },
        condition: {
          requestDomains: globalWhitelistDomains,
          resourceTypes: BLOCK_RESOURCE_TYPES,
        },
      });
      whitelistRulesAdded++;
    }

    for (const [site, domains] of Object.entries(perSiteWhitelist)) {
      if (whitelistRulesAdded >= whitelistBudget) break;
      const wlId = nextRuleId++;
      newWhitelistMap[wlId] = domains;
      newRules.push({
        id: wlId,
        priority: 3,
        action: { type: "allow" },
        condition: {
          requestDomains: domains,
          initiatorDomains: [site],
          resourceTypes: BLOCK_RESOURCE_TYPES,
        },
      });
      whitelistRulesAdded++;
    }
    } // end can("whitelistOverrides")

    // 4b. Hotfix allow rules: override static rulesets for zombie domains
    let hotfixDomainCount = 0;
    if (can("ownBlocking")) {
      let hotfixData = enhancedData["protoconsent_hotfix"];
      if (!hotfixData) {
        hotfixData = await getEnhancedDataFromStorage("protoconsent_hotfix");
      }
      if (hotfixData?.domains?.length) {
        const rId = nextRuleId++;
        newRules.push({
          id: rId,
          priority: 3,
          action: { type: "allow" },
          condition: {
            requestDomains: hotfixData.domains,
            resourceTypes: BLOCK_RESOURCE_TYPES,
          },
        });
        hotfixDomainCount = hotfixData.domains.length;
        if (DEBUG_RULES) console.log("ProtoConsent rebuild: hotfix allow rule for", hotfixDomainCount, "domains");
        setHotfixDomainSet(new Set(hotfixData.domains));
      } else {
        setHotfixDomainSet(new Set());
      }
      if (hotfixData?.pathRules?.length && can("enhancedDnr")) {
        for (const pr of hotfixData.pathRules) {
          if (!pr.urlFilter) continue;
          const rId = nextRuleId++;
          newRules.push({ id: rId, priority: 2, action: { type: "block" }, condition: { urlFilter: pr.urlFilter, resourceTypes: BLOCK_RESOURCE_TYPES } });
        }
        if (DEBUG_RULES) console.log("ProtoConsent rebuild: hotfix path block rules:", hotfixData.pathRules.length);
      }
      if (hotfixData?.pathExceptions?.length && can("enhancedDnr")) {
        for (const pe of hotfixData.pathExceptions) {
          if (!pe.urlFilter) continue;
          const rId = nextRuleId++;
          const condition = { urlFilter: pe.urlFilter, resourceTypes: BLOCK_RESOURCE_TYPES };
          if (Array.isArray(pe.initiatorDomains) && pe.initiatorDomains.length > 0) {
            condition.initiatorDomains = pe.initiatorDomains;
          } else if (pe.firstParty) {
            const hostMatch = pe.urlFilter.match(/^\|\|([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\//i);
            if (hostMatch) condition.initiatorDomains = [hostMatch[1]];
          }
          newRules.push({ id: rId, priority: 3, action: { type: "allow" }, condition });
        }
        if (DEBUG_RULES) console.log("ProtoConsent rebuild: hotfix path exception rules:", hotfixData.pathExceptions.length);
      }
    } else {
      setHotfixDomainSet(new Set());
    }
    updateHotfixListener();

    // 5. Enhanced Protection lists (dynamic block rules, priority 2)
    // CEL only activates lists whose category is a consent purpose (not security, cosmetic, cmp, etc.)
    const CEL_PURPOSES = new Set(["analytics", "ads", "personalization", "third_parties", "advanced_tracking"]);
    const consentLinkedListIds = new Set();
    const celPendingDownload = [];
    if (consentEnhancedLink.cel) {
      const celCatalog = await loadEnhancedListsCatalog();
      if (celCatalog) {
        // Custom mode: use user-selected purposes; profile mode: derive from global profile
        const deniedCategories = new Set();
        if (consentEnhancedLink.mode === "custom") {
          if (consentEnhancedLink.customPurposes && typeof consentEnhancedLink.customPurposes === "object") {
            for (const [purpose, denied] of Object.entries(consentEnhancedLink.customPurposes)) {
              if (denied && CEL_PURPOSES.has(purpose)) deniedCategories.add(purpose);
            }
          }
          // No stored custom purposes = no CEL activation until user configures
        } else {
          for (const [purpose, allowed] of Object.entries(globalPurposes)) {
            if (!allowed && CEL_PURPOSES.has(purpose)) deniedCategories.add(purpose);
          }
        }
        for (const [listId, listDef] of Object.entries(celCatalog)) {
          if (listDef.category && CEL_PURPOSES.has(listDef.category) && deniedCategories.has(listDef.category)) {
            if (enhancedListsMeta[listId]) {
              consentLinkedListIds.add(listId);
            } else if (listDef.fetch_url && consentEnhancedLink.sync) {
              celPendingDownload.push(listId);
            }
          }
        }
      }
    }

    if (consentLinkedListIds.size > 0) {
      const missingIds = [...consentLinkedListIds].filter(id => !enhancedData[id]);
      if (missingIds.length > 0) {
        const keys = missingIds.map(id => "enhancedData_" + id);
        const extraData = await new Promise(resolve => {
          chrome.storage.local.get(keys, result => {
            const out = {};
            for (const id of missingIds) {
              if (result["enhancedData_" + id]) out[id] = result["enhancedData_" + id];
            }
            resolve(out);
          });
        });
        Object.assign(enhancedData, extraData);
      }
    }

    setLastConsentLinkedListIds([...consentLinkedListIds]);
    setLastCelPendingDownload(celPendingDownload);

    // Auto-download CEL-linked lists in background without waiting for UI
    if (celPendingDownload.length > 0) {
      consumeCelPendingDownloads();
    }

    const enhancedExclude = permissiveSites.length > 0 ? permissiveSites : undefined;

    const useDirectUrlFilter = (chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES || 5000) >= 10000;
    const BUNDLED_PATH_LISTS = ["easyprivacy", "easylist"];

    if (can("enhancedDnr")) {
    for (const [listId, listMeta] of Object.entries(enhancedListsMeta)) {
      if (!listMeta.enabled && !consentLinkedListIds.has(listId)) continue;
      // Only process blocking lists (no type field); skip special types (cosmetic, cmp, informational, tracking_params, etc.)
      if (listMeta.type) continue;
      const listData = enhancedData[listId];
      if (!listData) continue;

      if (listData.domains?.length) {
        const rId = nextRuleId++;
        newEnhancedMap[rId] = listId;
        const condition = {
          requestDomains: listData.domains,
          resourceTypes: BLOCK_RESOURCE_TYPES,
        };
        if (enhancedExclude) condition.excludedInitiatorDomains = enhancedExclude;
        newRules.push({
          id: rId,
          priority: 2,
          action: { type: "block" },
          condition,
        });
      }

      if (listData.pathRules?.length && !BUNDLED_PATH_LISTS.includes(listId)) {
        if (useDirectUrlFilter) {
          for (const pr of listData.pathRules) {
            if (!pr.urlFilter) continue;
            const rId = nextRuleId++;
            newEnhancedMap[rId] = listId;
            const condition = { urlFilter: pr.urlFilter, resourceTypes: BLOCK_RESOURCE_TYPES };
            if (enhancedExclude) condition.excludedInitiatorDomains = enhancedExclude;
            newRules.push({ id: rId, priority: 2, action: { type: "block" }, condition });
          }
        } else {
          const byDomain = new Map();
          const ungroupable = [];
          for (const pr of listData.pathRules) {
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
              const rId = nextRuleId++;
              newEnhancedMap[rId] = listId;
              const condition = { urlFilter: `||${domain}/${paths[0]}`, resourceTypes: BLOCK_RESOURCE_TYPES };
              if (enhancedExclude) condition.excludedInitiatorDomains = enhancedExclude;
              newRules.push({ id: rId, priority: 2, action: { type: "block" }, condition });
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
                    const rId = nextRuleId++;
                    newEnhancedMap[rId] = listId;
                    const condition = { resourceTypes: BLOCK_RESOURCE_TYPES };
                    if (enhancedExclude) condition.excludedInitiatorDomains = enhancedExclude;
                    condition.regexFilter = prefix + chunk.join("|") + ")";
                    condition.isUrlFilterCaseSensitive = false;
                    newRules.push({ id: rId, priority: 2, action: { type: "block" }, condition });
                    chunk = [];
                    chunkLen = prefix.length + 1;
                  }
                  if (prefix.length + 1 + ep.length > REGEX_BYTE_LIMIT) {
                    const rId = nextRuleId++;
                    newEnhancedMap[rId] = listId;
                    const condition = { urlFilter: `||${domain}/${p}`, resourceTypes: BLOCK_RESOURCE_TYPES };
                    if (enhancedExclude) condition.excludedInitiatorDomains = enhancedExclude;
                    newRules.push({ id: rId, priority: 2, action: { type: "block" }, condition });
                    continue;
                  }
                }
                chunk.push(ep);
                chunkLen += added;
              }
              if (chunk.length > 0) {
                const rId = nextRuleId++;
                newEnhancedMap[rId] = listId;
                const condition = { resourceTypes: BLOCK_RESOURCE_TYPES };
                if (enhancedExclude) condition.excludedInitiatorDomains = enhancedExclude;
                condition.regexFilter = prefix + chunk.join("|") + ")";
                condition.isUrlFilterCaseSensitive = false;
                newRules.push({ id: rId, priority: 2, action: { type: "block" }, condition });
              }
            }
          }

          for (const pr of ungroupable) {
            const rId = nextRuleId++;
            newEnhancedMap[rId] = listId;
            const condition = { urlFilter: pr.urlFilter, resourceTypes: BLOCK_RESOURCE_TYPES };
            if (enhancedExclude) condition.excludedInitiatorDomains = enhancedExclude;
            newRules.push({ id: rId, priority: 2, action: { type: "block" }, condition });
          }
        }
      }
    }
    } // end can("enhancedDnr")

    // Enable/disable bundled external path rulesets alongside their domain rules
    for (const listId of BUNDLED_PATH_LISTS) {
      const rulesetId = listId + "_paths";
      const listMeta = enhancedListsMeta[listId];
      const isEnabled = can("enhancedDnr") && (listMeta?.enabled || consentLinkedListIds.has(listId));
      if (isEnabled) enableIds.push(rulesetId);
      else disableIds.push(rulesetId);
    }

    // 5b. URL tracking parameter stripping — dynamic rules from CDN data
    // When CDN data is available and enabled, build dynamic redirect rules
    // and disable the corresponding static ruleset (CDN data is fresher).
    let hasDynamicGlobalParams = false;
    let hasDynamicSiteParams = false;
    const paramStripRuleIds = new Set();

    if (paramStrippingEnabled) {
      // Global params from CDN
      for (const [listId, listMeta] of Object.entries(enhancedListsMeta)) {
        if (listMeta.type !== "tracking_params") continue;
        if (!listMeta.enabled) continue;
        const listData = enhancedData[listId];
        if (!listData?.params?.length) continue;
        hasDynamicGlobalParams = true;
        const ruleId = nextRuleId++;
        paramStripRuleIds.add(ruleId);
        newRules.push({
          id: ruleId,
          priority: 2,
          action: {
            type: "redirect",
            redirect: { transform: { queryTransform: { removeParams: listData.params } } },
          },
          condition: { urlFilter: "*", resourceTypes: ["main_frame", "sub_frame"] },
        });
      }
    }

    if (paramStrippingEnabled && paramStrippingSitesEnabled) {
      // Per-site params from CDN — group domains by identical param set
      for (const [listId, listMeta] of Object.entries(enhancedListsMeta)) {
        if (listMeta.type !== "tracking_params_sites") continue;
        if (!listMeta.enabled) continue;
        const listData = enhancedData[listId];
        if (!listData?.sites || !Object.keys(listData.sites).length) continue;
        hasDynamicSiteParams = true;
        const groups = new Map(); // paramKey → { params, domains }
        for (const [domain, params] of Object.entries(listData.sites)) {
          const sorted = [...params].sort();
          const key = sorted.join("\0");
          if (!groups.has(key)) groups.set(key, { params: sorted, domains: [] });
          groups.get(key).domains.push(domain);
        }
        for (const g of groups.values()) {
          const ruleId = nextRuleId++;
          paramStripRuleIds.add(ruleId);
          newRules.push({
            id: ruleId,
            priority: 2,
            action: {
              type: "redirect",
              redirect: { transform: { queryTransform: { removeParams: g.params } } },
            },
            condition: {
              urlFilter: "*",
              requestDomains: g.domains,
              resourceTypes: ["main_frame", "sub_frame"],
            },
          });
        }
      }
    }

    setDynamicParamStripIds(paramStripRuleIds);

    // Build enhanced reverse index for onErrorOccurred attribution (always, both modes)
    // Prefer lists with a category (purpose) over uncategorized ones.
    // Only index domain-level rules (full domain blocks); skip pathRules because
    // they only block specific URL patterns, not the entire domain. Including them
    // causes false attribution (e.g. a pathRule for ||instagram.com/api/v1/... would
    // make ALL instagram.com failures be attributed to that list).
    const newEnhancedReverseIndex = new Map();
    const indexedHasCategory = new Set();
    for (const [listId, listData] of Object.entries(enhancedData)) {
      // Only index blocking lists (no type field); skip special types (cosmetic, cmp, informational, tracking_params, etc.)
      const listMeta = enhancedListsMeta[listId];
      if (listMeta && listMeta.type) continue;
      const hasCategory = !!(listMeta && listMeta.category);
      if (listData.domains?.length) {
        for (const d of listData.domains) {
          if (indexedHasCategory.has(d) && !hasCategory) continue;
          newEnhancedReverseIndex.set(d, listId);
          if (hasCategory) indexedHasCategory.add(d);
        }
      }
    }
    setEnhancedReverseIndex(newEnhancedReverseIndex);

    // Build path attribution index for URL-level attribution of path blocks.
    const newPathAttrIndex = new Map();
    function addPathEntry(host, prefix, source) {
      let arr = newPathAttrIndex.get(host);
      if (!arr) { arr = []; newPathAttrIndex.set(host, arr); }
      arr.push({ prefix, source });
    }
    for (const [listId, hostMap] of bundledPathAttribution) {
      const lm = enhancedListsMeta[listId];
      if (!(can("enhancedDnr") && (lm?.enabled || consentLinkedListIds.has(listId)))) continue;
      for (const [host, entries] of hostMap) {
        for (const e of entries) addPathEntry(host, e.prefix, e.source);
      }
    }
    for (const [listId, listData] of Object.entries(enhancedData)) {
      const lm = enhancedListsMeta[listId];
      if (lm?.type) continue;
      if (BUNDLED_PATH_LISTS.includes(listId)) continue;
      if (!lm?.enabled && !consentLinkedListIds.has(listId)) continue;
      if (listData.pathRules?.length) {
        for (const pr of listData.pathRules) {
          const p = parseUrlFilterForAttribution(pr.urlFilter);
          if (p) addPathEntry(p.hostname, p.prefix, "enhanced:" + listId);
        }
      }
    }
    if (enhancedData["protoconsent_hotfix"]?.pathRules?.length) {
      for (const pr of enhancedData["protoconsent_hotfix"].pathRules) {
        const p = parseUrlFilterForAttribution(pr.urlFilter);
        if (p) addPathEntry(p.hostname, p.prefix, "enhanced:protoconsent_hotfix");
      }
    }
    setPathAttributionIndex(newPathAttrIndex);

    // 6. GPC header rules
    const globalNeedsGPC = gpcEnabled && gpcPurposes.some(p => !globalPurposes[p]);

    if (globalNeedsGPC) {
      const gpcGlobalId = nextRuleId++;
      newGpcSetIds.add(gpcGlobalId);
      newRules.push({
        id: gpcGlobalId,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Sec-GPC", operation: "set", value: "1" }
          ]
        },
        condition: {
          resourceTypes: GPC_RESOURCE_TYPES,
        },
      });
    }

    const gpcAddSites = [];
    const gpcRemoveSites = [];

    for (const [domain, siteConfig] of Object.entries(rulesByDomain)) {
      const sitePurposes = resolvePurposes(siteConfig, presets, defaultConfig);
      const siteNeedsGPC = gpcEnabled && gpcPurposes.some(p => !sitePurposes[p]);

      if (siteNeedsGPC === globalNeedsGPC) continue;

      if (siteNeedsGPC) {
        gpcAddSites.push(domain);
      } else {
        gpcRemoveSites.push(domain);
      }
    }

    if (gpcAddSites.length > 0) {
      const gpcAddId = nextRuleId++;
      newGpcSetIds.add(gpcAddId);
      newRules.push({
        id: gpcAddId,
        priority: 2,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Sec-GPC", operation: "set", value: "1" }
          ]
        },
        condition: {
          requestDomains: gpcAddSites,
          resourceTypes: GPC_RESOURCE_TYPES,
        },
      });
    }

    if (gpcRemoveSites.length > 0) {
      newRules.push({
        id: nextRuleId++,
        priority: 2,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Sec-GPC", operation: "remove" }
          ]
        },
        condition: {
          requestDomains: gpcRemoveSites,
          resourceTypes: GPC_RESOURCE_TYPES,
        },
      });
    }

    setGpcGlobalActive(globalNeedsGPC);
    setGpcAddDomains(new Set(gpcAddSites));
    setGpcRemoveDomains(new Set(gpcRemoveSites));

    // 6b. Client Hints stripping
    const chHeaders = HIGH_ENTROPY_CH.map(h => ({ header: h, operation: "remove" }));
    const globalDeniesAT = chStrippingEnabled && !globalPurposes.advanced_tracking;

    const chAddSites = [];
    const chRemoveSites = [];

    for (const [domain, siteConfig] of Object.entries(rulesByDomain)) {
      const sitePurposes = resolvePurposes(siteConfig, presets, defaultConfig);
      const siteDeniesAT = chStrippingEnabled && !sitePurposes.advanced_tracking;
      if (siteDeniesAT === globalDeniesAT) continue;
      if (siteDeniesAT) chAddSites.push(domain);
      else chRemoveSites.push(domain);
    }

    const newChRuleIds = new Set();
    if (globalDeniesAT) {
      const chGlobalId = nextRuleId++;
      newChRuleIds.add(chGlobalId);
      const chGlobalRule = {
        id: chGlobalId,
        priority: 1,
        action: { type: "modifyHeaders", requestHeaders: chHeaders },
        condition: { resourceTypes: GPC_RESOURCE_TYPES },
      };
      if (chRemoveSites.length > 0) {
        chGlobalRule.condition.excludedRequestDomains = chRemoveSites;
      }
      newRules.push(chGlobalRule);
    }

    if (chAddSites.length > 0) {
      const chPerSiteId = nextRuleId++;
      newChRuleIds.add(chPerSiteId);
      newRules.push({
        id: chPerSiteId,
        priority: 2,
        action: { type: "modifyHeaders", requestHeaders: chHeaders },
        condition: {
          requestDomains: chAddSites,
          resourceTypes: GPC_RESOURCE_TYPES,
        },
      });
    }

    if (DEBUG_RULES) {
      const overrideCount = newRules.filter(r => r.condition.initiatorDomains).length;
      const gpcGlobal = newRules.filter(r =>
        r.action.type === "modifyHeaders" && !r.condition.requestDomains).length;
      const gpcPerSite = newRules.filter(r =>
        r.action.type === "modifyHeaders" && r.condition.requestDomains).length;
      const categoryDomains = {};
      for (const key of PURPOSES_FOR_ENFORCEMENT) {
        const d = blocklists[key]?.domains?.length || 0;
        const p = blocklists[key]?.pathDomains?.length || 0;
        if (d || p) categoryDomains[key] = d + "d+" + p + "p=" + (d + p);
      }
      const overrideDetails = {};
      for (const r of newRules) {
        if (r.condition.initiatorDomains && r.condition.requestDomains) {
          overrideDetails[r.id] = r.action.type + " " + r.condition.requestDomains.length +
            " \u2192 " + r.condition.initiatorDomains.join(",");
        }
      }
      const customSites = Object.keys(rulesByDomain);
      setLastRebuildDebug({
        globalProfile: defaultConfig.profile || "balanced",
        globalPurposes,
        categoryDomains,
        customSites,
        enableIds,
        disableIds,
        dynamicCount: newRules.length,
        overrideCount,
        gpcGlobal,
        gpcPerSite,
        overrideDetails,
        whitelistDomainCount: Object.keys(whitelist).length,
        whitelistGlobalCount: globalWhitelistDomains.length,
        whitelistPerSiteCount: Object.values(perSiteWhitelist).reduce((s, d) => s + d.length, 0),
        whitelistRuleCount: (globalWhitelistDomains.length > 0 ? 1 : 0) + Object.keys(perSiteWhitelist).length,
        whitelistSites: Object.keys(perSiteWhitelist),
        enhancedCount: Object.values(enhancedListsMeta).filter(l => l.enabled).length,
        enhancedListIds: Object.entries(enhancedListsMeta)
          .filter(([, l]) => l.enabled).map(([id]) => id),
        enhancedRules: Object.keys(newEnhancedMap).length,
        enhancedPathRules: newRules.filter(r => newEnhancedMap[r.id] && r.condition.urlFilter?.startsWith("||")).length,
        chStripping: globalDeniesAT ? "global" : (chAddSites.length > 0 ? "per-site" : "off"),
        chEnabled: chStrippingEnabled,
        chRules: newChRuleIds.size,
        chExcluded: chRemoveSites.length,
        chAddSites: chAddSites.length,
        consentEnhancedLink: consentEnhancedLink.cel,
        paramStripping: paramStrippingEnabled,
        paramStrippingSites: paramStrippingSitesEnabled,
        paramStrippingCdn: hasDynamicGlobalParams ? "dynamic" : "static",
        paramStrippingSitesCdn: hasDynamicSiteParams ? "dynamic" : "static",
        consentLinkedListIds: [...consentLinkedListIds],
        celPendingDownload: celPendingDownload,
        cosmeticLists: Object.entries(enhancedListsMeta)
          .filter(([id, m]) => m.type === "cosmetic" && (m.enabled || consentLinkedListIds.has(id)))
          .map(([id]) => id),
        cmpLists: Object.entries(enhancedListsMeta)
          .filter(([id, m]) => m.type === "cmp" && (m.enabled || consentLinkedListIds.has(id)))
          .map(([id]) => id),
        hotfixDomainCount,
        hotfixPathCount: enhancedData["protoconsent_hotfix"]?.pathRules?.length || 0,
        hotfixPathExceptionCount: enhancedData["protoconsent_hotfix"]?.pathExceptions?.length || 0,
        pathAttrIndexSize: newPathAttrIndex.size,
        ts: Date.now(),
      });
    }

    // 7. Apply changes: dynamic rules FIRST, then static rulesets.
    // Safety cap: trim enhanced rules if over MAX_NUMBER_OF_DYNAMIC_RULES
    const dynLimit = chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES || 5000;
    if (newRules.length > dynLimit) {
      const excess = newRules.length - dynLimit + DYNAMIC_RULE_RESERVE;
      const enhancedRuleIds = new Set(Object.keys(newEnhancedMap).map(Number));
      let trimmed = 0;
      for (let i = newRules.length - 1; i >= 0 && trimmed < excess; i--) {
        if (enhancedRuleIds.has(newRules[i].id)) {
          delete newEnhancedMap[newRules[i].id];
          newRules.splice(i, 1);
          trimmed++;
        }
      }
      if (DEBUG_RULES) console.warn("ProtoConsent: trimmed", trimmed, "enhanced rules to fit dynamic limit");
    }

    const regexRules = newRules.filter(r => r.condition?.regexFilter);
    if (regexRules.length && chrome.declarativeNetRequest.isRegexSupported) {
      const checks = await Promise.all(regexRules.map(r =>
        chrome.declarativeNetRequest.isRegexSupported({ regex: r.condition.regexFilter, isCaseSensitive: r.condition.isUrlFilterCaseSensitive ?? true })
      ));
      const badIds = new Set();
      for (let i = 0; i < checks.length; i++) {
        if (!checks[i].isSupported) {
          badIds.add(regexRules[i].id);
          if (DEBUG_RULES) console.warn("ProtoConsent: dropping regex rule", regexRules[i].id, checks[i].reason, regexRules[i].condition.regexFilter.slice(0, 120));
        }
      }
      if (badIds.size) {
        newRules = newRules.filter(r => !badIds.has(r.id));
      }
    }

    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existingIds,
        addRules: newRules,
      });
      setDynamicBlockRuleMap(newDynamicBlockMap);
      setDynamicGpcSetIds(newGpcSetIds);
      setDynamicChRuleIds(newChRuleIds);
      setDynamicWhitelistMap(newWhitelistMap);
      setDynamicEnhancedMap(newEnhancedMap);
    } catch (e) {
      console.error("updateDynamicRules failed:", e.message, "rules:", newRules.length);
      if (DEBUG_RULES) lastRebuildDebug.error = e.message;
    }
    try {
      await chrome.declarativeNetRequest.updateEnabledRulesets({
        enableRulesetIds: enableIds,
        disableRulesetIds: disableIds,
      });
    } catch (e) {
      console.error("updateEnabledRulesets failed:", e.message,
        "enable:", enableIds, "disable:", disableIds);
      if (DEBUG_RULES) lastRebuildDebug.rulesetError = e.message;
    }

    await updateGPCContentScript(rulesByDomain, presets, defaultConfig, globalPurposes, gpcEnabled);
    await updateCosmeticInjection(enhancedListsMeta, enhancedData, permissiveSites, consentLinkedListIds);
    await updateCmpInjectionData(globalPurposes, gpcEnabled);

  } catch (e) {
    console.error("ProtoConsent: failed to rebuild dynamic rules:", e);
  }
}

// Register or unregister the GPC DOM signal (navigator.globalPrivacyControl)
async function updateGPCContentScript(rulesByDomain, presets, defaultConfig, globalPurposes, gpcEnabled) {
  if (!chrome.scripting?.registerContentScripts) return;

  try {
    await chrome.scripting.unregisterContentScripts({ ids: [GPC_SCRIPT_ID] }).catch(() => {});

    if (!gpcEnabled) return;

    const globalNeedsGPC = gpcPurposes.length > 0 && gpcPurposes.some(p => !globalPurposes[p]);

    const excludeDomains = [];
    const includeDomains = [];

    for (const [domain, siteConfig] of Object.entries(rulesByDomain)) {
      const sitePurposes = resolvePurposes(siteConfig, presets, defaultConfig);
      const siteNeedsGPC = gpcEnabled && gpcPurposes.some(p => !sitePurposes[p]);

      if (siteNeedsGPC === globalNeedsGPC) continue;

      if (globalNeedsGPC && !siteNeedsGPC) {
        excludeDomains.push(`*://*.${domain}/*`, `*://${domain}/*`);
      } else if (!globalNeedsGPC && siteNeedsGPC) {
        includeDomains.push(`*://*.${domain}/*`, `*://${domain}/*`);
      }
    }

    if (globalNeedsGPC) {
      await chrome.scripting.registerContentScripts([{
        id: GPC_SCRIPT_ID,
        matches: ["<all_urls>"],
        excludeMatches: excludeDomains.length > 0 ? excludeDomains : undefined,
        js: ["content-scripts/gpc-signal.js"],
        runAt: "document_start",
        world: "MAIN",
        allFrames: true,
      }]);
    } else if (includeDomains.length > 0) {
      await chrome.scripting.registerContentScripts([{
        id: GPC_SCRIPT_ID,
        matches: includeDomains,
        js: ["content-scripts/gpc-signal.js"],
        runAt: "document_start",
        world: "MAIN",
        allFrames: true,
      }]);
    }

  } catch (e) {
    console.error("ProtoConsent: failed to update GPC content script:", e);
  }
}

// Register or unregister the cosmetic filtering content script.
// Compiles generic+domain CSS from active cosmetic lists and stores it
// in chrome.storage.local for the content script to read at document_start.
async function updateCosmeticInjection(enhancedListsMeta, enhancedData, permissiveSites, consentLinkedListIds) {
  if (!chrome.scripting?.registerContentScripts) return;

  try {
    await chrome.scripting.unregisterContentScripts({ ids: [COSMETIC_SCRIPT_ID] }).catch(() => {});

    const { enhancedCosmeticEnabled } = await new Promise(resolve =>
      chrome.storage.local.get("enhancedCosmeticEnabled", resolve));
    if (enhancedCosmeticEnabled === false) {
      chrome.storage.local.remove(["_cosmeticCSS", "_cosmeticDomains", "_cosmeticExceptions"]);
      return;
    }

    // Collect all active cosmetic lists
    const activeCosmeticData = [];
    for (const [listId, listMeta] of Object.entries(enhancedListsMeta)) {
      if (listMeta.type !== "cosmetic") continue;
      if (!listMeta.enabled && !consentLinkedListIds.has(listId)) continue;
      const data = enhancedData[listId];
      if (data) activeCosmeticData.push(data);
    }

    if (activeCosmeticData.length === 0) {
      await new Promise(resolve => {
        chrome.storage.local.remove(["_cosmeticCSS", "_cosmeticDomains", "_cosmeticExceptions"], resolve);
      });
      return;
    }

    // Merge generic selectors and domain selectors from all active lists
    const genericSet = new Set();
    const domainMap = {};
    const exceptionMap = {};
    for (const data of activeCosmeticData) {
      if (data.generic) for (const sel of data.generic) genericSet.add(sel);
      if (data.domains) {
        for (const [domain, sels] of Object.entries(data.domains)) {
          if (!domainMap[domain]) domainMap[domain] = new Set();
          for (const sel of sels) domainMap[domain].add(sel);
        }
      }
      if (data.exceptions) {
        for (const [domain, sels] of Object.entries(data.exceptions)) {
          if (!exceptionMap[domain]) exceptionMap[domain] = new Set();
          for (const sel of sels) exceptionMap[domain].add(sel);
        }
      }
    }

    // Merge user-defined cosmetic exceptions
    const userExc = await new Promise(resolve =>
      chrome.storage.local.get(["cosmeticUserExceptions"], r => resolve(r.cosmeticUserExceptions || {}))
    );
    for (const [domain, sels] of Object.entries(userExc)) {
      if (!exceptionMap[domain]) exceptionMap[domain] = new Set();
      for (const sel of sels) exceptionMap[domain].add(sel);
    }

    // Build CSS string: chunk generic selectors into groups of 500
    // Filter out selectors containing { or } to prevent CSS injection
    const allGeneric = [...genericSet].filter(s => !s.includes("{") && !s.includes("}") && !s.includes("<") && !s.includes("url("));
    const CHUNK = 500;
    const chunks = [];
    for (let i = 0; i < allGeneric.length; i += CHUNK) {
      const slice = allGeneric.slice(i, i + CHUNK);
      chunks.push(slice.join(",") + "{display:none!important}");
    }
    const cosmeticCSS = chunks.join("\n");

    // Serialize domain map (convert Sets to Arrays, filter unsafe selectors)
    const cosmeticDomains = {};
    for (const [d, sels] of Object.entries(domainMap)) {
      const safe = [...sels].filter(s => !s.includes("{") && !s.includes("}") && !s.includes("<") && !s.includes("url("));
      if (safe.length) cosmeticDomains[d] = safe;
    }

    // Serialize exception map (convert Sets to Arrays)
    const cosmeticExceptions = {};
    for (const [d, sels] of Object.entries(exceptionMap)) {
      const arr = [...sels];
      if (arr.length) cosmeticExceptions[d] = arr;
    }

    // Store compiled CSS + domain map + exceptions for the content script
    const storageData = { _cosmeticCSS: cosmeticCSS, _cosmeticDomains: cosmeticDomains, _cosmeticExceptions: Object.keys(cosmeticExceptions).length > 0 ? cosmeticExceptions : {} };
    await new Promise(resolve => {
      chrome.storage.local.set(storageData, resolve);
    });

    // Build exclude patterns for permissive sites + user-excluded cosmetic sites
    const excludeMatches = [];
    if (permissiveSites && permissiveSites.length > 0) {
      for (const site of permissiveSites) {
        excludeMatches.push(`*://*.${site}/*`, `*://${site}/*`);
      }
    }
    const cosmeticExcSites = await new Promise(resolve =>
      chrome.storage.local.get(["cosmeticExcludedSites"], r => resolve(r.cosmeticExcludedSites || []))
    );
    for (const site of cosmeticExcSites) {
      excludeMatches.push(`*://*.${site}/*`, `*://${site}/*`);
    }

    await chrome.scripting.registerContentScripts([{
      id: COSMETIC_SCRIPT_ID,
      matches: ["<all_urls>"],
      excludeMatches: excludeMatches.length > 0 ? excludeMatches : undefined,
      js: ["cosmetic-inject.js"],
      runAt: "document_start",
      allFrames: true,
    }]);

    lastRebuildDebug.cosmeticGenericCount = allGeneric.length;
    lastRebuildDebug.cosmeticDomainCount = Object.keys(cosmeticDomains).length;

  } catch (e) {
    console.error("ProtoConsent: failed to update cosmetic injection:", e);
  }
}
