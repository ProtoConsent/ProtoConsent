// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// background.js - ProtoConsent enforcement using declarativeNetRequest
importScripts("config.js");

// We assign IDs for dynamic rules starting from 1 upwards
const BASE_RULE_ID = 1;

// Resource types for blocking rules (not main_frame — that would block the page itself)
const BLOCK_RESOURCE_TYPES = [
  "script", "xmlhttprequest", "image", "sub_frame", "ping", "other"
];

// Resource types for GPC header injection (includes main_frame for the server signal)
const GPC_RESOURCE_TYPES = ["main_frame", ...BLOCK_RESOURCE_TYPES];

// Purposes we currently enforce — derived at runtime from purposes.json keys.
let PURPOSES_FOR_ENFORCEMENT = [];

// Purposes that trigger the Sec-GPC header when denied.
// Derived at runtime from purposes.json (triggers_gpc: true).
let gpcPurposes = [];

// Cached domain and path-domain lists extracted from static rulesets (rules/block_*.json).
// Curated subset of public blocklists — not a full ad/tracking blocker.
// Sources: OISD big/small, HaGeZi Pro/Light/Ultimate, EasyPrivacy/EasyList, Disconnect.me
// Loaded once per SW lifetime. Maps purposeKey -> { domains: string[], pathDomains: string[] }.
let blocklistsConfig = null;

// Per-tab tracking of blocked domains for the popup detail view.
// Maps tabId -> { purposeKey -> { domain -> count } }
const tabBlockedDomains = new Map();

// Maps dynamic block rule IDs to their purpose (rebuilt on each rule update).
let dynamicBlockRuleMap = {};

// Last rebuild debug snapshot (served to popup on request)
let lastRebuildDebug = {};


// Cached in-memory copy of presets.json; loaded once per SW lifetime.
let presetsConfig = null;

// Cached in-memory copy of purposes.json; loaded once per SW lifetime.
let purposesConfig = null;


// Load domain and path-domain lists from static rulesets (rules/block_*.json, rules/block_*_paths.json).
// Subsequent calls return the cached in-memory version.
async function loadBlocklistsConfig() {
  if (blocklistsConfig) return blocklistsConfig;

  // Ensure purposes are loaded first (provides PURPOSES_FOR_ENFORCEMENT)
  await loadPurposesConfig();

  const config = {};
  for (const key of PURPOSES_FOR_ENFORCEMENT) {
    const entry = {};
    try {
      const url = chrome.runtime.getURL("rules/block_" + key + ".json");
      const res = await fetch(url);
      const rules = await res.json();
      entry.domains = rules[0]?.condition?.requestDomains || [];
    } catch (_) {
      // No static ruleset for this category (e.g. "functional")
      entry.domains = [];
    }
    // Extract unique domains from path-based rules (urlFilter "||domain.com/path")
    try {
      const url = chrome.runtime.getURL("rules/block_" + key + "_paths.json");
      const res = await fetch(url);
      const rules = await res.json();
      const domainSet = new Set(entry.domains);
      const pathDomains = [];
      for (const rule of rules) {
        const m = rule.condition?.urlFilter?.match(/^\|\|([^/]+)/);
        if (m && !domainSet.has(m[1])) {
          pathDomains.push(m[1]);
          domainSet.add(m[1]);
        }
      }
      entry.pathDomains = pathDomains;
    } catch (_) {
      entry.pathDomains = [];
    }
    config[key] = entry;
  }
  blocklistsConfig = config;
  return blocklistsConfig;
}

// Load presets.json once when the service worker starts.
// Subsequent calls return the cached in-memory version.
async function loadPresetsConfig() {
  if (presetsConfig) return presetsConfig;

  try {
    const url = chrome.runtime.getURL("config/presets.json");
    const res = await fetch(url);
    presetsConfig = await res.json();
    return presetsConfig;
  } catch (e) {
    console.error("Failed to load presets.json:", e);
    presetsConfig = {};
    return presetsConfig;
  }
}

