// ProtoConsent background DNR rebuild
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Core enforcement engine: reads storage + blocklists and rebuilds all
// declarativeNetRequest rules (static rulesets, dynamic overrides,
// whitelist, enhanced lists, GPC headers, Client Hints stripping).

import { DEBUG_RULES, loadDebugFlag, initBrowser, getChStrippingEnabled, HIGH_ENTROPY_CH } from "./config-bridge.js";
import {
  DYNAMIC_RULE_RESERVE, RULE_RANGES, BLOCK_RESOURCE_TYPES, GPC_RESOURCE_TYPES,
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
  getEnhancedListsFromStorage, getEnhancedDataFromStorage,
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
import { buildEnhancedRulesIncremental, buildHotfixRulesIncremental, buildParamStripRulesIncremental } from "./rebuild-enhanced.js";

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

// Selective rebuild: only update rules in the specified categories.
// categories: Set<string> with values: "whitelist", "enhanced", "signals", "overrides", "cosmetic", "cmp"
// Falls back to full rebuild on error or if legacy rule IDs are detected.
export async function rebuildCategories(categories) {
  if (_rebuildRunning) {
    setRebuildQueued(true);
    return;
  }
  setRebuildRunning(true);

  await loadDebugFlag();
  await initBrowser();

  try {
    await _rebuildCategoriesImpl(categories);
  } catch (e) {
    if (DEBUG_RULES) console.warn("ProtoConsent: selective rebuild failed, falling back to full:", e.message);
    try {
      await _rebuildAllDynamicRulesImpl();
    } catch (e2) {
      if (DEBUG_RULES) console.error("ProtoConsent: full rebuild fallback also failed:", e2.message);
    }
  } finally {
    setRebuildRunning(false);
    if (_rebuildQueued) {
      setRebuildQueued(false);
      rebuildAllDynamicRules();
    }
  }
}

// Map category names to the RULE_RANGES keys they affect.
const CATEGORY_TO_RANGES = {
  overrides: ["overrides"],
  whitelist: ["whitelist"],
  enhanced: ["hotfix", "enhanced", "paramStrip"],
  signals: ["gpc", "ch"],
  paramStrip: ["paramStrip"],
  cosmetic: [],
  cmp: [],
};

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

async function _rebuildCategoriesImpl(categories) {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) return;
  if (!categories || categories.size === 0) {
    await _rebuildAllDynamicRulesImpl();
    return;
  }

  // Determine which ID ranges are affected
  const affectedRangeKeys = new Set();
  for (const cat of categories) {
    const ranges = CATEGORY_TO_RANGES[cat];
    if (!ranges) {
      await _rebuildAllDynamicRulesImpl();
      return;
    }
    for (const r of ranges) affectedRangeKeys.add(r);
  }

  // Get existing rules from browser and check for legacy IDs
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const maxKnownId = RULE_RANGES.ch.end;
  for (const r of existingRules) {
    if (r.id > maxKnownId) {
      if (DEBUG_RULES) console.warn("ProtoConsent: legacy rule ID", r.id, "detected, falling back to full rebuild");
      await _rebuildAllDynamicRulesImpl();
      return;
    }
  }

  // IDs to remove: existing rules within affected ranges
  const removeIds = [];
  for (const r of existingRules) {
    for (const key of affectedRangeKeys) {
      const range = RULE_RANGES[key];
      if (r.id >= range.start && r.id <= range.end) {
        removeIds.push(r.id);
        break;
      }
    }
  }

  // Load inputs needed for affected categories
  await loadPurposesConfig();
  const storedMode = await new Promise(r =>
    chrome.storage.local.get(["operatingMode"], res => r(res.operatingMode || "standalone"))
  );
  setOperatingMode(storedMode);

  const [rulesByDomain, blocklists, presets, defaultConfig, whitelist, enhancedListsMetaRaw] = await Promise.all([
    getAllRulesFromStorage(),
    loadBlocklistsConfig(),
    loadPresetsConfig(),
    getDefaultProfileConfig(),
    getWhitelistFromStorage(),
    getEnhancedListsFromStorage(),
  ]);
  const enhancedListsMeta = enhancedListsMetaRaw || {};

  const globalPurposes = resolvePurposes({}, presets, defaultConfig);
  const gpcEnabled = await new Promise(resolve => {
    chrome.storage.local.get(["gpcEnabled"], r => resolve(r.gpcEnabled !== false));
  });
  let addRules = [];

  // --- Build rules for affected ranges ---

  if (affectedRangeKeys.has("overrides")) {
    const overrideRules = _buildOverrideRulesForCategory(rulesByDomain, blocklists, presets, defaultConfig, globalPurposes);
    addRules = addRules.concat(overrideRules.rules);
    setDynamicBlockRuleMap(overrideRules.blockMap);
  }

  if (affectedRangeKeys.has("whitelist")) {
    const wlRules = _buildWhitelistRulesForCategory(whitelist);
    addRules = addRules.concat(wlRules.rules);
    setDynamicWhitelistMap(wlRules.whitelistMap);
  }

  if (affectedRangeKeys.has("hotfix") || affectedRangeKeys.has("enhanced") || affectedRangeKeys.has("paramStrip")) {
    await loadBundledPathAttribution();

    const consentEnhancedLink = await new Promise(resolve => {
      chrome.storage.local.get(["consentEnhancedLink", "dynamicListsConsent", "celMode", "celCustomPurposes"], r => resolve({
        cel: r.consentEnhancedLink === true,
        sync: r.dynamicListsConsent === true,
        mode: r.celMode || "profile",
        customPurposes: r.celCustomPurposes || null,
      }));
    });

    // Compute permissiveSites from rulesByDomain
    const permissiveSites = [];
    if (can("ownBlocking")) {
      for (const [domain, siteConfig] of Object.entries(rulesByDomain)) {
        const sitePurposes = resolvePurposes(siteConfig, presets, defaultConfig);
        if (PURPOSES_FOR_ENFORCEMENT.every(p => sitePurposes[p])) permissiveSites.push(domain);
      }
    }

    // CEL resolution
    const CEL_PURPOSES = new Set(["analytics", "ads", "personalization", "third_parties", "advanced_tracking"]);
    const consentLinkedListIds = new Set();
    if (consentEnhancedLink.cel) {
      const celCatalog = await loadEnhancedListsCatalog();
      if (celCatalog) {
        const deniedCategories = new Set();
        if (consentEnhancedLink.mode === "custom") {
          if (consentEnhancedLink.customPurposes && typeof consentEnhancedLink.customPurposes === "object") {
            for (const [purpose, denied] of Object.entries(consentEnhancedLink.customPurposes)) {
              if (denied && CEL_PURPOSES.has(purpose)) deniedCategories.add(purpose);
            }
          }
        } else {
          for (const [purpose, allowed] of Object.entries(globalPurposes)) {
            if (!allowed && CEL_PURPOSES.has(purpose)) deniedCategories.add(purpose);
          }
        }
        for (const [listId, listDef] of Object.entries(celCatalog)) {
          if (listDef.category && CEL_PURPOSES.has(listDef.category) && deniedCategories.has(listDef.category)) {
            if (enhancedListsMeta[listId]) consentLinkedListIds.add(listId);
          }
        }
      }
    }

    let hfResult = null;
    if (affectedRangeKeys.has("hotfix")) {
      hfResult = await buildHotfixRulesIncremental();
      addRules = addRules.concat(hfResult.rules);
    }

    if (affectedRangeKeys.has("enhanced")) {
      const enhancedExclude = permissiveSites.length > 0 ? permissiveSites : undefined;
      const enhResult = await buildEnhancedRulesIncremental(enhancedListsMeta, consentLinkedListIds, enhancedExclude);
      addRules = addRules.concat(enhResult.rules);
      setDynamicEnhancedMap(enhResult.enhancedMap);
      setEnhancedReverseIndex(enhResult.reverseIndex);
      // Merge hotfix path attribution entries if hotfix was also rebuilt
      if (affectedRangeKeys.has("hotfix") && hfResult) {
        for (const entry of hfResult.pathAttrEntries) {
          let arr = enhResult.pathAttrIndex.get(entry.host);
          if (!arr) { arr = []; enhResult.pathAttrIndex.set(entry.host, arr); }
          arr.push({ prefix: entry.prefix, source: entry.source });
        }
      }
      setPathAttributionIndex(enhResult.pathAttrIndex);
    }

    if (affectedRangeKeys.has("paramStrip")) {
      const paramStrippingEnabled = await new Promise(resolve => {
        chrome.storage.local.get(["paramStrippingEnabled"], r => resolve(r.paramStrippingEnabled !== false));
      });
      const paramStrippingSitesEnabled = await new Promise(resolve => {
        chrome.storage.local.get(["paramStrippingSitesEnabled"], r => resolve(r.paramStrippingSitesEnabled !== false));
      });
      const psResult = await buildParamStripRulesIncremental(enhancedListsMeta, paramStrippingEnabled, paramStrippingSitesEnabled);
      addRules = addRules.concat(psResult.rules);
      setDynamicParamStripIds(psResult.paramStripIds);
    }
  }

  if (affectedRangeKeys.has("gpc")) {
    const gpcRules = _buildGpcRulesForCategory(rulesByDomain, presets, defaultConfig, globalPurposes, gpcEnabled);
    addRules = addRules.concat(gpcRules.rules);
    setDynamicGpcSetIds(gpcRules.gpcSetIds);
    setGpcGlobalActive(gpcRules.globalNeedsGPC);
    setGpcAddDomains(new Set(gpcRules.gpcAddSites));
    setGpcRemoveDomains(new Set(gpcRules.gpcRemoveSites));
  }

  if (affectedRangeKeys.has("ch")) {
    const chStrippingEnabled = await new Promise(resolve => {
      getChStrippingEnabled(resolve);
    });
    const chRules = _buildChRulesForCategory(rulesByDomain, presets, defaultConfig, globalPurposes, chStrippingEnabled);
    addRules = addRules.concat(chRules.rules);
    setDynamicChRuleIds(chRules.chRuleIds);
  }

  // Apply selective update
  if (removeIds.length > 0 || addRules.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: removeIds,
      addRules: addRules,
    });
  }

  // Update enhanced reverse index and path attribution when enhanced data changed
  // (only if not already done by the enhanced rebuild above)
  if ((affectedRangeKeys.has("hotfix") && !affectedRangeKeys.has("enhanced"))) {
    // Hotfix-only change: rebuild reverse index + path attribution incrementally
    const consentLinkedIdsForIndex = await _getConsentLinkedListIds(enhancedListsMeta, globalPurposes);
    const enhancedExclude = undefined; // not needed for index-only rebuild
    const enhResult = await buildEnhancedRulesIncremental(enhancedListsMeta, consentLinkedIdsForIndex, enhancedExclude);
    setEnhancedReverseIndex(enhResult.reverseIndex);
    // Merge hotfix path attribution
    const hotfixData = await getEnhancedDataFromStorage("protoconsent_hotfix");
    if (hotfixData?.pathRules?.length) {
      for (const pr of hotfixData.pathRules) {
        const p = parseUrlFilterForAttribution(pr.urlFilter);
        if (p) {
          let arr = enhResult.pathAttrIndex.get(p.hostname);
          if (!arr) { arr = []; enhResult.pathAttrIndex.set(p.hostname, arr); }
          arr.push({ prefix: p.prefix, source: "enhanced:protoconsent_hotfix" });
        }
      }
    }
    setPathAttributionIndex(enhResult.pathAttrIndex);
  }

  // Update static rulesets when enhanced or signals categories change
  if (affectedRangeKeys.has("enhanced") || affectedRangeKeys.has("paramStrip")) {
    const enableIds = [];
    const disableIds = [];
    const BUNDLED_PATH_LISTS = ["easyprivacy", "easylist"];
    for (const listId of BUNDLED_PATH_LISTS) {
      const rulesetId = listId + "_paths";
      const listMeta = enhancedListsMeta[listId];
      const isEnabled = can("enhancedDnr") && listMeta?.enabled;
      if (isEnabled) enableIds.push(rulesetId);
      else disableIds.push(rulesetId);
    }
    if (affectedRangeKeys.has("paramStrip")) {
      const paramStrippingEnabled = await new Promise(resolve => {
        chrome.storage.local.get(["paramStrippingEnabled"], r => resolve(r.paramStrippingEnabled !== false));
      });
      const paramStrippingSitesEnabled = await new Promise(resolve => {
        chrome.storage.local.get(["paramStrippingSitesEnabled"], r => resolve(r.paramStrippingSitesEnabled !== false));
      });
      if (paramStrippingEnabled) enableIds.push("strip_tracking_params");
      else disableIds.push("strip_tracking_params");
      if (paramStrippingEnabled && paramStrippingSitesEnabled) enableIds.push("strip_tracking_params_sites");
      else disableIds.push("strip_tracking_params_sites");
    }
    if (enableIds.length > 0 || disableIds.length > 0) {
      try {
        await chrome.declarativeNetRequest.updateEnabledRulesets({
          enableRulesetIds: enableIds,
          disableRulesetIds: disableIds,
        });
      } catch (e) {
        if (DEBUG_RULES) console.warn("ProtoConsent selective: updateEnabledRulesets failed:", e.message);
      }
    }
  }

  if (DEBUG_RULES) {
    lastRebuildDebug.selectiveCategories = [...categories];
    lastRebuildDebug.selectiveRemoved = removeIds.length;
    lastRebuildDebug.selectiveAdded = addRules.length;
    lastRebuildDebug.selectiveTs = Date.now();
  }

  // Content script updates only for relevant categories
  try {
    if (categories.has("signals") || categories.has("overrides")) {
      await updateGPCContentScript(rulesByDomain, presets, defaultConfig, globalPurposes, gpcEnabled);
    }
    if (categories.has("cosmetic") || categories.has("enhanced")) {
      const permissiveSites = [];
      if (can("ownBlocking")) {
        for (const [domain, siteConfig] of Object.entries(rulesByDomain)) {
          const sitePurposes = resolvePurposes(siteConfig, presets, defaultConfig);
          if (PURPOSES_FOR_ENFORCEMENT.every(p => sitePurposes[p])) permissiveSites.push(domain);
        }
      }
      await updateCosmeticInjection(enhancedListsMeta, permissiveSites,
        await _getConsentLinkedListIds(enhancedListsMeta, globalPurposes));
    }
    if (categories.has("cmp")) {
      await updateCmpInjectionData(globalPurposes, gpcEnabled);
    }
  } catch (e) {
    if (DEBUG_RULES) console.warn("ProtoConsent selective: content script update failed:", e.message);
  }
}

