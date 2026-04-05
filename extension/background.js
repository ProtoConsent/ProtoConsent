// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// background.js - ProtoConsent enforcement using declarativeNetRequest
importScripts("config.js");

// Resolved once at startup: use onRuleMatchedDebug only when both opted-in
// (USE_DNR_DEBUG in config.js) and available (unpacked extension).
const useDnrDebug = USE_DNR_DEBUG && !!chrome.declarativeNetRequest.onRuleMatchedDebug;

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
// Persisted to chrome.storage.session to survive SW idle/restart.
const tabBlockedDomains = new Map();

// Maps dynamic block rule IDs to their purpose (rebuilt on each rule update).
let dynamicBlockRuleMap = {};

// Set of dynamic rule IDs that inject Sec-GPC: 1 (rebuilt on each rule update).
let dynamicGpcSetIds = new Set();

// Reverse index: maps each hostname to its purpose key(s), so we can
// determine which purpose blocked a request given only the hostname.
// Built after loadBlocklistsConfig(). Used by onErrorOccurred.
let reverseHostIndex = null;

// Set of currently-enabled static blocking rulesets (e.g. "block_analytics").
// Updated on each rebuildAllDynamicRules cycle. Used to disambiguate purpose
// when a domain appears in multiple blocklists.
let enabledBlockRulesets = new Set();

// GPC (Global Privacy Control) configuration snapshot — updated on each rebuild.
// gpcGlobalActive: true if the global GPC rule is on (applies to all requests by default).
// gpcAddDomains: sites that override global to ADD GPC (requestDomains targets).
// gpcRemoveDomains: sites that override global to REMOVE GPC (requestDomains targets).
// Used by onSendHeaders to filter out browser-native GPC signals (e.g. Brave/Firefox
// send Sec-GPC natively; we only count signals injected by our own rules).
let gpcGlobalActive = false;
let gpcAddDomains = new Set();
let gpcRemoveDomains = new Set();

// Per-tab tracking of unique domains that received GPC (Sec-GPC: 1) signals.
// Maps tabId -> Set<domain>
const tabGpcDomains = new Map();

// Session persistence helpers:
// Throttled write to chrome.storage.session (max once per 2s) to avoid
// excessive writes on pages with many blocked requests.
let sessionPersistTimer = null;
function scheduleSessionPersist() {
  if (sessionPersistTimer) return;
  sessionPersistTimer = setTimeout(() => {
    sessionPersistTimer = null;
    persistTabDataToSession();
  }, 2000);
}

function persistTabDataToSession() {
  if (!chrome.storage.session) return;
  // Convert Maps to plain objects for storage
  const blocked = {};
  for (const [tabId, data] of tabBlockedDomains) {
    blocked[tabId] = data;
  }
  const gpc = {};
  for (const [tabId, domains] of tabGpcDomains) {
    gpc[tabId] = domains;
  }
  chrome.storage.session.set({ _tabBlocked: blocked, _tabGpc: gpc });
}

async function restoreTabDataFromSession() {
  if (!chrome.storage.session) return;
  try {
    const result = await chrome.storage.session.get(['_tabBlocked', '_tabGpc']);
    if (result._tabBlocked) {
      for (const [tabId, data] of Object.entries(result._tabBlocked)) {
        tabBlockedDomains.set(Number(tabId), data);
      }
    }
    if (result._tabGpc) {
      for (const [tabId, domains] of Object.entries(result._tabGpc)) {
        tabGpcDomains.set(Number(tabId), domains);
      }
    }
  } catch (_) { /* session storage may be empty on first run */ }
}

// Last rebuild debug snapshot (served to popup on request)
let lastRebuildDebug = {};

// Restore persisted tab data from session storage on every SW load.
// This runs at the top level so it executes each time Chrome spins up the worker.
restoreTabDataFromSession();