// Load purposes.json once when the service worker starts.
// Extracts the list of purposes that trigger GPC (triggers_gpc: true).
async function loadPurposesConfig() {
  if (purposesConfig) return purposesConfig;

  try {
    const url = chrome.runtime.getURL("config/purposes.json");
    const res = await fetch(url);
    purposesConfig = await res.json();
  } catch (e) {
    console.error("Failed to load purposes.json:", e);
    purposesConfig = {};
  }

  // Derive purpose lists from config
  PURPOSES_FOR_ENFORCEMENT = Object.keys(purposesConfig);
  gpcPurposes = PURPOSES_FOR_ENFORCEMENT
    .filter(key => purposesConfig[key].triggers_gpc);

  return purposesConfig;
}

// Utility: get the user's default profile config from storage.
// Returns { profile, purposes } where purposes is only set for custom defaults.
function getDefaultProfileConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["defaultProfile", "defaultPurposes"], (result) => {
      resolve({
        profile: result.defaultProfile || "balanced",
        purposes: result.defaultPurposes || null
      });
    });
  });
}


// Resolve purpose states for a site rule by applying profile defaults
// and then any explicit overrides.
// Returns an object with all purpose keys mapped to booleans.
function resolvePurposes(siteConfig, presets, defaultConfig) {
  const resolved = {};
  const profileName = siteConfig.profile || (defaultConfig && defaultConfig.profile) || "balanced";

  // Determine base purposes: custom global default or named preset
  let profilePurposes;
  if (!siteConfig.profile && profileName === "custom" && defaultConfig && defaultConfig.purposes) {
    profilePurposes = defaultConfig.purposes;
  } else {
    // Fall back to "balanced" if the named profile doesn't exist (e.g. "custom" without saved purposes)
    const profileDef = presets[profileName] || presets["balanced"];
    profilePurposes = (profileDef && profileDef.purposes) || {};
  }
  const overrides = siteConfig.purposes || {};

  for (const key of PURPOSES_FOR_ENFORCEMENT) {
    if (key in overrides) {
      resolved[key] = overrides[key];
    } else {
      resolved[key] = profilePurposes[key] !== false;
    }
  }
  return resolved;
}

// Utility: get all rules from storage.
// Returns an object mapping domain -> siteConfig.
function getAllRulesFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["rules"], (result) => {
      resolve(result.rules || {});
    });
  });
}

// Serialization guard: if a rebuild is already running, queue one re-run at the end.
let _rebuildRunning = false;
let _rebuildQueued = false;