// --- Category builder helpers ---

function _buildOverrideRulesForCategory(rulesByDomain, blocklists, presets, defaultConfig, globalPurposes) {
  const rules = [];
  const blockMap = {};
  let nextId = RULE_RANGES.overrides.start;

  if (!can("ownBlocking")) return { rules, blockMap };

  const allowOverrides = {};
  const blockOverrides = {};
  for (const [domain, siteConfig] of Object.entries(rulesByDomain)) {
    const sitePurposes = resolvePurposes(siteConfig, presets, defaultConfig);
    for (const purposeKey of PURPOSES_FOR_ENFORCEMENT) {
      const siteAllows = sitePurposes[purposeKey];
      const globalAllows = globalPurposes[purposeKey];
      if (siteAllows === globalAllows) continue;
      if (siteAllows) {
        if (!allowOverrides[purposeKey]) allowOverrides[purposeKey] = [];
        allowOverrides[purposeKey].push(domain);
      } else {
        if (!blockOverrides[purposeKey]) blockOverrides[purposeKey] = [];
        blockOverrides[purposeKey].push(domain);
      }
    }
  }

  for (const purposeKey of PURPOSES_FOR_ENFORCEMENT) {
    const domainList = blocklists[purposeKey]?.domains || [];
    const pathDomainList = blocklists[purposeKey]?.pathDomains || [];
    const domains = pathDomainList.length ? [...domainList, ...pathDomainList] : domainList;
    if (!domains.length) continue;

    if (allowOverrides[purposeKey]?.length) {
      nextIdInRange(nextId, "overrides");
      rules.push({
        id: nextId++,
        priority: 2,
        action: { type: "allow" },
        condition: { requestDomains: domains, initiatorDomains: allowOverrides[purposeKey], resourceTypes: BLOCK_RESOURCE_TYPES },
      });
    }
    if (blockOverrides[purposeKey]?.length) {
      const initiators = blockOverrides[purposeKey];
      let effectiveDomains = domains;
      if (pathDomainList.length) {
        const safePathDomains = pathDomainList.filter(pd =>
          !initiators.some(id => pd === id || pd.endsWith("." + id) || id.endsWith("." + pd))
        );
        effectiveDomains = safePathDomains.length ? [...domainList, ...safePathDomains] : domainList;
      }
      if (effectiveDomains.length) {
        nextIdInRange(nextId, "overrides");
        blockMap[nextId] = purposeKey;
        rules.push({
          id: nextId++,
          priority: 2,
          action: { type: "block" },
          condition: { requestDomains: effectiveDomains, initiatorDomains: initiators, resourceTypes: BLOCK_RESOURCE_TYPES },
        });
      }
    }
  }
  return { rules, blockMap };
}

