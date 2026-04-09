// ProtoConsent background DNR rebuild
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Core enforcement engine: reads storage + blocklists and rebuilds all
// declarativeNetRequest rules (static rulesets, dynamic overrides,
// whitelist, enhanced lists, GPC headers, Client Hints stripping).

import { DEBUG_RULES, loadDebugFlag, getChStrippingEnabled, HIGH_ENTROPY_CH } from "./config-bridge.js";
import {
  BASE_RULE_ID, DYNAMIC_RULE_RESERVE, BLOCK_RESOURCE_TYPES, GPC_RESOURCE_TYPES,
  PURPOSES_FOR_ENFORCEMENT, gpcPurposes,
  setEnabledBlockRulesets,
  setDynamicBlockRuleMap, setDynamicGpcSetIds, setDynamicChRuleIds,
  setDynamicWhitelistMap, setDynamicEnhancedMap,
  setEnhancedReverseIndex,
  setGpcGlobalActive, setGpcAddDomains, setGpcRemoveDomains,
  setLastRebuildDebug, lastRebuildDebug,
  setLastConsentLinkedListIds, setLastCelPendingDownload,
  _rebuildRunning, setRebuildRunning,
  _rebuildQueued, setRebuildQueued,
  GPC_SCRIPT_ID,
} from "./state.js";
import {
  getDefaultProfileConfig, resolvePurposes, getAllRulesFromStorage,
  getWhitelistFromStorage, isValidHostname,
  getEnhancedListsFromStorage, getAllEnhancedDataFromStorage,
  getEnhancedPresetFromStorage,
} from "./storage.js";
import {
  loadBlocklistsConfig, loadPresetsConfig, loadPurposesConfig,
  loadEnhancedListsCatalog,
} from "./config-loader.js";

// Main function: rebuild all DNR enforcement from current storage + blocklists.
export async function rebuildAllDynamicRules() {
  if (_rebuildRunning) {
    setRebuildQueued(true);
    return;
  }
  setRebuildRunning(true);

  await loadDebugFlag();

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

    const [rulesByDomain, blocklists, presets, defaultConfig, whitelist, enhancedListsMeta] = await Promise.all([
      getAllRulesFromStorage(),
      loadBlocklistsConfig(),
      loadPresetsConfig(),
      getDefaultProfileConfig(),
      getWhitelistFromStorage(),
      getEnhancedListsFromStorage(),
    ]);
    const enhancedData = await getAllEnhancedDataFromStorage(enhancedListsMeta);

    const gpcEnabled = await new Promise(resolve => {
      chrome.storage.local.get(["gpcEnabled"], r => resolve(r.gpcEnabled !== false));
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

    const newRules = [];
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
      const rulesetId = "block_" + purposeKey;
      if (!globalPurposes[purposeKey]) {
        if (hasDomains) enableIds.push(rulesetId);
        if (hasPaths) enableIds.push(rulesetId + "_paths");
      } else {
        if (hasDomains) disableIds.push(rulesetId);
        if (hasPaths) disableIds.push(rulesetId + "_paths");
      }
    }

    setEnabledBlockRulesets(new Set(enableIds));

    // 3. Per-site overrides (priority 2)
    const allowOverrides = {};
    const blockOverrides = {};
    const permissiveSites = [];

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

    // 4. Whitelist allow rules (priority 3)
    const globalWhitelistDomains = [];
    const perSiteWhitelist = {};

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
      console.warn("ProtoConsent: whitelist needs " + whitelistRulesNeeded +
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

    // 5. Enhanced Protection lists (dynamic block rules, priority 2)
    const consentLinkedListIds = new Set();
    const celPendingDownload = [];
    if (consentEnhancedLink.cel) {
      const celCatalog = await loadEnhancedListsCatalog();
      if (celCatalog) {
        // Custom mode: use user-selected purposes; profile mode: derive from global profile
        const deniedCategories = new Set();
        if (consentEnhancedLink.mode === "custom") {
          if (consentEnhancedLink.customPurposes) {
            for (const [purpose, denied] of Object.entries(consentEnhancedLink.customPurposes)) {
              if (denied) deniedCategories.add(purpose);
            }
          } else {
            // First time custom with no stored preferences: deny all (match UI defaults)
            for (const key of ["analytics", "ads", "personalization", "third_parties", "advanced_tracking"]) {
              deniedCategories.add(key);
            }
          }
        } else {
          for (const [purpose, allowed] of Object.entries(globalPurposes)) {
            if (!allowed) deniedCategories.add(purpose);
          }
        }
        for (const [listId, listDef] of Object.entries(celCatalog)) {
          if (listDef.category && deniedCategories.has(listDef.category)) {
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

    const enhancedExclude = permissiveSites.length > 0 ? permissiveSites : undefined;

    for (const [listId, listMeta] of Object.entries(enhancedListsMeta)) {
      if (!listMeta.enabled && !consentLinkedListIds.has(listId)) continue;
      if (listMeta.type === "informational") continue;
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

      if (listData.pathRules?.length) {
        for (const pr of listData.pathRules) {
          const rId = nextRuleId++;
          newEnhancedMap[rId] = listId;
          const condition = {
            urlFilter: pr.urlFilter,
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
      }
    }

    // Build enhanced reverse index for onErrorOccurred attribution
    const newEnhancedReverseIndex = new Map();
    for (const [listId, listData] of Object.entries(enhancedData)) {
      if (listData.domains?.length) {
        for (const d of listData.domains) {
          newEnhancedReverseIndex.set(d, listId);
        }
      }
      if (listData.pathRules?.length) {
        for (const pr of listData.pathRules) {
          const m = pr.urlFilter?.match(/^\|\|([^/]+)/);
          if (m && !newEnhancedReverseIndex.has(m[1])) {
            newEnhancedReverseIndex.set(m[1], listId);
          }
        }
      }
    }
    setEnhancedReverseIndex(newEnhancedReverseIndex);

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
        chStripping: globalDeniesAT ? "global" : (chAddSites.length > 0 ? "per-site" : "off"),
        chEnabled: chStrippingEnabled,
        chRules: newChRuleIds.size,
        chExcluded: chRemoveSites.length,
        chAddSites: chAddSites.length,
        consentEnhancedLink: consentEnhancedLink.cel,
        consentLinkedListIds: [...consentLinkedListIds],
        celPendingDownload: celPendingDownload,
        ts: Date.now(),
      });
    }

    // 7. Apply changes: dynamic rules FIRST, then static rulesets.
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
        js: ["gpc-signal.js"],
        runAt: "document_start",
        world: "MAIN",
        allFrames: true,
      }]);
    } else if (includeDomains.length > 0) {
      await chrome.scripting.registerContentScripts([{
        id: GPC_SCRIPT_ID,
        matches: includeDomains,
        js: ["gpc-signal.js"],
        runAt: "document_start",
        world: "MAIN",
        allFrames: true,
      }]);
    }

  } catch (e) {
    console.error("ProtoConsent: failed to update GPC content script:", e);
  }
}