// Main function: rebuild all DNR enforcement from current storage + blocklists.
// 1) Enable/disable static rulesets (domain + path) for global blocking per category.
// 2) Build per-site dynamic overrides (block/allow) grouped by category.
// 3) Build GPC header rules (global + per-site overrides).
// 4) Atomic-swap all dynamic rules in a single updateDynamicRules call.
// 5) Update static rulesets AFTER dynamic (over-block during gap, never under-block).
async function rebuildAllDynamicRules() {
  if (_rebuildRunning) {
    _rebuildQueued = true;
    return;
  }
  _rebuildRunning = true;

  try {
    await _rebuildAllDynamicRulesImpl();
  } finally {
    _rebuildRunning = false;
    if (_rebuildQueued) {
      _rebuildQueued = false;
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
    // loadPurposesConfig must run first — it populates PURPOSES_FOR_ENFORCEMENT
    // which loadBlocklistsConfig needs to know which rule files to read.
    await loadPurposesConfig();

    const [rulesByDomain, blocklists, presets, defaultConfig] = await Promise.all([
      getAllRulesFromStorage(),
      loadBlocklistsConfig(),
      loadPresetsConfig(),
      getDefaultProfileConfig(),
    ]);

    // Collect existing dynamic rule IDs for the atomic swap at the end
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const existingIds = existingRules.map((r) => r.id);

    const newRules = [];
    let nextRuleId = BASE_RULE_ID;
    const newDynamicBlockMap = {};

    // 1. Resolve global default purposes (what applies to unconfigured sites)
    const globalPurposes = resolvePurposes({}, presets, defaultConfig);

    // 2. Compute which static rulesets to enable/disable.
    //    Each category may have a domain ruleset (block_X) and/or a path ruleset (block_X_paths).
    //    We enable/disable them independently based on the global profile,
    //    freeing the dynamic rule budget for per-site overrides.
    const enableIds = [];
    const disableIds = [];
    for (const purposeKey of PURPOSES_FOR_ENFORCEMENT) {
      const hasDomains = blocklists[purposeKey]?.domains?.length > 0;
      const hasPaths = blocklists[purposeKey]?.pathDomains?.length > 0;
      if (!hasDomains && !hasPaths) continue; // no rulesets for this category
      const rulesetId = "block_" + purposeKey;
      if (!globalPurposes[purposeKey]) {
        if (hasDomains) enableIds.push(rulesetId);
        if (hasPaths) enableIds.push(rulesetId + "_paths");
      } else {
        if (hasDomains) disableIds.push(rulesetId);
        if (hasPaths) disableIds.push(rulesetId + "_paths");
      }
    }

    // 3. Per-site overrides (priority 2 — override static rules where site differs)
    //    First pass: group sites by (category, action) so we can batch all sites
    //    into one initiatorDomains array per rule. This reduces from O(categories × sites)
    //    to O(categories × 2) — max 10 dynamic rules regardless of how many custom sites.
    //    Override requestDomains merges domain + pathDomain lists so both domain-based
    //    and path-based static rules are overridden for the site.
    const allowOverrides = {}; // purposeKey -> [site1, site2, ...]
    const blockOverrides = {}; // purposeKey -> [site1, site2, ...]

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

    // Second pass: emit one rule per (category, action) with all sites grouped
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
        newDynamicBlockMap[nextRuleId] = purposeKey;
        newRules.push({
          id: nextRuleId++,
          priority: 2,
          action: { type: "block" },
          condition: {
            requestDomains: domains,
            initiatorDomains: blockOverrides[purposeKey],
            resourceTypes: BLOCK_RESOURCE_TYPES,
          },
        });
      }
    }

    // 4. GPC header rules — inject Sec-GPC: 1 when privacy purposes are denied.
    //
    // Per-site overrides use requestDomains (the destination), not initiatorDomains
    // (the page making the request). This means: trusting elpais.com (custom, all
    // allowed) removes GPC from requests TO elpais.com, but third-party requests
    // FROM elpais.com to e.g. google-analytics.com still carry the global GPC
    // signal — trusting a site does not imply trusting the third parties it loads.
    // The same applies to cross-origin iframes: an iframe from youtube.com on a
    // trusted elpais.com page still receives GPC from the global rule.
    const globalNeedsGPC = gpcPurposes.some(p => !globalPurposes[p]);

    if (globalNeedsGPC) {
      // Global: send GPC on all requests by default
      newRules.push({
        id: nextRuleId++,
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

    // Per-site GPC overrides — grouped into max 2 rules (add/remove)
    const gpcAddSites = [];
    const gpcRemoveSites = [];

    for (const [domain, siteConfig] of Object.entries(rulesByDomain)) {
      const sitePurposes = resolvePurposes(siteConfig, presets, defaultConfig);
      const siteNeedsGPC = gpcPurposes.some(p => !sitePurposes[p]);

      if (siteNeedsGPC === globalNeedsGPC) continue;

      if (siteNeedsGPC) {
        gpcAddSites.push(domain);
      } else {
        gpcRemoveSites.push(domain);
      }
    }

    if (gpcAddSites.length > 0) {
      newRules.push({
        id: nextRuleId++,
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

    // GPC remove rule for permissive sites — popup filters these out
    // by only counting "set" operations, not "remove"
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

    if (DEBUG_RULES) {
      const overrideCount = newRules.filter(r => r.condition.initiatorDomains).length;
      const gpcGlobal = newRules.filter(r =>
        r.action.type === "modifyHeaders" && !r.condition.requestDomains).length;
      const gpcPerSite = newRules.filter(r =>
        r.action.type === "modifyHeaders" && r.condition.requestDomains).length;
      // Per-category domain counts
      const categoryDomains = {};
      for (const key of PURPOSES_FOR_ENFORCEMENT) {
        const d = blocklists[key]?.domains?.length || 0;
        const p = blocklists[key]?.pathDomains?.length || 0;
        if (d || p) categoryDomains[key] = d + "d+" + p + "p=" + (d + p);
      }
      // Per-site override detail
      const overrideDetails = {};
      for (const r of newRules) {
        if (r.condition.initiatorDomains && r.condition.requestDomains) {
          overrideDetails[r.id] = r.action.type + " " + r.condition.requestDomains.length +
            " → " + r.condition.initiatorDomains.join(",");
        }
      }
      // Custom sites summary
      const customSites = Object.keys(rulesByDomain);
      lastRebuildDebug = {
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
        ts: Date.now(),
      };
    }

    // 5. Apply changes: dynamic rules FIRST, then static rulesets.
    //    Order matters for security: during the brief gap between calls,
    //    "new dynamic + old static" may over-block (safe), whereas the
    //    reverse order "new static + old dynamic" could under-block.
    //    Each wrapped in its own try/catch to surface errors independently.
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existingIds,
        addRules: newRules,
      });
    } catch (e) {
      console.error("updateDynamicRules failed:", e.message, "rules:", newRules.length);
      if (DEBUG_RULES) lastRebuildDebug.error = e.message;
    }
    dynamicBlockRuleMap = newDynamicBlockMap;
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

    // Update the GPC content script registration to match the new rule state
    await updateGPCContentScript(rulesByDomain, presets, defaultConfig, globalPurposes);

  } catch (e) {
    console.error("ProtoConsent: failed to rebuild dynamic rules:", e);
  }
}

// Register or unregister the GPC DOM signal (navigator.globalPrivacyControl)
// as a MAIN-world content script, scoped to domains where GPC is needed.
// Receives pre-computed data from the rebuild to avoid re-reading storage.
const GPC_SCRIPT_ID = "protoconsent-gpc";

async function updateGPCContentScript(rulesByDomain, presets, defaultConfig, globalPurposes) {
  if (!chrome.scripting?.registerContentScripts) return;

  try {
    // Always unregister first to start fresh
    await chrome.scripting.unregisterContentScripts({ ids: [GPC_SCRIPT_ID] }).catch(() => {});

    const globalNeedsGPC = gpcPurposes.length > 0 && gpcPurposes.some(p => !globalPurposes[p]);

    // Collect per-site exceptions (domains that differ from global GPC state)
    const excludeDomains = [];
    const includeDomains = [];

    for (const [domain, siteConfig] of Object.entries(rulesByDomain)) {
      const sitePurposes = resolvePurposes(siteConfig, presets, defaultConfig);
      const siteNeedsGPC = gpcPurposes.some(p => !sitePurposes[p]);

      if (siteNeedsGPC === globalNeedsGPC) continue;

      if (globalNeedsGPC && !siteNeedsGPC) {
        excludeDomains.push(`*://*.${domain}/*`, `*://${domain}/*`);
      } else if (!globalNeedsGPC && siteNeedsGPC) {
        includeDomains.push(`*://*.${domain}/*`, `*://${domain}/*`);
      }
    }

    // Determine if we need to register at all
    if (globalNeedsGPC) {
      // Register for all URLs, excluding domains that override to no-GPC
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
      // Global doesn't need GPC but some sites do
      await chrome.scripting.registerContentScripts([{
        id: GPC_SCRIPT_ID,
        matches: includeDomains,
        js: ["gpc-signal.js"],
        runAt: "document_start",
        world: "MAIN",
        allFrames: true,
      }]);
    }
    // else: no GPC needed anywhere, nothing to register

  } catch (e) {
    console.error("ProtoConsent: failed to update GPC content script:", e);
  }
}

// Handle a bridge query from the content script.
// Reads storage, resolves purposes for the requested domain,
// and returns the appropriate data based on the action.
async function handleBridgeQuery(message) {
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
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  // Popup notifies that rules were changed by the user
  if (message.type === "PROTOCONSENT_RULES_UPDATED") {
    rebuildAllDynamicRules();
    sendResponse({ ok: true });
    return;
  }

  // Popup requests per-tab blocked domain detail + per-purpose counts (domains + paths)
  if (message.type === "PROTOCONSENT_GET_BLOCKED_DOMAINS") {
    loadBlocklistsConfig().then(bl => {
      const purposeDomainCounts = {};
      const purposePathCounts = {};
      for (const key of PURPOSES_FOR_ENFORCEMENT) {
        const dLen = bl[key]?.domains?.length;
        const pLen = bl[key]?.pathDomains?.length;
        if (dLen) purposeDomainCounts[key] = dLen;
        if (pLen) purposePathCounts[key] = pLen;
      }
      sendResponse({
        data: tabBlockedDomains.get(message.tabId) || {},
        purposeDomainCounts,
        purposePathCounts,
      });
    });
    return true; // async response
  }

  // Content script forwards an SDK query
  if (message.type === "PROTOCONSENT_BRIDGE_QUERY") {
    handleBridgeQuery(message)
      .then((data) => sendResponse({ data }))
      .catch(() => sendResponse({ data: null }));
    return true; // keep message channel open for async response
  }

  // Popup requests last rebuild debug snapshot
  if (message.type === "PROTOCONSENT_GET_DEBUG") {
    sendResponse(lastRebuildDebug);
    return;
  }
});

// Track blocked domains per tab for the popup detail view.
// onRuleMatchedDebug fires for every matched rule (static + dynamic).
if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    const { rule, request } = info;
    if (request.tabId < 0) return;

    let purpose = null;

    // Static block ruleset (e.g. "block_ads" or "block_ads_paths" → "ads")
    if (rule.rulesetId && rule.rulesetId.startsWith("block_")) {
      purpose = rule.rulesetId.slice(6).replace(/_paths$/, "");
    }
    // Dynamic block override
    else if (rule.rulesetId === "_dynamic" && dynamicBlockRuleMap[rule.ruleId]) {
      purpose = dynamicBlockRuleMap[rule.ruleId];
    }

    if (!purpose) return;

    let domain;
    try { domain = new URL(request.url).hostname; } catch (_) { return; }

    if (!tabBlockedDomains.has(request.tabId)) {
      tabBlockedDomains.set(request.tabId, {});
    }
    const tabData = tabBlockedDomains.get(request.tabId);
    if (!tabData[purpose]) tabData[purpose] = {};
    tabData[purpose][domain] = (tabData[purpose][domain] || 0) + 1;
  });
}

// Clear per-tab tracking on navigation (main frame only) and tab close.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    tabBlockedDomains.delete(tabId);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  tabBlockedDomains.delete(tabId);
});

// Rebuild once on service worker startup (where supported)
chrome.runtime.onStartup?.addListener(() => {
  rebuildAllDynamicRules();
});

// For browsers that don't support onStartup in this context,
// also rebuild when the extension is installed or updated.
chrome.runtime.onInstalled.addListener((details) => {
  rebuildAllDynamicRules();

  if (details.reason === 'install') {
    chrome.storage.local.get(['onboardingComplete'], (result) => {
      if (!result.onboardingComplete) {
        chrome.tabs.create({ url: chrome.runtime.getURL('pages/onboarding.html') });
      }
    });
  }
});
