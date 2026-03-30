// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// background.js - ProtoConsent enforcement using declarativeNetRequest

// We assign IDs for dynamic rules starting from 1 upwards
const BASE_RULE_ID = 1;

// For debugging: set to true to log all rule rebuilds and inputs
const DEBUG_RULES = false;

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

// Cached in-memory copy of blocklists.json; loaded once per SW lifetime.
let blocklistsConfig = null;

// Cached in-memory copy of presets.json; loaded once per SW lifetime.
let presetsConfig = null;

// Cached in-memory copy of purposes.json; loaded once per SW lifetime.
let purposesConfig = null;

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
 * Load purposes.json once when the service worker starts.
 * Extracts the list of purposes that trigger GPC (triggers_gpc: true).
 */
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
      loadPurposesConfig(),
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
            resourceTypes: BLOCK_RESOURCE_TYPES,
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
                resourceTypes: BLOCK_RESOURCE_TYPES,
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
                resourceTypes: BLOCK_RESOURCE_TYPES,
              },
            });
          }
        }
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

    // Per-site GPC overrides (same priority pattern as block/allow)
    for (const [domain, siteConfig] of Object.entries(rulesByDomain)) {
      const sitePurposes = resolvePurposes(siteConfig, presets, defaultConfig);
      const siteNeedsGPC = gpcPurposes.some(p => !sitePurposes[p]);

      if (siteNeedsGPC === globalNeedsGPC) continue;

      if (siteNeedsGPC && !globalNeedsGPC) {
        // Site blocks privacy purposes but global doesn't → add GPC for this site
        // Uses requestDomains (not initiatorDomains) so main_frame navigations match
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
            requestDomains: [domain],
            resourceTypes: GPC_RESOURCE_TYPES,
          },
        });
      } else if (!siteNeedsGPC && globalNeedsGPC) {
        // Site allows all but global sends GPC → remove header for this site
        // Uses requestDomains (not initiatorDomains) so main_frame navigations match
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
            requestDomains: [domain],
            resourceTypes: GPC_RESOURCE_TYPES,
          },
        });
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

    // Update the GPC content script registration to match the new rule state
    await updateGPCContentScript(rulesByDomain, presets, defaultConfig);

  } catch (e) {
    console.error("ProtoConsent: failed to rebuild dynamic rules:", e);
  }
}

/**
 * Register or unregister the GPC DOM signal (navigator.globalPrivacyControl)
 * as a MAIN-world content script, scoped to domains where GPC is needed.
 *
 * Receives pre-computed data from the rebuild to avoid re-reading storage.
 */
const GPC_SCRIPT_ID = "protoconsent-gpc";

async function updateGPCContentScript(rulesByDomain, presets, defaultConfig) {
  if (!chrome.scripting?.registerContentScripts) return;

  try {
    // Always unregister first to start fresh
    await chrome.scripting.unregisterContentScripts({ ids: [GPC_SCRIPT_ID] }).catch(() => {});

    const globalPurposes = resolvePurposes({}, presets, defaultConfig);
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