function _buildWhitelistRulesForCategory(whitelist) {
  const rules = [];
  const whitelistMap = {};
  let nextId = RULE_RANGES.whitelist.start;

  if (!can("whitelistOverrides")) return { rules, whitelistMap };

  const globalDomains = [];
  const perSite = {};
  for (const [domain, siteMap] of Object.entries(whitelist)) {
    if (!isValidHostname(domain)) continue;
    for (const site of Object.keys(siteMap)) {
      if (site === "*") globalDomains.push(domain);
      else if (isValidHostname(site)) {
        if (!perSite[site]) perSite[site] = [];
        perSite[site].push(domain);
      }
    }
  }

  const budget = RULE_RANGES.whitelist.end - RULE_RANGES.whitelist.start + 1;
  let added = 0;

  if (globalDomains.length > 0 && added < budget) {
    const wlId = nextId++;
    whitelistMap[wlId] = globalDomains;
    rules.push({ id: wlId, priority: 3, action: { type: "allow" }, condition: { requestDomains: globalDomains, resourceTypes: BLOCK_RESOURCE_TYPES } });
    added++;
  }
  for (const [site, domains] of Object.entries(perSite)) {
    if (added >= budget) break;
    const wlId = nextId++;
    whitelistMap[wlId] = domains;
    rules.push({ id: wlId, priority: 3, action: { type: "allow" }, condition: { requestDomains: domains, initiatorDomains: [site], resourceTypes: BLOCK_RESOURCE_TYPES } });
    added++;
  }
  return { rules, whitelistMap };
}