// Badge: show blocked request count per tab on the extension icon.
// Uses our tabBlockedDomains as source (not Chrome's getMatchedRules total)
// so the number matches what the popup and log display.
chrome.action.setBadgeBackgroundColor({ color: "#6b7280" });

function updateBadgeForTab(tabId) {
  const tabData = tabBlockedDomains.get(tabId);
  if (!tabData) {
    chrome.action.setBadgeText({ tabId, text: "" });
    return;
  }
  let total = 0;
  for (const domains of Object.values(tabData)) {
    for (const count of Object.values(domains)) {
      total += count;
    }
  }
  chrome.action.setBadgeText({ tabId, text: total > 0 ? String(total) : "" });
}

// Cached in-memory copy of presets.json; loaded once per SW lifetime.
let presetsConfig = null;

// Cached in-memory copy of purposes.json; loaded once per SW lifetime.
let purposesConfig = null;

// Start loading blocklists early so the reverse hostname index is ready
// when the first onErrorOccurred event arrives. We don't await the result
// here — rebuildAllDynamicRules awaits it later. This call must stay below
// the presetsConfig/purposesConfig declarations or they will be undefined.
loadBlocklistsConfig();


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
      if (!res.ok) throw new Error("HTTP " + res.status);
      const rules = await res.json();
      entry.domains = rules[0]?.condition?.requestDomains || [];
    } catch (e) {
      // Expected for categories without a static ruleset (e.g. "functional")
      if (key !== "functional") console.warn("loadBlocklistsConfig: block_" + key + ".json:", e.message);
      entry.domains = [];
    }
    // Extract unique domains from path-based rules (urlFilter "||domain.com/path")
    try {
      const url = chrome.runtime.getURL("rules/block_" + key + "_paths.json");
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
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
    } catch (e) {
      if (key !== "functional") console.warn("loadBlocklistsConfig: block_" + key + "_paths.json:", e.message);
      entry.pathDomains = [];
    }
    config[key] = entry;
  }
  blocklistsConfig = config;
  reverseHostIndex = buildReverseHostIndex(config);
  return blocklistsConfig;
}

// Build a hostname-to-purpose lookup from the blocklists.
// Returns Map<hostname, string[]> where each value is an array of purpose keys.
// A domain may appear in multiple purposes (e.g. both "analytics" and "ads").
// ~40K entries; built once when blocklists are loaded.
function buildReverseHostIndex(config) {
  const index = new Map();
  for (const purpose of PURPOSES_FOR_ENFORCEMENT) {
    const entry = config[purpose];
    if (!entry) continue;
    const allDomains = (entry.domains || []).concat(entry.pathDomains || []);
    for (const domain of allDomains) {
      const existing = index.get(domain);
      if (existing) {
        if (!existing.includes(purpose)) existing.push(purpose);
      } else {
        index.set(domain, [purpose]);
      }
    }
  }
  return index;
}

// Resolve ALL matching purposes for a blocked hostname using the lookup index.
// Walks up the domain hierarchy to handle subdomain matching (declarativeNetRequest's
// requestDomains matches all subdomains, so "tracker.google-analytics.com" matches
// "google-analytics.com"). Returns an array of purpose keys (may be empty).
// In developer mode, onRuleMatchedDebug fires once per matching ruleset;
// this replicates that behavior for onErrorOccurred (which fires once per request).
function resolvePurposesFromHostname(hostname) {
  if (!reverseHostIndex) return [];
  let h = hostname;
  while (h) {
    const purposes = reverseHostIndex.get(h);
    if (purposes) {
      // Filter to purposes with active blocking (static rulesets or dynamic overrides)
      const activeDynamic = new Set(Object.values(dynamicBlockRuleMap));
      const active = purposes.filter(p =>
        enabledBlockRulesets.has("block_" + p) ||
        enabledBlockRulesets.has("block_" + p + "_paths") ||
        activeDynamic.has(p)
      );
      return active.length > 0 ? active : purposes;
    }
    const dot = h.indexOf(".");
    if (dot < 0) break;
    h = h.slice(dot + 1);
  }
  return [];
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
    if (!res.ok) throw new Error("HTTP " + res.status);
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

  // Force required purposes to true (defensive: even if storage is corrupted)
  for (const key of PURPOSES_FOR_ENFORCEMENT) {
    if (purposesConfig && purposesConfig[key]?.required) {
      resolved[key] = true;
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

// Utility: get the domain whitelist from storage.
// Returns an object mapping domain -> { purposeKey: true, ... }.
function getWhitelistFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["whitelist"], (result) => {
      resolve(result.whitelist || {});
    });
  });
}

