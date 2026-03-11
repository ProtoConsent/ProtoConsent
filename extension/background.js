// ProtoConsent browser extension
// Copyright (C) 2026 ProtoConsent contributors
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
// For more details see <https://www.gnu.org/licenses/>.

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
    const [rulesByDomain, blocklists] = await Promise.all([
      getAllRulesFromStorage(),
      loadBlocklistsConfig(),
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

    // For each site (domain) with rules
    for (const [domain, siteConfig] of Object.entries(rulesByDomain)) {
      const purposes = siteConfig.purposes || {};

      for (const purposeKey of PURPOSES_FOR_ENFORCEMENT) {
        const isAllowed = purposes[purposeKey] !== false; // default allowed
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