function _buildGpcRulesForCategory(rulesByDomain, presets, defaultConfig, globalPurposes, gpcEnabled) {
  const rules = [];
  const gpcSetIds = new Set();
  let nextId = RULE_RANGES.gpc.start;
  const globalNeedsGPC = gpcEnabled && gpcPurposes.some(p => !globalPurposes[p]);

  if (globalNeedsGPC) {
    nextIdInRange(nextId, "gpc");
    const gpcGlobalId = nextId++;
    gpcSetIds.add(gpcGlobalId);
    rules.push({
      id: gpcGlobalId, priority: 1,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "Sec-GPC", operation: "set", value: "1" }] },
      condition: { resourceTypes: GPC_RESOURCE_TYPES },
    });
  }

  const gpcAddSites = [];
  const gpcRemoveSites = [];
  for (const [domain, siteConfig] of Object.entries(rulesByDomain)) {
    const sitePurposes = resolvePurposes(siteConfig, presets, defaultConfig);
    const siteNeedsGPC = gpcEnabled && gpcPurposes.some(p => !sitePurposes[p]);
    if (siteNeedsGPC === globalNeedsGPC) continue;
    if (siteNeedsGPC) gpcAddSites.push(domain);
    else gpcRemoveSites.push(domain);
  }

  if (gpcAddSites.length > 0) {
    nextIdInRange(nextId, "gpc");
    const gpcAddId = nextId++;
    gpcSetIds.add(gpcAddId);
    rules.push({
      id: gpcAddId, priority: 2,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "Sec-GPC", operation: "set", value: "1" }] },
      condition: { requestDomains: gpcAddSites, resourceTypes: GPC_RESOURCE_TYPES },
    });
  }
  if (gpcRemoveSites.length > 0) {
    nextIdInRange(nextId, "gpc");
    rules.push({
      id: nextId++, priority: 2,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "Sec-GPC", operation: "remove" }] },
      condition: { requestDomains: gpcRemoveSites, resourceTypes: GPC_RESOURCE_TYPES },
    });
  }

  return { rules, gpcSetIds, globalNeedsGPC, gpcAddSites, gpcRemoveSites };
}