// Sequential guard: if a rebuild is already running, queue one re-run at the end.
let _rebuildRunning = false;
let _rebuildQueued = false;


// Main function: rebuild all DNR enforcement from current storage + blocklists.
// 1) Enable/disable static rulesets (domain + path) for global blocking per category.
// 2) Build per-site dynamic overrides (block/allow) grouped by category.
// 3) Build whitelist allow rules (priority 3 - global domain exceptions).
// 4) Build GPC header rules (global + per-site overrides).
// 5) Replace all dynamic rules in a single updateDynamicRules call.
// 6) Update static rulesets AFTER dynamic (may temporarily block too much, but never too little).
async function rebuildAllDynamicRules() {
  if (_rebuildRunning) {
    _rebuildQueued = true;
    return;
  }
  _rebuildRunning = true;

  await loadDebugFlag();

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

    const [rulesByDomain, blocklists, presets, defaultConfig, whitelist] = await Promise.all([
      getAllRulesFromStorage(),
      loadBlocklistsConfig(),
      loadPresetsConfig(),
      getDefaultProfileConfig(),
      getWhitelistFromStorage(),
    ]);

    // Collect existing dynamic rule IDs for the atomic swap at the end
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const existingIds = existingRules.map((r) => r.id);

    const newRules = [];
    let nextRuleId = BASE_RULE_ID;
    const newDynamicBlockMap = {};
    const newGpcSetIds = new Set();

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

    // Track which static rulesets are actively blocking (for onErrorOccurred disambiguation)
    enabledBlockRulesets = new Set(enableIds);

    // 3. Per-site overrides (priority 2 — override static rules where site differs)
    //    First pass: group sites by (category, action) so we can batch all sites
    //    into one initiatorDomains array per rule. This keeps the rule count
    //    proportional to categories (max 10 dynamic rules), not to the number of custom sites.
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
        // Path-extracted domains (e.g. "elpais.com" from ||elpais.com/t.gif)
        // are too broad as requestDomains — DNR matches all subdomains, so
        // "elpais.com" would block static.elpais.com, imagenes.elpais.com, etc.
        // When one overlaps with an initiatorDomain the rule blocks the site's
        // own first-party resources.  Filter those out; the static path ruleset
        // handles them with precise urlFilter patterns when enabled globally.
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

    // 4. Whitelist allow rules (priority 3 - always win over blocks and per-site overrides).
    //    A single rule with all whitelisted domains in requestDomains.
    //    No initiatorDomains - the whitelist is global (applies to all visited sites).
    const whitelistedDomains = Object.keys(whitelist);
    if (whitelistedDomains.length > 0) {
      newRules.push({
        id: nextRuleId++,
        priority: 3,
        action: { type: "allow" },
        condition: {
          requestDomains: whitelistedDomains,
          resourceTypes: BLOCK_RESOURCE_TYPES,
        },
      });
    }

    // 5. GPC header rules — inject Sec-GPC: 1 when privacy purposes are denied.
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

    // Snapshot GPC config for the onSendHeaders production filter.
    // This tells the production listener which domains should receive GPC,
    // filtering out native browser GPC signals that we didn't inject.
    gpcGlobalActive = globalNeedsGPC;
    gpcAddDomains = new Set(gpcAddSites);
    gpcRemoveDomains = new Set(gpcRemoveSites);

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
        whitelistDomainCount: whitelistedDomains.length,
        ts: Date.now(),
      };
    }

    // 5. Apply changes: dynamic rules FIRST, then static rulesets.
    //    Order matters for security: during the brief gap between calls,
    //    "new dynamic + old static" may block too much (safe), whereas the
    //    reverse order "new static + old dynamic" could let requests through.
    //    Each wrapped in its own try/catch to surface errors independently.
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existingIds,
        addRules: newRules,
      });
      dynamicBlockRuleMap = newDynamicBlockMap;
      dynamicGpcSetIds = newGpcSetIds;
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
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return;

  // Popup notifies that rules were changed by the user
  if (message.type === "PROTOCONSENT_RULES_UPDATED") {
    rebuildAllDynamicRules();
    sendResponse({ ok: true });
    return;
  }

  // Popup requests per-tab blocked domain detail + per-purpose counts (domains + paths)
  if (message.type === "PROTOCONSENT_GET_BLOCKED_DOMAINS") {
    // Lazy rebuild if SW restarted and in-memory state is stale
    if (PURPOSES_FOR_ENFORCEMENT.length === 0) {
      rebuildAllDynamicRules();
    }
    Promise.all([loadBlocklistsConfig(), getWhitelistFromStorage()]).then(([bl, whitelist]) => {
      const purposeDomainCounts = {};
      const purposePathCounts = {};
      for (const key of PURPOSES_FOR_ENFORCEMENT) {
        const dLen = bl[key]?.domains?.length;
        const pLen = bl[key]?.pathDomains?.length;
        if (dLen) purposeDomainCounts[key] = dLen;
        if (pLen) purposePathCounts[key] = pLen;
      }
      const gpcDomains = tabGpcDomains.get(message.tabId);
      sendResponse({
        data: tabBlockedDomains.get(message.tabId) || {},
        purposeDomainCounts,
        purposePathCounts,
        gpcDomains: gpcDomains ? Object.keys(gpcDomains) : [],
        gpcDomainCounts: gpcDomains || {},
        whitelist,
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
    const debugData = Object.assign({}, lastRebuildDebug, {
      navigatingTabs: tabNavigating.size,
      logPorts: logPorts.size,
    });
    // Session key count (async; chrome.storage.session may not exist in all browsers)
    if (chrome.storage.session && chrome.storage.session.get) {
      chrome.storage.session.get(null).then((s) => {
        debugData.sessionKeys = Object.keys(s).length;
        sendResponse(debugData);
      }).catch(() => {
        debugData.sessionKeys = -1;
        sendResponse(debugData);
      });
    } else {
      debugData.sessionKeys = -1;
      sendResponse(debugData);
    }
    return true; // async response
  }

  // Popup requests .well-known fetch (via background to bypass page Service Workers)
  if (message.type === "PROTOCONSENT_FETCH_WELL_KNOWN") {
    const domain = message.domain;
    if (!domain || typeof domain !== "string") {
      sendResponse({ data: null });
      return;
    }
    const host = (message.host && typeof message.host === "string") ? message.host : domain;
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
    return true; // async response
  }

  // Popup requests adding a domain to the whitelist
  if (message.type === "PROTOCONSENT_WHITELIST_ADD") {
    const { domain, purpose } = message;
    if (!domain || !purpose) { sendResponse({ ok: false }); return; }
    getWhitelistFromStorage().then(whitelist => {
      if (!whitelist[domain]) whitelist[domain] = {};
      whitelist[domain][purpose] = true;
      chrome.storage.local.set({ whitelist }, () => {
        rebuildAllDynamicRules();
        sendResponse({ ok: true });
      });
    });
    return true; // async response
  }

  // Popup requests removing a domain from the whitelist
  if (message.type === "PROTOCONSENT_WHITELIST_REMOVE") {
    const { domain, purpose } = message;
    if (!domain) { sendResponse({ ok: false }); return; }
    getWhitelistFromStorage().then(whitelist => {
      if (whitelist[domain]) {
        if (purpose) {
          delete whitelist[domain][purpose];
          if (Object.keys(whitelist[domain]).length === 0) delete whitelist[domain];
        } else {
          delete whitelist[domain];
        }
      }
      chrome.storage.local.set({ whitelist }, () => {
        rebuildAllDynamicRules();
        sendResponse({ ok: true });
      });
    });
    return true; // async response
  }
});

// Track blocked domains per tab for the popup detail view.
// onRuleMatchedDebug fires for every matched rule (static + dynamic).
// Also forwards events to connected log ports for real-time display.
const logPorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "log") return;
  logPorts.add(port);
  port.onDisconnect.addListener(() => logPorts.delete(port));
});

