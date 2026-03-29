// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// background.js - ProtoConsent enforcement using declarativeNetRequest

// We assign IDs for dynamic rules starting from 1 upwards
const BASE_RULE_ID = 1;

// For debugging: set to true to log all rule rebuilds and inputs
const DEBUG_RULES = false;

// Purposes we currently enforce
const PURPOSES_FOR_ENFORCEMENT = [
  "functional",
  "analytics",
  "ads",
  "personalization",
  "third_parties",
  "advanced_tracking"
];

// Cached in-memory copy of blocklists.json; loaded once per SW lifetime.
let blocklistsConfig = null;

// Cached in-memory copy of presets.json; loaded once per SW lifetime.
let presetsConfig = null;

/**
 * Load blocklists.json once when the service worker starts.
 * Subsequent calls return the cached in-memory version.
 */
async function loadBlocklistsConfig() {
  if (blocklistsConfig) return blocklistsConfig;

  try {
    const url = chrome.runtime.getURL("config/blocklists.json");
    const res = await fetch(url);
    blocklistsConfig = await res.json();
    return blocklistsConfig;
  } catch (e) {
    console.error("Failed to load blocklists.json:", e);
    blocklistsConfig = {
      analytics: { domains: [] },
      ads: { domains: [] },
    };
    return blocklistsConfig;
  }
}

/**
 * Load presets.json once when the service worker starts.
 * Subsequent calls return the cached in-memory version.
 */
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

/**
 * Utility: get the user's default profile config from storage.
 * Returns { profile, purposes } where purposes is only set for custom defaults.
 */
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

/**
 * Resolve purpose states for a site rule by applying profile defaults
 * and then any explicit overrides.
 * Returns an object with all purpose keys mapped to booleans.
 */
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

/**
 * Utility: get all rules from storage.
 * Returns an object mapping domain -> siteConfig.
 */
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

/**
 * Main function: rebuild all dynamic DNR rules from current storage + blocklists.
 * This function:
 * 1) Deletes all existing dynamic rules.
 * 2) Reconstructs rules based on user choices and blocklists.
 * 3) Installs the new set of rules.
 */
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
    if (DEBUG_RULES) {
      console.warn("ProtoConsent: declarativeNetRequest not available in this browser.");
    }
    return;
  }

  try {
    const [rulesByDomain, blocklists, presets, defaultConfig] = await Promise.all([
      getAllRulesFromStorage(),
      loadBlocklistsConfig(),
      loadPresetsConfig(),
      getDefaultProfileConfig(),
    ]);

    // First, remove all existing dynamic rules
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const existingIds = existingRules.map((r) => r.id);

    if (existingIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existingIds,
      });
    }

    // Now build new rules
    const newRules = [];
    let nextRuleId = BASE_RULE_ID;

    // 1. Resolve global default purposes (what applies to unconfigured sites)
    const globalPurposes = resolvePurposes({}, presets, defaultConfig);

    // 2. Global block rules (priority 1, no initiatorDomains — apply to ALL sites)
    for (const purposeKey of PURPOSES_FOR_ENFORCEMENT) {
      if (globalPurposes[purposeKey]) continue; // allowed globally, no block

      const blocklist = blocklists[purposeKey];
      if (!blocklist || !Array.isArray(blocklist.domains)) continue;

      for (const blockedDomain of blocklist.domains) {
        newRules.push({
          id: nextRuleId++,
          priority: 1,
          action: { type: "block" },
          condition: {
            urlFilter: "||" + blockedDomain,
            resourceTypes: ["script", "xmlhttprequest", "image", "sub_frame", "ping", "other"],
          },
        });
      }
    }

    // 3. Per-site overrides (priority 2 — override global rules where site differs)
    for (const [domain, siteConfig] of Object.entries(rulesByDomain)) {
      const sitePurposes = resolvePurposes(siteConfig, presets, defaultConfig);

      for (const purposeKey of PURPOSES_FOR_ENFORCEMENT) {
        const siteAllows = sitePurposes[purposeKey];
        const globalAllows = globalPurposes[purposeKey];

        if (siteAllows === globalAllows) continue; // same as global, no override needed

        const blocklist = blocklists[purposeKey];
        if (!blocklist || !Array.isArray(blocklist.domains)) continue;

        for (const blockedDomain of blocklist.domains) {
          if (siteAllows && !globalAllows) {
            // Site allows what global blocks → allow rule to override
            newRules.push({
              id: nextRuleId++,
              priority: 2,
              action: { type: "allow" },
              condition: {
                urlFilter: "||" + blockedDomain,
                initiatorDomains: [domain],
                resourceTypes: ["script", "xmlhttprequest", "image", "sub_frame", "ping", "other"],
              },
            });
          } else {
            // Site blocks what global allows → block rule for this site
            newRules.push({
              id: nextRuleId++,
              priority: 2,
              action: { type: "block" },
              condition: {
                urlFilter: "||" + blockedDomain,
                initiatorDomains: [domain],
                resourceTypes: ["script", "xmlhttprequest", "image", "sub_frame", "ping", "other"],
              },
            });
          }
        }
      }
    }

    if (DEBUG_RULES) {
      const globalCount = newRules.filter(r => !r.condition.initiatorDomains).length;
      const perSiteCount = newRules.filter(r => r.condition.initiatorDomains).length;
      console.log("ProtoConsent: rebuilt", newRules.length, "rules (" +
        globalCount + " global, " + perSiteCount + " per-site overrides)");
    }

    // Chrome allows max 5000 dynamic rules; warn if approaching
    if (newRules.length > 4500) {
      console.warn("ProtoConsent: approaching dynamic rule limit (" + newRules.length + "/5000).");
    }

    if (newRules.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: newRules,
      });
    }

  } catch (e) {
    console.error("ProtoConsent: failed to rebuild dynamic rules:", e);
  }
}

/**
 * Handle a bridge query from the content script.
 * Reads storage, resolves purposes for the requested domain,
 * and returns the appropriate data based on the action.
 */
async function handleBridgeQuery(message) {
  const { domain, action, purpose } = message;

  const [rules, presets, defaultConfig] = await Promise.all([
    getAllRulesFromStorage(),
    loadPresetsConfig(),
    getDefaultProfileConfig()
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

  // Content script forwards an SDK query
  if (message.type === "PROTOCONSENT_BRIDGE_QUERY") {
    handleBridgeQuery(message)
      .then((data) => sendResponse({ data }))
      .catch(() => sendResponse({ data: null }));
    return true; // keep message channel open for async response
  }
});

// Rebuild once on service worker startup (where supported)
chrome.runtime.onStartup?.addListener(() => {
  rebuildAllDynamicRules();
});

// For browsers that don't support onStartup in this context,
// also rebuild when the extension is installed or updated.
chrome.runtime.onInstalled.addListener(() => {
  rebuildAllDynamicRules();
});