function _buildChRulesForCategory(rulesByDomain, presets, defaultConfig, globalPurposes, chStrippingEnabled) {
  const rules = [];
  const chRuleIds = new Set();
  let nextId = RULE_RANGES.ch.start;
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

  if (globalDeniesAT) {
    nextIdInRange(nextId, "ch");
    const chGlobalId = nextId++;
    chRuleIds.add(chGlobalId);
    const chGlobalRule = { id: chGlobalId, priority: 1, action: { type: "modifyHeaders", requestHeaders: chHeaders }, condition: { resourceTypes: GPC_RESOURCE_TYPES } };
    if (chRemoveSites.length > 0) chGlobalRule.condition.excludedRequestDomains = chRemoveSites;
    rules.push(chGlobalRule);
  }
  if (chAddSites.length > 0) {
    nextIdInRange(nextId, "ch");
    const chPerSiteId = nextId++;
    chRuleIds.add(chPerSiteId);
    rules.push({ id: chPerSiteId, priority: 2, action: { type: "modifyHeaders", requestHeaders: chHeaders }, condition: { requestDomains: chAddSites, resourceTypes: GPC_RESOURCE_TYPES } });
  }
  return { rules, chRuleIds };
}

// Resolve consent-enhanced-link list IDs from current storage state (shared by builders and post-update).
async function _getConsentLinkedListIds(enhancedListsMeta, globalPurposes) {
  const CEL_PURPOSES = new Set(["analytics", "ads", "personalization", "third_parties", "advanced_tracking"]);
  const consentLinkedListIds = new Set();
  const celState = await new Promise(resolve => {
    chrome.storage.local.get(["consentEnhancedLink", "celMode", "celCustomPurposes"], r => resolve({
      cel: r.consentEnhancedLink === true,
      mode: r.celMode || "profile",
      customPurposes: r.celCustomPurposes || null,
    }));
  });
  if (!celState.cel) return consentLinkedListIds;
  const celCatalog = await loadEnhancedListsCatalog();
  if (!celCatalog) return consentLinkedListIds;
  const deniedCategories = new Set();
  if (celState.mode === "custom") {
    if (celState.customPurposes && typeof celState.customPurposes === "object") {
      for (const [purpose, denied] of Object.entries(celState.customPurposes)) {
        if (denied && CEL_PURPOSES.has(purpose)) deniedCategories.add(purpose);
      }
    }
  } else {
    for (const [purpose, allowed] of Object.entries(globalPurposes)) {
      if (!allowed && CEL_PURPOSES.has(purpose)) deniedCategories.add(purpose);
    }
  }
  for (const [listId, listDef] of Object.entries(celCatalog)) {
    if (listDef.category && CEL_PURPOSES.has(listDef.category) && deniedCategories.has(listDef.category)) {
      if (enhancedListsMeta[listId]) consentLinkedListIds.add(listId);
    }
  }
  return consentLinkedListIds;
}