if (useDnrDebug) {
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

    if (!purpose) {
      // Track unique domains that received a GPC "set" signal
      if (rule.rulesetId === "_dynamic" && dynamicGpcSetIds.has(rule.ruleId)) {
        let domain;
        try { domain = new URL(request.url).hostname; } catch (_) { return; }
        if (!tabGpcDomains.has(request.tabId)) tabGpcDomains.set(request.tabId, {});
        const gpcData = tabGpcDomains.get(request.tabId);
        const now = Date.now();
        if (!gpcData[domain]) gpcData[domain] = { count: 0, firstSeen: now };
        gpcData[domain].count++;
        gpcData[domain].lastSeen = now;
        scheduleSessionPersist();
        // Forward GPC event to log ports
        for (const port of logPorts) {
          try { port.postMessage({ type: "gpc", domain, tabId: request.tabId }); } catch (_) {}
        }
      }
      return;
    }

    let domain;
    try { domain = new URL(request.url).hostname; } catch (_) { return; }

    if (!tabBlockedDomains.has(request.tabId)) {
      tabBlockedDomains.set(request.tabId, {});
    }
    const tabData = tabBlockedDomains.get(request.tabId);
    if (!tabData[purpose]) tabData[purpose] = {};
    tabData[purpose][domain] = (tabData[purpose][domain] || 0) + 1;
    scheduleSessionPersist();
    updateBadgeForTab(request.tabId);

    // Forward block event to log ports
    for (const port of logPorts) {
      try { port.postMessage({ type: "block", purpose, url: request.url, tabId: request.tabId }); } catch (_) {}
    }
  });
}

