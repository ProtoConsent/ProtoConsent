// ProtoConsent background DNR rebuild
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Core enforcement engine: reads storage + blocklists and rebuilds all
// declarativeNetRequest rules (static rulesets, dynamic overrides,
// whitelist, enhanced lists, GPC headers, Client Hints stripping).

import { DEBUG_RULES, loadDebugFlag, initBrowser, getChStrippingEnabled } from "./config-bridge.js";
import {
  DYNAMIC_RULE_RESERVE, RULE_RANGES,
  PURPOSES_FOR_ENFORCEMENT,
  setEnabledBlockRulesets,
  setDynamicBlockRuleMap, setDynamicGpcSetIds, setDynamicChRuleIds,
  setDynamicWhitelistMap, setDynamicEnhancedMap, setDynamicParamStripIds,
  setEnhancedReverseIndex,
  setPathAttributionIndex,
  setGpcGlobalActive, setGpcAddDomains, setGpcRemoveDomains,
  setLastRebuildDebug, lastRebuildDebug,
  setLastConsentLinkedListIds, setLastCelPendingDownload,
  _rebuildRunning, setRebuildRunning,
  _rebuildQueued, setRebuildQueued,
  setOperatingMode, can,
} from "./state.js";
import {
  getDefaultProfileConfig, resolvePurposes, getAllRulesFromStorage,
  getWhitelistFromStorage,
  getEnhancedListsFromStorage,
} from "./storage.js";
import {
  loadBlocklistsConfig, loadPresetsConfig, loadPurposesConfig,
  loadBundledPathAttribution,
} from "./config-loader.js";
import { updateCmpInjectionData } from "./cmp-injection.js";
import { consumeCelPendingDownloads } from "./auto-refresh.js";
import { buildEnhancedRulesIncremental, buildParamStripRulesIncremental } from "./rebuild-enhanced.js";
import { buildRevokeRules } from "./rebuild-revoke.js";
import { buildGpcRules, buildChRules, updateGPCContentScript } from "./rebuild-signals.js";
import { updateCosmeticInjection } from "./rebuild-cosmetic.js";
import { buildOverrideRules, buildWhitelistRules } from "./rebuild-overrides.js";
import { resolveConsentEnhancedLink } from "./rebuild-cel.js";

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
  let consentLinkedListIds = new Set();

  // Compute permissiveSites once (needed by enhanced + cosmetic)
  const permissiveSites = [];
  if (can("ownBlocking")) {
    for (const [domain, siteConfig] of Object.entries(rulesByDomain)) {
      const sitePurposes = resolvePurposes(siteConfig, presets, defaultConfig);
      if (PURPOSES_FOR_ENFORCEMENT.every(p => sitePurposes[p])) permissiveSites.push(domain);
    }
  }

  // Read param strip prefs once (used in rule building + static rulesets)
  const paramStrippingEnabled = await new Promise(resolve => {
    chrome.storage.local.get(["paramStrippingEnabled"], r => resolve(r.paramStrippingEnabled !== false));
  });
  const paramStrippingSitesEnabled = await new Promise(resolve => {
    chrome.storage.local.get(["paramStrippingSitesEnabled"], r => resolve(r.paramStrippingSitesEnabled !== false));
  });

  // --- Build rules for affected ranges ---

  if (affectedRangeKeys.has("overrides")) {
    const overrideRules = buildOverrideRules(rulesByDomain, blocklists, presets, defaultConfig, globalPurposes);
    addRules = addRules.concat(overrideRules.rules);
    setDynamicBlockRuleMap(overrideRules.blockMap);
  }

  if (affectedRangeKeys.has("whitelist")) {
    const wlRules = buildWhitelistRules(whitelist);
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

    // CEL resolution
    ({ consentLinkedListIds } = await resolveConsentEnhancedLink(enhancedListsMeta, globalPurposes, consentEnhancedLink));

    let hfResult = null;
    if (affectedRangeKeys.has("hotfix")) {
      hfResult = await buildRevokeRules(enhancedListsMeta);
      addRules = addRules.concat(hfResult.rules);
    }

    if (affectedRangeKeys.has("enhanced")) {
      const enhancedExclude = permissiveSites.length > 0 ? permissiveSites : undefined;
      const enhResult = await buildEnhancedRulesIncremental(enhancedListsMeta, consentLinkedListIds, enhancedExclude);
      addRules = addRules.concat(enhResult.rules);
      setDynamicEnhancedMap(enhResult.enhancedMap);
      setEnhancedReverseIndex(enhResult.reverseIndex);
      setPathAttributionIndex(enhResult.pathAttrIndex);
    }

    if (affectedRangeKeys.has("paramStrip")) {
      const psResult = await buildParamStripRulesIncremental(enhancedListsMeta, paramStrippingEnabled, paramStrippingSitesEnabled);
      addRules = addRules.concat(psResult.rules);
      setDynamicParamStripIds(psResult.paramStripIds);
    }
  }

  if (affectedRangeKeys.has("gpc")) {
    const gpcRules = buildGpcRules(rulesByDomain, presets, defaultConfig, globalPurposes, gpcEnabled);
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
    const chRules = buildChRules(rulesByDomain, presets, defaultConfig, globalPurposes, chStrippingEnabled);
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

  // Update static rulesets when enhanced or signals categories change
  if (affectedRangeKeys.has("enhanced") || affectedRangeKeys.has("paramStrip")) {
    const enableIds = [];
    const disableIds = [];
    const BUNDLED_PATH_LISTS = ["easyprivacy", "easylist"];
    for (const listId of BUNDLED_PATH_LISTS) {
      const rulesetId = listId + "_paths";
      const listMeta = enhancedListsMeta[listId];
      const isEnabled = can("enhancedDnr") && (listMeta?.enabled || consentLinkedListIds.has(listId));
      if (isEnabled) enableIds.push(rulesetId);
      else disableIds.push(rulesetId);
    }
    if (affectedRangeKeys.has("paramStrip")) {
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
    const patch = {
      selectiveCategories: [...categories],
      selectiveRemoved: removeIds.length,
      selectiveAdded: addRules.length,
      selectiveTs: Date.now(),
    };
    if (affectedRangeKeys.has("enhanced") || affectedRangeKeys.has("hotfix")) {
      patch.enhancedCount = Object.values(enhancedListsMeta).filter(l => l.enabled).length;
      patch.enhancedListIds = Object.entries(enhancedListsMeta)
        .filter(([, l]) => l.enabled).map(([id]) => id);
      patch.enhancedRules = addRules.filter(r => r.priority === 2 && r.action.type === "block").length;
      patch.consentLinkedListIds = [...consentLinkedListIds];
    }
    if (hfResult) {
      patch.hotfixDomainCount = hfResult.domainCount;
      patch.hotfixExceptionCount = hfResult.exceptionCount;
    }
    if (affectedRangeKeys.has("paramStrip")) {
      patch.paramStripping = paramStrippingEnabled;
      patch.paramStrippingSites = paramStrippingSitesEnabled;
    }
    if (affectedRangeKeys.has("overrides")) {
      patch.customSites = Object.keys(rulesByDomain);
      patch.permissiveSites = permissiveSites.length;
    }
    if (affectedRangeKeys.has("whitelist")) {
      patch.whitelistDomainCount = Object.keys(whitelist).length;
    }
    Object.assign(lastRebuildDebug, patch);
  }

  // Content script updates only for relevant categories
  try {
    if (categories.has("signals") || categories.has("overrides")) {
      await updateGPCContentScript(rulesByDomain, presets, defaultConfig, globalPurposes, gpcEnabled);
    }
    if (categories.has("cosmetic") || categories.has("enhanced")) {
      await updateCosmeticInjection(enhancedListsMeta, permissiveSites, consentLinkedListIds);
    }
    if (categories.has("cmp")) {
      await updateCmpInjectionData(globalPurposes, gpcEnabled);
    }
  } catch (e) {
    if (DEBUG_RULES) console.warn("ProtoConsent selective: content script update failed:", e.message);
  }
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
    const overrideResult = buildOverrideRules(rulesByDomain, blocklists, presets, defaultConfig, globalPurposes);
    newRules = newRules.concat(overrideResult.rules);
    Object.assign(newDynamicBlockMap, overrideResult.blockMap);
    const permissiveSites = overrideResult.permissiveSites;

    // 4. Whitelist allow rules (priority 3) - standalone only
    const wlResult = buildWhitelistRules(whitelist);
    newRules = newRules.concat(wlResult.rules);
    Object.assign(newWhitelistMap, wlResult.whitelistMap);
    const globalWhitelistDomains = wlResult.globalDomains || [];
    const perSiteWhitelist = wlResult.perSite || {};

    // 4b. Hotfix safelist rules: override static rulesets for zombie domains
    const hotfixResult = await buildRevokeRules(enhancedListsMeta);
    newRules = newRules.concat(hotfixResult.rules);

    // 5. Enhanced Protection lists (dynamic block rules, priority 2)
    const { consentLinkedListIds, celPendingDownload } = await resolveConsentEnhancedLink(enhancedListsMeta, globalPurposes, consentEnhancedLink);

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
    const gpcResult = buildGpcRules(rulesByDomain, presets, defaultConfig, globalPurposes, gpcEnabled);
    newRules = newRules.concat(gpcResult.rules);
    for (const id of gpcResult.gpcSetIds) newGpcSetIds.add(id);
    const globalNeedsGPC = gpcResult.globalNeedsGPC;
    const gpcAddSites = gpcResult.gpcAddSites;
    const gpcRemoveSites = gpcResult.gpcRemoveSites;

    setGpcGlobalActive(globalNeedsGPC);
    setGpcAddDomains(new Set(gpcAddSites));
    setGpcRemoveDomains(new Set(gpcRemoveSites));

    // 6b. Client Hints stripping
    const chResult = buildChRules(rulesByDomain, presets, defaultConfig, globalPurposes, chStrippingEnabled);
    newRules = newRules.concat(chResult.rules);
    const newChRuleIds = chResult.chRuleIds;
    const globalDeniesAT = chStrippingEnabled && !globalPurposes.advanced_tracking;
    const chAddSites = [];
    const chRemoveSites = [];
    for (const r of chResult.rules) {
      if (r.condition.excludedRequestDomains) chRemoveSites.push(...r.condition.excludedRequestDomains);
      if (r.priority === 2 && r.condition.requestDomains) chAddSites.push(...r.condition.requestDomains);
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
        hotfixDomainCount: hotfixResult.domainCount,
        hotfixExceptionCount: hotfixResult.exceptionCount,
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