async function _rebuildAllDynamicRulesImpl() {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) {
    if (DEBUG_RULES) console.warn("ProtoConsent: declarativeNetRequest not available in this browser.");
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
    let nextOverrideId = RULE_RANGES.overrides.start;
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
          id: nextOverrideId++,
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
          newDynamicBlockMap[nextOverrideId] = purposeKey;
          newRules.push({
            id: nextOverrideId++,
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
    let nextWhitelistId = RULE_RANGES.whitelist.start;
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
      const wlId = nextWhitelistId++;
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
      const wlId = nextWhitelistId++;
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
    const hotfixResult = await buildHotfixRulesIncremental();
    newRules = newRules.concat(hotfixResult.rules);
    let hotfixDomainCount = hotfixResult.rules.length > 0 ? hotfixResult.rules[0].condition?.requestDomains?.length || 0 : 0;

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

    setLastConsentLinkedListIds([...consentLinkedListIds]);
    setLastCelPendingDownload(celPendingDownload);

    // Auto-download CEL-linked lists in background without waiting for UI
    if (celPendingDownload.length > 0) {
      consumeCelPendingDownloads();
    }

    const enhancedExclude = permissiveSites.length > 0 ? permissiveSites : undefined;
    const BUNDLED_PATH_LISTS = ["easyprivacy", "easylist"];

    // --- Incremental per-list enhanced rules + reverse index + path attribution ---
    const enhancedResult = await buildEnhancedRulesIncremental(enhancedListsMeta, consentLinkedListIds, enhancedExclude);
    newRules = newRules.concat(enhancedResult.rules);
    Object.assign(newEnhancedMap, enhancedResult.enhancedMap);
    setEnhancedReverseIndex(enhancedResult.reverseIndex);

    // Add hotfix path attribution entries to the path attribution index
    for (const entry of hotfixResult.pathAttrEntries) {
      let arr = enhancedResult.pathAttrIndex.get(entry.host);
      if (!arr) { arr = []; enhancedResult.pathAttrIndex.set(entry.host, arr); }
      arr.push({ prefix: entry.prefix, source: entry.source });
    }
    setPathAttributionIndex(enhancedResult.pathAttrIndex);

    // Enable/disable bundled external path rulesets alongside their domain rules
    for (const listId of BUNDLED_PATH_LISTS) {
      const rulesetId = listId + "_paths";
      const listMeta = enhancedListsMeta[listId];
      const isEnabled = can("enhancedDnr") && (listMeta?.enabled || consentLinkedListIds.has(listId));
      if (isEnabled) enableIds.push(rulesetId);
      else disableIds.push(rulesetId);
    }

    // 5b. URL tracking parameter stripping -- incremental per-list read
    const paramResult = await buildParamStripRulesIncremental(enhancedListsMeta, paramStrippingEnabled, paramStrippingSitesEnabled);
    newRules = newRules.concat(paramResult.rules);
    setDynamicParamStripIds(paramResult.paramStripIds);
    const hasDynamicGlobalParams = paramResult.hasDynamicGlobalParams;
    const hasDynamicSiteParams = paramResult.hasDynamicSiteParams;

    // 6. GPC header rules
    let nextGpcId = RULE_RANGES.gpc.start;
    const globalNeedsGPC = gpcEnabled && gpcPurposes.some(p => !globalPurposes[p]);

    if (globalNeedsGPC) {
      const gpcGlobalId = nextGpcId++;
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
      const gpcAddId = nextGpcId++;
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
        id: nextGpcId++,
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
    let nextChId = RULE_RANGES.ch.start;
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
      const chGlobalId = nextChId++;
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
      const chPerSiteId = nextChId++;
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
        mode: "full",
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
        enhancedAllIds: Object.keys(enhancedListsMeta),
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
        hotfixPathCount: hotfixResult.rules.filter(r => r.priority === 2 && r.condition?.urlFilter).length,
        hotfixPathExceptionCount: hotfixResult.rules.filter(r => r.priority === 3 && r.condition?.urlFilter).length,
        pathAttrIndexSize: enhancedResult.pathAttrIndex.size,
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
      if (DEBUG_RULES) {
        console.error("updateDynamicRules failed:", e.message, "rules:", newRules.length);
        lastRebuildDebug.error = e.message;
      }
    }
    try {
      await chrome.declarativeNetRequest.updateEnabledRulesets({
        enableRulesetIds: enableIds,
        disableRulesetIds: disableIds,
      });
    } catch (e) {
      if (DEBUG_RULES) {
        console.error("updateEnabledRulesets failed:", e.message,
          "enable:", enableIds, "disable:", disableIds);
        lastRebuildDebug.rulesetError = e.message;
      }
    }

    await updateGPCContentScript(rulesByDomain, presets, defaultConfig, globalPurposes, gpcEnabled);
    await updateCosmeticInjection(enhancedListsMeta, permissiveSites, consentLinkedListIds);
    await updateCmpInjectionData(globalPurposes, gpcEnabled);

  } catch (e) {
    if (DEBUG_RULES) console.error("ProtoConsent: failed to rebuild dynamic rules:", e);
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
    if (DEBUG_RULES) console.error("ProtoConsent: failed to update GPC content script:", e);
  }
}

// Register or unregister the cosmetic filtering content script.
// Compiles generic+domain CSS from active cosmetic lists and stores it
// in chrome.storage.local for the content script to read at document_start.
async function updateCosmeticInjection(enhancedListsMeta, permissiveSites, consentLinkedListIds) {
  if (!chrome.scripting?.registerContentScripts) return;

  try {
    await chrome.scripting.unregisterContentScripts({ ids: [COSMETIC_SCRIPT_ID] }).catch(() => {});

    const { enhancedCosmeticEnabled } = await new Promise(resolve =>
      chrome.storage.local.get("enhancedCosmeticEnabled", resolve));
    if (enhancedCosmeticEnabled === false) {
      chrome.storage.local.remove(["_cosmeticCSS", "_cosmeticDomains", "_cosmeticExceptions"]);
      return;
    }

    // Collect all active cosmetic lists (read individually from storage)
    const activeCosmeticData = [];
    for (const [listId, listMeta] of Object.entries(enhancedListsMeta)) {
      if (listMeta.type !== "cosmetic") continue;
      if (!listMeta.enabled && !consentLinkedListIds.has(listId)) continue;
      const data = await getEnhancedDataFromStorage(listId);
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
    if (DEBUG_RULES) console.error("ProtoConsent: failed to update cosmetic injection:", e);
  }
}