// Standard data source: webRequest.onErrorOccurred for ERR_BLOCKED_BY_CLIENT.
// Used by default in both developer and store builds (USE_DNR_DEBUG = false).
// Provides URL and tabId but no ruleId — purpose resolved via reverse hostname index.
// Known limitation: other extensions blocking the same request produce false positives
// (mitigated by filtering against our blocklists via reverseHostIndex).
if (!useDnrDebug) {
  try {
    chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      if (details.error !== "net::ERR_BLOCKED_BY_CLIENT") return;
      if (details.tabId < 0) return;

      let hostname;
      try { hostname = new URL(details.url).hostname; } catch (_) { return; }

      // Resolve ALL matching purposes; empty means not in our blocklists
      // (likely blocked by another extension — skip to avoid counting someone else's blocks)
      const purposes = resolvePurposesFromHostname(hostname);
      if (!purposes.length) return;

      // Update tabBlockedDomains for each matching purpose (mirrors dev behavior
      // where onRuleMatchedDebug fires once per matching ruleset)
      if (!tabBlockedDomains.has(details.tabId)) {
        tabBlockedDomains.set(details.tabId, {});
      }
      const tabData = tabBlockedDomains.get(details.tabId);
      for (const purpose of purposes) {
        if (!tabData[purpose]) tabData[purpose] = {};
        tabData[purpose][hostname] = (tabData[purpose][hostname] || 0) + 1;
      }
      scheduleSessionPersist();
      updateBadgeForTab(details.tabId);

      // Forward block event to connected log ports (one per purpose, same as dev)
      for (const purpose of purposes) {
        for (const port of logPorts) {
          try {
            port.postMessage({ type: "block", purpose, url: details.url, tabId: details.tabId });
          } catch (_) {}
        }
      }
    },
    { urls: ["<all_urls>"] }
  );
  } catch (e) {
    console.warn("ProtoConsent: onErrorOccurred listener not available:", e.message);
  }

  // Standard GPC tracking: webRequest.onSendHeaders observes final request headers.
  // If Chrome applies DNR modifyHeaders (Sec-GPC: 1) before this event, we can detect
  // which domains received the GPC signal. Same data structure as onRuleMatchedDebug path.
  // If DNR headers are NOT visible here, this listener harmlessly captures nothing.
  // Filter: only count GPC for domains where OUR rules inject the header, not native browser GPC.
  try {
  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
      if (details.tabId < 0) return;
      if (!details.requestHeaders) return;

      const hasGpc = details.requestHeaders.some(
        h => h.name.toLowerCase() === "sec-gpc" && h.value === "1"
      );
      if (!hasGpc) return;

      let domain;
      try { domain = new URL(details.url).hostname; } catch (_) { return; }

      // Check if OUR DNR rules would inject GPC for this domain.
      // DNR requestDomains matches subdomains, so "tracker.example.com" matches
      // a rule targeting "example.com". Walk up labels to replicate DNR behavior.
      if (gpcGlobalActive) {
        // Global rule sends GPC to all domains, except per-site remove overrides.
        // Check if this domain matches any gpcRemoveDomains entry (subdomain-aware).
        if (gpcRemoveDomains.size > 0) {
          let h = domain;
          while (h) {
            if (gpcRemoveDomains.has(h)) return; // Excluded by per-site override
            const dot = h.indexOf(".");
            if (dot < 0) break;
            h = h.slice(dot + 1);
          }
        }
      } else {
        // No global rule — GPC only for per-site add overrides.
        if (gpcAddDomains.size === 0) return;
        let matched = false;
        let h = domain;
        while (h) {
          if (gpcAddDomains.has(h)) { matched = true; break; }
          const dot = h.indexOf(".");
          if (dot < 0) break;
          h = h.slice(dot + 1);
        }
        if (!matched) return;
      }

      if (!tabGpcDomains.has(details.tabId)) tabGpcDomains.set(details.tabId, {});
      const gpcData = tabGpcDomains.get(details.tabId);
      const now = Date.now();
      if (!gpcData[domain]) gpcData[domain] = { count: 0, firstSeen: now };
      gpcData[domain].count++;
      gpcData[domain].lastSeen = now;
      scheduleSessionPersist();

      // Forward GPC event to log ports
      for (const port of logPorts) {
        try { port.postMessage({ type: "gpc", domain, tabId: details.tabId }); } catch (_) {}
      }
    },
    { urls: ["<all_urls>"] },
    ["requestHeaders"]
  );
  } catch (e) {
    console.warn("ProtoConsent: onSendHeaders listener not available:", e.message);
  }
}

// Clear per-tab tracking on navigation and tab close.
// Guard against multiple "loading" events per navigation cycle (e.g. redirects,
// paywall logic on sites like wsj.com) which would wipe already-captured domains.
const tabNavigating = new Set();
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    if (!tabNavigating.has(tabId)) {
      tabNavigating.add(tabId);
      tabBlockedDomains.delete(tabId);
      tabGpcDomains.delete(tabId);
      scheduleSessionPersist();
      chrome.action.setBadgeText({ tabId, text: "" });
    }
  } else if (changeInfo.status === "complete") {
    tabNavigating.delete(tabId);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  tabBlockedDomains.delete(tabId);
  tabGpcDomains.delete(tabId);
  scheduleSessionPersist();
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
