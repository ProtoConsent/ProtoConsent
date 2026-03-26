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
 * Resolve purpose states for a site rule by applying profile defaults
 * and then any explicit overrides.
 * Returns an object with all purpose keys mapped to booleans.
 */
function resolvePurposes(siteConfig, presets) {
  const resolved = {};
  const profileName = siteConfig.profile || "balanced";
  const profileDef = presets[profileName];
  const profilePurposes = (profileDef && profileDef.purposes) || {};
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

/**
 * Main function: rebuild all dynamic DNR rules from current storage + blocklists.
 * This function:
 * 1) Deletes all existing dynamic rules.
 * 2) Reconstructs rules based on user choices and blocklists.
 * 3) Installs the new set of rules.
 */
async function rebuildAllDynamicRules() {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) {
    if (DEBUG_RULES) {
      console.warn("ProtoConsent: declarativeNetRequest not available in this browser.");
    }
    return;
  }

  try {
    const [rulesByDomain, blocklists, presets] = await Promise.all([
      getAllRulesFromStorage(),
      loadBlocklistsConfig(),
      loadPresetsConfig(),
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

    // For each site (domain) with rules, resolve profile inheritance
    for (const [domain, siteConfig] of Object.entries(rulesByDomain)) {
      const purposes = resolvePurposes(siteConfig, presets);

      for (const purposeKey of PURPOSES_FOR_ENFORCEMENT) {
        const isAllowed = purposes[purposeKey]; // resolved boolean from profile + overrides
        if (isAllowed) continue; // only create block rules when user says NO

        const blocklist = blocklists[purposeKey];
        if (!blocklist || !Array.isArray(blocklist.domains)) continue;

        // Create one DNR rule per blockedDomain for this initiator domain
        for (const blockedDomain of blocklist.domains) {
          const rule = {
            id: nextRuleId++,
            priority: 1,
            action: { type: "block" },
            condition: {
              // Simple urlFilter; can be refined later if needed
              urlFilter: blockedDomain,
              initiatorDomains: [domain],
              resourceTypes: [
                "script",
                "xmlhttprequest",
                "image",
                "sub_frame",
              ],
            },
          };
          newRules.push(rule);
        }
      }
    }

    if (DEBUG_RULES) {
      console.log("ProtoConsent: dynamic rules input (by domain):");
      for (const [domain, siteConfig] of Object.entries(rulesByDomain)) {
        console.log("  ", domain, siteConfig.purposes || {});
      }

      console.log(
        "ProtoConsent: rebuilt",
        newRules.length,
        "rules for",
        Object.keys(rulesByDomain).length,
        "domains"
      );
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

// Listen for messages from the popup to trigger rule rebuild
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "PROTOCONSENT_RULES_UPDATED") {
    // Fire and forget
    rebuildAllDynamicRules();
    sendResponse({ ok: true });
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
